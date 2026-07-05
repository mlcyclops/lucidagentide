// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_p_sandbox_4.ts
//
// P-SANDBOX.4 (ADR-0168): the macOS Seatbelt backend — real runtime containment for macOS, closing the
// "Linux-only" gap of P-SANDBOX.1-.3. Proves on any platform (the seam is pure; `which` is injected):
//   1. resolution: darwin + sandbox-exec → the ISOLATING Seatbelt backend; win32 → the disclosed
//      passthrough (Windows AppContainer needs native support — a tracked follow-up); darwin without
//      sandbox-exec → disclosed;
//   2. the Seatbelt profile enforces the SAME three network states as bwrap: network-off denies ALL
//      network AND cuts DNS (mDNSResponder); mediated confines egress to LOOPBACK only (so a raw-IP
//      socket ignoring HTTP_PROXY is DENIED by the kernel — bwrap only drops it) + sets HTTP(S)_PROXY;
//      network-capable-but-unmediated fails closed to total deny;
//   3. managed require-isolation is satisfied by sandbox-exec, and REFUSES on macOS-without-it and on
//      Windows (fail-closed, never a silent unisolated run);
//   4. wrapForProfile: a suspicious-chain downgrade yields a genuinely network-denied isolated plan.
//
// Run: bun run harness/scripts/demo_p_sandbox_4.ts

import {
  resolveBackend,
  SeatbeltBackend,
  seatbeltProfile,
  wrapForProfile,
  type BackendResolution,
} from "../runs/sandbox_exec.ts";
import { caps, chooseProfile } from "../runs/profiles.ts";

const fail = (m: string): never => { console.error(`FAIL: ${m}`); process.exit(1); };
const ok = (cond: boolean, m: string) => { if (!cond) fail(m); console.log(`  ok  ${m}`); };
const has = (bin: string) => (b: string) => b === bin;
const none = () => false;
const ARGV = ["/opt/omp", "acp", "-e", "/repo/gate.ts"];
const CTX = { workspace: "/work/ws", home: "/home/u" };
const PROXY = { host: "127.0.0.1", httpPort: 8888, httpProxyUrl: "http://127.0.0.1:8888" };

console.log("== #ADR-0168 P-SANDBOX.4: the macOS Seatbelt backend (runtime containment lands on macOS) ==\n");

// ── [1] resolution per platform ──────────────────────────────────────────────
console.log("[1] backend resolution — macOS gets Seatbelt; Windows stays disclosed (AppContainer follow-up)");
const mac = resolveBackend({ platform: "darwin", which: has("sandbox-exec") });
ok(mac.ok && mac.backend.name === "seatbelt" && mac.backend.isolates && !mac.disclosed, "darwin + sandbox-exec → the ISOLATING Seatbelt backend");
const macNo = resolveBackend({ platform: "darwin", which: none });
ok(macNo.ok && macNo.backend.name === "noop" && macNo.disclosed, "darwin WITHOUT sandbox-exec → disclosed passthrough (LUCID still functions)");
const win = resolveBackend({ platform: "win32", which: has("sandbox-exec") });
ok(win.ok && win.backend.name === "noop" && win.disclosed, "win32 → disclosed passthrough (Windows AppContainer needs native support — tracked)");

// ── [2] the Seatbelt profile — same three network states as bwrap ─────────────
console.log("\n[2] the Seatbelt profile enforces canNetwork, and confines mediated egress to loopback");
const off = seatbeltProfile(caps("container-local"), CTX);
ok(off.includes("(deny network*)") && off.includes("mDNSResponder"), "network-off → deny ALL network AND cut DNS (mDNSResponder mach-lookup denied)");
const mediated = new SeatbeltBackend(has("sandbox-exec")).wrap(ARGV, caps("trusted-local"), { ...CTX, proxy: PROXY });
const medProfile = mediated.args[1]!;
ok(medProfile.includes("(deny network-outbound)") && medProfile.includes('(remote ip "localhost:*")') && !medProfile.includes("(deny network*)"),
  "mediated → egress confined to LOOPBACK only (a raw-IP socket ignoring HTTP_PROXY is DENIED by the kernel)");
ok(mediated.env.HTTPS_PROXY === "http://127.0.0.1:8888" && mediated.env.NO_PROXY!.includes("127.0.0.1"), "…and HTTP(S)_PROXY steers pip/curl through the proxy");
const unmediated = seatbeltProfile(caps("trusted-local"), CTX); // canNetwork:true but no proxy
ok(unmediated.includes("(deny network*)"), "network-capable but NO proxy → fail-closed to total deny (no mediator ⇒ no network)");

// ── [3] managed require-isolation (fail-closed) ──────────────────────────────
console.log("\n[3] managed require-isolation — satisfied by sandbox-exec, refused where no backend exists");
ok(resolveBackend({ platform: "darwin", requireIsolation: true, which: has("sandbox-exec") }).ok, "macOS with sandbox-exec SATISFIES require-isolation");
const macReq = resolveBackend({ platform: "darwin", requireIsolation: true, which: none });
ok(!macReq.ok && /Seatbelt/.test(macReq.ok ? "" : macReq.reason), "macOS WITHOUT sandbox-exec → REFUSED (never a silent unisolated run)");
const winReq = resolveBackend({ platform: "win32", requireIsolation: true, which: has("sandbox-exec") });
ok(!winReq.ok && /AppContainer/.test(winReq.ok ? "" : winReq.reason), "Windows under require-isolation → REFUSED (AppContainer follow-up named)");

// ── [4] wrapForProfile: the downgrade path is genuinely network-denied ───────
console.log("\n[4] the suspicious-chain downgrade yields a genuinely network-denied Seatbelt plan");
const downgrade = chooseProfile({ requested: "trusted-local", trustLabel: "suspicious" });
const res: BackendResolution = { ok: true, backend: new SeatbeltBackend(has("sandbox-exec")), disclosed: false };
const d = wrapForProfile({ argv: ARGV, caps: caps(downgrade.profile), ctx: CTX, resolution: res });
ok(d.action === "spawn" && d.isolated && d.plan.cmd === "sandbox-exec" && d.plan.args[1]!.includes("(deny network*)"),
  "container-local under Seatbelt → sandbox-exec with a network-denied profile (the DNS-TXT exfil dies)");
ok(d.action === "spawn" && d.plan.args.slice(2).join(" ") === ARGV.join(" "), "…and the wrapped omp argv is preserved verbatim");

console.log("\n✓ P-SANDBOX.4 demo passed — macOS now has real runtime containment (Seatbelt): declared caps enforced, mediated egress confined to loopback, require-isolation fail-closed. Windows AppContainer + Linux slirp raw-socket forwarding are named follow-ups.");
process.exit(0);
