// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_p_sandbox_6.ts
//
// P-SANDBOX.6 (ADR-0172): the Windows AppContainer backend SEAM. Windows was the last platform on the
// disclosed passthrough (no runtime containment). Unlike bwrap / sandbox-exec there is NO OS argv-wrapper
// for AppContainer, so we introduce a thin FIRST-PARTY helper (`lucid-appcontainer <flags> -- <argv>`)
// that fits the seam's wrap→{cmd,args,env} contract. THIS increment builds + tests the seam + the flag
// contract; the native helper that consumes it is P-SANDBOX.7. Proves (pure; `which` injected):
//   1. resolution: win32 + the helper → the ISOLATING AppContainer backend; win32 WITHOUT it → the
//      disclosed passthrough (unchanged from .1-.5 until the helper ships); require-isolation is satisfied
//      by the helper and REFUSES (fail-closed) without it;
//   2. the flag contract mirrors bwrap / Seatbelt's three network states: network-off → --deny-network;
//      mediated → --loopback-only + HTTP(S)_PROXY (raw-IP sockets WFP-denied); unmediated → --deny-network;
//   3. wrapForProfile: a suspicious-chain downgrade yields a genuinely network-denied isolated plan;
//   4. available() is strictly gated on the helper being on PATH.
//
// Run: bun run harness/scripts/demo_p_sandbox_6.ts

import {
  appContainerArgs,
  AppContainerBackend,
  resolveBackend,
  wrapForProfile,
  type BackendResolution,
} from "../runs/sandbox_exec.ts";
import { caps, chooseProfile } from "../runs/profiles.ts";

const fail = (m: string): never => { console.error(`FAIL: ${m}`); process.exit(1); };
const ok = (cond: boolean, m: string) => { if (!cond) fail(m); console.log(`  ok  ${m}`); };
const has = (bin: string) => (b: string) => b === bin;
const none = () => false;
const ARGV = ["/opt/omp", "acp", "-e", "/repo/gate.ts"];
const CTX = { workspace: "C:\\work\\ws", home: "C:\\Users\\dev" };
const PROXY = { host: "127.0.0.1", httpPort: 8888, httpProxyUrl: "http://127.0.0.1:8888" };

console.log("== #ADR-0172 P-SANDBOX.6: the Windows AppContainer backend seam (containment reaches Windows) ==\n");

// ── [1] resolution per helper presence ───────────────────────────────────────
console.log("[1] resolution — win32 gets AppContainer WHEN the lucid-appcontainer helper is present");
const withHelper = resolveBackend({ platform: "win32", which: has("lucid-appcontainer") });
ok(withHelper.ok && withHelper.backend.name === "appcontainer" && withHelper.backend.isolates && !withHelper.disclosed, "win32 + helper → the ISOLATING AppContainer backend");
const noHelper = resolveBackend({ platform: "win32", which: none });
ok(noHelper.ok && noHelper.backend.name === "noop" && noHelper.disclosed, "win32 WITHOUT the helper → disclosed passthrough (unchanged until P-SANDBOX.7 ships it)");
const req = resolveBackend({ platform: "win32", requireIsolation: true, which: none });
ok(!req.ok && /lucid-appcontainer/.test(req.ok ? "" : req.reason), "require-isolation without the helper → REFUSED (fail-closed, never a silent unisolated run)");
ok(resolveBackend({ platform: "win32", requireIsolation: true, which: has("lucid-appcontainer") }).ok, "…and SATISFIED once the helper is installed");

// ── [2] the flag contract — the same three network states ─────────────────────
console.log("\n[2] the flag contract mirrors bwrap / Seatbelt (the helper enforces AppContainer + WFP)");
ok(appContainerArgs(caps("container-local"), CTX).includes("--deny-network"), "network-off → --deny-network (WFP blocks all outbound for the container SID)");
const ac = new AppContainerBackend(has("lucid-appcontainer"));
const mediated = ac.wrap(ARGV, caps("trusted-local"), { ...CTX, proxy: PROXY });
ok(mediated.cmd === "lucid-appcontainer" && mediated.args.includes("--loopback-only") && !mediated.args.includes("--deny-network"),
  "mediated → --loopback-only: only the loopback proxy is reachable (a raw-IP socket ignoring HTTP_PROXY is WFP-denied)");
ok(mediated.env.HTTPS_PROXY === "http://127.0.0.1:8888" && mediated.env.NO_PROXY!.includes("127.0.0.1"), "…and HTTP(S)_PROXY steers the child through the proxy");
ok(appContainerArgs(caps("trusted-local"), CTX).includes("--deny-network"), "network-capable but NO proxy → fail-closed to --deny-network (no mediator ⇒ no network)");
ok(appContainerArgs(caps("trusted-local"), CTX).join(" ").includes("--workspace C:\\work\\ws"), "the workspace is bound rw (fs containment stays omp --isolate's job)");

// ── [3] wrapForProfile: the downgrade path is genuinely network-denied ───────
console.log("\n[3] the suspicious-chain downgrade yields a genuinely network-denied AppContainer plan");
const downgrade = chooseProfile({ requested: "trusted-local", trustLabel: "suspicious" });
const res: BackendResolution = { ok: true, backend: ac, disclosed: false };
const d = wrapForProfile({ argv: ARGV, caps: caps(downgrade.profile), ctx: CTX, resolution: res });
ok(d.action === "spawn" && d.isolated && d.plan.cmd === "lucid-appcontainer" && d.plan.args.includes("--deny-network"),
  "container-local under AppContainer → lucid-appcontainer --deny-network (the DNS-TXT exfil dies)");
ok(d.action === "spawn" && d.plan.args.slice(d.plan.args.indexOf("--") + 1).join(" ") === ARGV.join(" "), "…and the wrapped omp argv is preserved verbatim after --");

// ── [4] available() gating ────────────────────────────────────────────────────
console.log("\n[4] available() is strictly gated on the helper");
ok(new AppContainerBackend(has("lucid-appcontainer")).available(), "helper on PATH → available");
ok(!new AppContainerBackend(none).available() && !new AppContainerBackend(has("bwrap")).available(), "helper absent (or a different tool) → NOT available ⇒ disclosed passthrough");

console.log("\n✓ P-SANDBOX.6 demo passed — the Windows AppContainer seam + flag contract are in place: containment activates the moment the lucid-appcontainer helper ships (P-SANDBOX.7); until then Windows honestly discloses.");
process.exit(0);
