// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/mascot.ts - P-MASCOT.1 (ADR-0251 direction pivot): LUCID the ninja.
//
// An ORIGINAL fighting-game-style pixel ninja who lives on the immersive stage: he practices kata,
// throws shuriken, and meditates WHILE the agent works, guards attentively while the mic listens,
// gestures while replies are spoken, strikes a victory pose when a turn lands, and just breathes when
// idle. Pixel frames are hand-authored CHARACTER GRIDS in code (20x26 cells, palette below) - no binary
// assets, no likeness, no uncanny valley by construction (the lesson of the killed face direction).
//
// PURE except paintFrame (which takes a caller-owned 2D context): frames, validation, the animation
// state machine, and the working-activity scheduler are all deterministic and unit-tested. app.ts owns
// the canvas + the ~10fps ticker.

export const MASCOT_W = 20;
export const MASCOT_H = 26;

/** Palette: char -> css color. '.' is transparent. Neon green ties him to the LUCID brand. */
export const MASCOT_PALETTE: Record<string, string> = {
  k: "#10161d", // outline / near-black
  K: "#223140", // gi navy
  D: "#18232e", // gi shadow
  S: "#eec39a", // skin
  G: "#41ff8b", // neon accent - headband, belt, scarf tails
  g: "#1e8f52", // deep green shade
  W: "#f4f7f5", // eye white
  B: "#0a0e12", // pupil / mask slit
  M: "#c2d1dc", // steel (shuriken)
};

type Rows = string[];

/** Clone base rows with row-index overrides - variants stay diffs, so the character stays consistent. */
function rows(base: Rows, over: Record<number, string> = {}): Rows {
  const out = base.slice();
  for (const [i, r] of Object.entries(over)) out[Number(i)] = r;
  return out;
}

// The base standing ninja, facing the viewer with a slight fighter's lean. Head rows 0-11 (chibi -
// mascot proportions), torso 12-19 (belt 17), legs 20-25.
const BASE: Rows = [
  "....kkkkkkkkkk......",
  "...kKKKKKKKKKKk.....",
  "..kKKKKKKKKKKKKk....",
  ".kKKKKKKKKKKKKKKk...",
  ".kGGGGGGGGGGGGGGk...",
  ".kGGGGGGGGGGGGGGkGG.",
  ".kSSWWBSSSSWWBSSk.G.",
  ".kSSWWBSSSSWWBSSk...",
  ".kKKKKKKKKKKKKKKk...",
  ".kKKKKKKKKKKKKKKk...",
  "..kKKKKKKKKKKKKk....",
  "...kkKKKKKKKKkk.....",
  "....kKKKKKKKKk......",
  "..kkKKKKKKKKKKkk....",
  ".kKKDKKKKKKKKDKKk...",
  ".kKKDkKKKKKKkDKKk...",
  ".kSSkkKKKKKKkkSSk...",
  "..kk.kGGGGGGk.kk....",
  ".....kKKKKKKk.......",
  ".....kKKKKKKk.......",
  ".....kDKkkKDk.......",
  "....kKKk..kKKk......",
  "....kKKk..kKKk......",
  "....kDDk..kDDk......",
  "...kkkkk..kkkkk.....",
  "....................",
];

