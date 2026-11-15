// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_mini_1.ts
//
// P-MINI.1 (ADR-0580), brought up to P-MINI.3 (ADR-0596): mini Lucid visits and sits down to type. Pure checks,
// no browser:
//   1. the seated typing scene is a full pixel grid, the hands alternate, and it differs from the idle pose
//   2. on the prompt bar, at both sizes, he lives at the bar's right end, sits on the bar top to type and never
//      covers the prompt; he stays calm (no walk before four minutes, none while a turn runs)
//   3. a double-click sends a visitor off for good (dismissed once), a resident walks back in later, and a
//      right-click turns him off once
//   4. the Developer's first new session of a launch always gets a visit
//   5. over a simulated day of 400 new sessions another role is visited 3 times, at least 30 minutes apart
//   6. an untouched install has him Off outside the LUCID Agent role; Always and the LUCID Agent role mean a
//      resident; a right-click's turn-off beats even the LUCID Agent role
//
// Run: bun run desktop/scripts/demo_p_mini_1.ts

import { KEYBOARD_WHOLE, MASCOT_FRAMES, MASCOT_PALETTE } from "../renderer/mascot.ts";
import { SCENE_H, SCENE_W, sceneRows, typingRows } from "../renderer/mascot_mini.ts";
import {
  AWAY_MS, DASH_MS, TRAVERSE_MIN_MS, createRunnerBrain, homeSeatBox, paintedBottom, runnerCellPx, runnerGesture, runnerHeadroom, runnerPlan, standTop, startDash, stepRunnerBrain,
  type RunnerLayout, type RunnerWorld,
} from "../renderer/mascot_runner.ts";
import { MASCOT_CELL_CSS, MASCOT_SIZES, VISITS_PER_DAY, VISIT_GAP_MS, localDay, miniMount, noteVisit, parsePresence, readLedger, shouldVisit, type MiniStore } from "../renderer/mini_lucid.ts";

const fail = (m: string): never => { console.error(`FAIL: ${m}`); process.exit(1); };
const ok = (m: string): void => console.log(`   ok - ${m}`);
const count = (rows: readonly string[], ch: string): number => rows.reduce((n, r) => n + [...r].filter((c) => c === ch).length, 0);

console.log("1) the seated typing scene");
{
  const t0 = sceneRows("working", 0);
  const t1 = sceneRows("working", 150);
  if (t0.length !== SCENE_H || t0.some((r) => r.length !== SCENE_W)) fail("the scene must be a full grid");
  if (t0.some((r) => [...r].some((c) => c !== "." && !(c in MASCOT_PALETTE)))) fail("every cell must be a palette colour");
  const fist = (rows: readonly string[], left: boolean): number =>
    count(rows.slice(SCENE_H - KEYBOARD_WHOLE.length + 1).map((r) => (left ? r.slice(0, SCENE_W / 2) : r.slice(SCENE_W / 2))), "S");
  if (!(fist(t0, true) > fist(t1, true) && fist(t1, false) > fist(t0, false))) fail("the hands must alternate");
  if (sceneRows("idle", 0).join("") === t0.join("")) fail("typing must differ from the idle pose");
  // Half-resolution print: two rows and two columns per character, so the figure is recognisable in a terminal.
  const shade = (c: string): string => (c === "." ? " " : c === "S" || c === "s" ? "o" : c === "G" || c === "g" ? "=" : c === "W" ? "'" : c === "M" ? ":" : "#");
  for (let y = 0; y < SCENE_H; y += 2) console.log(`      ${[...t0[y]!].filter((_, x) => x % 2 === 0).map(shade).join("")}`);
  ok(`${SCENE_W} x ${SCENE_H} cells, left hand down at 0 ms and right hand down at 150 ms`);
}

/** The layout the runner measures for a size on a 900 x 120 CSS px composer at DPR 2. */
const layoutFor = (size: "small" | "large"): RunnerLayout => {
  const room = runnerHeadroom(MASCOT_CELL_CSS[size]);
  return { width: 1800, barTop: Math.round(room * 2), height: Math.round((room + 120) * 2), scale: runnerCellPx(size, 2) };
};
const worldFor = (l: RunnerLayout, over: Partial<RunnerWorld> = {}): RunnerWorld => {
  let seed = 11;
  const rand = (): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  return { busy: false, reduced: false, visitor: false, actMs: 0, rand, plan: runnerPlan(l), ...over };
};

console.log("2) on the prompt bar, at both sizes");
for (const size of MASCOT_SIZES) {
  const l = layoutFor(size);
  const p = runnerPlan(l);
  const stand = standTop(p, "idleA");
  if (stand + (paintedBottom(MASCOT_FRAMES.idleA!) + 1) * l.scale !== l.barTop || stand < 0) fail(`${size}: he must stand on the bar top, inside the canvas`);
  if (p.homeX + p.spriteW >= l.width || p.homeX < l.width / 2) fail(`${size}: home must be just inside the bar's right end`);
  const seat = typingRows(0);
  const box = homeSeatBox(l, p, seat);
  if (box.y + (paintedBottom(seat) + 1) * l.scale !== l.barTop || box.y < 0 || box.x + box.w > l.width) fail(`${size}: seated, he must sit on the bar top and inside the bar`);
  const busy = worldFor(l, { busy: true });
  const b = createRunnerBrain(busy.rand);
  for (let t = 0; t < 30 * 60_000; t += 50) stepRunnerBrain(b, 50, busy);
  if (b.mode !== "home") fail(`${size}: he must stay home while a turn runs`);
  const idle = worldFor(l);
  const c = createRunnerBrain(idle.rand);
  let walkAt = -1;
  for (let t = 50; t < 10 * 60_000 && walkAt < 0; t += 50) { stepRunnerBrain(c, 50, idle); if (c.mode === "traverse") walkAt = t; }
  if (walkAt < TRAVERSE_MIN_MS) fail(`${size}: his walk along the bar must wait at least four minutes (came at ${walkAt} ms)`);
  ok(`${size}: ${l.scale} device px a cell, home at x ${p.homeX}, seated at y ${box.y}..${box.y + box.h} on the bar top at ${l.barTop}; first walk after ${(walkAt / 60_000).toFixed(1)} min, none in 30 min of work`);
}

