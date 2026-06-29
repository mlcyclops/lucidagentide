// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_netdiag_1.ts
//
// Increment P-NETDIAG.1 (ADR-0090) — in-app network diagnostics for the OAuth localhost callback.
// Proves, against canned OS output (deterministic; no live sockets), that:
//   (1) the Windows `netstat -ano` parser yields loopback listeners with the resolved process name;
//   (2) the macOS/Linux `lsof` parser reaches the same NetSocket shape (cross-platform parity);
//   (3) `relevant()` keeps loopback traffic AND every listener — including a 0.0.0.0 / all-interface
//       bind (the exact case a loopback-only filter missed, which is why "nothing happened" before);
//   (4) the snapshot DIFF flags a brand-new LISTENING socket on the callback port as a CANDIDATE —
//       the single most useful signal: "did the OAuth callback server actually bind, and who owns it?";
//   (5) it stays pure diagnostics — the view is read-only and never emits an allow/block verdict.

import {
  parseNetstatLine, parseLsofLine, relevant, diffSockets, socketKey,
  netdiagView, netdiagSupported, DEFAULT_CALLBACK_PORTS, type NetSocket,
} from "../netdiag.ts";

const fail = (msg: string): never => { console.error(`FAIL: ${msg}`); process.exit(1); };
const ok = (msg: string): void => console.log(`   ${msg} ✓`);

console.log("== P-NETDIAG.1 — OAuth localhost-callback network watcher ==");

// A realistic Windows netstat capture: the OAuth broker listening on the Codex callback port, a public
// (non-loopback) listener, and an ordinary outbound connection that is NOT loopback.
const NETSTAT = [
  "Active Connections",
  "  Proto  Local Address          Foreign Address        State           PID",
  "  TCP    127.0.0.1:1455         0.0.0.0:0              LISTENING       4242",
  "  TCP    0.0.0.0:445            0.0.0.0:0              LISTENING       4",
  "  TCP    192.168.1.20:55012     140.82.112.21:443     ESTABLISHED     9001",
  "  UDP    127.0.0.1:1900         *:*                                   1500",
].join("\r\n");
const names = new Map([["4242", "omp.exe"], ["4", "System"], ["9001", "chrome.exe"], ["1500", "svchost.exe"]]);
const procFor = (pid: string) => names.get(pid) ?? `pid ${pid}`;

// (1) Windows parse → the callback listener resolves to its owning process.
const cb = parseNetstatLine(NETSTAT.split("\r\n")[2]!, procFor);
if (!cb || cb.port !== 1455 || cb.proc !== "omp.exe" || cb.state !== "LISTENING" || !cb.loopback) fail("netstat callback row mis-parsed");
ok(`netstat: 127.0.0.1:1455 LISTENING → ${cb.proc} (pid ${cb.pid})`);

// (2) macOS/Linux parse reaches the same shape from `lsof`.
const lsof = parseLsofLine("omp     4242 nick    7u  IPv4 0x1  0t0  TCP 127.0.0.1:1455 (LISTEN)");
if (!lsof || lsof.port !== 1455 || lsof.proc !== "omp" || lsof.state !== "LISTENING") fail("lsof callback row mis-parsed");
ok(`lsof: same NetSocket shape on macOS/Linux → ${lsof.proc} on :${lsof.port}`);

// (3) relevant(): keep loopback + EVERY listener (incl. all-interface binds); drop the rest.
const parsed = NETSTAT.split("\r\n").map((l) => parseNetstatLine(l, procFor)).filter(Boolean) as NetSocket[];
const kept = parsed.filter(relevant);
if (!kept.some((s) => s.port === 445 && !s.loopback)) fail("a 0.0.0.0 (all-interface) listener was dropped — the bug that made the callback invisible");
if (kept.some((s) => s.state === "ESTABLISHED" && !s.loopback)) fail("a non-loopback outbound connection leaked through the filter");
ok("relevant(): kept loopback + all listeners (incl. 0.0.0.0:445), dropped the non-loopback outbound");

// (4) DIFF: clicking "Connect" makes the callback listener appear → flagged as a candidate.
const before = new Map(parsed.filter((s) => s.port !== 1455).filter(relevant).map((s) => [socketKey(s), s] as const));
const after = new Map(kept.map((s) => [socketKey(s), s] as const));
const events = diffSockets(before, after, 1000, DEFAULT_CALLBACK_PORTS);
const cand = events.find((e) => e.candidate);
if (!cand || cand.port !== 1455 || cand.kind !== "listener" || cand.proc !== "omp.exe") fail("the new callback listener was not flagged as a candidate");
if (events.some((e) => e.candidate && e.port === 445)) fail("a non-loopback public listener was wrongly flagged as a callback candidate");
ok(`diff: new LISTENER on :1455 (${cand.proc}) flagged "callback?" — the bind-or-not evidence`);

// the inverse: the listener vanishing emits a close event (so a too-brief bind is still recorded).
const closed = diffSockets(after, before, 2000, DEFAULT_CALLBACK_PORTS);
if (!closed.some((e) => e.kind === "close" && e.port === 1455)) fail("a closing callback listener produced no close event");
ok("diff: the callback listener closing emits a close event (a brief bind is never silently lost)");

// (5) Pure diagnostics — the view is read-only metadata; its keys never express a security decision.
const v = netdiagView();
const keys = Object.keys(v).sort().join(",");
if (!/events/.test(keys) || !/listeners/.test(keys) || !/probes/.test(keys)) fail("netdiagView shape regressed");
for (const forbidden of ["allow", "block", "deny", "verdict", "quarantine"]) {
  if (keys.includes(forbidden)) fail(`netdiagView leaked a gate-like field "${forbidden}" — it must stay cosmetic diagnostics`);
}
if (typeof v.watching !== "boolean" || typeof netdiagSupported() !== "boolean") fail("watcher state flags missing");
ok(`netdiagView is read-only diagnostics (supported=${netdiagSupported()}, fields: ${keys}); no allow/block verdict`);

console.log("demo-P-NETDIAG.1 OK");
process.exit(0);