// ── Frames ──────────────────────────────────────────────────────────────────────────────────────
export const MASCOT_FRAMES: Record<string, Rows> = {
  // Idle: a calm breath (body settles one row) and an occasional blink; scarf tails drift.
  idleA: BASE,
  idleB: rows(BASE, {
    5: ".kGGGGGGGGGGGGGGk.G.",
    6: ".kSSWWBSSSSWWBSSkG..",
    13: "..kkKKKKKKKKKKkk....",
    14: ".kKKDKKKKKKKKDKKk...",
  }),
  blink: rows(BASE, {
    6: ".kSSkkkSSSSkkkSSk...",
    7: ".kSSSSSSSSSSSSSSk...",
  }),
  // Listening: guard up, eyes steady - attentive, coiled.
  guard: rows(BASE, {
    14: ".kKKDKKKKKKKKDKKk...",
    15: ".kSSkKKKKKKKKkSSk...",
    16: ".kSSkkKKKKKKkkSSk...",
  }),
  // Speaking: an open-hand gesture that alternates sides - talking with his hands.
  talkA: rows(BASE, {
    14: ".kKKDKKKKKKKKDSSk...",
    15: ".kKKDkKKKKKKkSSk....",
    16: ".kSSkkKKKKKKkkk.....",
  }),
  talkB: rows(BASE, {
    14: ".kSSDKKKKKKKKDKKk...",
    15: "..kSSkKKKKKKkDKKk...",
    16: "...kkkKKKKKKkkSSk...",
  }),
  // Kata: jab and a snap kick - practice while the real work runs.
  punchA: rows(BASE, {
    14: ".kKKDKKKKKKKKDkkk...",
    15: ".kKKDkKKKKKKkSSSSk..",
    16: ".kSSkkKKKKKKkkkkk...",
  }),
  punchB: rows(BASE, {
    14: ".kKKDKKKKKKKKDkkkkk.",
    15: ".kKKDkKKKKKKkSSSSSSk",
    16: ".kSSkkKKKKKKkkkkkk..",
  }),
  kickA: rows(BASE, {
    20: ".....kDKkkKDkk......",
    21: "....kKKk..kKKKk.....",
    22: "....kKKk...kKKKk....",
    23: "....kDDk....kkkk....",
    24: "...kkkkk............",
  }),
  kickB: rows(BASE, {
    20: ".....kDKkkKDkkkk....",
    21: "....kKKk..kKKKKKKk..",
    22: "....kKKk....kkkkkk..",
    23: "....kDDk............",
    24: "...kkkkk............",
  }),
  // Shuriken practice: wind up, release - the star flies off-frame.
  throwA: rows(BASE, {
    13: "..kkKKKKKKKKKKkkM...",
    14: ".kKKDKKKKKKKKDSSMk..",
    15: ".kKKDkKKKKKKkSSk....",
    16: ".kSSkkKKKKKKkkk.....",
  }),
  throwB: rows(BASE, {
    13: "..kkKKKKKKKKKKkk..M.",
    14: ".kKKDKKKKKKKKDkkk.M.",
    15: ".kKKDkKKKKKKkSSSSk..",
    16: ".kSSkkKKKKKKkkkkk...",
  }),
  // Meditation: cross-legged, hands together, eyes closed - the long-haul work pose.
  meditate: rows(BASE, {
    6: ".kSSkkkSSSSkkkSSk...",
    7: ".kSSSSSSSSSSSSSSk...",
    14: ".kKKDKKKKKKKKDKKk...",
    15: "..kSSkKKKKKKkSSk....",
    16: "...kkSSKKKKSSkk.....",
    17: "....kGGGGGGGGk......",
    18: "...kKKKKKKKKKKk.....",
    19: "..kKKKKkkkkKKKKk....",
    20: ".kKKKKk....kKKKKk...",
    21: ".kkkkk......kkkkk...",
    22: "....................",
    23: "....................",
    24: "....................",
  }),
  // P-MASCOT.2: the composer runner's parkour set.
  // Run: a two-beat stride, arms pumping, legs scissored.
  runA: rows(BASE, {
    14: ".kKKDKKKKKKKKDSSk...",
    15: ".kSSDkKKKKKKkDkk....",
    16: "..kkkkKKKKKKkk......",
    20: ".....kDKkkKDk.......",
    21: "...kKKk....kKKk.....",
    22: "..kKKk......kKKk....",
    23: "..kDDk.......kkk....",
    24: ".kkkk...............",
  }),
  runB: rows(BASE, {
    14: ".kSSDKKKKKKKKDKKk...",
    15: "..kkDkKKKKKKkDSSk...",
    16: "......kKKKKKKkkkk...",
    20: ".....kDKkkKDk.......",
    21: ".....kKKkkKKk.......",
    22: "....kKKk..kKKk......",
    23: "....kkk....kDDk.....",
    24: "...........kkkk.....",
  }),
  // P-MASCOT.3: the full four-beat gait (contact - pass - contact - pass) for smooth locomotion.
  runC: rows(BASE, {
    14: ".kSSDKKKKKKKKDKKk...",
    15: "..kkDkKKKKKKkDSSk...",
    16: "......kKKKKKKkkkk...",
    20: ".....kDKkkKDk.......",
    21: ".....kKKk.kKKk......",
    22: "....kKKk...kKKk.....",
    23: "....kkk.....kDDk....",
    24: "............kkkk....",
  }),
  runD: rows(BASE, {
    14: ".kKKDKKKKKKKKDSSk...",
    15: ".kSSDkKKKKKKkDkk....",
    16: "..kkkkKKKKKKkk......",
    20: ".....kDKkkKDk.......",
    21: "....kKKkkkKKk.......",
    22: "....kKKk..kKKk......",
    23: "....kDDk..kkk.......",
    24: "...kkkk.............",
  }),
  // Hang: both arms straight up, gripping a ledge - the peek over the prompt bar.
  hang: rows(BASE, {
    12: ".kSSkKKKKKKKKkSSk...",
    13: ".kSSkKKKKKKKKkSSk...",
    14: ".kKKDKKKKKKKKDKKk...",
    15: ".kKKDkKKKKKKkDKKk...",
    16: "..kkkkKKKKKKkkkk....",
    21: "....kKKk..kKKk......",
    22: "....kKKkkkKKk.......",
    23: ".....kDDkkDD........",
    24: "......kkkkk.........",
  }),
  // P-MASCOT.3: alternate grip (climb wiggle) and the mantle over the edge.
  hangB: rows(BASE, {
    11: "...kkKKKKKKKKkkSS...",
    12: ".kSSkKKKKKKKKkSSk...",
    13: ".kSSkKKKKKKKKkkk....",
    14: ".kKKDKKKKKKKKDKKk...",
    15: ".kKKDkKKKKKKkDKKk...",
    16: "..kkkkKKKKKKkkkk....",
    21: "....kKKk..kKKk......",
    22: "....kKKkkkKKk.......",
    23: ".....kDDkkDD........",
    24: "......kkkkk.........",
  }),
  mantle: rows(BASE, {
    12: "....kKKKKKKKKk......",
    13: "..kkKKKKKKKKKKkk....",
    14: ".kSSDKKKKKKKKDSSk...",
    15: ".kkkkkKKKKKKkkkkk...",
    16: "......kKKKKKKk......",
    20: "....kDKkkKDkkk......",
    21: "...kKKk..kKKKKk.....",
    22: "...kKKk...kkkkk.....",
    23: "...kDDk.............",
    24: "..kkkkk.............",
  }),
  // Landing squash: knees deep, arms out - the drop's full stop.
  land: rows(BASE, {
    14: ".kSSDKKKKKKKKDSSk...",
    15: ".kkkDkKKKKKKkDkkk...",
    16: "....kkKKKKKKkk......",
    20: "...kkDKkkKDkk.......",
    21: "..kKKKk..kKKKk......",
    22: ".kKKkk....kkKKk.....",
    23: ".kkkk......kkkk.....",
    24: "....................",
  }),
  // Sneak: low, wide, knees bent - crawling along the top edge of the bar.
  sneakA: rows(BASE, {
    20: "....kDKkkKDkk.......",
    21: "..kkKKk..kKKKkk.....",
    22: ".kKKkk....kkKKKk....",
    23: ".kkkk......kkkkk....",
    24: "....................",
  }),
  sneakB: rows(BASE, {
    20: "....kkDKkkKDk.......",
    21: "...kkKKKk..kKKkk....",
    22: "..kKKKkk....kkKKk...",
    23: "..kkkkk......kkkk...",
    24: "....................",
  }),
  // Fall: arms up, legs tucked - the silent drop.
  fall: rows(BASE, {
    12: ".kSSkKKKKKKKKkSSk...",
    13: ".kSSkKKKKKKKKkSSk...",
    14: ".kKKDKKKKKKKKDKKk...",
    15: ".kKKDkKKKKKKkDKKk...",
    16: "..kkkkKKKKKKkkkk....",
    20: "....kDKkkKDkk.......",
    21: "...kKKKkkKKKk.......",
    22: "....kkkkkkkk........",
    23: "....................",
    24: "....................",
  }),
  // P-AVATAR.6b: the blade set - reach across, unsheathe high, cut through, follow through low.
  draw: rows(BASE, {
    12: "..MMkKKKKKKKKk......",
    13: "..kkKKKKKKKKKKkk....",
    14: ".kKKSSSKKKKKKDKKk...",
    15: ".kKKDkKKKKKKkDKKk...",
    16: "..kkkkKKKKKKkkkk....",
  }),
  slashUp: rows(BASE, {
    12: "....kKKKKKKKKkM.....",
    13: "..kkKKKKKKKKKSSk....",
    14: ".kKKDKKKKKKKKDkk....",
    15: ".kKKDkKKKKKKkDKKk...",
    16: "..kkkkKKKKKKkkkk....",
  }),
  slash: rows(BASE, {
    14: ".kKKDKKKKKKKKDSSkM..",
    15: ".kKKDkKKKKKKkSSSkk..",
    16: "..kkkkKKKKKKkkkk....",
    20: "....kDKkkKDkk.......",
    21: "...kKKk..kKKKk......",
    22: "..kKKk....kKKKk.....",
    23: "..kDDk.....kkkk.....",
    24: ".kkkkk..............",
  }),
  slashEnd: rows(BASE, {
    14: ".kKKDKKKKKKKKDKKk...",
    15: ".kKKDkKKKKKKkDSSk...",
    16: "..kkkkKKKKKKkkSSkM..",
    20: "....kDKkkKDkk.......",
    21: "...kKKk..kKKKk......",
    22: "..kKKk....kKKKk.....",
    23: "..kDDk.....kkkk.....",
    24: ".kkkkk..............",
  }),
  // Victory: feet leave the ground, fist to the sky.
  victoryA: rows(BASE, {
    13: "..kkKKKKKKKKKKkkSSk.",
    14: ".kKKDKKKKKKKKDkSSk..",
    15: ".kKKDkKKKKKKkDkk....",
    16: ".kSSkkKKKKKKkk......",
    21: "....kKKk..kKKk......",
    22: "....kDDk..kDDk......",
    23: "...kkkkk..kkkkk.....",
    24: "....................",
  }),
  victoryB: rows(BASE, {
    12: "....kKKKKKKKKk...SS.",
    13: "..kkKKKKKKKKKKkkSSk.",
    14: ".kKKDKKKKKKKKDkkk...",
    15: ".kKKDkKKKKKKkDk.....",
    16: ".kSSkkKKKKKKkk......",
    20: ".....kDKkkKDk.......",
    21: "....kKKkkkKKk.......",
    22: "....kDDk..kDDk......",
    23: "...kkkkk..kkkkk.....",
    24: "....................",
  }),
};

