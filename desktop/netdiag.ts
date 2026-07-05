// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/netdiag.ts - the in-app network diagnostics watcher (developer mode only).
//
// Why this exists: omp's `auth-broker login` opens a LOCAL loopback callback server (OpenAI's Codex
// broker uses a fixed :1455; others vary) to catch the OAuth redirect. When that fails the browser
// shows "localhost refused to connect" - meaning nothing bound the port, something else squats it, or
// the broker died before binding. A terminal tool you start by hand keeps missing the exact window
// (the bind can be brief, and OTP entry stretches the flow to 30-45s). So this runs CONTINUOUSLY in
// the backend while developer mode is on, recording a rolling event log of loopback listeners /
// connections / DNS / port-probes. By the time the Logs panel is opened, the OAuth window is already
// captured.
//
// PURE DIAGNOSTICS: it never binds, blocks, or mutates anything - it shells out to the read-only OS
// tools the platform already ships (netstat/tasklist + DNS cache on Windows, lsof on macOS/Linux) and
// makes a throwaway TCP connect to probe the callback port. The pure parse/diff helpers are unit-tested
// in netdiag.test.ts; the OS calls and the timer are the only impure parts.

import { Socket } from "node:net";

export interface NetSocket {
  proto: string; local: string; foreign: string; state: string;
  pid: string; proc: string; port: number; loopback: boolean;
}
export interface NetEvent {
  at: number; kind: "listener" | "open" | "close" | "probe";
  text: string; port?: number; proc?: string; candidate?: boolean;
}
export interface NetProbe { port: number; state: "open" | "closed" | "timeout"; }
export interface NetDiagView {
  watching: boolean; platform: string; supported: boolean;
  ports: number[]; probes: NetProbe[];
  listeners: NetSocket[]; connections: NetSocket[];
  dns: string[]; events: NetEvent[]; startedAt: number | null;
}

const WIN = process.platform === "win32";
const UNIX = process.platform === "darwin" || process.platform === "linux";
// Known fixed callback ports for OAuth providers. Each is actively probed; ephemeral ports (e.g. xAI)
// are still caught by the socket diff the instant they appear.
//   :1455  — OpenAI Codex
//   :54545 — Anthropic Claude
//   :8085  — Google Gemini CLI (Code Assist)
export const DEFAULT_CALLBACK_PORTS = [1455, 54545, 8085];

// ───────────────────────── pure parsing helpers (unit-tested, no OS) ─────────────────────────
export function portOf(addr: string): number {
  const i = addr.lastIndexOf(":");
  const n = i >= 0 ? parseInt(addr.slice(i + 1), 10) : NaN;
  return Number.isFinite(n) ? n : NaN;
}
export function isLoopback(addr: string): boolean {
  const a = addr.toLowerCase();
  return a.startsWith("127.") || a.startsWith("[::1]") || a.includes("127.0.0.1") || a.includes("[::1]");
}
/** Parse one `netstat -ano` row (Windows). null for headers / non TCP-UDP lines. */
export function parseNetstatLine(raw: string, procFor: (pid: string) => string = (p) => `pid ${p}`): NetSocket | null {
  const t = raw.trim().split(/\s+/);
  if (t[0] !== "TCP" && t[0] !== "UDP") return null;
  const tcp = t[0] === "TCP";
  const local = t[1] ?? "", foreign = t[2] ?? "";
  const state = tcp ? (t[3] ?? "") : "";
  const pid = tcp ? (t[4] ?? "") : (t[3] ?? "");
  return { proto: t[0], local, foreign, state, pid, proc: procFor(pid), port: portOf(local), loopback: isLoopback(local) || isLoopback(foreign) };
}
/** Parse one `lsof -nP -iTCP` row (macOS / Linux). null for the header / malformed lines. */
export function parseLsofLine(raw: string): NetSocket | null {
  const t = raw.trim().split(/\s+/);
  if (t.length < 9 || t[0] === "COMMAND") return null;
  const proc = t[0], pid = t[1], addr = t[8];
  if (!proc || !pid || !addr) return null; // length-checked above; this narrows for noUncheckedIndexedAccess
  const sm = raw.match(/\(([A-Z_]+)\)/);
  const state = sm ? (sm[1] === "LISTEN" ? "LISTENING" : (sm[1] ?? "")) : "";
  let local = addr, foreign = "";
  if (addr.includes("->")) { const parts = addr.split("->"); local = parts[0] ?? addr; foreign = parts[1] ?? ""; }
  return { proto: "TCP", local, foreign, state, pid, proc, port: portOf(local), loopback: isLoopback(local) || isLoopback(foreign) };
}
export function parseTasklistCsv(out: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of out.split(/\r?\n/)) {
    const cols = line.match(/"([^"]*)"/g);
    if (!cols || cols.length < 2) continue;
    const c0 = cols[0], c1 = cols[1];
    if (c0 === undefined || c1 === undefined) continue; // length-checked; narrows for noUncheckedIndexedAccess
    const name = c0.slice(1, -1), pid = c1.slice(1, -1);
    if (pid) m.set(pid, name);
  }
  return m;
}
export function socketKey(s: NetSocket): string { return `${s.proto}|${s.local}|${s.foreign}|${s.state}|${s.pid}`; }
/** Diff two socket snapshots into events. A new LISTENING socket on a watched/loopback port is a
 *  callback CANDIDATE - the prime suspect for "did the OAuth callback server actually bind?". */
