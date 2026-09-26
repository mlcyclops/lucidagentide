// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_fleet_l20.ts
//
// P-FLEET.L20 (ADR-0402): a spoke can be closed from where it is shown. The orbit node carries an X beside
// the click-to-open card, and the takeover banner carries one beside Switch. Both take the grid's own
// two-step (P-FLEET.L10): a live spoke STOPS (card stays, Respawn revives it); a stopped spoke is DISMISSED.
// The step is decided by one pure function the node's label, tip and click all read from.
//
// Run: bun run desktop/scripts/demo_p_fleet_l20.ts

import { spokeClose } from "../renderer/orbit_layout.ts";
import type { LaneStatus } from "../renderer/bridge.ts";

const fail = (m: string): never => { console.error(`FAIL: ${m}`); process.exit(1); };
const ok = (cond: boolean, m: string) => { if (!cond) fail(m); console.log(`  ok  ${m}`); };

console.log("== #ADR-0402 P-FLEET.L20: close a spoke from its node or its banner ==\n");

console.log("[1] one glyph, two named steps");
const live: LaneStatus[] = ["starting", "working", "needs-approval", "awaiting-input", "done", "error"];
ok(live.every((s) => spokeClose(s).act === "stop"), "every live state stops first, never dismisses");
ok(spokeClose("stopped").act === "dismiss", "an already-stopped spoke dismisses");
ok(spokeClose("working").label !== spokeClose("stopped").label, "the label changes with the step");
ok(spokeClose("working").tip.includes("Click again once stopped to dismiss"), "the stop tip announces the second step");
ok(spokeClose("stopped").tip.includes("Timeline"), "the dismiss tip names where the conversation survives");

console.log("\nP-FLEET.L20 demo: all checks passed.");