// ── Animation state machine ─────────────────────────────────────────────────────────────────────
export type MascotState = "idle" | "listening" | "speaking" | "working" | "victory";
export interface MascotInputs { speaking: boolean; listening: boolean; working: boolean }

export const VICTORY_MS = 1500;
const ACTIVITY_MS = 6500; // how long each working activity runs before rotating

interface Beat { frame: keyof typeof MASCOT_FRAMES & string; ms: number }
const LOOPS: Record<Exclude<MascotState, "working">, Beat[]> = {
  idle: [{ frame: "idleA", ms: 2100 }, { frame: "idleB", ms: 900 }, { frame: "idleA", ms: 1300 }, { frame: "blink", ms: 140 }],
  listening: [{ frame: "guard", ms: 1400 }, { frame: "idleB", ms: 220 }],
  speaking: [{ frame: "talkA", ms: 420 }, { frame: "idleA", ms: 260 }, { frame: "talkB", ms: 420 }, { frame: "idleA", ms: 220 }],
  victory: [{ frame: "victoryA", ms: 220 }, { frame: "victoryB", ms: 320 }],
};
/** The three things he practices while the agent works, rotated every ACTIVITY_MS. */
export const WORK_ACTIVITIES: readonly string[] = ["kata", "shuriken", "meditate"];
const WORK_LOOPS: Record<string, Beat[]> = {
  kata: [
    { frame: "idleA", ms: 500 }, { frame: "punchA", ms: 160 }, { frame: "punchB", ms: 260 },
    { frame: "punchA", ms: 140 }, { frame: "idleA", ms: 340 }, { frame: "kickA", ms: 170 },
    { frame: "kickB", ms: 280 }, { frame: "kickA", ms: 150 },
  ],
  shuriken: [
    { frame: "idleA", ms: 600 }, { frame: "throwA", ms: 300 }, { frame: "throwB", ms: 380 }, { frame: "idleB", ms: 420 },
  ],
  meditate: [{ frame: "meditate", ms: 2600 }, { frame: "meditate", ms: 2600 }],
};

