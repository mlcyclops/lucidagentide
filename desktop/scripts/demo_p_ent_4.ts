// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_ent_4.ts
//
// Increment P-ENT.4 (ADR-0069) — every per-action gate DENIAL is auditable + attributed. The investigation
// that motivated this: a turn showed several "tool call denied by user" chips (browser/bash/eval) with NO
// matching record in the OCSF audit log — because the fail-closed TIMEOUT path settled silently. This proves
// the attribution that now backs both the exec + egress deny paths (incl. the timeout):
//   (1) an explicit deny (you clicked Block) → "denied by you";
//   (2) a turn-ended/disconnected pending prompt → "fail-closed (turn ended)" — NOT you;
//   (3) a timed-out prompt → "fail-closed (no response in 5m)" — NOT you.
// So "did I deny it, or did it auto-deny?" is answerable from the audit trail.

import { gateDenyReason } from "../gate_audit.ts";

const fail = (msg: string): never => { console.error(`FAIL: ${msg}`); process.exit(1); };
const ok = (msg: string): void => console.log(`   ${msg} ✓`);

console.log("== P-ENT.4 — gate denials are auditable + attributed ==");

console.log("\n1) explicit Block → your decision");
if (gateDenyReason("exec:deny") !== "denied by you") fail("explicit deny should attribute to you");
ok('optionId "exec:deny" → "denied by you"');

console.log("\n2) turn ended while pending → fail-closed, not you");
if (gateDenyReason(null) !== "fail-closed (turn ended)") fail("null optionId → fail-closed (turn ended)");
ok('optionId null → "fail-closed (turn ended)"');

console.log("\n3) timed out → fail-closed, not you (the gap this closes — used to settle silently)");
if (gateDenyReason(null, true) !== "fail-closed (no response in 5m)") fail("timeout → fail-closed (no response)");
if (gateDenyReason("exec:deny", true) !== "fail-closed (no response in 5m)") fail("timeout dominates");
ok('timed out → "fail-closed (no response in 5m)"');

console.log("\nPASS — exec + egress denials (incl. fail-closed timeout) now emit a SecurityEvent with an honest cause.");