export function diffSockets(prev: Map<string, NetSocket>, cur: Map<string, NetSocket>, at: number, ports: number[]): NetEvent[] {
  const ev: NetEvent[] = [];
  for (const [k, s] of cur) if (!prev.has(k)) {
    const listener = s.state === "LISTENING";
    const candidate = listener && (ports.includes(s.port) || s.loopback);
    ev.push({ at, kind: listener ? "listener" : "open", text: `${s.proto} ${s.local} ${s.foreign} ${s.state}`.trim(), port: s.port, proc: s.proc, candidate });
  }
  for (const [k, s] of prev) if (!cur.has(k))
    ev.push({ at, kind: "close", text: `${s.proto} ${s.local} ${s.foreign} ${s.state}`.trim(), port: s.port, proc: s.proc });
  return ev;
}
/** Keep loopback traffic AND every listener (a callback server may bind 0.0.0.0 / [::], not just
 *  127.0.0.1, so a loopback-only filter would miss it). Drops everything else to keep the diff focused. */
export function relevant(s: NetSocket): boolean { return s.loopback || s.state === "LISTENING"; }

// ───────────────────────────────── OS capture (impure) ──────────────────────────────────────
function sh(cmd: string[]): string {
  try { return Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" }).stdout.toString(); }
  catch { return ""; }
}
let pidNames = new Map<string, string>();
function procFor(pid: string): string { return pidNames.get(pid) ?? (pid === "0" ? "System" : `pid ${pid}`); }

function capture(): Map<string, NetSocket> {
  const map = new Map<string, NetSocket>();
  if (WIN) {
    for (const raw of sh(["netstat", "-ano"]).split(/\r?\n/)) {
      const s = parseNetstatLine(raw, procFor);
      if (s && relevant(s)) map.set(socketKey(s), s);
    }
  } else if (UNIX) {
    for (const raw of sh(["lsof", "-nP", "-iTCP"]).split(/\r?\n/)) {
      const s = parseLsofLine(raw);
      if (s && relevant(s)) map.set(socketKey(s), s);
    }
  }
  return map;
}

/** Throwaway TCP connect - the "is anything listening on the callback port?" probe (like `nc -z`). */
function probe(port: number, host = "127.0.0.1", timeoutMs = 600): Promise<"open" | "closed" | "timeout"> {
  return new Promise((resolve) => {
    const s = new Socket();
    let done = false;
    const finish = (r: "open" | "closed" | "timeout") => { if (done) return; done = true; s.destroy(); resolve(r); };
    s.setTimeout(timeoutMs);
    s.once("connect", () => finish("open"));
    s.once("timeout", () => finish("timeout"));
    s.once("error", () => finish("closed")); // ECONNREFUSED -> nothing is listening
    s.connect(port, host);
  });
}

// ───────────────────────────────── background watcher ───────────────────────────────────────
const MAX_EVENTS = 400;
let timer: ReturnType<typeof setInterval> | null = null;
let prevMap = new Map<string, NetSocket>();
let events: NetEvent[] = [];
let probes: NetProbe[] = [];
let dns: string[] = [];
let dnsSeen = new Set<string>();
let watchPorts: number[] = [...DEFAULT_CALLBACK_PORTS];
let startedAt: number | null = null;
let ticking = false;
let tick = 0;

async function runTick(): Promise<void> {
  if (ticking) return; // never overlap; netstat + powershell can be slow
  ticking = true;
  try {
    const at = Date.now();
    if (WIN && tick % 3 === 0) pidNames = parseTasklistCsv(sh(["tasklist", "/fo", "csv", "/nh"]));

    // 1) probe each callback port; record state TRANSITIONS as events
    const ps: NetProbe[] = [];
    for (const port of watchPorts) {
      const st = await probe(port);
      const prevSt = probes.find((x) => x.port === port)?.state;
      if (prevSt && prevSt !== st) events.push({ at, kind: "probe", text: `probe 127.0.0.1:${port} ${prevSt} -> ${st}`, port });
      ps.push({ port, state: st });
    }
    probes = ps;

    // 2) socket diff (tick 0 is a silent baseline so we don't emit "everything is new")
    const cur = capture();
    if (tick > 0) events.push(...diffSockets(prevMap, cur, at, watchPorts));
    prevMap = cur;

    // 3) DNS resolver cache (Windows; new names only), kept gentle - every ~6s
    if (WIN && tick % 3 === 0) {
      for (const n of sh(["powershell", "-NoProfile", "-Command", "Get-DnsClientCache | Select-Object -ExpandProperty Entry -Unique"]).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
        if (!dnsSeen.has(n)) { dnsSeen.add(n); dns.push(n); }
      }
      if (dns.length > 100) dns = dns.slice(-100);
    }

    if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS);
    tick++;
  } finally { ticking = false; }
}