console.log("3) double-click and right-click");
{
  const l = layoutFor("small");
  const visitor = worldFor(l, { visitor: true });
  const v = createRunnerBrain(visitor.rand);
  startDash(v, -1, visitor.plan.homeX, visitor);
  let dismissed = 0;
  for (let t = 0; t < 3 * AWAY_MS; t += 50) if (stepRunnerBrain(v, 50, visitor) === "dismiss") dismissed++;
  if (dismissed !== 1 || v.mode !== "gone") fail("a visitor's dash must dismiss him exactly once, for good");
  const resident = worldFor(l);
  const r = createRunnerBrain(resident.rand);
  startDash(r, -1, resident.plan.homeX, resident);
  let homeAt = -1;
  for (let t = 50; t < 3 * AWAY_MS && homeAt < 0; t += 50) { stepRunnerBrain(r, 50, resident); if (r.mode === "home") homeAt = t; }
  if (homeAt < DASH_MS + AWAY_MS) fail("a resident must stay away a while before walking back in");
  const g = { lastTapAt: -Infinity, off: false };
  const offs = (["contextmenu", "contextmenu", "dblclick"] as const).map((x) => runnerGesture(g, x, 0)).filter((a) => a === "off").length;
  if (offs !== 1) fail("a right-click must turn him off exactly once");
  ok(`a visitor dashes off and is dismissed once; a resident is home again ${(homeAt / 1000).toFixed(0)} s later; a right-click turns him off once`);
}

function memStore(): MiniStore {
  const data: Record<string, string> = {};
  return { getItem: (k) => (k in data ? data[k]! : null), setItem: (k, v) => { data[k] = v; } };
}
const day = new Date(2026, 10, 14, 8, 0, 0).getTime();

console.log("4) the Developer's first new session of a launch");
{
  const used = { day: localDay(day), count: 9, lastAt: day - 1000 };
  if (!shouldVisit({ role: "developer", presence: "sometimes", newSessionNumber: 1, ledger: used, now: day, rand: 0.99 })) fail("the first session must always get a visit");
  if (shouldVisit({ role: "developer", presence: "sometimes", newSessionNumber: 2, ledger: used, now: day, rand: 0 })) fail("a later session follows the ordinary limits");
  if (miniMount("developer", "sometimes", true).kind !== "visitor") fail("a visit mounts a visitor, who leaves on a double-click");
  ok("always visited, even with the day's visits used up; a double-click sends him away");
}

console.log("5) a simulated day: 400 new sessions, one every two minutes, Security role");
{
  const store = memStore();
  const visits: number[] = [];
  let seed = 7;
  const rand = (): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let i = 0; i < 400; i++) {
    const now = day + i * 120_000;
    if (shouldVisit({ role: "security", presence: "sometimes", newSessionNumber: i + 1, ledger: readLedger(store, now), now, rand: rand() })) { noteVisit(store, now); visits.push(now); }
  }
  if (visits.length !== VISITS_PER_DAY) fail(`expected ${VISITS_PER_DAY} visits, got ${visits.length}`);
  for (let i = 1; i < visits.length; i++) if (visits[i]! - visits[i - 1]! < VISIT_GAP_MS) fail("two visits were closer than thirty minutes");
  ok(`${visits.length} visits, at ${visits.map((v) => new Date(v).toTimeString().slice(0, 5)).join(", ")}`);
}

console.log("6) the preference, the LUCID Agent role and the turn-off");
{
  if (parsePresence(null) !== "off") fail("an untouched install must have him Off outside the LUCID Agent role");
  if (shouldVisit({ role: "developer", presence: "off", newSessionNumber: 1, ledger: readLedger(null, day), now: day, rand: 0 })) fail("Off must never visit");
  if (miniMount("developer", "off", true).kind !== "none") fail("Off must remove him even mid-visit");
  if (miniMount("security", "always", false).kind !== "resident") fail("Always is a resident");
  if (miniMount("lucid-agent", "off", false).kind !== "resident") fail("the LUCID Agent role keeps him whatever the preference");
  if (miniMount("lucid-agent", "always", false, true).kind !== "none") fail("a right-click's turn-off must beat the LUCID Agent role");
  ok("Off by default and never visits; Always and the LUCID Agent role: a resident; turned off: nowhere");
}

console.log("\ndemo_p_mini_1 OK - mini Lucid lives calmly at the bar's right end at either size, sits and types while a turn runs, dashes off on a double-click, turns off on a right-click, visits the Developer's first session, drops by other sessions at most three times a day, and the preference wins.");
process.exit(0);