export interface MascotSnap {
  state: MascotState;
  /** When the current state was entered (drives loop position + activity rotation). */
  since: number;
  /** Victory expiry when state === "victory". */
  until: number;
}

/** Advance the machine. Priorities: an active victory finishes > speaking > listening > working > idle.
 *  Finishing WORK (working -> not working) triggers the victory pose - the turn landed. Pure. */
export function stepMascot(prev: MascotSnap | null, i: MascotInputs, now: number): MascotSnap {
  const p = prev ?? { state: "idle" as MascotState, since: now, until: 0 };
  if (p.state === "victory" && now < p.until) return p;
  if (p.state === "working" && !i.working && !i.speaking) {
    return { state: "victory", since: now, until: now + VICTORY_MS };
  }
  const next: MascotState = i.speaking ? "speaking" : i.listening ? "listening" : i.working ? "working" : "idle";
  if (next === p.state) return p;
  return { state: next, since: now, until: 0 };
}

/** The activity he is practicing `elapsed` ms into a working stretch. */
export function workActivity(elapsedMs: number): string {
  return WORK_ACTIVITIES[Math.floor(Math.max(0, elapsedMs) / ACTIVITY_MS) % WORK_ACTIVITIES.length]!;
}

/** The frame to show for a snapshot at `now`. Pure table lookup over the loop's beat timeline. */
export function mascotFrame(snap: MascotSnap, now: number): string {
  const elapsed = Math.max(0, now - snap.since);
  const beats = snap.state === "working" ? WORK_LOOPS[workActivity(elapsed)]! : LOOPS[snap.state];
  const cycle = beats.reduce((s, b) => s + b.ms, 0);
  let t = elapsed % cycle;
  for (const b of beats) { if (t < b.ms) return b.frame; t -= b.ms; }
  return beats[0]!.frame;
}

