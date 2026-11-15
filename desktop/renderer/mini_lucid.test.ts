// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/mini_lucid.test.ts - P-MINI.1 (ADR-0580): mini Lucid's seated scene (mascot_mini.ts), the
// runner's typing position (mascot_runner.ts) and the rules for when he visits (mini_lucid.ts).

import { describe, expect, test } from "bun:test";
import { KEYBOARD_WHOLE, MASCOT_FRAMES, MASCOT_PALETTE } from "./mascot.ts";
import { MINI_STATES, SCENE_H, SCENE_W, TYPING_BEAT_MS, limbCells, sceneRows, seatedRows, typingRows } from "./mascot_mini.ts";
import { runnerHeadroom, typingBox, type RunnerLayout } from "./mascot_runner.ts";
import {
  MASCOT_CELL_CSS,
  MASCOT_SIZES,
  MASCOT_SIZE_KEY,
  MINI_PRESENCES,
  MINI_PRESENCE_KEY,
  MINI_VISITS_KEY,
  VISITS_PER_DAY,
  VISIT_CHANCE,
  VISIT_GAP_MS,
  localDay,
  miniLucidCardHtml,
  miniMount,
  noteVisit,
  parseLedger,
  parseMascotSize,
  parsePresence,
  readLedger,
  readMascotHidden,
  readMascotSize,
  readPresence,
  shouldVisit,
  writeMascotHidden,
  writeMascotSize,
  writePresence,
  type MiniStore,
  type VisitInput,
  type VisitLedger,
} from "./mini_lucid.ts";

const count = (rows: readonly string[], ch: string): number => rows.reduce((n, r) => n + [...r].filter((c) => c === ch).length, 0);
const idleScene = (): string[] => sceneRows("idle", 0);