export function netdiagSupported(): boolean { return WIN || UNIX; }

/** Start (or retarget) the background watcher. Idempotent: a second call with new ports just widens
 *  the probe set without resetting the event history. */
export function startNetdiagWatch(ports?: number[]): void {
  if (ports && ports.length) watchPorts = Array.from(new Set([...DEFAULT_CALLBACK_PORTS, ...ports]));
  if (timer || !netdiagSupported()) return;
  startedAt = Date.now(); tick = 0; prevMap = new Map(); events = []; dns = []; dnsSeen = new Set(); probes = [];
  void runTick(); // prime the baseline immediately so the first interval tick diffs against reality
  timer = setInterval(() => { void runTick(); }, 2000);
  (timer as { unref?: () => void } | null)?.unref?.(); // don't keep the process alive on its own
}
export function stopNetdiagWatch(): void { if (timer) { clearInterval(timer); timer = null; } startedAt = null; }
/** Start the watcher if it isn't already running - called on each /api/dev read so it's live by the
 *  time the Logs panel (or a boot-time loadDev()) first asks for diagnostics. */
export function ensureNetdiagWatch(ports?: number[]): void { if (!timer) startNetdiagWatch(ports); }

export function netdiagView(): NetDiagView {
  const all = [...prevMap.values()];
  return {
    watching: !!timer, platform: process.platform, supported: netdiagSupported(),
    ports: watchPorts, probes,
    listeners: all.filter((s) => s.state === "LISTENING").sort((a, b) => a.port - b.port),
    connections: all.filter((s) => s.state !== "LISTENING" && s.proto === "TCP"),
    dns, events: events.slice(-200), startedAt,
  };
}
