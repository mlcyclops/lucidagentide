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
//
// Handshake v2: the token never crosses the endpoint. Whoever answers on it (the holder, or a process that created
// the name after the holder was gone) first proves it holds the token over a fresh nonce of the engine's; only then
// does the engine prove itself over the holder's nonce and name the offset to replay from. A squatter learns
// nothing it could use, and gets neither the replay nor the user's prompts.

import { spawn, spawnSync } from "node:child_process";
import { dlopen, FFIType, ptr, type Library } from "bun:ffi";
import { hmacSha256, randomBytes } from "../harness/crypto/fips_crypto.ts";
import { CHANNEL_ENV, mintChannelKey } from "../harness/omp/engine_channel.ts";
import { LaneChannels } from "./lane_channel.ts";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { tokenValid } from "./origin_guard.ts";
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
/** The handshake version this engine speaks (proto.rs HANDSHAKE). A holder that speaks another is refused. */
export const HANDSHAKE = 2;
const NONCE_RE = /^[0-9a-f]{32}$/;
/** The holder sends stdout and stderr in chunks of at most 64 KiB (its stderr tail is 64 KiB too). A frame that
 *  claims more is a broken or hostile peer: the connection is dropped rather than buffered. */
export const MAX_FRAME = 1024 * 1024;

/** The holder binary this engine runs, or null when it is not built or shipped (lanes are then the engine's own
 *  children, as before P-HOLDER.1). LUCID_HOLDER_BIN names one explicitly (tests, a local build). */
export function holderBinary(env: Record<string, string | undefined> = process.env): string | null {
  const exe = process.platform === "win32" ? "lucid-holder.exe" : "lucid-holder";
  const candidates = [env.LUCID_HOLDER_BIN, repoAsset("bin", exe), repoAsset("native", "lucid-holder", "target", "release", exe)];
  for (const c of candidates) if (c && existsSync(c)) return c;
  return null;
}

/** What one side of the handshake proves with (proto.rs `proof`): HMAC-SHA256 keyed with the attach token over
 *  `lucid-holder/v2 <role> <nonce>`, in hex. The holder proves over the engine's nonce, the engine over the holder's;
 *  the role keeps either proof from being reflected as the other. */
export function holderProof(token: string, role: "holder" | "engine", nonce: string): string {
  return hmacSha256(Buffer.from(token, "utf8"), Buffer.from(`lucid-holder/v2 ${role} ${nonce}`, "utf8")).toString("hex");
}

const KERNEL32 = {
  OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.i64 },
  GetProcessTimes: { args: [FFIType.i64, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  GetExitCodeProcess: { args: [FFIType.i64, FFIType.ptr], returns: FFIType.i32 },
  CloseHandle: { args: [FFIType.i64], returns: FFIType.i32 },
} as const;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const STILL_ACTIVE = 259;
let k32: Library<typeof KERNEL32> | null = null;

/** Windows: the creation time of a running process (a FILETIME, 100 ns ticks since 1601), or null when no running
 *  process has the pid or it cannot be opened. */
function windowsCreationTime(pid: number): string | null {
  try {
    k32 ??= dlopen("kernel32.dll", KERNEL32);
    const sym = k32.symbols;
    const h = BigInt(sym.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid));
    if (h === 0n) return null;
    try {
      // An exited process whose handle someone still holds keeps its pid and its times; it is not running.
      const code = new Uint32Array(1);
      if (!sym.GetExitCodeProcess(h, ptr(code)) || code[0] !== STILL_ACTIVE) return null;
      const times = new BigUint64Array(4); // creation, exit, kernel, user
      if (!sym.GetProcessTimes(h, ptr(times), ptr(times, 8), ptr(times, 16), ptr(times, 24))) return null;
      return String(times[0]);
    } finally { sym.CloseHandle(h); }
  } catch { return null; }
}

/** LH-07: what tells a process apart from a later one that got the same pid: its start time (Linux: field 22 of
 *  /proc/<pid>/stat, clock ticks since boot; macOS: `ps -o lstart=`; Windows: its creation time). Null when the
 *  process is gone or its start cannot be read. */
export function processStartId(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === "win32") return windowsCreationTime(pid);
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

/** The identity of the holder an authenticated connection just reported, sampled while that connection is open (so
 *  the holder, and the agent it has not reaped, are the processes it reported). Windows needs only the holder's:
 *  its job object ends the agent's tree, and no group is signaled. */
export function holderIdentity(pid: number, childPid: number): HolderIdentity {
  return { pid, childPid, start: processStartId(pid), childStart: process.platform === "win32" ? null : processStartId(childPid) };
}

