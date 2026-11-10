// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/lane_holder.ts - P-HOLDER.1 (ADR-0534): the engine's side of `lucid-holder` (native/lucid-holder).
//
// A fleet lane's agent (`omp acp`) used to be a child of the engine, so an engine restart, an IDE update or closing
// the window ended every turn in flight. With a holder the agent is a child of its own small process instead: the
// holder keeps everything the agent writes to stdout in a spool file, and the engine attaches to it over a local
// endpoint (a named pipe on Windows, a Unix socket elsewhere), asking for the bytes from the offset it last
// handled. An engine that comes back reattaches and the turn carries on; nothing is re-run.
//
// The holder never interprets ACP. The engine records, per lane, what it needs to come back: the endpoint and its
// token, the lane's identity (session, model, cwd, transcript), the offset it had handled, and the turn in flight
// (the JSON-RPC id of its session/prompt and the offset at which it was sent, so a reattach replays that whole turn
// into a fresh lane and the reply settles it). Records live in `<data root>/lane-holders/` (0700), each 0600.

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { CHANNEL_ENV, mintChannelKey } from "../harness/omp/engine_channel.ts";
import { LaneChannels } from "./lane_channel.ts";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { repoAsset } from "./repo_root.ts";
import type { LaneTurnRecord } from "./fleet_lanes.ts";

const OUT = 0x4f; // 'O'
const ERR = 0x45; // 'E'
const EXIT = 0x58; // 'X'
const STDIN = 0x49; // 'I'
const CLOSE_STDIN = 0x43; // 'C'
const TRIM = 0x54; // 'T'
const ORPHAN = 0x50; // 'P'
const KILL = 0x4b; // 'K'

/** A held lane in a turn keeps its agent this long with no engine attached (an IDE closed overnight). */
export const HELD_BUSY_KEEP_MS = 24 * 60 * 60 * 1000;
/** An idle held lane survives an engine restart or an IDE update, not a night with the IDE closed. */
export const HELD_IDLE_KEEP_MS = 15 * 60 * 1000;
const LAUNCH_MS = 25_000;
const CONNECT_MS = 10_000;
const KILL_MS = 10_000;
const HOLDER_ID_RE = /^[A-Za-z0-9-]{1,64}$/;

/** The holder binary this engine runs, or null when it is not built or shipped (lanes are then the engine's own
 *  children, as before P-HOLDER.1). LUCID_HOLDER_BIN names one explicitly (tests, a local build). */
export function holderBinary(env: Record<string, string | undefined> = process.env): string | null {
  const exe = process.platform === "win32" ? "lucid-holder.exe" : "lucid-holder";
  const candidates = [env.LUCID_HOLDER_BIN, repoAsset("bin", exe), repoAsset("native", "lucid-holder", "target", "release", exe)];
  for (const c of candidates) if (c && existsSync(c)) return c;
  return null;
}

/** Whether a process with this pid exists (one owned by another account counts). */
export function holderProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

/** LH-07: what tells a process apart from a later one that got the same pid: its start time (Linux: field 22 of
 *  /proc/<pid>/stat, clock ticks since boot; macOS: `ps -o lstart=`). Null when the process is gone or the OS
 *  offers neither (Windows, where the holder's job object ends the tree and no group kill is sent). */
export function processStartId(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      // The command name (field 2) may hold spaces and parentheses; the fields after its last ')' start at field 3.
      return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
    } catch { return null; }
  }
  if (process.platform === "darwin") {
    const r = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 2_000 });
    const s = r.status === 0 && typeof r.stdout === "string" ? r.stdout.trim() : "";
    return s || null;
  }
  return null;
}

/** The pids a holder's handshake reported, with the start times sampled while that connection was open. */
export interface HolderIdentity { pid: number; childPid: number; start: string | null; childStart: string | null }

export interface EndHolderDeps {
  platform: NodeJS.Platform;
  startOf: (pid: number) => string | null;
  kill: (pid: number, signal: NodeJS.Signals) => void;
}

const END_HOLDER_DEPS: EndHolderDeps = { platform: process.platform, startOf: processStartId, kill: (pid, signal) => { process.kill(pid, signal); } };

/** LH-05: the last resort when a holder did not confirm a KILL. Ending the holder ends the agent's tree on Windows
 *  (its job object kills on close). Elsewhere the agent leads its own process group, signalled first, while the
 *  holder is alive: the holder never reaps the agent before its own group kill (serve.rs), so a live holder keeps
 *  the agent's pid, and with it the group id, from being reused.
 *  LH-07: on POSIX a pid is signalled only when it still names the process the handshake reported (same start
 *  time). A pid whose identity cannot be read or differs belongs to someone else now and is left alone; the
 *  holder's own keep-for ends whatever is left of the lane. */
