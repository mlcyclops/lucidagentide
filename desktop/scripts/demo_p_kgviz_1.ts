// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Increment P-KGVIZ.1 — form in place (ADR-0183). Opening a knowledge/code graph with hundreds of
// nodes used to mean seconds of on-screen shaking while the force sim settled and the camera chased
// checkpoint fits - disorienting and un-grabbable. The settle now runs OFF-SCREEN before the first
// paint (time-boxed), the view opens snapped at the final center, and the sim stays PARKED - panning
// and dragging are immediate. Live merges settle silently; resizes re-fit without reheating.
//
// Run with: bun run desktop/scripts/demo_p_kgviz_1.ts

import { KE_REST, presettle, stepForces, type SimBody } from "../renderer/kg_ops.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) { console.error("  ✗ " + msg); process.exit(1); }
  console.log("  ✓ " + msg);
}
const body = (x: number, y: number, r = 8): SimBody => ({ x, y, vx: 0, vy: 0, r });
const cloud = (n: number): SimBody[] =>
  Array.from({ length: n }, (_, i) => body(300 + Math.cos(i * 2.4) * (40 + (i % 9) * 6), 300 + Math.sin(i * 2.4) * (40 + (i % 7) * 6), 6 + (i % 5) * 2));
const ring = (n: number): Array<readonly [number, number]> => Array.from({ length: n - 1 }, (_, i) => [i, i + 1] as const);

console.log("== #ADR-0183 P-KGVIZ.1: form in place - no more on-screen graph shake ==\n");

console.log("[1] a cold 300-node graph settles OFF-SCREEN, fast");
{
  const bodies = cloud(300);
  const t0 = performance.now();
  const frames = presettle(bodies, ring(300), 300, 300, { settle: 480, frames: 0, deadlineMs: 420 });
  const ms = Math.round(performance.now() - t0);
  assert(frames <= 480 && ms <= 600, `300 nodes + 299 springs pre-settled in ${ms}ms / ${frames} frames (the user never sees any of it)`);
  assert(bodies.every((b) => Number.isFinite(b.x) && Number.isFinite(b.y)), "every node lands on a finite position");
}

console.log("\n[2] parked means parked - the layout the user opens onto does not move");
{
  const bodies = cloud(150);
  presettle(bodies, ring(150), 300, 300, { settle: 480, frames: 0, deadlineMs: 60_000 });
  const residual = stepForces(bodies, ring(150), 300, 300, 480);
  assert(residual < 150 * KE_REST * 2, `one more physics frame moves the settled layout by ~nothing (Σv² ${residual.toFixed(3)})`);
}

console.log("\n[3] the wall-clock deadline caps HUGE graphs - a mount can never hang");
{
  let t = 0;
  const frames = presettle(cloud(50), [], 300, 300, { settle: 480, frames: 0, deadlineMs: 250, now: () => (t += 100) });
  assert(frames <= 4, `with a fake 100ms/frame clock and a 250ms budget, presettle stopped after ${frames} frames`);
}

console.log("\n[4] live merges form in place too - newcomers nestle without shaking the neighbors");
{
  const bodies = [...cloud(60), body(300, 300), body(302, 300)]; // two newborn nodes stacked at center
  const settledBefore = bodies.slice(0, 60).map((n) => ({ x: n.x, y: n.y }));
  presettle(bodies, [], 300, 300, { settle: 480, frames: 0, deadlineMs: 60_000 }); // settle the veterans first
  const vets = bodies.slice(0, 60).map((n) => ({ x: n.x, y: n.y }));
  const kids0 = bodies.slice(-2).map((n) => n.x);
  presettle(bodies, [], 300, 300, { settle: 480, frames: 320, deadlineMs: 200 }); // the update() path: late start, short budget
  assert(bodies.slice(-2).map((n) => n.x).some((x, i) => x !== kids0[i]), "the newborn nodes spread out (grace counts iterations run, not the frame counter)");
  const drift = Math.max(...bodies.slice(0, 60).map((n, i) => Math.hypot(n.x - vets[i]!.x, n.y - vets[i]!.y)));
  assert(drift < 60, `settled neighbors barely drift while newcomers nestle (max ${drift.toFixed(1)}px, was 160 frames of visible shake)`);
  void settledBefore;
}

console.log("\n[5] determinism - the same graph always forms the same layout");
{
  const a = cloud(80), b = cloud(80);
  presettle(a, ring(80), 300, 300, { settle: 480, frames: 0, deadlineMs: 60_000 });
  presettle(b, ring(80), 300, 300, { settle: 480, frames: 0, deadlineMs: 60_000 });
  assert(a.every((n, i) => n.x === b[i]!.x && n.y === b[i]!.y), "identical input → identical settled layout, every time");
}

console.log("\n✓ P-KGVIZ.1 demo passed — graphs open already formed, centered, and still; grab and pan from the first frame.");