export interface EndHolderDeps {
  platform: NodeJS.Platform;
  startOf: (pid: number) => string | null;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  /** Whether any process has this pid (one owned by another account counts). */
  exists: (pid: number) => boolean;
}

function pidExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return e instanceof Error && "code" in e && e.code === "EPERM"; }
}

const END_HOLDER_DEPS: EndHolderDeps = { platform: process.platform, startOf: processStartId, kill: (pid, signal) => { process.kill(pid, signal); }, exists: pidExists };

/** Whether the holder a record names still runs. With a recorded start time the pid must still name that process
 *  (a pid handed to another process means the holder is gone); without one, or while the start cannot be read, any
 *  process with the pid counts (the cautious answer: its record is kept). */
export function holderProcessAlive(pid: number, start: string | null, deps: Pick<EndHolderDeps, "startOf" | "exists"> = END_HOLDER_DEPS): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const now = start === null ? null : deps.startOf(pid);
  return now !== null ? now === start : deps.exists(pid);
}

/** LH-05: the last resort when a holder did not confirm a KILL. Ending the holder ends the agent's tree on Windows
 *  (its job object kills on close). Elsewhere the agent leads its own process group, signaled first, while the
 *  holder is alive: the holder never reaps the agent before its own group kill (serve.rs), so a live holder keeps
 *  the agent's pid, and with it the group id, from being reused.
 *  LH-07: a pid is signaled only when it still names the process the handshake reported (same start time, on
 *  Windows the same creation time). A pid whose identity cannot be read or differs is left alone.
 *  Returns true when nothing of the holder runs as far as can be told (it was ended, or its pid now names another
 *  process or none), false when it may still run (its identity could not be read and its pid is alive): the caller
 *  keeps its record then, so nothing is started over it. */
export function endHolderProcess(h: HolderIdentity, deps: EndHolderDeps = END_HOLDER_DEPS): boolean {
  const send = (pid: number, signal: NodeJS.Signals) => { try { deps.kill(pid, signal); } catch { /* gone */ } };
  const same = (pid: number, start: string | null) => Number.isInteger(pid) && pid > 1 && start !== null && deps.startOf(pid) === start;
  if (deps.platform !== "win32" && same(h.childPid, h.childStart)) send(-h.childPid, "SIGKILL");
  if (same(h.pid, h.start)) { send(h.pid, "SIGKILL"); return true; }
  return !holderProcessAlive(h.pid, h.start, deps);
}

/** POSIX: a socket is connected to only in a folder that is a real folder (not a link) of this account with mode
 *  0700, and only when the socket is this account's. Anything else (a /tmp/lucid-holder-<uid> another account made
 *  first, a link) could put someone else's listener there. Null when it is fine (always on Windows, whose pipes are
 *  answered through the handshake proof alone). */
export function socketFolderProblem(endpoint: string, platform: NodeJS.Platform = process.platform, uid: number | undefined = process.getuid?.()): string | null {
  if (platform === "win32") return null;
  const folder = dirname(endpoint);
  try {
    const dir = lstatSync(folder);
    if (!dir.isDirectory() || dir.uid !== uid || (dir.mode & 0o777) !== 0o700) return `${folder} is not a 0700 folder of this account; the holder endpoint in it is not trusted`;
    const sock = lstatSync(endpoint);
    if (!sock.isSocket() || sock.uid !== uid) return `${endpoint} is not a socket of this account`;
  } catch (e) {
    return `holder endpoint ${endpoint} cannot be checked (${e instanceof Error ? e.message : String(e)})`;
  }
  return null;
}

/** `dropped` (LH-08): bytes between the offset asked for and where the replay starts, because the spool reached its
 *  cap during the turn and let its oldest output go (0 when nothing was dropped). */
export interface HolderHello { base: number; end: number; pid: number; childPid: number; exited: number | null; dropped: number }

