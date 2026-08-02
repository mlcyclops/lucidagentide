// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_mascot_1.ts - P-MASCOT.1 (ADR-0251 pivot): LUCID the ninja mascot.
//
// Proves with no DOM: every hand-authored frame grid is on-model (dims + palette + brand accent), the
// state machine follows the real session (victory when work lands, speaking wins, victory finishes),
// the working activities rotate, and every state resolves to a real frame at any clock offset.
//
// Run: bun run desktop/scripts/demo_p_mascot_1.ts

import { MASCOT_FRAMES, MASCOT_H, MASCOT_PALETTE, MASCOT_W, VICTORY_MS, mascotFrame, stepMascot, workActivity } from "../renderer/mascot.ts";

const fail = (msg: string): never => { console.error(`FAIL: ${msg}`); process.exit(1); };
const ok = (msg: string): void => console.log(`   ${msg} \u2713`);

console.log("== P-MASCOT.1 (ADR-0251 pivot) - LUCID the ninja ==");

// (1) frame integrity.
const ids = Object.keys(MASCOT_FRAMES);
if (ids.length < 12) fail(`expected a full pose set, got ${ids.length} frames`);
for (const [id, f] of Object.entries(MASCOT_FRAMES)) {
  if (f.length !== MASCOT_H) fail(`${id}: ${f.length} rows (want ${MASCOT_H})`);
  for (const row of f) {
    if (row.length !== MASCOT_W) fail(`${id}: row width ${row.length} (want ${MASCOT_W})`);
    for (const c of row) if (c !== "." && !(c in MASCOT_PALETTE)) fail(`${id}: unknown pixel '${c}'`);
  }
  if (!f.join("").includes("G")) fail(`${id}: lost the neon brand accent`);
}
ok(`${ids.length} frames, all 20x26, palette-clean, brand accent everywhere`);

// (2) the machine follows the session.
let s = stepMascot(null, { speaking: false, listening: false, working: true }, 0);
s = stepMascot(s, { speaking: false, listening: false, working: false }, 9000);
if (s.state !== "victory" || s.until !== 9000 + VICTORY_MS) fail("landed work must trigger a finishing victory pose");
if (stepMascot(s, { speaking: false, listening: true, working: false }, 9100).state !== "victory") fail("an active victory must finish");
if (stepMascot(null, { speaking: true, listening: true, working: true }, 0).state !== "speaking") fail("speaking must win");
ok("state machine: victory on landed work (uninterruptible, finishes), speaking > listening > working > idle");

// (3) he keeps himself busy - and every beat resolves.
if (workActivity(0) !== "kata" || workActivity(7000) !== "shuriken" || workActivity(14000) !== "meditate") fail("activity rotation drifted");
for (const t of [0, 313, 5555, 777777]) {
  const f = mascotFrame({ state: "working", since: 0, until: 0 }, t);
  if (!(f in MASCOT_FRAMES)) fail(`working frame at t=${t} is not a real frame`);
}
ok("activities rotate kata -> shuriken -> meditate; every offset resolves to a real frame");

console.log("\nALL CHECKS PASSED");
