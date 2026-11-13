// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/acp.ts
//
// Minimal Agent Client Protocol client: drives `omp acp` over stdio
// (newline-delimited JSON-RPC 2.0). The handshake + capabilities are verified by
// tools/acp_probe.ts. The session/update → ChatEvent mapping follows the ACP
// spec; field shapes should be confirmed on the first real model turn (they
// could not be exercised headlessly).

import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, constants, fstatSync, ftruncateSync, mkdtempSync, openSync, readSync, writeSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

// P-BROWSER.4 (ADR-0415): the `windowsHide` a spawn uses when its caller does not pass one. This module is
// also bundled into the Node-hosted VS Code extension, so it must not import console_host.ts (bun:ffi):
// the engine installs console_host's `ompWindowsHide` here at boot (dev.ts, after ensureHiddenConsole), and
// every other host keeps CREATE_NO_WINDOW, the contract from before the hidden console existed.
let defaultWindowsHide: () => boolean = () => true;
export function setDefaultWindowsHide(fn: () => boolean): void { defaultWindowsHide = fn; }

// Support diagnosability (the "agent process exited (code 1)" support ticket): every omp child's stderr
// is appended to ONE rolling log so a fresh-install failure leaves evidence a human can send in. The
// write is best-effort - diagnostics must never break the client - and the file is bounded: past 512KB
// it is rewritten keeping the newest 256KB.
//
// The recovery incident report quotes this log's tail as its only evidence, so it must hold the operator's
// real omp children and nothing else. Every suite that drives the fake ACP agent spawns through this
// client; resolved to the real home, a full `bun test` run filled the tail with `[fake-acp] ready` lines
// and pushed the real omp stderr out of the report. So under `bun test` (NODE_ENV=test) it NEVER resolves
// to the real log (the security_log.ts rule). `LUCID_ACP_LOG` gives a test a deterministic file. Resolved
// per call, never at import: import order must not decide where a line lands. The test file lives in a
// private mkdtemp directory (0700), never at a predictable name in the shared temp dir.
let testLogDir: string | null = null;
export function acpLogPath(): string {
  const override = process.env.LUCID_ACP_LOG?.trim();
  if (override) return override;
  if (process.env.NODE_ENV === "test") return join(testLogDir ??= mkdtempSync(join(tmpdir(), "lucid-acp-test-")), "lucid-acp.log");
  return join(homedir(), ".omp", "lucid-acp.log");
}
const ACP_LOG_MAX = 512 * 1024;
const ACP_LOG_KEEP = 256 * 1024;
/** Append, and past ACP_LOG_MAX keep the newest ACP_LOG_KEEP bytes. Every step goes through ONE descriptor,
 *  so the size checked is the size of the file rewritten (no path re-resolved between check and use). Writes
 *  are positional rather than O_APPEND because Windows refuses to truncate a handle opened for append. */
function acpLog(text: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(acpLogPath(), constants.O_RDWR | constants.O_CREAT, 0o600);
    const line = Buffer.from(text, "utf8");
    const at = fstatSync(fd).size;
    writeSync(fd, line, 0, line.length, at);
    const size = at + line.length;
    if (size > ACP_LOG_MAX) {
      const tail = Buffer.alloc(ACP_LOG_KEEP);
      const n = readSync(fd, tail, 0, ACP_LOG_KEEP, size - ACP_LOG_KEEP);
      ftruncateSync(fd, 0);
      writeSync(fd, tail, 0, n, 0);
    }
  } catch { /* best-effort; never break the client over a log line */ }
  finally { if (fd !== null) { try { closeSync(fd); } catch { /* already closed */ } } }
}

/** A JSON-RPC error object from the agent, as a real Error whose message says what went wrong.
 *  P-NORESP.2: rejecting with the raw `{code, message, data}` object reached the chat as
 *  "[object Object]" (every `String(e)` downstream), hiding the provider's actual failure. The
 *  message folds in `data` (where omp puts the provider detail), clamped; `code` and `data` stay on
 *  the Error for any caller that branches on them. Pure. */