/** Why a holder refused, in words: a holder that speaks another handshake is named as such. */
function refusal(msg: Record<string, unknown>): string {
  if (msg.v !== HANDSHAKE) return `it speaks handshake v${String(msg.v)} and this engine v${HANDSHAKE} (a lucid-holder from another build; it ends by its own keep-for)`;
  return String(msg.error ?? "no reason");
}

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
  readonly #endpoint: string;
  readonly #token: string;
  readonly closedPromise: Promise<void>;

  private constructor(private readonly socket: Socket, endpoint: string, token: string, readonly hello: HolderHello, from: number, rest: Buffer) {
    this.#endpoint = endpoint;
    this.#token = token;
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

  /** Connect and shake hands (handshake v2): this engine's nonce; the holder's proof over it and a nonce of its own;
   *  this engine's proof over that and the offset to replay from; the holder's hello. The token is never sent.
   *  Rejects with the holder's reason ("holder refused the attach: ..."), or when whoever answered could not prove
   *  it holds the token. */
  static connect(endpoint: string, token: string, from: number): Promise<HolderLink> {
    const unsafe = socketFolderProblem(endpoint);
    if (unsafe) return Promise.reject(new Error(unsafe));
    const { promise, resolve, reject } = Promise.withResolvers<HolderLink>();
    const socket = connect({ path: endpoint });
    const ours = randomBytes(16).toString("hex");
    let theirs: string | null = null;
    let head = Buffer.alloc(0);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`holder ${endpoint} did not answer in ${CONNECT_MS} ms`)); }, CONNECT_MS);
    const fail = (e: Error) => { clearTimeout(timer); socket.destroy(); reject(e); };
    const onData = (d: Buffer) => {
      head = Buffer.concat([head, d]);
      for (;;) {
        const nl = head.indexOf(0x0a);
        if (nl < 0) { if (head.length > 4096) fail(new Error("holder sent no handshake line")); return; }
        let msg: Record<string, unknown>;
        try { msg = JSON.parse(head.subarray(0, nl).toString("utf8")); } catch { fail(new Error("holder handshake is not JSON")); return; }
        head = head.subarray(nl + 1);
        if (msg.ok === false) { fail(new Error(`holder refused the attach: ${refusal(msg)}`)); return; }
        if (theirs === null) {
          const proof = typeof msg.proof === "string" ? msg.proof : null;
          if (msg.v !== HANDSHAKE || typeof msg.nonce !== "string" || !NONCE_RE.test(msg.nonce) || !tokenValid(proof, holderProof(token, "holder", ours))) {
            fail(new Error(`${endpoint} did not prove it is this lane's holder`));
            return;
          }
          theirs = msg.nonce;
          socket.write(`${JSON.stringify({ v: HANDSHAKE, proof: holderProof(token, "engine", theirs), from })}\n`);
          continue;
        }
        if (msg.ok !== true) { fail(new Error("holder refused the attach: no reason")); return; }
        socket.off("data", onData);
        socket.pause();
        clearTimeout(timer);
        const num = (k: string) => { const v = msg[k]; return typeof v === "number" ? v : 0; };
        // LH-08: a holder whose spool cap dropped the bytes at `from` replays from `from` in its answer (its base, on a
        // line start); the offsets below count from there.
        const start = typeof msg.from === "number" && msg.from >= from ? msg.from : from;
        const hello: HolderHello = { base: num("base"), end: num("end"), pid: num("pid"), childPid: num("childPid"), exited: typeof msg.exited === "number" ? msg.exited : null, dropped: start - from };
        resolve(new HolderLink(socket, endpoint, token, hello, start, head));
        return;
      }
    };
    socket.on("data", onData);
    socket.once("error", (e) => fail(e));
    socket.once("connect", () => socket.write(`${JSON.stringify({ v: HANDSHAKE, nonce: ours })}\n`));
    return promise;
  }

  /** A new connection to the same holder, replaying from `from` (the holder dropped this one). */
  reconnect(from: number): Promise<HolderLink> {
    return HolderLink.connect(this.#endpoint, this.#token, from);
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
      if (len > MAX_FRAME) {
        this.#pending = Buffer.alloc(0);
        this.socket.destroy();
        return;
      }
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

  /** End the agent's whole tree and the holder. True once the holder closed the connection the KILL went on. A link
   *  the holder already closed (it dropped this client, or it exited) sends the KILL on a new connection; a holder
   *  that cannot be reached is not confirmed ended (false), so its record is kept. */
  async kill(): Promise<boolean> {
    if (this.#closed) {
      let again: HolderLink;
      try { again = await this.reconnect(this.#offset); } catch { return false; }
      return again.kill();
    }
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
  /** LH-07: the start times (Windows: the holder's creation time) of `pid` and `childPid` when an engine last held
   *  a connection to this holder. */
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
    // The holder's start (on Windows its creation time) is recorded now, so no later kill can reach another process.
    return { holderId, endpoint: ready.endpoint, token, channel, ...holderIdentity(link.hello.pid, link.hello.childPid), link };
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
    try { current = JSON.parse(readFileSync(this.#path(laneId), "utf8")); } catch { return; }
    if (current && typeof current === "object" && "holderId" in current && current.holderId === holderId) this.remove(laneId);
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
