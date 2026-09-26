// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Increment P-STALL.1 — patience for overloaded providers (ADR-0186), as evolved by P-STALL.2
// (ADR-0263). P-STALL.1 replaced a 5-minute kill (whose error falsely said "2 minutes") with a
// 10-minute cap plus visible 2-minute slow notices. P-STALL.2 then removed the cap outright — long
// subagent fan-outs routinely outlive any fixed clock — so what REMAINS of P-STALL.1, and what this
// demo pins, is the visibility half: the 2-minute notice cadence and the honest silence wording.
// The cutoff's removal and the pending-task visibility are pinned by demo-P-STALL.2.
//
// Run with: bun run desktop/scripts/demo_p_stall_1.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { slowPhaseLabel } from "../renderer/stall_notice.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) { console.error("  ✗ " + msg); process.exit(1); }
  console.log("  ✓ " + msg);
}

console.log("== #ADR-0186 P-STALL.1 (evolved by ADR-0263): visible provider silence ==\n");

const backend = readFileSync(join(import.meta.dir, "..", "acp_backend.ts"), "utf8");

console.log("[1] a silent provider is VISIBLE, not a frozen pane");
assert(/SLOW_NOTICE_MS = 120_000/.test(backend), "a { type:'slow' } event fires at each silent 2-minute mark");
assert(/type: \"slow\"; waitedMs: number/.test(backend), "the event is part of the ChatEvent contract");
assert(slowPhaseLabel(240_000) === "Still waiting on the provider · silent for 4 min", "the HUD phase line counts the silence honestly");
assert(slowPhaseLabel(45_000).includes("1 min"), "an early fire never says '0 min'");

console.log("\n[2] the stale-wording bug class stays dead");
assert(!backend.includes("did not respond for 2 minutes"), "the old lying message never returned");
assert(!backend.includes("the model sent nothing for"), "and neither did its 10-minute successor (the cutoff is gone - ADR-0263)");

console.log("\n✓ P-STALL.1 demo passed — the wait is visible and honestly worded; the cutoff itself is history (see demo-P-STALL.2).");
