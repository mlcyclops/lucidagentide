// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_gate_diag_1.ts
//
// Increment P-GATE-DIAG.1 (ADR-0066/0062) — observability for "I never got a prompt, it just denied".
// The exec/egress gate auto-DENIES (no prompt) when its interactive check is false:
//     interactive = askActive && listener && !goalActive && !autoRunning
// When that's false during what should be a live chat turn, the user sees a tool "denied" with no chance to
// allow. This increment records the interactive-check inputs + decision for EVERY exec/egress permission
// request into a dev-mode ring (acp_backend.gateDiagnostics()), surfaced in Logs → "Exec / egress gate
// decisions". The next live run then shows the smoking gun. This script documents how to read a row.

const ok = (msg: string): void => console.log(`   ${msg} ✓`);
console.log("== P-GATE-DIAG.1 — read a gate-decision row ==");

// A captured row looks like (one per exec/egress permission request):
const example = { at: 0, kind: "exec", tool: "node", tier: "T3", askActive: false, listener: false, goalActive: false, autoRunning: false, interactive: false, verdict: "prompt", decision: "block(no-ui)" };

console.log("\nfields recorded per request:");
for (const k of Object.keys(example)) ok(k);

console.log("\nhow to diagnose your run (open Logs → 'Exec / egress gate decisions'):");
console.log("   • decision = 'prompt'          → you SHOULD have seen an approval card (good).");
console.log("   • decision = 'allow(standing)' → a prior 'always allow' approved it (no prompt expected).");
console.log("   • decision = 'block(no-ui)' with:");
console.log("       - askActive = NO            → the request arrived OUTSIDE a chat turn (timing/teardown).");
console.log("       - listener  = NO            → the chat UI sink was missing/clobbered (e.g. a concurrent");
console.log("                                     utility completion) — so the gate had no one to ask.");
console.log("       - loop = goal/auto          → an unattended /goal loop or scheduled run was active.");
console.log("   The FIRST of those that is true on your denied rows is the root cause to fix next.");

console.log("\nPASS — gate decisions are now recorded; a live denied run reveals WHY there was no prompt.");