export function endHolderProcess(h: HolderIdentity, deps: EndHolderDeps = END_HOLDER_DEPS): void {
  const send = (pid: number, signal: NodeJS.Signals) => { try { deps.kill(pid, signal); } catch { /* gone */ } };
  if (deps.platform === "win32") {
    if (Number.isInteger(h.pid) && h.pid > 0) send(h.pid, "SIGKILL");
    return;
  }
  const same = (pid: number, start: string | null) => Number.isInteger(pid) && pid > 1 && start !== null && deps.startOf(pid) === start;
  if (same(h.childPid, h.childStart)) send(-h.childPid, "SIGKILL");
  if (same(h.pid, h.start)) send(h.pid, "SIGKILL");
}

/** `dropped` (LH-08): bytes between the offset asked for and where the replay starts, because the spool reached its
 *  cap during the turn and let its oldest output go (0 when nothing was dropped). */
export interface HolderHello { base: number; end: number; pid: number; childPid: number; exited: number | null; dropped: number }

/** One connection to a holder. Frames received before `resume()` wait in the socket, so the caller wires its
 *  handlers first and loses nothing of the replay. */
export class HolderLink {
  onStdout: (chunk: Buffer, endOffset: number) => void = () => {};
  onStderr: (chunk: Buffer) => void = () => {};
  onExit: (code: number) => void = () => {};
  /** The connection ended: the holder exited, or it dropped this client. Not called after detach(). */
  onClose: () => void = () => {};
  #pending: Buffer = Buffer.alloc(0);
  #offset: number;
  #closed = false;
  #detaching = false;
  readonly closedPromise: Promise<void>;