export function rpcError(err: unknown): Error & { code?: number; data?: unknown } {
  const o = (err && typeof err === "object" ? err : { message: String(err) }) as { code?: number; message?: unknown; data?: unknown };
  const base = typeof o.message === "string" && o.message ? o.message : "agent returned an error";
  const d = o.data;
  const detail = d === undefined || d === null ? "" : typeof d === "string" ? d : (() => { try { return JSON.stringify(d); } catch { return String(d); } })();
  const msg = detail && !base.includes(detail) ? `${base}: ${detail}` : base;
  const e = new Error((o.code !== undefined ? `${msg} (code ${o.code})` : msg).slice(0, 500)) as Error & { code?: number; data?: unknown };
  e.code = o.code;
  e.data = d;
  return e;
}

type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void; cleanup: () => void };

/** P-HOLDER.1 (ADR-0534): a connection to a `lucid-holder` that owns the agent process (desktop/lane_holder.ts
 *  HolderLink). Structural, so this module, which the VS Code extension also bundles, imports nothing of the
 *  engine's. Frames wait until `resume()`, so the client wires its handlers before the replay arrives. */
export interface HeldIO {
  readonly hello: { childPid: number };
  /** Offset one past the last stdout byte delivered. */
  readonly offset: number;
  onStdout: (chunk: Buffer, endOffset: number) => void;
  onStderr: (chunk: Buffer) => void;
  onExit: (code: number) => void;
  onClose: () => void;
  resume(): void;
  write(data: string): void;
  /** The holder may forget stdout before `offset`. */
  trim(offset: number): void;
  /** How long the holder keeps the agent with no engine attached. */
  keepFor(ms: number): void;
  /** End the agent's tree and the holder; true once confirmed. A closed connection sends it on a new one. */
  kill(): Promise<boolean>;
  detach(): void;
  /** A new connection to the same holder, replaying stdout from `from` (the holder dropped this one). */
  reconnect(from: number): Promise<HeldIO>;
}

/** Per-request bounds. Without at least one of these a request waits forever (P-KG-INGEST.5, ADR-0264). */
export type RequestOpts = {
  /** Reject after this many ms with no response. Omit only for calls already raced against another clock. */
  timeoutMs?: number;
  /** Reject as soon as the caller aborts. */
  signal?: AbortSignal;
};

export class ACPClient {
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buf = "";
  /** Set once the child is gone (exit or spawn error). Every later request rejects with this reason. */
  private dead: string | null = null;
  /** P-HOLDER.1: the agent runs under a holder instead of as this process's child. */
  private held: HeldIO | null = null;
  /** Offset one past the last held stdout byte received, and its UTF-8 decoder (a character may span chunks). */
  private heldEnd = 0;
  private decoder = new StringDecoder("utf8");
  /** Set by detach(): the connection was let go on purpose, so nobody is told the agent ended. */
  private detached = false;
  /** While the holder connection is being made again: what was sent meanwhile, in order, for the new connection. */
  private reconnecting: ((io: HeldIO) => void)[] | null = null;
  /** The offset the last reconnect replayed from; a connection that closes again with nothing handled since ends. */
  private reconnectedFrom = -1;

  /** P-HOLDER.1: an agent request a previous engine already answered (a replay brings it again). Skipped. */
  skipRequest: (id: number | string) => boolean = () => false;
  /** P-HOLDER.1: an agent request was answered (the lane records it for a later replay). */
  onAnswered: (id: number | string) => void = () => {};

  /** notifications from the agent (e.g. "session/update"). */
  onNotify: (method: string, params: any) => void = () => {};
  /** agent→client requests we must answer (e.g. "session/request_permission"). */
  onRequest: (method: string, params: any) => Promise<any> = async () => ({});
  /** raw stderr (used to catch the gate's "[BLOCKED …]" line). */
  onStderr: (chunk: string) => void = () => {};
  onExit: (code: number | null) => void = () => {};

