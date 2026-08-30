// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Increment P-PORTGUARD.1 - the engine port handshake (ADR-0305).
//
// A live field incident (2026-08-30) proved the defect: an orphaned `bun server.ts` from a scaffold
// fork had been LISTENING on *:5319 for days, main.ts's waitForServer() accepted ANY 200 from
// /api/health, and LUCID's window rendered the stranger's UI inside its trusted chrome through two
// upgrades and a reinstall. The fix: main mints a per-launch nonce, hands it to the spawned engine
// via env, and only renders a health answer that echoes it back. A foreign squatter fails LOUDLY
// with a copy/paste incident block (process name, pid, start time, command), never a silent roll.
//
// This demo drives the pure core in desktop/port_guard.ts against REAL Bun.serve squatters:
//   [1] a squatter answering { ok: true } with NO nonce  -> "foreign-missing-nonce"
//   [2] a squatter echoing a WRONG nonce                 -> "foreign-wrong-nonce"
//   [3] a compliant engine echoing the minted nonce      -> "ours"
//   [4] formatPortIncident carries port/pid/name/start-time/product; null observed says attribution failed
//   [5] parseOwnerProbe round-trips a canned win32 JSON sample and a canned posix ps line
//
// Run with: bun run desktop/scripts/demo_portguard.ts

import { formatPortIncident, healthVerdict, parseOwnerProbe } from "../port_guard.ts";
import type { PortIncidentInput, SquatterInfo } from "../port_guard.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) { console.error("  \u2717 " + msg); process.exit(1); }
  console.log("  \u2713 " + msg);
}

console.log("== #ADR-0305 P-PORTGUARD.1: the engine port handshake ==\n");

// The per-launch nonce main would mint and pass to the spawned engine via LUCID_ENGINE_NONCE.
const NONCE = crypto.randomUUID();

// Every server started here is collected and stopped in finally, pass or fail.
const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];
function serve(health: () => Response): { port: number } {
  const s = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      if (new URL(req.url).pathname === "/api/health") return health();
      return new Response("not found", { status: 404 });
    },
  });
  servers.push(s);
  return { port: s.port };
}

try {
  console.log("[1] a squatter answering health with NO nonce is never ours");
  const noNonce = serve(() => Response.json({ ok: true }));
  const r1 = await fetch(`http://127.0.0.1:${noNonce.port}/api/health`);
  const v1 = healthVerdict(NONCE, r1.ok, await r1.json());
  assert(v1 === "foreign-missing-nonce", `a 200 { ok: true } without our nonce verdicts "${v1}" (the pre-ADR-0305 waitForServer would have rendered it)`);

  console.log("\n[2] a squatter echoing a WRONG nonce is caught");
  const wrongNonce = serve(() => Response.json({ ok: true, nonce: "not-the-minted-nonce" }));
  const r2 = await fetch(`http://127.0.0.1:${wrongNonce.port}/api/health`);
  const v2 = healthVerdict(NONCE, r2.ok, await r2.json());
  assert(v2 === "foreign-wrong-nonce", `a health answer carrying a different nonce verdicts "${v2}" (a guesser cannot fake a per-launch secret)`);

  console.log("\n[3] the engine main actually spawned passes the handshake");
  const ours = serve(() => Response.json({ ok: true, nonce: NONCE }));
  const r3 = await fetch(`http://127.0.0.1:${ours.port}/api/health`);
  const v3 = healthVerdict(NONCE, r3.ok, await r3.json());
  assert(v3 === "ours", "only the child that received LUCID_ENGINE_NONCE via env can echo it back -> \"ours\"");

  console.log("\n[4] the copy/paste incident block carries the forensics (user requirement, ADR-0305)");
  const observed: SquatterInfo = {
    pid: 40409,
    name: "bun",
    startedAt: "Wed Aug 27 09:14:02 2026",
    command: "bun server.ts",
  };
  const input: PortIncidentInput = {
    port: 5319,
    productName: "LUCID Agent IDE",
    appVersion: "1.14.1",
    platform: "darwin",
    engineDescription: "bin/lucid-engine (compiled, spawned by main.ts)",
    verdict: "foreign-missing-nonce",
    observed,
  };
  const block = formatPortIncident(input);
  assert(block.includes("5319"), "the block names the squatted port");
  assert(block.includes("40409"), "the block names the squatting pid");
  assert(block.includes("bun"), "the block names the squatting process");
  assert(block.includes("Wed Aug 27 09:14:02 2026"), "the block carries the process start date/time");
  assert(block.includes("LUCID Agent IDE"), "the block names the product (pasteable into an email or issue verbatim)");
  const unattributed = formatPortIncident({ ...input, observed: null });
  assert(/attribution/i.test(unattributed) && /fail/i.test(unattributed), "when attribution fails the block SAYS so instead of omitting the section");

  console.log("\n[5] parseOwnerProbe round-trips both platform probe outputs");
  // Canned win32 sample: what the ownerProbeSpec powershell.exe ConvertTo-Json invocation emits
  // (PS 5.1 shape: Id/ProcessName/StartTime/Path).
  const win32Sample = JSON.stringify({
    Id: 40409,
    ProcessName: "bun",
    StartTime: "\/Date(1756298042000)\/",
    Path: "C:\\Users\\dev\\forks\\trainer\\bun.exe",
  });
  const winInfo = parseOwnerProbe("win32", win32Sample);
  assert(winInfo !== null && winInfo.pid === 40409 && winInfo.name === "bun", "win32 JSON parses to the squatter's pid + name");
  assert(winInfo !== null && winInfo.startedAt !== null && winInfo.command !== null && winInfo.command.includes("bun"), "win32 JSON keeps the start time + command");
  // Canned posix sample: what `lsof ... | ps -o pid=,lstart=,command=` emits.
  const posixSample = "40409 Wed Aug 27 09:14:02 2026 bun server.ts\n";
  const posixInfo = parseOwnerProbe("darwin", posixSample);
  assert(posixInfo !== null && posixInfo.pid === 40409, "posix ps line parses to the squatter's pid");
  assert(posixInfo !== null && posixInfo.startedAt !== null && posixInfo.command !== null && posixInfo.command.includes("server.ts"), "posix ps line keeps the lstart time + command");
  assert(parseOwnerProbe("darwin", "") === null && parseOwnerProbe("win32", "garbage{{") === null, "empty/garbage probe output attributes NOTHING (null), never a fabricated process");
} finally {
  for (const s of servers) { try { s.stop(true); } catch { /* best effort */ } }
}

console.log("\n\u2713 P-PORTGUARD.1 demo passed - the window only ever renders a health answer carrying its own per-launch nonce; a stranger fails loudly with a pasteable incident report.");