// P-AVATAR.6b: the sacrificial keyboard - a PROP, not a mascot frame. v2 (user: v1 was unreadable):
// 24x8 with a steel deck, THREE visible keycap rows separated by deck lines, and a wide spacebar, so it
// reads as a keyboard at a glance. Halves carry a jagged cut edge.
// v3 (user: v2's steel deck read as a solid white slab): DARK deck, individual grey keycaps ('M') on
// key rows 2 and 4 at every even column 2..20, grey spacebar. While the keyboard is ALIVE a few caps
// light up neon and hop around like typing (keyboardLitKeys below); a sliced keyboard goes dark forever.
export const KEYBOARD_WHOLE: readonly string[] = [
  "kkkkkkkkkkkkkkkkkkkkkkkk",
  "kDDDDDDDDDDDDDDDDDDDDDDk",
  "kDMkMkMkMkMkMkMkMkMkMkDk",
  "kDDDDDDDDDDDDDDDDDDDDDDk",
  "kDMkMkMkMkMkMkMkMkMkMkDk",
  "kDDDDDDDDDDDDDDDDDDDDDDk",
  "kDDkMMMMMMMMMMMMMMkDDDDk",
  "kkkkkkkkkkkkkkkkkkkkkkkk",
];
export const KEYBOARD_LEFT: readonly string[] = [
  "kkkkkkkkkkkk",
  "kDDDDDDDDDDk",
  "kDMkMkMkMkkk",
  "kDDDDDDDDDk.",
  "kDMkMkMkMkDk",
  "kDDDDDDDDDkk",
  "kDDkMMMMMMk.",
  "kkkkkkkkkkk.",
];
export const KEYBOARD_RIGHT: readonly string[] = [
  "kkkkkkkkkkkk",
  "kDDDDDDDDDDk",
  "kkkMkMkMkMDk",
  ".kDDDDDDDDDk",
  "kkMkMkMkMkDk",
  ".kDDDDDDDDDk",
  "kkMMMMMMkDDk",
  ".kkkkkkkkkkk",
];

/** Which keycaps glow right now, in KEYBOARD_WHOLE grid coords. A deterministic pseudo-typing hop:
 *  three fingers walking different strides across the two key rows. A SLICED keyboard returns [] -
 *  the lights die with the cut and never come back. Pure. */
export function keyboardLitKeys(tMs: number, sliced: boolean): { col: number; row: number }[] {
  if (sliced) return [];
  const step = Math.floor(Math.max(0, tMs) / 150); // a new chord every 150ms - typing cadence
  const out: { col: number; row: number }[] = [];
  for (let finger = 0; finger < 3; finger++) {
    const keyIdx = (step * (3 + finger * 2) + finger * 4) % 10; // 10 keys per row
    const row = ((step >> 2) + finger) % 2 === 0 ? 2 : 4;
    out.push({ col: 2 + keyIdx * 2, row });
  }
  return out;
}