  // `env` (P-SANDBOX.2, ADR-0166) is an OVERLAY added on top of the inherited process.env for THIS child
  // only — the mediated-egress proxy sets HTTP(S)_PROXY here so the omp child (and its bash/pip children)
  // tunnel through the proxy, WITHOUT polluting the desktop process's own environment. Default {} ⇒ the
  // child inherits process.env exactly as before.
  // `spawnOpts.windowsHide` (P-BROWSER.4, ADR-0415): by default the child attaches to this process's hidden
  // console when there is one (console_host.ts), so omp sees a console and spawns ITS children, the visible
  // browser above all, without SW_HIDE. Passing `true` keeps the child console-less (CREATE_NO_WINDOW), the
  // AppContainer helper's contract.
  constructor(private cmd: string, private args: string[], private cwd: string, private env: Record<string, string> = {}, private spawnOpts: { windowsHide?: boolean } = {}) {}

  /** Newest stderr bytes from THIS child (bounded). A non-zero exit quotes the last line so the UI
   *  error names the actual failure instead of a bare exit code. */
  private errTail = "";

  start(): void {
    const windowsHide = this.spawnOpts.windowsHide ?? defaultWindowsHide();
    this.proc = spawn(this.cmd, this.args, { cwd: this.cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide, env: { ...process.env, ...this.env } });
    acpLog(`\n[acp spawn ${new Date().toISOString()} cmd=${this.cmd} cwd=${this.cwd}]\n`);
    this.proc.stdout!.on("data", (d) => this.onData(String(d)));
    this.proc.stderr!.on("data", (d) => {
      const s = String(d);
      this.errTail = (this.errTail + s).slice(-4096);
      acpLog(s);
      this.onStderr(s);
    });
    this.proc.stdin!.on("error", () => { /* EPIPE once the child is gone; the exit handler drains */ });
    // A spawn failure (ENOENT, EACCES) emits "error" and NO "exit". Both must drain `pending`,
    // otherwise every in-flight request stays unsettled forever (the import-hang bug).
    this.proc.on("error", (e) => this.die(`acp: agent process failed to start: ${e.message}`, null));
    this.proc.on("exit", (code) => {
      const hint = code ? this.lastStderrLine() : "";
      this.die(`acp: agent process exited (code ${code ?? "null"})${hint ? ` - last stderr: ${hint}` : ""}`, code);
    });
  }

  /** P-HOLDER.1: start the agent under a holder. `launch` gets exactly what start() would spawn (this client's
   *  command, arguments, cwd and the full child environment) and returns the attached connection. */
  async startHeld(launch: (cmd: string, args: string[], cwd: string, env: Record<string, string | undefined>) => Promise<HeldIO>): Promise<void> {
    acpLog(`\n[acp held spawn ${new Date().toISOString()} cmd=${this.cmd} cwd=${this.cwd}]\n`);
    this.attachHeld(await launch(this.cmd, this.args, this.cwd, { ...process.env, ...this.env }));
  }

  /** P-HOLDER.1: speak to an agent a holder already runs (a new one, or one a previous engine started). The
   *  replay from the connection's offset arrives first, so any adopt() must be registered before this. */
  attachHeld(io: HeldIO): void {
    this.held = io;
    this.heldEnd = io.offset;
    io.onStdout = (chunk, end) => { this.heldEnd = end; this.onData(this.decoder.write(chunk)); };
    io.onStderr = (chunk) => {
      const s = chunk.toString("utf8");
      this.errTail = (this.errTail + s).slice(-4096);
      acpLog(s);
      this.onStderr(s);
    };
    io.onExit = (code) => {
      const hint = code ? this.lastStderrLine() : "";
      this.die(`acp: agent process exited (code ${code})${hint ? ` - last stderr: ${hint}` : ""}`, code);
    };
    io.onClose = () => { void this.reconnectHeld(io); };
    io.resume();
  }

