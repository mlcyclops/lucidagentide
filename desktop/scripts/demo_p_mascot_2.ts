// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_mascot_2.ts - P-MASCOT.2: the prompt-bar parkour mini ninja.
//
// Proves with no DOM: the route is run -> climb -> sneak -> pause -> drop -> rest, the clip contract
// hides him exactly while crossing the bar band, the drop is gravity-eased, cycles alternate direction,
// and the parkour frames are on-model (the shared frame validators run in demo-P-MASCOT.1).
//
// Run: bun run desktop/scripts/demo_p_mascot_2.ts

import { MASCOT_FRAMES, MASCOT_H, mirrorFrame } from "../renderer/mascot.ts";
import { RUNNER_SCALE, RUNNER_TIMINGS as T, runnerAt, runnerCycle, type RunnerLayout, type RunnerPhase } from "../renderer/mascot_runner.ts";

const fail = (msg: string): never => { console.error(`FAIL: ${msg}`); process.exit(1); };
const ok = (msg: string): void => console.log(`   ${msg} \u2713`);

console.log("== P-MASCOT.2 - the prompt-bar parkour ==");

const L: RunnerLayout = { width: 760, barTop: 62, barBottom: 150, height: 150, scale: RUNNER_SCALE };
const c = runnerCycle(L);

// (1) route order + lanes.
const seen: RunnerPhase[] = [];
for (let t = 0; t < c.total; t += 15) { const p = runnerAt(t, L).phase; if (seen[seen.length - 1] !== p) seen.push(p); }
if (seen.join(",") !== "run,climb,mantle,sneak,pause,drop,land,rest") fail(`route drifted: ${seen.join(" -> ")}`);
if (runnerAt(10, L).y !== L.height - MASCOT_H * RUNNER_SCALE) fail("run lane must hug the canvas foot");
if (runnerAt(c.runMs + T.CLIMB_MS + T.MANTLE_MS + 100, L).y !== L.barTop - MASCOT_H * RUNNER_SCALE) fail("sneak lane must sit ON the bar top");
ok("route: run -> climb -> mantle -> sneak -> pause -> drop -> land -> rest, on the right lanes (P-MASCOT.3 smoothness pass)");

// (2) the clip contract: hidden crossing the band, visible on the lanes.
if (runnerAt(10, L).clipBar) fail("the foot-lane run must be visible");
if (!runnerAt(c.runMs + 100, L).clipBar) fail("the climb must clip (he slips BEHIND the bar)");
if (!runnerAt(c.runMs + T.CLIMB_MS + T.MANTLE_MS + c.sneakMs + T.PAUSE_MS + 100, L).clipBar) fail("the drop must clip (silent)");
if (runnerAt(c.total - 100, L).clipBar) fail("the rest must be visible again");
ok("clip contract: visible on lanes, hidden crossing the band (the silent drop)");

// (3) gravity + direction alternation + mirror integrity.
const d0 = c.runMs + T.CLIMB_MS + T.MANTLE_MS + c.sneakMs + T.PAUSE_MS;
const a = runnerAt(d0 + 100, L), m = runnerAt(d0 + 210, L), z = runnerAt(d0 + 340, L);
if (!((z.y - m.y) > (m.y - a.y))) fail("the drop must accelerate");
const gait = new Set<string>();
for (let t = 0; t < 800; t += 30) gait.add(runnerAt(t, L).frame);
if (gait.size < 4) fail("the run must cycle a four-beat gait");
if (!runnerAt(c.total + 10, L).mirrored) fail("odd cycles must run mirrored");
const f = MASCOT_FRAMES.sneakA!;
if (mirrorFrame(mirrorFrame(f)).join("") !== f.join("")) fail("mirror must be an involution");
ok("gravity-eased drop, alternating direction, clean mirroring");

console.log("\nALL CHECKS PASSED");