describe("the seated scene (mascot_mini.ts)", () => {
  test("every state paints a full SCENE_W x SCENE_H grid of palette cells", () => {
    for (const state of MINI_STATES) {
      for (const t of [0, 75, 150, 480, 1234, 5999]) {
        const rows = sceneRows(state, t);
        expect(rows.length).toBe(SCENE_H);
        for (const r of rows) {
          expect(r.length).toBe(SCENE_W);
          for (const c of r) expect(c === "." || c in MASCOT_PALETTE).toBe(true);
        }
      }
    }
  });

  test("the same state and time always give the same rows", () => {
    expect(sceneRows("working", 900)).toEqual(sceneRows("working", 900));
    expect(sceneRows("done", 400)).toEqual(sceneRows("done", 400));
  });

  test("working: the keyboard is on his lap with three lit keys, and the picture changes as he types", () => {
    const a = sceneRows("working", 0);
    const b = sceneRows("working", 150);
    expect(a).not.toEqual(b);
    // The keyboard's top edge is a full run of outline cells one keyboard wide.
    const top = "k".repeat(KEYBOARD_WHOLE[0]!.length);
    expect(a.some((r) => r.includes(top))).toBe(true);
    // Lit keys are the only "G" cells on the keyboard (its 8 rows end the scene); a fist can cover some of
    // the three, never all of them at both moments.
    const keys = (rows: readonly string[]): number => count(rows.slice(SCENE_H - KEYBOARD_WHOLE.length), "G");
    expect(keys(a)).toBeLessThanOrEqual(3);
    expect(keys(b)).toBeLessThanOrEqual(3);
    expect(keys(a) + keys(b)).toBeGreaterThanOrEqual(1);
    expect(keys(idleScene())).toBe(0); // no keyboard, so no lit key, when he is not working
    // Bare forearms: skin cells that the seated idle pose does not have at keyboard height.
    const idle = sceneRows("idle", 0);
    expect(count(a.slice(SCENE_H - 16), "S")).toBeGreaterThan(count(idle.slice(SCENE_H - 16), "S"));
  });

  test("working: the two hands alternate every 150 ms", () => {
    // Skin on the keyboard's own rows is a fist striking a key: the left one at 0 ms, the right one at 150.
    const fist = (rows: readonly string[], left: boolean): number => {
      const half = SCENE_W / 2;
      return count(rows.slice(SCENE_H - KEYBOARD_WHOLE.length + 1).map((r) => (left ? r.slice(0, half) : r.slice(half))), "S");
    };
    const t0 = sceneRows("working", 0);
    const t1 = sceneRows("working", 150);
    expect(fist(t0, true)).toBeGreaterThan(fist(t1, true));
    expect(fist(t1, false)).toBeGreaterThan(fist(t0, false));
    // And back again a beat later.
    expect(fist(sceneRows("working", 300), true)).toBeGreaterThan(fist(t1, true));
  });

  test("idle: eyes closed, opening and looking up on the glance; breathing shifts the head one row", () => {
    const rest = sceneRows("idle", 0);
    const look = sceneRows("idle", 0, { lookUp: true });
    expect(look).not.toEqual(rest);
    expect(count(look, "W")).toBeGreaterThan(count(rest, "W")); // open eyes show their whites
    expect(sceneRows("idle", 0, { breathe: true })).not.toEqual(rest);
  });

  test("done cycles the victory frames and error blinks, both standing", () => {
    const done = new Set([0, 250, 600, 800].map((t) => sceneRows("done", t).join("\n")));
    expect(done.size).toBeGreaterThanOrEqual(3);
    expect(sceneRows("error", 0)).not.toEqual(sceneRows("error", 200));
    expect(sceneRows("error", 200)).toEqual(sceneRows("error", 600)); // settled back to the plain frame
  });

  test("seatedRows keeps the frame size and only the head changes when the eyes open", () => {
    const closed = seatedRows();
    const open = seatedRows({ open: true });
    expect(closed).toEqual([...MASCOT_FRAMES.meditate!]);
    expect(open.length).toBe(closed.length);
    expect(open.slice(28)).toEqual(closed.slice(28));
    expect(open.slice(0, 28)).toEqual(MASCOT_FRAMES.idleA!.slice(0, 28));
  });

  test("limbCells: a capsule covers its bone, marks the inside negative, and is wider with a bulge", () => {
    const plain = limbCells([0, 0], [10, 0], 2, 2);
    const fat = limbCells([0, 0], [10, 0], 2, 2, 1.5);
    expect(plain.some((c) => c.x === 5 && c.y === 0 && c.edge < 0)).toBe(true);
    expect(plain.some((c) => c.x === 5 && c.y === 1 && c.below > 0)).toBe(true);
    expect(fat.filter((c) => c.edge <= 0).length).toBeGreaterThan(plain.filter((c) => c.edge <= 0).length);
  });

  test("typingRows repeats every 6 s and returns the cached rows for a beat", () => {
    expect(typingRows(0)).toEqual(sceneRows("working", 0));
    expect(typingRows(TYPING_BEAT_MS * 3 + 10)).toEqual(sceneRows("working", TYPING_BEAT_MS * 3));
    expect(typingRows(6000)).toBe(typingRows(0));
    expect(typingRows(-50)).toBe(typingRows(0));
  });
});

describe("the runner's typing position (mascot_runner.ts)", () => {
  const sky = runnerHeadroom(MASCOT_CELL_CSS.large) * 2;
  const layout = (width: number): RunnerLayout => ({ width, barTop: sky, height: sky + 100, scale: 4 });

  test("he sits on the bar top, at the walker's x", () => {
    const l = layout(1600);
    const box = typingBox(l, 500);
    expect(box).toEqual({ x: 500, y: l.barTop - SCENE_H * 4, w: SCENE_W * 4, h: SCENE_H * 4 });
    expect(box.y + box.h).toBe(l.barTop); // never over the prompt
    expect(box.y).toBeGreaterThanOrEqual(0); // inside the canvas headroom
  });

  test("he is kept inside the bar when the walker was off either end", () => {
    const l = layout(1600);
    expect(typingBox(l, -300).x).toBe(0);
    expect(typingBox(l, 5000).x).toBe(1600 - SCENE_W * 4);
  });
});

function memStore(init: Record<string, string> = {}): MiniStore & { data: Record<string, string> } {
  const data = { ...init };
  return { data, getItem: (k) => (k in data ? data[k]! : null), setItem: (k, v) => { data[k] = v; } };
}
const NOON = new Date(2026, 10, 14, 12, 0, 0).getTime();
const empty = (now = NOON): VisitLedger => ({ day: localDay(now), count: 0, lastAt: 0 });
const input = (over: Partial<VisitInput> = {}): VisitInput => ({ role: "security", presence: "sometimes", newSessionNumber: 2, ledger: empty(), now: NOON, rand: 0.1, ...over });