  /** P-HOLDER.1: the holder closed this connection while nobody here let go of it. It drops a client that fell too
   *  far behind (its queue for it is bounded) and the agent runs on, so attach again from the last handled line: the
   *  replay brings every byte after it. What is sent meanwhile waits for the new connection. A reconnect that fails,
   *  or a connection that closes again before anything new was handled, ends the client as before. */
  private async reconnectHeld(io: HeldIO): Promise<void> {
    if (this.dead || this.held !== io) return;
    const from = this.consumedOffset;
    if (from === this.reconnectedFrom) { this.die("acp: the lane holder closed the connection", null); return; }
    this.reconnectedFrom = from;
    this.reconnecting = [];
    let next: HeldIO;
    try { next = await io.reconnect(from); }
    catch (e) {
      this.reconnecting = null;
      this.die(`acp: the lane holder closed the connection and did not take it back (${e instanceof Error ? e.message : String(e)})`, null);
      return;
    }
    const queued = this.reconnecting ?? [];
    this.reconnecting = null;
    // Stopped, detached or ended meanwhile: whoever did that acts on the agent; this connection only lets go.
    if (this.dead || this.held !== io) { next.detach(); return; }
    // The replay starts at a line start, so the partial line and any half character go.
    this.buf = "";
    this.decoder = new StringDecoder("utf8");
    this.attachHeld(next);
    for (const send of queued) send(next);
  }

  /** P-HOLDER.1: hand `send` the holder connection now, or the next one while it is being made again. */
  private toHeld(send: (io: HeldIO) => void): void {
    if (!this.held || this.dead) return;
    if (this.reconnecting) this.reconnecting.push(send);
    else send(this.held);
  }

  /** P-HOLDER.1: every held stdout byte before this offset was handled (a partial line is not). */
  get consumedOffset(): number { return this.heldEnd - Buffer.byteLength(this.buf, "utf8"); }

  /** P-HOLDER.1: tell the holder how long to keep the agent if this engine goes away, and that everything handled
   *  so far may be forgotten (`trim`, at a turn's end). No-ops for an agent this process spawned itself. */
  holdFor(ms: number, trim = false): void {
    const handled = this.consumedOffset;
    this.toHeld((io) => {
      if (trim) io.trim(handled);
      io.keepFor(ms);
    });
  }

  /** The id the last request() used (0 before any). */
  get lastRequestId(): number { return this.nextId - 1; }

  /** P-HOLDER.1: a reattached client must never reuse an id the previous engine sent on this agent. */
  reserveIds(above: number): void { if (above >= this.nextId) this.nextId = above + 1; }

