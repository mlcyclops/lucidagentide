// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// tools/netwatch.ts - a loopback / DNS / process watcher for debugging the OAuth localhost callback.
//
// omp's `auth-broker login` opens the provider in a browser, then runs a LOCAL callback server
// (e.g. http://localhost:1455/...) that catches the redirect, exchanges the code, and exits. The
// classic failure is the browser showing "localhost refused to connect" - which means one of:
//   (a) nothing ever bound the callback port (the broker died, e.g. a full stdout pipe), or
//   (b) some OTHER process already owns the port, or
//   (c) the bind happened but on a different interface / family than the browser hit.
//
// `netcat` can't tell you WHICH process owns a port, and it can't watch DNS on Windows. So this is a
// small poller built on the tools Windows already ships (netstat / tasklist / powershell DNS cache)
// plus an active TCP probe of the callback port. It prints a live diff to the screen and appends a
// timestamped log. PURE diagnostics - it never binds, blocks, or changes anything.
//
// Usage (Bun):
//   bun tools/netwatch.ts                  # watch loopback + probe :1455, 1s interval
//   bun tools/netwatch.ts --port 1455,8976 # probe/highlight these callback ports
//   bun tools/netwatch.ts --dns            # also diff the DNS resolver cache
//   bun tools/netwatch.ts --all            # every connection, not just loopback
//   bun tools/netwatch.ts --interval 500   # poll every 500ms
//   bun tools/netwatch.ts --log nw.log     # where to append (default ./netwatch.log)
//   bun tools/netwatch.ts --no-color
//
// Then click "Connect via OAuth" in the app and watch: you want to see a LISTENING row appear on the
// callback port owned by `omp` (or node/bun), followed by an inbound ESTABLISHED row when the browser
// hits it. If the probe stays CLOSED the whole time, the broker never bound - look at its stderr. If a
// LISTENING row appears under a DIFFERENT process name, that process is squatting your callback port.

import { appendFileSync } from "node:fs";
import { Socket } from "node:net";

// ---------- args ----------
const argv = process.argv.slice(2);
function flag(name: string): boolean { return argv.includes("--" + name); }
function opt(name: string, def: string): string {
  const i = argv.indexOf("--" + name);
  return i >= 0 && i + 1 < argv.length ? (argv[i + 1] ?? def) : def;
}
const PORTS = opt("port", "1455").split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => n > 0);
const INTERVAL = Math.max(200, parseInt(opt("interval", "1000"), 10) || 1000);
const LOG_PATH = opt("log", "netwatch.log");
const WATCH_DNS = flag("dns");
const SHOW_ALL = flag("all");
const NO_COLOR = flag("no-color") || !process.stdout.isTTY;

// ---------- color ----------
const c = (code: string) => (s: string) => (NO_COLOR ? s : `\x1b[${code}m${s}\x1b[0m`);
const dim = c("2"), red = c("31"), grn = c("32"), ylw = c("33"), cyn = c("36"), bold = c("1");

// ---------- output (screen + log) ----------
function ts(): string { return new Date().toISOString().slice(11, 23); }
function emit(line: string): void {
  console.log(line);
  // Strip ANSI before it hits the log file.
  try { appendFileSync(LOG_PATH, `${new Date().toISOString()} ${line.replace(/\x1b\[[0-9;]*m/g, "")}\n`); }
  catch { /* logging is best-effort; never let it kill the watch */ }
}

// ---------- shelling out to Windows tools ----------
function run(cmd: string[]): string {
  try {
    const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
    return p.stdout.toString();
  } catch { return ""; }
}

// PID -> "name.exe", refreshed every few ticks (tasklist is the slow call).
let pidNames = new Map<string, string>();
function refreshPidNames(): void {
  const out = run(["tasklist", "/fo", "csv", "/nh"]);
  const m = new Map<string, string>();
  for (const line of out.split(/\r?\n/)) {
    // "name.exe","1234","Console","1","12,345 K"
    const cols = line.match(/"([^"]*)"/g);
    if (!cols || cols.length < 2) continue;
    const name = (cols[0] ?? "").slice(1, -1);
    const pid = (cols[1] ?? "").slice(1, -1);
    if (pid) m.set(pid, name);
  }
  if (m.size) pidNames = m;
}
function procFor(pid: string): string { return pidNames.get(pid) ?? (pid === "0" ? "System" : `pid ${pid}`); }

