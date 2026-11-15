// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_mascot_2.ts - P-MASCOT.2, as reworked by P-MINI.3 (ADR-0596): the prompt-bar ninja's route.
//
// The parkour loop (run the foot of the bar, climb, sneak the top, drop) is gone: he is calm now. Proves with
// no DOM, at both sizes: home is the bar's right end with his feet on the bar top; the traverse walks to the
// left end, looks out and back, and walks home, always on the bar top and inside it; the walk turns home on
// the spot when a turn starts; the dash leaves the bar wholly; and the mirrored frames are clean.
//
// Run: bun run desktop/scripts/demo_p_mascot_2.ts

import { MASCOT_FRAMES, mirrorFrame } from "../renderer/mascot.ts";
import { DASH_MS, dashAt, paintedBottom, runnerCellPx, runnerHeadroom, runnerPlan, standTop, traverseAt, traverseTurnBack, type RunnerLayout } from "../renderer/mascot_runner.ts";
import { MASCOT_CELL_CSS, MASCOT_SIZES } from "../renderer/mini_lucid.ts";

const fail = (msg: string): never => { console.error(`FAIL: ${msg}`); process.exit(1); };
const ok = (msg: string): void => console.log(`   ${msg} \u2713`);

console.log("== P-MASCOT.2 / P-MINI.3 - the prompt-bar ninja's calm route ==");

for (const size of MASCOT_SIZES) {
  const room = runnerHeadroom(MASCOT_CELL_CSS[size]);
  const L: RunnerLayout = { width: 760, barTop: room, height: room + 90, scale: runnerCellPx(size, 1) };
  const p = runnerPlan(L);

  // (1) home and the bar top.
  if (standTop(p, "idleA") + (paintedBottom(MASCOT_FRAMES.idleA!) + 1) * L.scale !== L.barTop) fail(`${size}: feet must be on the bar top`);
  if (p.homeX + p.spriteW >= L.width) fail(`${size}: home must be inside the bar's right end`);

  // (2) the traverse: out to the left end, a look, back home; on the bar top and inside it throughout.
  const legs: string[] = [];
  let minX = Infinity;
  for (let t = 0; t < p.traverseMs; t += 15) {
    const s = traverseAt(t, p);
    if (s.y + (paintedBottom(MASCOT_FRAMES[s.frame]!) + 1) * L.scale !== L.barTop) fail(`${size}: the walk must stay on the bar top`);
    if (s.x < 0 || s.x + p.spriteW > L.width) fail(`${size}: the walk must stay inside the bar`);
    const leg = s.x === p.endX && !s.frame.startsWith("run") ? "look" : s.mirrored ? "out" : "home";
    if (legs[legs.length - 1] !== leg) legs.push(leg);
    minX = Math.min(minX, s.x);
  }
  if (legs.join(",") !== "out,look,home") fail(`${size}: route drifted: ${legs.join(" -> ")}`);
  if (minX !== p.endX || traverseAt(p.traverseMs, p).x !== p.homeX) fail(`${size}: the walk must reach the left end and end at home`);
  ok(`${size}: home at x ${p.homeX}, a walk of ${p.beats} whole strides out to x ${p.endX}, a look, and back home (${(p.traverseMs / 1000).toFixed(1)} s)`);

  // (3) a turn mid-walk: he turns around where he stands.
  const mid = Math.floor(p.walkMs / 2);
  if (traverseAt(traverseTurnBack(mid, p), p).x !== traverseAt(mid, p).x) fail(`${size}: turning back must not jump`);

  // (4) the dash leaves the bar wholly, in an arc that fits the canvas.
  let peak = Infinity;
  for (let t = 0; t <= DASH_MS; t += 10) { const s = dashAt(t, p, p.homeX, -1); peak = Math.min(peak, s.y - s.lift * L.scale); }
  if (peak < 0) fail(`${size}: the dash arc must fit the canvas`);
  if (dashAt(DASH_MS, p, p.homeX, -1).x + p.spriteW > 0) fail(`${size}: the dash must leave the bar`);
  ok(`${size}: a mid-walk turn home holds his spot; the dash arcs within the canvas and leaves the bar`);
}

// (5) mirror integrity.
const f = MASCOT_FRAMES.sneakA!;
if (mirrorFrame(mirrorFrame(f)).join("") !== f.join("")) fail("mirror must be an involution");
ok("clean mirroring");

console.log("\nALL CHECKS PASSED");
