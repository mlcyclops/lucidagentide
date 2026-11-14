// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_mini_1.ts
//
// P-MINI.1 (ADR-0580): mini Lucid visits and sits down to type. Pure checks, no browser:
//   1. the seated typing scene is a full pixel grid, the hands alternate, and it differs from the idle pose
//   2. on the prompt bar he sits on the bar top and never over the prompt
//   3. the Developer's first new session of a launch always gets a visit
//   4. over a simulated day of 400 new sessions another role is visited 3 times, at least 30 minutes apart
//   5. Off means never, Always and the LUCID Agent role mean a resident who is greeted, not dismissed
//
// Run: bun run desktop/scripts/demo_p_mini_1.ts

import { KEYBOARD_WHOLE, MASCOT_PALETTE } from "../renderer/mascot.ts";
import { SCENE_H, SCENE_W, sceneRows } from "../renderer/mascot_mini.ts";
import { RUNNER_HEADROOM, typingBox, type RunnerLayout } from "../renderer/mascot_runner.ts";
import { VISITS_PER_DAY, VISIT_GAP_MS, localDay, miniMount, noteVisit, readLedger, shouldVisit, type MiniStore } from "../renderer/mini_lucid.ts";

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

console.log("2) on the prompt bar");
{
  const l: RunnerLayout = { width: 1600, barTop: RUNNER_HEADROOM * 2, barBottom: RUNNER_HEADROOM * 2 + 120, height: RUNNER_HEADROOM * 2 + 120, scale: 4 };
  const box = typingBox(l, 700);
  if (box.y + box.h !== l.barTop || box.y < 0) fail("he must sit on the bar top, inside the canvas");
  if (typingBox(l, -500).x !== 0 || typingBox(l, 9000).x !== l.width - box.w) fail("he must stay inside the bar");
  ok(`sits at y ${box.y}..${box.y + box.h} with the bar top at ${l.barTop}: never over the prompt`);
}

function memStore(): MiniStore {
  const data: Record<string, string> = {};
  return { getItem: (k) => (k in data ? data[k]! : null), setItem: (k, v) => { data[k] = v; } };
}
const day = new Date(2026, 10, 14, 8, 0, 0).getTime();

console.log("3) the Developer's first new session of a launch");
{
  const used = { day: localDay(day), count: 9, lastAt: day - 1000 };
  if (!shouldVisit({ role: "developer", presence: "sometimes", newSessionNumber: 1, ledger: used, now: day, rand: 0.99 })) fail("the first session must always get a visit");
  if (shouldVisit({ role: "developer", presence: "sometimes", newSessionNumber: 2, ledger: used, now: day, rand: 0 })) fail("a later session follows the ordinary limits");
  if (miniMount("developer", "sometimes", true).kind !== "visitor") fail("a visit mounts a visitor, who leaves on a click");
  ok("always visited, even with the day's visits used up; a click sends him away");
}

console.log("4) a simulated day: 400 new sessions, one every two minutes, Security role");
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

console.log("5) the preference and the LUCID Agent role");
{
  if (shouldVisit({ role: "developer", presence: "off", newSessionNumber: 1, ledger: readLedger(null, day), now: day, rand: 0 })) fail("Off must never visit");
  if (miniMount("developer", "off", true).kind !== "none") fail("Off must remove him even mid-visit");
  if (miniMount("security", "always", false).kind !== "resident") fail("Always is a resident");
  if (miniMount("lucid-agent", "off", false).kind !== "resident") fail("the LUCID Agent role keeps him whatever the preference");
  ok("Off: never. Always and the LUCID Agent role: a resident who is greeted by a click, not dismissed");
}

console.log("\ndemo_p_mini_1 OK - mini Lucid sits and types while a turn runs, visits the Developer's first session, drops by other sessions at most three times a day, and the preference wins.");
process.exit(0);