  /** P-HOLDER.1: the reply to a request a PREVIOUS engine sent on this agent (a held turn in flight). No timeout:
   *  like a prompt, it is raced only against the agent's life. */
  adopt<T = unknown>(id: number): Promise<T> {
    if (this.dead) return Promise.reject(new Error(this.dead));
    // Classic executor, like request(): the VS Code extension typechecks this file under a pre-ES2024 lib.
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (v) => resolve(v as T), reject, cleanup: () => {} });
    });
    this.reserveIds(id);
    return promise;
  }

  /** P-HOLDER.1: let go of a held agent and leave it running (this engine is going away; the next one
   *  reattaches). Requests still waiting are dropped quietly and onExit is not called. */
  detach(): void {
    if (!this.held || this.dead) return;
    this.detached = true;
    this.held.detach();
    this.die("acp: detached from the lane holder", null);
  }

  /** The newest non-empty stderr line, clamped for a UI-safe error suffix. */
  private lastStderrLine(): string {
    const lines = this.errTail.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const t = lines[i]!.trim();
      if (t) return t.slice(0, 200);
    }
    return "";
  }

  /** Child is gone: reject everything still waiting, then notify the owner exactly once. */
  private die(reason: string, code: number | null): void {
    if (this.dead) return;
    this.dead = reason;
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const p of waiting) p.cleanup();
    if (this.detached) return; // the agent runs on under its holder; nobody here may act on its end
    for (const p of waiting) p.reject(new Error(reason));
    this.onExit(code);
  }

  /** True once the child has exited or failed to spawn: the connection can never answer again. */
  get isDead(): boolean { return this.dead !== null; }

  /** P-LIVENESS.1: the spawned child's pid (the root of the agent's process tree), while it runs. */
  get pid(): number | null { return this.dead === null ? (this.held ? this.held.hello.childPid : this.proc?.pid ?? null) : null; }

  /** P-HOLDER.1: the agent runs under a holder. */
  get isHeld(): boolean { return this.held !== null; }

  private onData(s: string): void {
    this.buf += s;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (line) this.handle(line);
    }
  }

  private async handle(line: string): Promise<void> {
    let msg: any;
    try { msg = JSON.parse(line); } catch { return; }

    // response to one of our requests
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (p) { this.pending.delete(msg.id); p.cleanup(); msg.error ? p.reject(rpcError(msg.error)) : p.resolve(msg.result); }
      return;
    }
    // request FROM the agent (needs a response)
    if (msg.method && msg.id !== undefined) {
      if (this.skipRequest(msg.id)) return; // P-HOLDER.1: answered before a reattach; the agent has its answer
      try { const result = await this.onRequest(msg.method, msg.params); this.write({ jsonrpc: "2.0", id: msg.id, result }); }
      catch (e) { this.write({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: String(e) } }); }
      this.onAnswered(msg.id);
      return;
    }
    // notification
    if (msg.method) this.onNotify(msg.method, msg.params);
  }

  request<T = any>(method: string, params?: any, opts: RequestOpts = {}): Promise<T> {
    if (this.dead) return Promise.reject(new Error(this.dead));
    if (!this.proc && !this.held) return Promise.reject(new Error("acp: agent process not started"));
    if (opts.signal?.aborted) return Promise.reject(new Error(`acp: ${method} canceled`));
    const id = this.nextId++;
    // Classic executor (not Promise.withResolvers): the VS Code extension typechecks this file under a
    // pre-ES2024 lib, and the desktop tsconfig targets Node types - the executor form works on every
    // surface this client compiles on.
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      clearTimeout(timer);
      timer = undefined;
      opts.signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => { this.pending.delete(id); cleanup(); reject(new Error(`acp: ${method} canceled`)); };
    // The JSON-RPC result is untyped on the wire; the caller declares the shape it expects.
    this.pending.set(id, { resolve: (v) => resolve(v as T), reject, cleanup });
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => { this.pending.delete(id); cleanup(); reject(new Error(`acp: ${method} timed out after ${opts.timeoutMs}ms`)); }, opts.timeoutMs);
      timer.unref?.();
    }
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    try { this.write({ jsonrpc: "2.0", id, method, params }); }
    catch (e) { this.pending.delete(id); cleanup(); reject(new Error(`acp: ${method} write failed: ${String(e)}`)); }
    return promise;
  }

  /** Send a JSON-RPC NOTIFICATION (no id, no response) — e.g. ACP `session/cancel`. */
  notify(method: string, params?: any): void {
    if (!this.proc && !this.held) return;
    this.write({ jsonrpc: "2.0", method, params });
  }

  private write(o: unknown): void {
    const line = JSON.stringify(o) + "\n";
    if (this.held) { this.toHeld((io) => io.write(line)); return; }
    this.proc?.stdin!.write(line);
  }

  /** The stop in progress or finished. stop() is idempotent: every call shares it, except that a FAILED
   *  attempt is dropped while its root process still runs, so the next call tries again. */
  private stopping: Promise<boolean> | null = null;

  /**
   * End the child and everything it started. Requests still waiting are rejected at once; the returned
   * promise resolves true only once the end is CONFIRMED, and false when part of the tree may still be
   * running, so a caller about to start a replacement can refuse instead of letting two agents act in one
   * workspace. Never rejects. Callers that only need the connection gone may ignore the result.
   */
  stop(): Promise<boolean> {
    if (!this.stopping) {
      const attempt = this.endTree();
      this.stopping = attempt;
      // Once the root is gone nothing can walk its tree again, so only a failure with the root still
      // running is worth a retry.
      void attempt.then((ok) => { if (!ok && this.stopping === attempt && this.proc && running(this.proc)) this.stopping = null; });
    }
    // Ending the process is async on every platform; drain now so callers awaiting a reply fail fast.
    this.die("acp: agent connection stopped", null);
    return this.stopping;
  }

  private async endTree(): Promise<boolean> {
    // P-HOLDER.1: the holder owns the agent's tree (a job object on Windows, a process group elsewhere) and ends
    // it whole; confirmed once the holder closed the connection.
    if (this.held) return this.held.kill();
    const proc = this.proc;
    if (!proc || proc.pid === undefined || !running(proc)) return true; // never spawned, or already exited
    if (process.platform === "win32") {
      // P-RECOVER.1 (ADR-0385): on Windows `omp.exe` is a Bun shim and the real agent is a `bun.exe cli.js`
      // GRANDCHILD, with the agent's own tool processes under it. kill() ends only the shim, so the agent
      // outlived stop() until it noticed stdin EOF (or never, when wedged). taskkill /T ends the whole tree.
      // Ownership is proven: this is the pid WE spawned and it has not exited (a reused pid is impossible
      // while our handle is still live), and taskkill is named by its absolute System32 path so PATH cannot
      // substitute another binary. Confirmed means taskkill reported every process ended (exit 0) and the
      // child's own exit was observed. If taskkill fails, the direct child is still killed so the
      // connection does not linger, but the result is false: the rest of the tree is unaccounted for.
      const treeEnded = await taskkillTree(proc.pid);
      if (!treeEnded) { try { proc.kill(); } catch { /* already gone */ } }
      const childExited = await exited(proc, STOP_EXIT_MS);
      return treeEnded && childExited;
    }
    // POSIX: `omp` is the agent process itself. SIGTERM, then SIGKILL if it has not exited in time.
    try { proc.kill(); } catch { /* already gone */ }
    if (await exited(proc, STOP_EXIT_MS)) return true;
    try { proc.kill("SIGKILL"); } catch { /* already gone */ }
    return exited(proc, STOP_EXIT_MS);
  }
}