// ---------- netstat snapshot ----------
interface Conn { proto: string; local: string; foreign: string; state: string; pid: string; }
function portOf(addr: string): number {
  const i = addr.lastIndexOf(":");
  return i >= 0 ? parseInt(addr.slice(i + 1), 10) : NaN;
}
function isLoopback(addr: string): boolean {
  return addr.startsWith("127.") || addr.startsWith("[::1]") || addr.toLowerCase().includes("127.0.0.1");
}
function snapshot(): Map<string, Conn> {
  const out = run(["netstat", "-ano"]);
  const map = new Map<string, Conn>();
  for (const raw of out.split(/\r?\n/)) {
    const t = raw.trim().split(/\s+/);
    if (t[0] !== "TCP" && t[0] !== "UDP") continue;
    const conn: Conn = t[0] === "TCP"
      ? { proto: t[0], local: t[1] ?? "", foreign: t[2] ?? "", state: t[3] ?? "", pid: t[4] ?? "" }
      : { proto: t[0], local: t[1] ?? "", foreign: t[2] ?? "", state: "", pid: t[3] ?? "" };
    // Keep loopback traffic AND every LISTENING socket - a callback server may bind 0.0.0.0 / [::]
    // (all interfaces), not just 127.0.0.1, so a loopback-only filter would miss it. --all keeps everything.
    if (!SHOW_ALL && !isLoopback(conn.local) && !isLoopback(conn.foreign) && conn.state !== "LISTENING") continue;
    const key = `${conn.proto}|${conn.local}|${conn.foreign}|${conn.state}|${conn.pid}`;
    map.set(key, conn);
  }
  return map;
}
function fmtConn(conn: Conn): string {
  const onTarget = PORTS.includes(portOf(conn.local)) || PORTS.includes(portOf(conn.foreign));
  const who = procFor(conn.pid);
  const left = `${conn.proto.padEnd(3)} ${conn.local.padEnd(24)} ${conn.foreign.padEnd(24)} ${conn.state.padEnd(12)}`;
  const line = `${left} ${who}`;
  return onTarget ? bold(ylw("★ " + line)) : line;
}

// ---------- active TCP probe (the "netcat -z" part) ----------
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

// ---------- DNS resolver cache diff (Windows, opt-in) ----------
let dnsSeen = new Set<string>();
function pollDns(): void {
  const out = run(["powershell", "-NoProfile", "-Command",
    "Get-DnsClientCache | Select-Object -ExpandProperty Entry -Unique"]);
  for (const name of out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
    if (!dnsSeen.has(name)) { dnsSeen.add(name); emit(`${dim(ts())} ${cyn("dns")}  ${name}`); }
  }
}

// ---------- main loop ----------
const probeState = new Map<number, string>();
let tick = 0;
let idleTicks = 0;
const HEARTBEAT_EVERY = Math.max(1, Math.round(5000 / INTERVAL)); // an idle status line ~every 5s

emit(bold(cyn("netwatch")) + dim(`  ports=${PORTS.join(",")}  interval=${INTERVAL}ms  scope=${SHOW_ALL ? "all" : "loopback+listeners"}  dns=${WATCH_DNS}  log=${LOG_PATH}`));

// Capture a SILENT baseline of what's already open, so once you click Connect you only see what CHANGES
// (otherwise the first tick dumps every existing socket and buries the one that matters).
refreshPidNames();
let prev = snapshot();
emit(dim(`baseline: ${prev.size} sockets already open - now showing only changes.`));
emit(bold("Click 'Connect via OAuth' now.") + dim(" A new LISTENING row = the callback server. Then an inbound connection to it."));
emit(dim("legend: " + grn("+ opened") + "  " + red("- closed") + "  " + ylw("★ watched port") + "  " + bold(grn("<- NEW LISTENER")) + dim(" = callback candidate")));

while (true) {
  // PID table is the expensive call; refresh it every 4th tick (process churn is slower than sockets).
  if (tick % 4 === 0) refreshPidNames();

  let events = 0;

  // 1) active probe of each callback port
  for (const port of PORTS) {
    const state = await probe(port);
    if (probeState.get(port) !== state) {
      probeState.set(port, state);
      const tag = state === "open" ? grn("OPEN  ") : state === "closed" ? red("CLOSED") : ylw("TIMEOUT");
      emit(`${dim(ts())} ${bold("probe")} 127.0.0.1:${port} -> ${tag}`);
      events++;
    }
  }

  // 2) socket diff (loopback + any listener). A brand-new LISTENING socket is the prime suspect: that's
  // what a callback server creates the instant the broker starts.
  const cur = snapshot();
  for (const [key, conn] of cur) if (!prev.has(key)) {
    const note = conn.state === "LISTENING" ? "  " + bold(grn("<- NEW LISTENER (callback candidate)")) : "";
    emit(`${dim(ts())} ${grn("+")} ${fmtConn(conn)}${note}`);
    events++;
  }
  for (const [key, conn] of prev) if (!cur.has(key)) { emit(`${dim(ts())} ${red("-")} ${fmtConn(conn)}`); events++; }
  prev = cur;

  // 3) DNS cache diff (opt-in)
  if (WATCH_DNS && tick % 2 === 0) pollDns();

  // 4) idle heartbeat so the screen always moves (screen only - keeps the log clean).
  if (events === 0) {
    if (++idleTicks % HEARTBEAT_EVERY === 0) {
      const probes = PORTS.map((p) => `:${p}=${probeState.get(p) ?? "?"}`).join(" ");
      console.log(dim(`${ts()} idle - probe ${probes} | ${cur.size} sockets | waiting for the OAuth click...`));
    }
  } else { idleTicks = 0; }

  tick++;
  await Bun.sleep(INTERVAL);
}
