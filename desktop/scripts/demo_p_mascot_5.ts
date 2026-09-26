// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_mascot_5.ts - P-MASCOT.5: arcade-parity prompt-bar runner + the game cabinet.
//
// Proves with no DOM:
//  (1) the prompt-bar runner paints at the arcade's sprite scale, so it is the SAME character;
//  (2) the no-slip stride contract: during the run some sole holds its world position every beat
//      (the reported "does not have the same walk" bug is exactly this failing);
//  (3) the mini-game registry carries three playable, deterministic, scoring engines.
//
// Run: bun run desktop/scripts/demo_p_mascot_5.ts

import { MASCOT_FRAMES, MASCOT_H, MASCOT_RUN_BEAT_MS, MASCOT_RUN_SWEEP_CELLS, MASCOT_W } from "../renderer/mascot.ts";
import { arcadeScale } from "../renderer/mascot_game.ts";
import { RUNNER_SCALE, runnerAt, type RunnerLayout } from "../renderer/mascot_runner.ts";
import {
  KATA_POSES, MINI_GAMES,
  applyKataInput, applyShurikenInput, createKataState, createShurikenState, createStackState,
  dropStackBlock, stepKata, stepShuriken, stepStack,
} from "../renderer/mascot_minigames.ts";

const fail = (msg: string): never => { console.error(`FAIL: ${msg}`); process.exit(1); };
const ok = (msg: string): void => console.log(`   ${msg} \u2713`);

console.log("== P-MASCOT.5 - arcade-parity runner + the game cabinet ==");

// (1) sprite-scale parity with the arcade (a wide panel paints the ninja at scale 2).
if (RUNNER_SCALE !== arcadeScale(1000)) fail(`runner scale ${RUNNER_SCALE} != arcade scale ${arcadeScale(1000)}`);
ok(`the prompt-bar ninja and the arcade ninja share one pixel scale (${RUNNER_SCALE})`);

// (2) no-slip stride: on every run beat, one sole holds the same world x it held on the last beat.
const L: RunnerLayout = { width: 900, barTop: MASCOT_H * RUNNER_SCALE + 10, barBottom: 300, height: 300, scale: RUNNER_SCALE };
const soles = (frameId: string): number[] => {
  const bottom = MASCOT_FRAMES[frameId]![MASCOT_H - 1]!;
  const centres: number[] = [];
  for (let x = 0; x < MASCOT_W; x++) {
    if (bottom[x] === ".") continue;
    let end = x;
    while (end + 1 < MASCOT_W && bottom[end + 1] !== ".") end++;
    centres.push((x + end) / 2);
    x = end;
  }
  return centres;
};
for (let beat = 1; beat < 8; beat++) {
  const world = (t: number): number[] => {
    const p = runnerAt(t, L);
    if (p.phase !== "run") fail("sampled outside the run phase");
    return soles(p.frame).map((c) => p.x + c * RUNNER_SCALE);
  };
  const before = world((beat - 1) * MASCOT_RUN_BEAT_MS + 1);
  const after = world(beat * MASCOT_RUN_BEAT_MS + 1);
  if (!before.some((a) => after.some((b) => Math.abs(a - b) < 1))) fail(`the planted foot skates on beat ${beat}`);
}
ok(`no-slip stride: a planted sole holds its ground on all 8 beats (${MASCOT_RUN_SWEEP_CELLS} cells/beat)`);

// (3) the cabinet registry: three games, stable ids, one-line labels.
if (MINI_GAMES.map((g) => g.id).join(",") !== "shuriken,kata,stack") fail("registry ids drifted");
for (const g of MINI_GAMES) if (!g.name || g.name.includes("\n") || !g.blurb || g.blurb.includes("\n")) fail(`bad label/blurb for ${g.id}`);
ok("registry: shuriken, kata, stack - names and blurbs are single lines");

// (4) each engine is deterministic and can actually score and actually end.
const runTwice = <S>(make: () => S, step: (s: S, t: number) => S): void => {
  let a = make(), b = make();
  for (let t = 16; t <= 4000; t += 16) { a = step(a, 16); b = step(b, 16); }
  if (JSON.stringify(a) !== JSON.stringify(b)) fail("engine is not deterministic");
};
runTwice(() => createShurikenState(640, 7), (s, t) => stepShuriken(s, t));
runTwice(() => createKataState(640, 7), (s, t) => stepKata(s, t));
runTwice(() => createStackState(640, 7), (s, t) => stepStack(s, t));
// Shuriken: spraying the middle lane for a run must land at least one hit.
let sh = createShurikenState(640, 7);
for (let t = 0; t < 60_000 && sh.hits === 0; t += 90) sh = applyShurikenInput(stepShuriken(sh, 90), "throw");
if (sh.hits <= 0) fail("shuriken range never scores");
// Kata: a wrong pose during the input phase ends the run.
let ka = createKataState(640, 7);
for (let t = 0; t < 30_000 && ka.phase !== "input"; t += 16) ka = stepKata(ka, 16);
if (ka.phase !== "input") fail("kata never reaches the input phase");
const wrong = KATA_POSES.find((p) => p !== ka.sequence[ka.cursor])!;
if (applyKataInput(ka, wrong).phase !== "over") fail("a broken kata must end the run");
// Stack: a centred drop builds height; a clean miss ends the tower.
let st = createStackState(640, 7);
const base = st.tower[st.tower.length - 1]!;
st = dropStackBlock({ ...st, blockX: base.x });
if (st.height !== 1 || st.phase !== "playing") fail("a centred crate must land");
const top = st.tower[st.tower.length - 1]!;
if (dropStackBlock({ ...st, blockX: top.x + top.width + 60 }).phase !== "over") fail("a missed crate must end the run");
ok("engines: deterministic, scoring reachable, loss conditions fire");

console.log("\nALL CHECKS PASSED");
