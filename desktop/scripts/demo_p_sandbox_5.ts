// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_sandbox_5.ts
//
// P-SANDBOX.5 (ADR-0169): the runtime-execution boundary is now VISIBLE in the Security panel. P-SANDBOX
// .1-.4 built the boundary (bwrap / Seatbelt / disclosed), the mediated-egress proxy, and its audit trail
// - all correct but invisible. This surfaces, per session: is exec runtime-isolated (and via which
// backend), is subprocess egress mediated, and which reach-outs the proxy REFUSED. Proves:
//   1. the store reflects the resolved posture and keeps a bounded, newest-first ring of refused reach-outs;
//   2. the pure panel builder renders green (isolated) / amber (disclosed) / red (fail-closed) posture,
//      auto-opening when NOT isolated, and escapes hostile host/reason text (no HTML injection);
//   3. end-to-end: a denied subprocess reach-out flows through the audit sink into a panel block row.
//
// Run: bun run desktop/scripts/demo_p_sandbox_5.ts

import { recordEgressBlockView, resetSandboxStatus, sandboxStatus, setSandboxState } from "../sandbox_status.ts";
import { renderSandboxSection } from "../renderer/sandbox_panel.ts";
import { egressAuditSink } from "../egress_audit.ts";
import type { ProxyEvent } from "../../harness/runs/egress_proxy.ts";

const fail = (m: string): never => { console.error(`FAIL: ${m}`); process.exit(1); };
const ok = (cond: boolean, m: string) => { if (!cond) fail(m); console.log(`  ok  ${m}`); };
const at = "2026-07-05T00:00:00Z";

console.log("== #ADR-0169 P-SANDBOX.5: the runtime-execution boundary, made visible in the Security panel ==\n");

// ── [1] the store ─────────────────────────────────────────────────────────────
console.log("[1] the GUI-owned store reflects the live posture + a bounded ring of refused reach-outs");
resetSandboxStatus();
ok(sandboxStatus().state === null, "starts empty (nothing until the first omp spawn resolves a posture)");
setSandboxState({ backend: "seatbelt", isolated: true, disclosed: false, platform: "darwin", execBlocked: null, proxied: true, at });
ok(sandboxStatus().state?.backend === "seatbelt" && sandboxStatus().state?.isolated === true, "setSandboxState surfaces the resolved backend + isolation");
for (let i = 0; i < 60; i++) recordEgressBlockView({ host: `h${i}.cn`, channel: "dns", type: "dns_query_blocked", reason: "r", at });
ok(sandboxStatus().egressBlocks.length === 50 && sandboxStatus().egressBlocks[0]!.host === "h59.cn", "the refused-reach-out ring is bounded (50) + newest-first");

// ── [2] the pure panel builder ────────────────────────────────────────────────
console.log("\n[2] the pure panel builder renders the posture (green/amber/red) and escapes hostile text");
resetSandboxStatus();
const isolated = renderSandboxSection({ state: { backend: "bwrap", isolated: true, disclosed: false, platform: "linux", execBlocked: null, proxied: true, at }, egressBlocks: [] });
ok(isolated.includes("Linux bubblewrap") && isolated.includes("sbx-row good") && isolated.includes("mediated"), "isolated → green posture, named backend, mediated-egress line");
const disclosed = renderSandboxSection({ state: { backend: "noop", isolated: false, disclosed: true, platform: "win32", execBlocked: null, proxied: false, at }, egressBlocks: [] });
ok(disclosed.includes("not isolated") && disclosed.includes("win32") && disclosed.includes('class="acc open"'), "disclosed passthrough → amber posture, platform named, AUTO-OPENS to draw the eye");
const blocked = renderSandboxSection({ state: { backend: null, isolated: false, disclosed: false, platform: "linux", execBlocked: "bwrap not installed", proxied: false, at }, egressBlocks: [] });
ok(blocked.includes("sbx-row bad") && blocked.includes("fail-closed BLOCKED") && blocked.includes("bwrap not installed"), "managed require-isolation with no backend → red fail-closed posture + reason");
const hostile = renderSandboxSection({ state: { backend: "seatbelt", isolated: true, disclosed: false, platform: "darwin", execBlocked: null, proxied: true, at }, egressBlocks: [{ host: "<img src=x onerror=alert(1)>.cn", channel: "dns", type: "dns_query_blocked", reason: "denied <b>", at }] });
ok(!hostile.includes("<img src=x") && hostile.includes("&lt;img") && hostile.includes("count"), "a hostile refused host is ESCAPED (no HTML injection) and counted");

// ── [3] end-to-end: a refused reach-out lands in the panel ────────────────────
console.log("\n[3] end-to-end — a denied subprocess reach-out flows through the audit sink into a panel row");
resetSandboxStatus();
const sink = egressAuditSink(() => {}); // real recordView (default), no-op emit
const denyEv: ProxyEvent = { channel: "dns", decision: { action: "deny", host: "s0m3b64.attacker.cn", reason: "prompt-not-auto-allowed", via: "allow-all" } };
sink(denyEv);
sink(denyEv); // repeat host — deduped
const blocks = sandboxStatus().egressBlocks;
ok(blocks.length === 1 && blocks[0]!.host === "s0m3b64.attacker.cn" && blocks[0]!.type === "dns_query_blocked", "a denied gethostbyname → exactly one panel block row (deduped by host)");
resetSandboxStatus();

console.log("\n✓ P-SANDBOX.5 demo passed — the whole P-SANDBOX epic is now visible: the reviewer sees whether exec is runtime-isolated, whether egress is mediated, and every subprocess reach-out the proxy refused.");
process.exit(0);