/** Bounds for stop(): taskkill's own run, then the child's exit. */
const TASKKILL_MS = 10_000;
const STOP_EXIT_MS = 5_000;

function running(proc: ChildProcess): boolean {
  return proc.exitCode === null && proc.signalCode === null;
}

/** True once `proc` has exited, false if it is still running after `ms`. */
function exited(proc: ChildProcess, ms: number): Promise<boolean> {
  if (!running(proc)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onExit = (): void => { clearTimeout(timer); resolve(true); };
    const timer = setTimeout(() => { proc.off("exit", onExit); resolve(false); }, ms);
    timer.unref?.();
    proc.once("exit", onExit);
  });
}

/** `taskkill /PID <pid> /T /F`, awaited. True only when it exits 0, which it does when every process in
 *  the tree was ended; any failure, a spawn error, or no answer in TASKKILL_MS is false. */
function taskkillTree(pid: number): Promise<boolean> {
  return new Promise((resolve) => {
    let tk: ChildProcess;
    try {
      tk = spawn(join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => { try { tk.kill(); } catch { /* already gone */ } resolve(false); }, TASKKILL_MS);
    timer.unref?.();
    tk.once("error", () => { clearTimeout(timer); resolve(false); });
    tk.once("exit", (code) => { clearTimeout(timer); resolve(code === 0); });
    tk.unref();
  });
}