// P-AVATAR.6b v2: the katana as PROPS (user: the in-frame sword was too small - a 20-col character
// grid cannot hold a real blade). Flat = full horizontal extension for the cut; the diagonal is built
// once at module load (tip top-right, W edge over M body, 2px thick).
export const BLADE_FLAT: readonly string[] = [
  "WWWWWWWWWWWWWWWWWW",
  "MMMMMMMMMMMMMMMMMW",
];
const diag: string[] = [];
for (let y = 0; y < 12; y++) {
  const row = Array.from({ length: 13 }, () => ".");
  const c = 12 - y;
  row[c] = "W";
  if (c - 1 >= 0 && y > 0) row[c - 1] = "M";
  diag.push(row.join(""));
}
export const BLADE_DIAG: readonly string[] = diag;

/** Horizontal mirror of a frame (rows reversed char-by-char; the palette has no directional glyphs).
 *  Pure - the runner alternates direction by mirroring, never by authoring second copies. */
export function mirrorFrame(f: Rows): Rows {
  return f.map((r) => [...r].reverse().join(""));
}

export interface MascotHandle { update(i: MascotInputs): void; dispose(): void }

/** Mount the mascot into `host`: a DPR-crisp canvas, a ~10fps beat ticker, bottom-center anchored.
 *  The caller feeds live inputs via update(); everything decidable is in the pure functions above. */
export function mountMascot(host: HTMLElement): MascotHandle {
  const cv = document.createElement("canvas");
  cv.style.cssText = "position:absolute;inset:0;width:100%;height:100%";
  host.appendChild(cv);
  const ctx = cv.getContext("2d")!;
  let snap: MascotSnap | null = null;
  let inputs: MascotInputs = { speaking: false, listening: false, working: false };
  let lastFrame = "";
  const paint = (frameId: string): void => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(host.clientWidth * dpr)), h = Math.max(1, Math.floor(host.clientHeight * dpr));
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    ctx.clearRect(0, 0, w, h);
    // Integer scale, companion-sized (~32% of stage height - the 55% hero draped over the empty-state
    // logo, user call 2026-08-01), anchored low so the centered welcome copy stays clear.
    const scale = Math.max(2, Math.floor(Math.min(w / (MASCOT_W * 2.6), (h * 0.32) / MASCOT_H)));
    const ox = Math.floor((w - MASCOT_W * scale) / 2);
    const oy = Math.floor(h * 0.86 - MASCOT_H * scale);
    paintFrame(ctx, frameId, scale, ox, oy);
  };
  const tick = (): void => {
    if (document.hidden) return; // resumes on the next tick once visible
    const now = performance.now();
    snap = stepMascot(snap, inputs, now);
    const f = mascotFrame(snap, now);
    if (f !== lastFrame) { lastFrame = f; paint(f); }
  };
  const timer = window.setInterval(tick, 100);
  const ro = new ResizeObserver(() => { lastFrame = ""; tick(); });
  ro.observe(host);
  tick();
  return {
    update(i) { inputs = i; },
    dispose() { window.clearInterval(timer); ro.disconnect(); cv.remove(); },
  };
}

/** Paint raw frame rows crisp (nearest-neighbor) at integer `scale`, top-left (ox, oy). */
export function paintRows(ctx: CanvasRenderingContext2D, f: readonly string[], scale: number, ox: number, oy: number): void {
  for (let y = 0; y < f.length; y++) {
    const row = f[y]!;
    for (let x = 0; x < row.length; x++) {
      const c = MASCOT_PALETTE[row[x]!];
      if (!c) continue;
      ctx.fillStyle = c;
      ctx.fillRect(ox + x * scale, oy + y * scale, scale, scale);
    }
  }
}

/** Paint a frame by id (the runner paints mirrored rows via paintRows directly). */
export function paintFrame(ctx: CanvasRenderingContext2D, frameId: string, scale: number, ox: number, oy: number): void {
  paintRows(ctx, MASCOT_FRAMES[frameId] ?? MASCOT_FRAMES.idleA!, scale, ox, oy);
}
