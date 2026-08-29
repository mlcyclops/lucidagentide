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
import { appendFileSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Support diagnosability (the "agent process exited (code 1)" support ticket): every omp child's stderr
// is appended to ONE rolling log so a fresh-install failure leaves evidence a human can send in. The
// write is best-effort - diagnostics must never break the client - and the file is bounded: past 512KB
// it is rewritten keeping the newest 256KB.
const ACP_LOG = join(homedir(), ".omp", "lucid-acp.log");
const ACP_LOG_MAX = 512 * 1024;
const ACP_LOG_KEEP = 256 * 1024;
function acpLog(text: string): void {
  try {
    appendFileSync(ACP_LOG, text);
    if (statSync(ACP_LOG).size > ACP_LOG_MAX) {
      const tail = readFileSync(ACP_LOG, "utf8").slice(-ACP_LOG_KEEP);
      writeFileSync(ACP_LOG, tail);
    }
  } catch { /* best-effort; never break the client over a log line */ }
}

type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void; cleanup: () => void };

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
  constructor(private cmd: string, private args: string[], private cwd: string, private env: Record<string, string> = {}) {}

  /** Newest stderr bytes from THIS child (bounded). A non-zero exit quotes the last line so the UI
   *  error names the actual failure instead of a bare exit code. */
  private errTail = "";

  start(): void {
    this.proc = spawn(this.cmd, this.args, { cwd: this.cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: { ...process.env, ...this.env } });
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
    for (const p of waiting) { p.cleanup(); p.reject(new Error(reason)); }
    this.onExit(code);
  }

  /** True once the child has exited or failed to spawn: the connection can never answer again. */
  get isDead(): boolean { return this.dead !== null; }

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
      if (p) { this.pending.delete(msg.id); p.cleanup(); msg.error ? p.reject(msg.error) : p.resolve(msg.result); }
      return;
    }
    // request FROM the agent (needs a response)
    if (msg.method && msg.id !== undefined) {
      try { const result = await this.onRequest(msg.method, msg.params); this.write({ jsonrpc: "2.0", id: msg.id, result }); }
      catch (e) { this.write({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: String(e) } }); }
      return;
    }
    // notification
    if (msg.method) this.onNotify(msg.method, msg.params);
  }

  request<T = any>(method: string, params?: any, opts: RequestOpts = {}): Promise<T> {
    if (this.dead) return Promise.reject(new Error(this.dead));
    if (!this.proc) return Promise.reject(new Error("acp: agent process not started"));
    if (opts.signal?.aborted) return Promise.reject(new Error(`acp: ${method} cancelled`));
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
    const onAbort = () => { this.pending.delete(id); cleanup(); reject(new Error(`acp: ${method} cancelled`)); };
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
    if (!this.proc) return;
    this.write({ jsonrpc: "2.0", method, params });
  }

  private write(o: unknown): void {
    this.proc?.stdin!.write(JSON.stringify(o) + "\n");
  }

  stop(): void {
    try { this.proc?.kill(); } catch { /* ignore */ }
    // kill() is async on every platform; drain now so callers awaiting a reply fail fast.
    this.die("acp: agent connection stopped", null);
  }
}