  private constructor(private readonly socket: Socket, readonly hello: HolderHello, from: number, rest: Buffer) {
    this.#offset = from;
    this.#pending = rest;
    const closed = Promise.withResolvers<void>();
    this.closedPromise = closed.promise;
    socket.on("data", (d: Buffer) => this.#feed(d));
    socket.on("error", () => { /* the close handler reports it */ });
    socket.on("close", () => {
      this.#closed = true;
      closed.resolve();
      if (!this.#detaching) this.onClose();
    });
  }

  /** Connect and shake hands: the token, then the offset to replay from. Rejects with the holder's reason. */
  static connect(endpoint: string, token: string, from: number): Promise<HolderLink> {
    const { promise, resolve, reject } = Promise.withResolvers<HolderLink>();
    const socket = connect({ path: endpoint });
    let head = Buffer.alloc(0);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`holder ${endpoint} did not answer in ${CONNECT_MS} ms`)); }, CONNECT_MS);
    const fail = (e: Error) => { clearTimeout(timer); socket.destroy(); reject(e); };
    const onData = (d: Buffer) => {
      head = Buffer.concat([head, d]);
      const nl = head.indexOf(0x0a);
      if (nl < 0) { if (head.length > 4096) fail(new Error("holder sent no handshake line")); return; }
      socket.off("data", onData);
      socket.pause();
      clearTimeout(timer);
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(head.subarray(0, nl).toString("utf8")); } catch { fail(new Error("holder handshake is not JSON")); return; }
      if (msg.ok !== true) { fail(new Error(`holder refused the attach: ${String(msg.error ?? "no reason")}`)); return; }
      const num = (k: string) => (typeof msg[k] === "number" ? (msg[k] as number) : 0);
      // LH-08: a holder whose spool cap dropped the bytes at `from` replays from `from` in its answer (its base, on a
      // line start); the offsets below count from there.
      const start = typeof msg.from === "number" && msg.from >= from ? msg.from : from;
      const hello: HolderHello = { base: num("base"), end: num("end"), pid: num("pid"), childPid: num("childPid"), exited: typeof msg.exited === "number" ? msg.exited : null, dropped: start - from };
      resolve(new HolderLink(socket, hello, start, head.subarray(nl + 1)));
    };
    socket.on("data", onData);
    socket.once("error", (e) => fail(e));
    socket.once("connect", () => socket.write(`${JSON.stringify({ v: 1, token, from })}\n`));
    return promise;
  }

  /** Start delivering frames (the replay first). */
  resume(): void {
    const rest = this.#pending;
    this.#pending = Buffer.alloc(0);
    if (rest.length) this.#feed(rest);
    this.socket.resume();
  }

  get closed(): boolean { return this.#closed; }
  /** Offset one past the last stdout byte delivered. */
  get offset(): number { return this.#offset; }

  #feed(d: Buffer): void {
    let buf = this.#pending.length ? Buffer.concat([this.#pending, d]) : d;
    while (buf.length >= 5) {
      const len = buf.readUInt32LE(1);
      if (buf.length < 5 + len) break;
      const kind = buf[0];
      const payload = buf.subarray(5, 5 + len);
      buf = buf.subarray(5 + len);
      if (kind === OUT) { this.#offset += payload.length; this.onStdout(payload, this.#offset); }
      else if (kind === ERR) this.onStderr(payload);
      else if (kind === EXIT) this.onExit(payload.length >= 4 ? payload.readInt32LE(0) : -1);
    }
    this.#pending = Buffer.from(buf);
  }

  #send(kind: number, payload: Buffer): void {
    if (this.#closed) return;
    const head = Buffer.alloc(5);
    head[0] = kind;
    head.writeUInt32LE(payload.length, 1);
    this.socket.write(Buffer.concat([head, payload]));
  }

  write(data: string): void { this.#send(STDIN, Buffer.from(data, "utf8")); }
  closeStdin(): void { this.#send(CLOSE_STDIN, Buffer.alloc(0)); }
  /** The holder may forget the bytes before `offset`. */
  trim(offset: number): void { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(offset)); this.#send(TRIM, b); }
  /** How long the holder keeps the agent with no engine attached. */
  keepFor(ms: number): void { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(Math.max(0, Math.floor(ms)))); this.#send(ORPHAN, b); }

  /** End the agent's whole tree and the holder. True once the holder closed the connection. */
  async kill(): Promise<boolean> {
    if (this.#closed) return true;
    // A paused socket never reports its close (the end waits for the data before it to be read).
    this.socket.resume();
    this.#send(KILL, Buffer.alloc(0));
    const timer = Promise.withResolvers<boolean>();
    const t = setTimeout(() => timer.resolve(false), KILL_MS);
    const ok = await Promise.race([this.closedPromise.then(() => true), timer.promise]);
    clearTimeout(t);
    if (!ok) this.socket.destroy();
    return ok;
  }

  /** Leave the holder running and let go of it (the engine is going away; a later engine reattaches). */
  detach(): void {
    this.#detaching = true;
    if (!this.#closed) this.socket.end();
  }
}

/** What a held lane needs to come back after the engine that started it is gone. */
export interface HeldLaneRecord {
  v: 1;
  laneId: string;
  /** The holder's own id (`<lane id>-<4 hex>`, new per agent process, so a respawn never meets the old one). */
  holderId: string;
  endpoint: string;
  token: string;
  pid: number;
  childPid: number;
  /** LH-07: the start times of `pid` and `childPid` when an engine last held a connection to this holder. */
  start: string | null;
  childStart: string | null;
  /** LH-03: the lane's channel key (its agent has it as LUCID_LANE_CHANNEL); every engine that reattaches the lane
   *  accepts its calls with it. A record without one gets no channel, and its agent's calls are refused. */
  channel: string;
  name: string;
  cwd: string;
  model: string;
  sessionId: string | null;
  canLoadSession: boolean;
  turns: number;
  transcript: LaneTurnRecord[];
  supervised: boolean;
  /** The lane's own auto switch when the record was written. A reattach never turns auto on for a lane that had
   *  it off (an ask left open at shutdown is asked again, and must reach a human). */
  autoApprove: boolean;
  remote: { approvalMs: number; offTask: boolean } | null;
  hubSessionId: string | null;
  createdAt: number;
  /** Every stdout byte before this offset was handled while the lane was idle. */
  consumed: number;
  /** The highest JSON-RPC id the engine used on this agent; a new engine starts above it. */
  lastRequestId: number;
  /** The turn in flight: its session/prompt id, the offset at which it was sent, what the user said, when, and
   *  the agent's requests already answered in it (a replay must not answer them twice). */
  inFlight: { requestId: number; offset: number; text: string; at: number; answered: (number | string)[] } | null;
}

export interface LaunchedHolder extends HolderIdentity { holderId: string; endpoint: string; token: string; channel: string; link: HolderLink }

/** The holders of this engine's data root: launching them, and the records that bring their lanes back. */
export class HolderPool {
  /** LH-03: the channel keys of the held lanes this engine runs (launched here or reattached). */
  readonly channels = new LaneChannels();

  constructor(readonly dir: string, readonly binary: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") chmodSync(dir, 0o700);
  }

  /** The pool for this engine, or null when no holder binary is available or the engine has no data root of its
   *  own. Records name processes to reattach to, so they never live in ~/.omp, which agents can write. */
  static forEngine(env: Record<string, string | undefined> = process.env): HolderPool | null {
    const bin = holderBinary(env);
    if (!bin || !env.LUCID_DATA_ROOT) return null;
    return new HolderPool(join(env.LUCID_DATA_ROOT, "lane-holders"), bin);
  }

  /** Start a holder for `laneId` running `cmd args` in `cwd` with `env` plus the lane's new channel key, and attach
   *  to it from offset 0. LH-06: the attach token goes to the holder on its stdin (one line, then end of input),
   *  never in an environment, so it is not in the holder's or the agent's process environment. */
  async launch(laneId: string, cmd: string, args: string[], cwd: string, env: Record<string, string | undefined>): Promise<LaunchedHolder> {
    const holderId = `${laneId}-${randomBytes(2).toString("hex")}`;
    if (!HOLDER_ID_RE.test(holderId)) throw new Error(`lane id "${laneId}" cannot name a holder`);
    const token = randomBytes(32).toString("hex");
    const channel = mintChannelKey();
    const child = spawn(this.binary, ["run", "--dir", this.dir, "--id", holderId, "--cwd", cwd, "--orphan-ms", String(HELD_IDLE_KEEP_MS), "--", cmd, ...args], {
      cwd, detached: true, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...env, [CHANNEL_ENV]: channel },
    });
    child.stdin!.on("error", () => { /* a holder that refused to start says why on stderr */ });
    child.stdin!.end(`${token}\n`);
    let out = "";
    let err = "";
    child.stdout!.on("data", (d) => { out += String(d); });
    child.stderr!.on("data", (d) => { err += String(d); });
    const done = Promise.withResolvers<number | null>();
    child.once("error", (e) => { err += e.message; done.resolve(null); });
    child.once("exit", (code) => done.resolve(code));
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, LAUNCH_MS);
    const code = await done.promise;
    clearTimeout(timer);
    if (code !== 0) throw new Error(`lane holder did not start: ${(err.trim() || `exit ${code}`).slice(0, 300)}`);
    let ready: { endpoint?: unknown; pid?: unknown; childPid?: unknown };
    try { ready = JSON.parse(out.trim()); } catch { throw new Error("lane holder printed no ready record"); }
    if (typeof ready.endpoint !== "string" || typeof ready.pid !== "number" || typeof ready.childPid !== "number") throw new Error("lane holder's ready record is malformed");
    const link = await HolderLink.connect(ready.endpoint, token, 0);
    this.channels.register(laneId, channel);
    // Sampled while the connection is open, so the holder (and the agent it has not reaped) are the ones it reported.
    return { holderId, endpoint: ready.endpoint, token, channel, pid: ready.pid, childPid: ready.childPid, start: processStartId(ready.pid), childStart: processStartId(ready.childPid), link };
  }

  #path(laneId: string): string { return join(this.dir, `${laneId}.lane.json`); }

  /** Owner-only, temp then rename: a crash mid-write leaves the previous record, never half a file. */
  save(rec: HeldLaneRecord): void {
    const path = this.#path(rec.laneId);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(rec), { mode: 0o600 });
    renameSync(tmp, path);
  }

  /** Forget the lane: its record, and its channel (its agent's calls are refused from now on). */
  remove(laneId: string): void {
    this.channels.forget(laneId);
    rmSync(this.#path(laneId), { force: true });
  }

  /** Remove the lane's record only while it still names `holderId` (a newer holder on the lane keeps its own). */
  removeIf(laneId: string, holderId: string): void {
    let current: unknown;
    try { current = (JSON.parse(readFileSync(this.#path(laneId), "utf8")) as { holderId?: unknown }).holderId; } catch { return; }
    if (current === holderId) this.remove(laneId);
  }

  /** Every readable record that could only have come from this pool. A record that does not parse, or whose lane
   *  id, holder id or endpoint is not one a holder of this pool would have (a pipe or socket path anywhere else, a
   *  UNC path, a lane id that is not its file's name), is skipped and left for a human (it names a process). */
  all(): HeldLaneRecord[] {
    const out: HeldLaneRecord[] = [];
    let names: string[] = [];
    try { names = readdirSync(this.dir); } catch { return out; }
    for (const n of names) {
      if (!n.endsWith(".lane.json")) continue;
      try {
        const r = JSON.parse(readFileSync(join(this.dir, n), "utf8")) as HeldLaneRecord;
        if (r?.v === 1 && `${r.laneId}.lane.json` === n && typeof r.token === "string" && this.ownsEndpoint(r.holderId, r.endpoint, r.laneId)) out.push(r);
      } catch { /* skipped */ }
    }
    return out;
  }

  /** The endpoint a holder of this pool, for this lane, would have listened on (serve.rs endpoint_for). */
  ownsEndpoint(holderId: unknown, endpoint: unknown, laneId: string): boolean {
    if (typeof holderId !== "string" || typeof endpoint !== "string") return false;
    if (!HOLDER_ID_RE.test(holderId) || !holderId.startsWith(`${laneId}-`)) return false;
    if (process.platform === "win32") return endpoint.startsWith(`\\\\.\\pipe\\lucid-holder-${holderId}-`) && /^[0-9a-f]{32}$/.test(endpoint.slice(`\\\\.\\pipe\\lucid-holder-${holderId}-`.length));
    return endpoint === join(this.dir, `${holderId}.sock`) || endpoint === join("/tmp", `lucid-holder-${process.getuid?.()}`, `${holderId}.sock`);
  }
}
