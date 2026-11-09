// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/lane_holder.ts - P-HOLDER.1 (ADR-0528): the engine's side of `lucid-holder` (native/lucid-holder).
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

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { homedir } from "node:os";
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

export interface HolderHello { base: number; end: number; pid: number; childPid: number; exited: number | null }

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
      const hello: HolderHello = { base: num("base"), end: num("end"), pid: num("pid"), childPid: num("childPid"), exited: typeof msg.exited === "number" ? msg.exited : null };
      resolve(new HolderLink(socket, hello, from, head.subarray(nl + 1)));
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
  name: string;
  cwd: string;
  model: string;
  sessionId: string | null;
  canLoadSession: boolean;
  turns: number;
  transcript: LaneTurnRecord[];
  supervised: boolean;
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

export interface LaunchedHolder { holderId: string; endpoint: string; token: string; pid: number; childPid: number; link: HolderLink }

/** The holders of this engine's data root: launching them, and the records that bring their lanes back. */
export class HolderPool {
  constructor(readonly dir: string, readonly binary: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") chmodSync(dir, 0o700);
  }

  /** The pool for this engine, or null when no holder binary is available. */
  static forEngine(env: Record<string, string | undefined> = process.env): HolderPool | null {
    const bin = holderBinary(env);
    if (!bin) return null;
    return new HolderPool(join(env.LUCID_DATA_ROOT || join(homedir(), ".omp"), "lane-holders"), bin);
  }

  /** Start a holder for `laneId` running `cmd args` in `cwd` with exactly `env`, and attach to it from offset 0. */
  async launch(laneId: string, cmd: string, args: string[], cwd: string, env: Record<string, string | undefined>): Promise<LaunchedHolder> {
    const holderId = `${laneId}-${randomBytes(2).toString("hex")}`;
    if (!HOLDER_ID_RE.test(holderId)) throw new Error(`lane id "${laneId}" cannot name a holder`);
    const token = randomBytes(32).toString("hex");
    const child = spawn(this.binary, ["run", "--dir", this.dir, "--id", holderId, "--cwd", cwd, "--orphan-ms", String(HELD_IDLE_KEEP_MS), "--", cmd, ...args], {
      cwd, detached: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...env, LUCID_HOLDER_TOKEN: token },
    });
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
    return { holderId, endpoint: ready.endpoint, token, pid: ready.pid, childPid: ready.childPid, link };
  }

  #path(laneId: string): string { return join(this.dir, `${laneId}.lane.json`); }

  /** Owner-only, temp then rename: a crash mid-write leaves the previous record, never half a file. */
  save(rec: HeldLaneRecord): void {
    const path = this.#path(rec.laneId);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(rec), { mode: 0o600 });
    renameSync(tmp, path);
  }

  remove(laneId: string): void { rmSync(this.#path(laneId), { force: true }); }

  /** Every readable record. A record that does not parse is skipped and left for a human (it names a process). */
  all(): HeldLaneRecord[] {
    const out: HeldLaneRecord[] = [];
    let names: string[] = [];
    try { names = readdirSync(this.dir); } catch { return out; }
    for (const n of names) {
      if (!n.endsWith(".lane.json")) continue;
      try {
        const r = JSON.parse(readFileSync(join(this.dir, n), "utf8")) as HeldLaneRecord;
        if (r?.v === 1 && typeof r.laneId === "string" && typeof r.endpoint === "string" && typeof r.token === "string") out.push(r);
      } catch { /* skipped */ }
    }
    return out;
  }
}