describe("when he visits (mini_lucid.ts)", () => {
  test("the Developer's first new session of a launch always gets him", () => {
    expect(shouldVisit(input({ role: "developer", newSessionNumber: 1, rand: 0.99 }))).toBe(true);
    // Even when the day's visits are used up and the last one was a minute ago.
    expect(shouldVisit(input({ role: "developer", newSessionNumber: 1, rand: 0.99, ledger: { day: localDay(NOON), count: 9, lastAt: NOON - 60_000 } }))).toBe(true);
  });

  test("a Developer's later sessions, and every other role, get him one time in four", () => {
    expect(shouldVisit(input({ role: "developer", newSessionNumber: 2, rand: VISIT_CHANCE - 0.01 }))).toBe(true);
    expect(shouldVisit(input({ role: "developer", newSessionNumber: 2, rand: VISIT_CHANCE }))).toBe(false);
    for (const role of ["security", "manager", "executive", null]) {
      expect(shouldVisit(input({ role, newSessionNumber: 1, rand: 0.2 }))).toBe(true);
      expect(shouldVisit(input({ role, newSessionNumber: 1, rand: 0.6 }))).toBe(false);
    }
  });

  test("never twice within thirty minutes, and never more than three times a day", () => {
    const recent: VisitLedger = { day: localDay(NOON), count: 1, lastAt: NOON - VISIT_GAP_MS + 1 };
    expect(shouldVisit(input({ ledger: recent, rand: 0 }))).toBe(false);
    expect(shouldVisit(input({ ledger: { ...recent, lastAt: NOON - VISIT_GAP_MS }, rand: 0 }))).toBe(true);
    const full: VisitLedger = { day: localDay(NOON), count: VISITS_PER_DAY, lastAt: NOON - 4 * VISIT_GAP_MS };
    expect(shouldVisit(input({ ledger: full, rand: 0 }))).toBe(false);
  });

  test("Off and Always never need a visit, and the LUCID Agent role never does", () => {
    expect(shouldVisit(input({ presence: "off", role: "developer", newSessionNumber: 1, rand: 0 }))).toBe(false);
    expect(shouldVisit(input({ presence: "always", rand: 0 }))).toBe(false);
    expect(shouldVisit(input({ role: "lucid-agent", rand: 0 }))).toBe(false);
  });

  test("over a simulated day of 400 new sessions he visits at most three times, at least thirty minutes apart", () => {
    const store = memStore();
    const start = new Date(2026, 10, 14, 8, 0, 0).getTime();
    const visits: number[] = [];
    let seed = 7;
    const rand = (): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    for (let i = 0; i < 400; i++) {
      const now = start + i * 2 * 60_000; // a new session every two minutes for over thirteen hours
      if (shouldVisit({ role: "security", presence: "sometimes", newSessionNumber: i + 1, ledger: readLedger(store, now), now, rand: rand() })) {
        noteVisit(store, now);
        visits.push(now);
      }
    }
    expect(visits.length).toBe(VISITS_PER_DAY);
    for (let i = 1; i < visits.length; i++) expect(visits[i]! - visits[i - 1]!).toBeGreaterThanOrEqual(VISIT_GAP_MS);
  });

  test("the ledger: a new day resets the count and keeps the last visit time; junk is an empty ledger", () => {
    const yesterday = NOON - 24 * 3600_000;
    const stored = JSON.stringify({ day: localDay(yesterday), count: 3, lastAt: yesterday });
    expect(parseLedger(stored, NOON)).toEqual({ day: localDay(NOON), count: 0, lastAt: yesterday });
    expect(parseLedger(null, NOON)).toEqual(empty());
    expect(parseLedger("{not json", NOON)).toEqual(empty());
    expect(parseLedger(JSON.stringify({ day: localDay(NOON), count: -4, lastAt: "soon" }), NOON)).toEqual(empty());
    // A last visit in the future (a clock that moved back) is ignored, so it cannot block visits forever.
    expect(parseLedger(JSON.stringify({ day: localDay(NOON), count: 1, lastAt: NOON + 5000 }), NOON).lastAt).toBe(0);
  });

  test("noteVisit counts the visit and stores it; a blocked store changes nothing and does not throw", () => {
    const store = memStore();
    expect(noteVisit(store, NOON)).toEqual({ day: localDay(NOON), count: 1, lastAt: NOON });
    expect(noteVisit(store, NOON + 1000).count).toBe(2);
    expect(JSON.parse(store.data[MINI_VISITS_KEY]!)).toEqual({ day: localDay(NOON), count: 2, lastAt: NOON + 1000 });
    const blocked: MiniStore = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(noteVisit(blocked, NOON).count).toBe(1);
    expect(readLedger(blocked, NOON)).toEqual(empty());
    expect(noteVisit(null, NOON).count).toBe(1);
  });

  test("P-MINI.3: the preference defaults to Off, round-trips, and anything unknown reads as Off", () => {
    const store = memStore();
    expect(readPresence(store)).toBe("off");
    writePresence(store, "sometimes");
    expect(store.data[MINI_PRESENCE_KEY]).toBe("sometimes");
    expect(readPresence(store)).toBe("sometimes");
    expect(parsePresence("always")).toBe("always");
    expect(parsePresence("ALWAYS")).toBe("off");
    expect(parsePresence(undefined)).toBe("off");
    expect(readPresence(null)).toBe("off");
  });

  test("P-MINI.3: the size defaults to Small, round-trips, and anything unknown reads as Small", () => {
    const store = memStore();
    expect(readMascotSize(store)).toBe("small");
    writeMascotSize(store, "large");
    expect(store.data[MASCOT_SIZE_KEY]).toBe("large");
    expect(readMascotSize(store)).toBe("large");
    expect(parseMascotSize("LARGE")).toBe("small");
    expect(readMascotSize(null)).toBe("small");
    expect(MASCOT_CELL_CSS.large).toBe(2 * MASCOT_CELL_CSS.small);
  });

  test("P-MINI.3: a right-click's turn-off persists until turned back on; a blocked store reads as shown", () => {
    const store = memStore();
    expect(readMascotHidden(store)).toBe(false);
    writeMascotHidden(store, true);
    expect(readMascotHidden(store)).toBe(true);
    writeMascotHidden(store, false);
    expect(readMascotHidden(store)).toBe(false);
    const blocked: MiniStore = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(readMascotHidden(blocked)).toBe(false);
    expect(() => writeMascotHidden(blocked, true)).not.toThrow();
  });

  test("miniMount: who is on the prompt bar", () => {
    expect(miniMount("lucid-agent", "off", false)).toEqual({ kind: "resident" }); // the Agent role keeps him
    expect(miniMount("developer", "always", false)).toEqual({ kind: "resident" });
    expect(miniMount("developer", "sometimes", true)).toEqual({ kind: "visitor" });
    expect(miniMount("developer", "sometimes", false)).toEqual({ kind: "none" });
    expect(miniMount("developer", "off", true)).toEqual({ kind: "none" }); // Off ends a visit
    expect(miniMount(null, "sometimes", true)).toEqual({ kind: "visitor" });
    // P-MINI.3: turned off by a right-click beats every role and preference, the Agent role included.
    expect(miniMount("lucid-agent", "always", false, true)).toEqual({ kind: "none" });
    expect(miniMount("developer", "always", false, true)).toEqual({ kind: "none" });
    expect(miniMount("developer", "sometimes", true, true)).toEqual({ kind: "none" });
  });

  test("the Settings card: the show switch, the presence and size choices with the stored ones checked, each row's text one span", () => {
    const esc = (s: string): string => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
    const h = miniLucidCardHtml("off", esc, "<i></i>", "large", false);
    for (const p of MINI_PRESENCES) expect(h).toContain(`name="miniPresence" value="${p}"`);
    for (const z of MASCOT_SIZES) expect(h).toContain(`name="mascotSize" value="${z}"`);
    expect(h).toContain('name="miniPresence" value="off" checked');
    expect(h).toContain('name="mascotSize" value="large" checked');
    expect(h).toContain('id="mascotShown" checked');
    expect(h.split(" checked").length - 1).toBe(3);
    expect(miniLucidCardHtml("off", esc, "", "small", true)).not.toContain('id="mascotShown" checked');
    // Invariant 11: a set-toggle label holds its input and ONE span, never loose text beside inline tags.
    expect(h.match(/<label class="set-toggle"><input [^>]*\/>\s*<span>.*?<\/span><\/label>/gs)?.length).toBe(1 + MINI_PRESENCES.length + MASCOT_SIZES.length);
    expect(h).toContain('<div class="set-note">');
  });
});
