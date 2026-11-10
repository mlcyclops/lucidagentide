// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/mascot_season.ts - P-SEASON.1 (ADR-0525): LUCID's seasonal costume and act.
//
// Every special theme dresses the ninja (a gi/accent recolor plus an optional head or chest piece) and
// gives him one short act, 1.8 to 3.6 s, choreographed from the EXISTING body frames in mascot.ts with
// pixel prop sprites on top: a football he slices in half, a gift a star pops out of, a dove he
// releases. Everything here is PURE except paintSeasonExtras (which takes a caller-owned context):
// sprites are rasterised once at module load, an act is a closed-form function of t, and the head
// anchor that hats ride on is derived from each frame's own grid, so a hat sits right on every frame.
//
// Coordinates are mascot CELLS in the unmirrored 40x52 sprite box, top-left (0, 0); the feet stand on
// row 50 and GROUND (51) is the first row below them. Props may leave the box on any side (a ball
// volleyed away flies off to the right). Props are GROUND-relative: an act that lifts the body (a jump)
// lifts the props it holds itself, so world props (a pot, a flag pole) never jump with him.
//
// Pixel size: the ninja is authored as a chunky 20x26 grid upscaled to 40x52, so props are painted at
// TWO cells per sprite pixel to match him (the `px` of def()). Fine work (hats, badges, thin lines, the pole,
// the rainbow) is one cell per pixel, like his eyes.

import { MASCOT_FRAMES, MASCOT_W, mirrorFrame, paintRows } from "./mascot.ts";
import type { SeasonId } from "./seasons.ts";

/** A prop sprite placed relative to the mascot's 40x52-cell sprite box, top-left = (0,0), in UNMIRRORED cells (may be negative or beyond the box). */
export interface SeasonProp { sprite: string; x: number; y: number }
export interface SeasonActFrame {
  frame: string;      // a key of MASCOT_FRAMES (mascot.ts) for this beat
  mirrored: boolean;  // relative flip: XOR with the runner's own facing
  lift: number;       // vertical offset in cells, positive = up (jumps)
  props: SeasonProp[];
}

// ── prop palette ────────────────────────────────────────────────────────────────────────────────
// Its own namespace: prop chars never collide with or mutate MASCOT_PALETTE. '.' is transparent.

export const PROP_PALETTE: Readonly<Record<string, string>> = {
  k: "#10161d", // outline, same ink as the mascot
  w: "#f6f8f7", // white
  x: "#c3cdd6", // white shade / light steel
  g: "#9aa7b3", // steel
  G: "#5b6672", // dark steel
  z: "#262b33", // charcoal (top hat, pot)
  r: "#e5383f", // red
  R: "#9a202b", // dark red
  o: "#f78c2a", // orange
  O: "#b2521a", // dark orange
  y: "#ffd84a", // yellow / gold
  Y: "#c38c1d", // gold shade
  f: "#fff4bf", // hot white-yellow (sparks, flame core)
  b: "#9a6136", // brown / wood
  n: "#5c391f", // dark brown
  t: "#efbf78", // pastry / tan
  T: "#c2ab7c", // khaki
  Q: "#86744d", // khaki shade
  e: "#4cbb5a", // green
  E: "#20743a", // dark green
  m: "#b6f3cf", // mint
  u: "#3c6fd2", // blue
  U: "#1e3568", // navy
  c: "#8fe0ff", // cyan / water light
  p: "#ff9ec6", // pink
  P: "#da4882", // rose
  a: "#dccbff", // lavender
  v: "#a57be0", // violet
  V: "#55357f", // deep violet
};

// ── sprite construction (all at module load) ────────────────────────────────────────────────────

type Rows = string[];
type Plot = (x: number, y: number, c: string) => void;

/** Rasterise a sprite from fills, then (optionally) ring every filled cell with the outline ink. The
 *  outline pass pads the sprite by one pixel on every side. */
function gen(w: number, h: number, draw: (set: Plot) => void, outline = true): Rows {
  const pad = outline ? 1 : 0;
  const W = w + 2 * pad, H = h + 2 * pad;
  const g = Array.from({ length: H }, () => Array<string>(W).fill("."));
  draw((x, y, c) => {
    const xx = Math.round(x) + pad, yy = Math.round(y) + pad;
    if (xx >= 0 && xx < W && yy >= 0 && yy < H) g[yy]![xx] = c;
  });
  if (outline) {
    const src = g.map((r) => r.slice());
    const solid = (x: number, y: number): boolean => x >= 0 && x < W && y >= 0 && y < H && src[y]![x] !== "." && src[y]![x] !== "k";
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (src[y]![x] === "." && (solid(x - 1, y) || solid(x + 1, y) || solid(x, y - 1) || solid(x, y + 1))) g[y]![x] = "k";
    }
  }
  return g.map((r) => r.join(""));
}
function ellipse(set: Plot, cx: number, cy: number, rx: number, ry: number, c: string, keep: (x: number, y: number) => boolean = () => true): void {
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
    const dx = (x - cx) / rx, dy = (y - cy) / ry;
    if (dx * dx + dy * dy <= 1.05 && keep(x, y)) set(x, y, c);
  }
}
function rect(set: Plot, x0: number, y0: number, x1: number, y1: number, c: string): void {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) set(x, y, c);
}
const recolor = (s: readonly string[], map: Record<string, string>): Rows => s.map((r) => [...r].map((c) => map[c] ?? c).join(""));
/** Rotate a sprite a quarter turn clockwise. */
function rot90(s: readonly string[]): Rows {
  const h = s.length, w = s[0]!.length;
  return Array.from({ length: w }, (_, y) => Array.from({ length: h }, (_, x) => s[h - 1 - x]![y]!).join(""));
}
/** Lean a sprite forward (rightward toward the top): row r shifts right by floor((h-1-r)/step). */
function shear(s: readonly string[], step: number): Rows {
  const h = s.length, extra = Math.floor((h - 1) / step);
  return s.map((r, i) => { const k = Math.floor((h - 1 - i) / step); return ".".repeat(k) + r + ".".repeat(extra - k); });
}
/** Split a sprite at column `col` into two halves whose cut edges are inked. */
function split(s: readonly string[], col: number): [Rows, Rows] {
  const ink = (c: string): string => (c === "." ? "." : "k");
  return [s.map((r) => r.slice(0, col) + ink(r[col]!)), s.map((r) => ink(r[col]!) + r.slice(col + 1))];
}

const S: Record<string, Rows> = {};
const PX: Record<string, number> = {};
/** Register a sprite; `px` = mascot cells per sprite pixel (2 = chunky like his body, 1 = fine). */
const def = (name: string, rows: Rows, px = 2): void => { S[name] = rows; PX[name] = px; };

// Single pixels and confetti chips in every prop color: lines, sparks and confetti are built from
// these. DOT is a fine one-cell dot (fishing line, wire), PIX a chunky one (sparks, rod).
for (const c of Object.keys(PROP_PALETTE)) {
  def(`DOT_${c}`, [c], 1);
  def(`PIX_${c}`, [c]);
  def(`CHIP_H_${c}`, [c + c]);
  def(`CHIP_V_${c}`, [c, c]);
}
def("TWINKLE", ["..f..", "..w..", "fwwwf", "..w..", "..f.."]);
def("TWINKLE_S", [".f.", "fwf", ".f."]);

// Blades: the katana extension from the grip ('M' in the slash frames), steel back + bright edge.
def("BLADE_FLAT", ["w".repeat(19) + ".", "g".repeat(19) + "w"]);
def("BLADE_UP", gen(10, 10, (set) => { for (let i = 0; i < 10; i++) { set(i, 9 - i, "w"); if (i > 0) set(i - 1, 9 - i, "g"); } }, false));
def("BLADE_DOWN", [...S.BLADE_UP!].reverse());

// Super Bowl: the football (two spin phases) and its halves.
def("FOOTBALL", [
  "...kkkkkkk...",
  ".kkbbbbbbbkk.",
  "kbbbwbwbwbbbk",
  "kwbbwwwwwbbwk",
  "kbbbbbbbbbbnk",
  ".kknbbbbbnkk.",
  "...kkkkkkk...",
]);
def("FOOTBALL_B", [
  "...kkkkkkk...",
  ".kkbbbbbbbkk.",
  "kbwbbbbbbbwbk",
  "kbwbwbwbwbwbk",
  "kbbbwwwwwbbnk",
  ".kknbbbbbnkk.",
  "...kkkkkkk...",
]);
{ const [l, r] = split(S.FOOTBALL!, 6); def("FOOTBALL_L", l); def("FOOTBALL_R", r); }

// World Cup: the ball, two spin phases.
def("SOCCER", ["..kkkk..", ".kwwwwk.", "kwwkkwwk", "kwkkkkwk", "kwwkkwwk", "kwwwwwxk", ".kwwxxk.", "..kkkk.."]);
def("SOCCER_B", ["..kkkk..", ".kwwkwk.", "kwwkkkwk", "kwwwkkwk", "kwwwwwwk", "kkwwwwxk", ".kkwwxk.", "..kkkk.."]);

// Thanksgiving: autumn leaves (and their flutter mirror) and a pumpkin pie with a cream dollop.
const LEAF: Rows = ["...k...", "..kok..", "kkkOkkk", "koOOOok", ".koOok.", "kooOook", ".kkOkk.", "...n..."];
for (const [n, map] of [["O", {}], ["R", { o: "r", O: "R" }], ["Y", { o: "y", O: "Y" }]] as const) {
  def(`LEAF_${n}`, recolor(LEAF, map));
  def(`LEAF_${n}_F`, mirrorFrame(S[`LEAF_${n}`]!));
}
def("PIE", [".....kwk....", "..kkkwwwkk..", ".ktoooooootk", "kttttttttttk", ".kggggggggk.", "..kkkkkkkk.."]);

// Christmas: the gift (box + lid with bow) and the star that pops out.
def("GIFT_LID", [
  ".....kk..kk.....",
  "....kyykkyyk....",
  ".kkkkkyyyykkkkk.",
  "krrrrrryyrrrrrrk",
  "kRRRRRRyyRRRRRRk",
  "kkkkkkkkkkkkkkkk",
]);
def("GIFT_BOX", [
  "krrrrryyrrrrRk",
  "krrrrryyrrrrRk",
  "kyyyyyyyyyyyyk",
  "kYYYYYYYYYYYYk",
  "krrrrryyrrrrRk",
  "krrrrryyrrrrRk",
  "kRRRRRYYRRRRRk",
  "kkkkkkkkkkkkkk",
]);
def("STAR", [
  ".....k.....",
  "....kyk....",
  "....kyk....",
  "kkkkyyykkkk",
  "kyyyyfyyyYk",
  ".kyyyyyyYk.",
  "..kyyyyyk..",
  "..kyyyyYk..",
  ".kyyykyyYk.",
  ".kyk...kYk.",
  ".kk.....kk.",
]);
def("STAR_LIT", recolor(S.STAR!, { y: "f", f: "w" }));

// Halloween: the jack-o'-lantern (candle flicker phase), its halves, and the ghost that escapes.
def("PUMPKIN", [
  ".....knk.....",
  "..kkkknkkkk..",
  ".koOooOooOok.",
  "koOooOooOooOk",
  "koyyyOoOyyyok",
  "kooyoOoOoyook",
  "koOooOoOooOok",
  "koyoyyyyyoyok",
  "kooyyoyoyyook",
  ".kOoOooOoOok.",
  "..kkkkkkkkk..",
]);
def("PUMPKIN_LIT", recolor(S.PUMPKIN!, { y: "f" }));
{ const [l, r] = split(S.PUMPKIN!, 6); def("PUMPKIN_L", l); def("PUMPKIN_R", r); }
def("GHOST", ["..kkk..", ".kwwwk.", "kwkwkwk", "kwwwwwk", "kwwkwwk", "kwwwwwk", "kwxwxwk", ".k.k.k."]);
def("FLAME_S", [".o.", "oyo", "ofo"]);

// Flag days: pole, finial and a waving U.S. flag (four wave phases).
def("POLE", Array.from({ length: 64 }, () => "kxgk"), 1);
def("POLE_BASE", ["..kkkk..", ".kGGGGk.", "kGGGGGGk", "kkkkkkkk"]);
def("FINIAL", gen(3, 3, (set) => { ellipse(set, 1, 1, 1.2, 1.2, "y"); set(0, 0, "f"); }), 1);
const FLAG_BODY: Rows = Array.from({ length: 7 }, (_, y) => Array.from({ length: 13 }, (_, x) =>
  x < 5 && y < 4 ? ((x + y) % 2 === 1 ? "w" : "U") : y % 2 === 0 ? "r" : "w").join(""));
for (let p = 0; p < 4; p++) {
  def(`FLAG_${p}`, gen(13, 9, (set) => {
    for (let x = 0; x < 13; x++) {
      const off = Math.round(Math.sin(p * Math.PI / 2 - x * 0.75) * (x / 12) * 1.4) + 1;
      for (let y = 0; y < 7; y++) set(x, y + off, FLAG_BODY[y]![x]!);
    }
  }));
}

// New Year's: the party popper.
def("POPPER", ["kkkkkkk", "kyyyyyk", "kvvvvvk", ".kyyyk.", ".kPPPk.", "..kyk..", "..kvk..", "...k..."]);

// Hearts: the spinning heart shuriken (four quarter turns), a mini heart and a big one.
function heart(n: number, fill: string, shade: string): Rows {
  return gen(n, n, (set) => {
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const u = ((x + 0.5) / n * 2 - 1) * 1.25, v = -(((y + 0.5) / n) * 2 - 0.85) * 1.25;
      const q = u * u + v * v - 1;
      if (q * q * q - u * u * v * v * v <= 0) set(x, y, x + y > n * 1.2 ? shade : fill);
    }
    set(Math.floor(n * 0.28), Math.floor(n * 0.3), "w");
  });
}
{
  // Steel tips on the heart's points make it a throwing star, not a valentine card.
  const tips = heart(7, "p", "P").map((r) => [...r]);
  const last = tips.length - 1, mid = Math.floor(tips[0]!.length / 2);
  tips[1]![0] = "g"; tips[1]![tips[0]!.length - 1] = "g"; tips[last]![mid] = "g";
  let s: Rows = tips.map((r) => r.join(""));
  for (let i = 0; i < 4; i++) { def(`HEART_SHURI_${i}`, s); s = rot90(s); }
}
def("HEART_S", [".k.k.", "kpkpk", "kpppk", ".kpk.", "..k.."]);
def("HEART_L", heart(8, "r", "R"));

// Presidents' Day: the stovepipe hat, and a forward-tipped copy for the act.
def("TOPHAT", gen(22, 16, (set) => {
  rect(set, 4, 0, 17, 13, "z");
  for (let y = 0; y <= 13; y++) set(5, y, "G");
  rect(set, 4, 10, 17, 11, "R");
  rect(set, 0, 14, 21, 15, "z");
  rect(set, 1, 14, 20, 14, "G");
}), 1);
def("TOPHAT_TILT", shear(S.TOPHAT!, 4), 1);
/** The top hat's brim row, seated on the hood's top row (the act lifts and tips it from here). */
const TOPHAT_SEAT = 15;

// St. Patrick's: pot of gold, coins (spin phases) and a rainbow that draws itself in (8 steps).
def("POT", [
  "....kkkkkk....",
  "..kkyyfyyykk..",
  ".kyyYyyyYyyyk.",
  "kkkkkkkkkkkkkk",
  "kGGGGGGGGGGGGk",
  ".kzzzzzzzzzzk.",
  "kzzGzzzzzzzzzk",
  "kzzzzzzzzzzzzk",
  ".kzzzzzzzzzzk.",
  "..kkkkkkkkkk..",
]);
def("COIN", [".kkk.", "kyfyk", "kyYyk", "kyyYk", ".kkk."]);
def("COIN_MID", ["kkk", "kyk", "kfk", "kYk", "kkk"]);
def("COIN_EDGE", ["k", "Y", "y", "Y", "k"]);
const RAINBOW_BANDS = "roye" + "uv";
for (let k = 0; k < 8; k++) {
  def(`RAINBOW_${k}`, gen(41, 21, (set) => {
    for (let y = 0; y < 21; y++) for (let x = 0; x < 41; x++) {
      const dx = x - 20, dy = 20.5 - y, d = Math.sqrt(dx * dx + dy * dy);
      const band = Math.floor((20.5 - d) / 2);
      if (band < 0 || band >= RAINBOW_BANDS.length) continue;
      // Reveal from the far (right) foot toward the pot at the left foot.
      if (Math.atan2(dy, dx) <= Math.PI * (k + 1) / 8) set(x, y, RAINBOW_BANDS[band]!);
    }
  }, false), 1);
}

// Easter: a painted egg, a grass tuft and a surprised "!".
def("EGG", ["..kk..", ".kppk.", "kpwppk", "kavavk", "kmmmmk", "kppppk", ".kpPk.", "..kk.."]);
def("GRASS", [".e...e..e.", ".e.e.ee.e.", "eEeEeEeeEe", "EEEEEEEEEE"]);
def("EXCLAIM", [".k.", "kyk", "kyk", "kyk", ".k.", "kyk", ".k."]);

// Mother's Day: the bouquet (pink, red and violet blooms in a lavender wrap), leaning forward.
def("BOUQUET", shear([
  ".kkk.kkk.",
  "kpppkrrrk",
  "kpypkryrk",
  "kpppkrrrk",
  ".kkkvkkk.",
  "..kvyvk..",
  ".ekkvkke.",
  "eekaEakee",
  "..kaEak..",
  "..kawak..",
  "...kak...",
  "....k....",
], 4));

// Father's Day: bobber, fish (and its flop mirror), water.
def("BOBBER", [".k.", "krk", "kwk", ".k."]);
def("FISH", ["...kkkkk..kk", ".kkccccckkck", "kckcccccccck", "kcccccccccck", ".kkxxxxxkkck", "...kkkkk..kk"]);
def("FISH_F", mirrorFrame(S.FISH!));
for (let p = 0; p < 4; p++) {
  def(`WATER_${p}`, gen(26, 3, (set) => {
    for (let x = 0; x < 26; x++) {
      const crest = Math.round(Math.sin((x + p * 2) * 0.7));
      for (let y = 1 + crest; y < 3; y++) set(x, y, y === 1 + crest ? "c" : "u");
    }
  }, false));
}

// Labor Day: the hammer (raised over the shoulder, and striking), the block and the nail by depth.
def("HAMMER_RAISED", gen(9, 9, (set) => {
  for (let i = 0; i <= 6; i++) set(i, 8 - i, "b");
  for (let i = 0; i < 5; i++) { set(4 + i, i, i === 0 ? "x" : "g"); set(5 + i - 1, i - 1, "G"); }
}));
def("HAMMER_STRIKE", [".......kkk", ".......kxk", "kkkkkkkkgk", "kbbbbbbkgk", "kkkkkkkkgk", ".......kGk", ".......kkk"]);
def("BLOCK", gen(8, 5, (set) => { rect(set, 0, 0, 7, 4, "b"); rect(set, 0, 0, 7, 0, "t"); rect(set, 0, 3, 7, 3, "n"); }));
for (const n of [0, 2, 4, 6]) def(`NAIL_${n}`, gen(3, n + 1, (set) => { rect(set, 0, 0, 2, 0, "x"); for (let y = 1; y <= n; y++) set(1, y, "g"); }), 1);

// Indigenous Peoples' Day: soil mound, seed and the sprout's six growth stages.
def("MOUND", gen(12, 3, (set) => ellipse(set, 5.5, 3, 6, 3, "b", (_x, y) => y < 3)));
def("SEED", ["nb", "bn"]);
for (let k = 0; k < 6; k++) {
  def(`SPROUT_${k}`, gen(9, 9, (set) => {
    const h = [1, 3, 5, 6, 7, 8][k]!;
    for (let y = 0; y < h; y++) set(4, 8 - y, "e");
    if (k >= 2) { set(3, 9 - h + 2, "e"); set(2, 9 - h + 1, "e"); set(5, 9 - h + 3, "e"); set(6, 9 - h + 2, "E"); }
    if (k >= 4) { set(1, 9 - h + 1, "E"); set(7, 9 - h + 2, "e"); set(3, 9 - h + 1, "e"); }
    if (k >= 5) { set(4, 0, "y"); set(3, 1, "y"); set(5, 1, "y"); set(4, 1, "f"); }
  }));
}

// MLK Jr. Day: the white dove (wings up / wings down) carrying an olive sprig.
def("DOVE_UP", [
  "..k.........",
  "..kk........",
  "..kwk....kk.",
  "..kwwk..kwwk",
  ".kkwwwkkwkwo",
  "kxwwwwwwwwke",
  ".kkxwwwwwk..",
  "...kkkkkk...",
  "............",
  "............",
]);
def("DOVE_DOWN", [
  "............",
  "............",
  ".........kk.",
  "........kwwk",
  ".kkkkkkkwkwo",
  "kxwwwwwwwwke",
  ".kkwwwwwwk..",
  "...kwwk.k...",
  "....kwk.....",
  ".....k......",
]);

// Olympics: the torch, its flame (three flicker phases), a pedestal and the gold medal.
def("TORCH", ["kYyyyYk", ".kYyYk.", "..kgk..", "..kgk..", "..kGk..", "..kgk..", "..kGk..", "..kgk..", "...k..."]);
def("FLAME_0", ["...o...", "..oyo..", "..oyo.o", ".oyfyo.", ".oyfyo.", "oyfffyo", ".offfo."]);
def("FLAME_1", mirrorFrame(S.FLAME_0!));
def("FLAME_2", ["..o....", "..oo...", ".oyyo..", ".oyfo..", "oyffyo.", "oyfffyo", ".offfo."]);
def("PEDESTAL", gen(7, 5, (set) => { rect(set, 1, 0, 5, 4, "g"); rect(set, 0, 4, 6, 4, "G"); rect(set, 1, 1, 5, 1, "y"); }));
def("MEDAL", ["kuk...kuk", ".kuk.kuk.", "..kurk...", "...kyk...", "..kyyyk..", ".kyyfyyk.", ".kyYyyyk.", ".kyyyYyk.", "..kyyyk..", "...kkk..."]);

// Elections: ballot box (and its lit star), the ballot, the "I voted" sticker.
def("BALLOT_BOX", [
  "kkkkkkkkkkkkkk",
  "kggggkkkkggggk",
  "kxxxxxxxxxxxxk",
  "kUUUUUUwUUUUUk",
  "kUUUUwwwwwUUUk",
  "kUUUUUwwwUUUUk",
  "kUUUUUwUwUUUUk",
  "krrrrrrrrrrrrk",
  "kwwwwwwwwwwwwk",
  "krrrrrrrrrrrrk",
  "kkkkkkkkkkkkkk",
]);
def("BALLOT_BOX_LIT", recolor(S.BALLOT_BOX!, { w: "y" }));
def("BALLOT", ["kkkkkk", "kwwwwk", "kxxxwk", "kwwwwk", "kwwwek", "kewewk", "kwewwk", "kkkkkk"]);
def("STICKER", [".kkkkk.", "kUwUrrk", "kwwwwwk", "krrrrrk", ".kkkkk."]);
def("STICKER_S", ["kkk", "krk", "kkk"]);

// ── costume pieces (head pieces ride the head anchor; badges sit on the headband or chest) ─────────

def("HAT_SANTA", [
  "......................kkk..",
  ".....................kwwwk.",
  "..................kkkkwwwk.",
  "...............kkkrrrrkkk..",
  "............kkkrrrrrrrk....",
  "..........kkrrrrrrrrrRk....",
  "........kkrrrrrrrrrrRk.....",
  "......kkrrrrrrrrrrrRRk.....",
  ".....krrrrrrrrrrrrrrRRk....",
  "...kkkkkkkkkkkkkkkkkkkkkk..",
  "..kwwwwwwwwwwwwwwwwwwwwwxk.",
  "..kwxwwwxwwwwxwwwwxwwwwxxk.",
  "...kkkkkkkkkkkkkkkkkkkkkk..",
], 1);
def("HAT_PARTY", [
  ".....kkk.....",
  "....kfwfk....",
  ".....kkk.....",
  ".....kyk.....",
  "....kyyyk....",
  "....kvvvk....",
  "...kyyyyyk...",
  "...kPPPPPk...",
  "..kyyyyyyyk..",
  "..kvvvvvvvk..",
  ".kkkkkkkkkkk.",
], 1);
def("HAT_BUNNY", [
  "..kkk............kkk..",
  ".kwwwk..........kwwwk.",
  ".kwpwk..........kwpwk.",
  ".kwpwk..........kwpwk.",
  ".kwpwk..........kwpwk.",
  "..kwpwk........kwpwk..",
  "..kwpwk........kwpwk..",
  "..kwpwk........kwpwk..",
  "...kwpwk......kwpwk...",
  "...kwwwk......kwwwk...",
  "....kkk........kkk....",
], 1);
def("HAT_CROWN", gen(26, 5, (set) => {
  for (let x = 0; x < 26; x++) set(x, 2 + Math.round(Math.abs(x - 12.5) / 12.5), x % 3 === 0 ? "E" : "e");
  const blooms: [number, string][] = [[2, "a"], [7, "p"], [13, "P"], [19, "p"], [24, "a"]];
  for (const [fx, c] of blooms) {
    const fy = 2 + Math.round(Math.abs(fx - 12.5) / 12.5);
    set(fx - 1, fy, c); set(fx + 1, fy, c); set(fx, fy - 1, c); set(fx, fy + 1, c); set(fx, fy, "y");
  }
}), 1);
def("HAT_HARD", gen(26, 9, (set) => {
  ellipse(set, 12.5, 7, 9, 6.5, "y", (_x, y) => y <= 6);
  for (let y = 1; y <= 6; y++) { set(12, y, "f"); set(13, y, "f"); }
  for (let y = 2; y <= 6; y++) set(19 + Math.floor((y - 2) / 3), y, "Y");
  rect(set, 0, 7, 25, 7, "y"); rect(set, 0, 8, 25, 8, "Y");
}), 1);
def("HAT_BOWLER", gen(17, 7, (set) => {
  ellipse(set, 8, 5, 5.5, 5, "E", (_x, y) => y <= 5);
  rect(set, 3, 4, 13, 4, "y");
  set(5, 2, "e"); set(4, 1, "e"); set(6, 1, "e");
  rect(set, 0, 6, 16, 6, "E");
}), 1);
def("HAT_WITCH", gen(30, 18, (set) => {
  for (let r = 0; r <= 15; r++) {
    const k = r / 15, hw = 0.6 + k * 7.5, cx = 15 + 7 * (1 - k) * (1 - k);
    for (let x = Math.round(cx - hw); x <= Math.round(cx + hw); x++) set(x, r, x <= cx - hw + 1.2 ? "v" : "V");
  }
  rect(set, 8, 12, 22, 13, "o");
  rect(set, 14, 12, 16, 13, "y"); set(15, 12, "z"); set(15, 13, "z");
  ellipse(set, 15, 16, 14.5, 1.4, "V");
  for (let x = 2; x < 28; x++) set(x, 15, "v");
}), 1);
def("HAT_LAUREL", gen(30, 6, (set) => {
  for (let x = 0; x < 30; x++) {
    if (x > 11 && x < 18) continue;
    const y = 1 + Math.round(((x - 14.5) / 14.5) ** 2 * 3);
    set(x, y + 1, "E");
    if (x % 2 === 0) set(x, y, "e"); else set(x, y + 2, "e");
  }
  set(11, 1, "y"); set(18, 1, "y");
}), 1);
def("HAT_BUCKET", gen(26, 7, (set) => {
  rect(set, 6, 0, 19, 3, "T"); rect(set, 6, 3, 19, 3, "Q"); rect(set, 5, 4, 20, 4, "T");
  rect(set, 1, 5, 24, 5, "T"); rect(set, 0, 6, 25, 6, "Q");
  set(16, 1, "u"); set(17, 1, "o"); set(17, 2, "u");
}), 1);
def("BADGE_HEART", S.HEART_S!, 1);
def("BADGE_STAR", ["..w..", "wwwww", ".www.", ".w.w."], 1);
def("BADGE_LEAF", LEAF, 1);
def("POPPY", gen(4, 4, (set) => { ellipse(set, 1.5, 1.5, 2, 2, "r"); set(3, 3, "R"); set(2, 3, "R"); set(1, 1, "k"); set(2, 2, "k"); set(1, 2, "z"); set(2, 1, "z"); }), 1);

/** Every prop and costume sprite by name. Rows are equal-width strings over PROP_PALETTE chars + '.'. */
export const SEASON_SPRITES: Readonly<Record<string, readonly string[]>> = S;

/** Width / height of a sprite in mascot cells. */
const sw = (n: string): number => S[n]![0]!.length * PX[n]!;
const sh = (n: string): number => S[n]!.length * PX[n]!;

// ── the head anchor ─────────────────────────────────────────────────────────────────────────────

const anchors = new Map<string, { x: number; y: number }>();
/** Where a hat sits on `frame`: the center of the topmost hood row (the first row whose longest solid
 *  run is at least 10 cells). Derived from the grid itself, so a hat follows the head on every frame,
 *  including the ones that bob, lean, crouch or fall. Unknown frames resolve like idleA. */
export function headAnchor(frame: string): { x: number; y: number } {
  const hit = anchors.get(frame);
  if (hit) return hit;
  const grid = MASCOT_FRAMES[frame] ?? MASCOT_FRAMES.idleA!;
  let a = { x: MASCOT_W / 2 - 2, y: 0 };
  for (let y = 0; y < grid.length; y++) {
    const r = grid[y]!;
    let best = 0, at = 0, run = 0, start = 0;
    for (let x = 0; x <= r.length; x++) {
      if (x < r.length && r[x] !== ".") { if (run === 0) start = x; run++; }
      else { if (run > best) { best = run; at = start; } run = 0; }
    }
    if (best >= 10) { a = { x: at + Math.floor(best / 2), y }; break; }
  }
  anchors.set(frame, a);
  return a;
}

// ── costumes ────────────────────────────────────────────────────────────────────────────────────

/** A costume piece: `sprite` with its top-left at (anchor.x + dx, anchor.y + dy) of the head anchor. */
interface Piece { sprite: string; dx: number; dy: number }
interface Costume { gi: Record<"K" | "D" | "L" | "G" | "g", string>; pieces: Piece[] }

/** A head piece centered on the anchor (plus `xOff`), its row `seatRow` landing on the hood's top row. */
const onHead = (sprite: string, seatRow: number, xOff = 0): Piece => ({ sprite, dx: -Math.floor(sw(sprite) / 2) + xOff, dy: -seatRow });
const onBand = (sprite: string): Piece => ({ sprite, dx: -Math.floor(sw(sprite) / 2) + 1, dy: 9 });
const onChest = (sprite: string): Piece => ({ sprite, dx: -12, dy: 25 });

const COSTUMES: Record<SeasonId, Costume> = {
  "new-year": { gi: { K: "#24212d", D: "#16141c", L: "#433d52", G: "#ffd36b", g: "#b08a2e" }, pieces: [onHead("HAT_PARTY", 9, 4)] },
  "mlk-day": { gi: { K: "#3b3350", D: "#26213a", L: "#62598a", G: "#ffb36b", g: "#c06a3a" }, pieces: [] },
  "super-bowl": { gi: { K: "#2b3a5c", D: "#1b2540", L: "#46608f", G: "#ff7a3d", g: "#b4471f" }, pieces: [] },
  "valentines": { gi: { K: "#5a1f38", D: "#3a1325", L: "#8f3a5e", G: "#ff86b0", g: "#c23a6b" }, pieces: [onBand("BADGE_HEART")] },
  "presidents-day": { gi: { K: "#1f2c4f", D: "#141d36", L: "#3a4f80", G: "#e0434e", g: "#9a2232" }, pieces: [onHead("TOPHAT", TOPHAT_SEAT)] },
  "st-patricks": { gi: { K: "#1d4a2c", D: "#123320", L: "#33754a", G: "#ffd84a", g: "#b88a1e" }, pieces: [onHead("HAT_BOWLER", 7, 3)] },
  "easter": { gi: { K: "#6a5894", D: "#4d406d", L: "#9a86c4", G: "#ffd1e6", g: "#d98fb5" }, pieces: [onHead("HAT_BUNNY", 9)] },
  "mothers-day": { gi: { K: "#6b3654", D: "#4b253b", L: "#9b5a7d", G: "#ffb3cf", g: "#d0698f" }, pieces: [onHead("HAT_CROWN", 2)] },
  "memorial-day": { gi: { K: "#232b3d", D: "#171d2a", L: "#3d4a63", G: "#d8434e", g: "#8f2733" }, pieces: [onChest("POPPY")] },
  "fathers-day": { gi: { K: "#2b4a5e", D: "#1c3344", L: "#4a7590", G: "#ffcf6b", g: "#c0902e" }, pieces: [onHead("HAT_BUCKET", 7)] },
  "juneteenth": { gi: { K: "#2c2622", D: "#1a1613", L: "#4f443a", G: "#e8483c", g: "#2f9a4c" }, pieces: [] },
  "world-cup": { gi: { K: "#2f6fd1", D: "#1f4c95", L: "#5a94ee", G: "#ffe14d", g: "#c9a227" }, pieces: [] },
  "independence-day": { gi: { K: "#2a3d7a", D: "#1b2856", L: "#4a63b0", G: "#e8404b", g: "#f2f4f6" }, pieces: [onBand("BADGE_STAR")] },
  "olympics": { gi: { K: "#e6eaf0", D: "#aeb8c6", L: "#ffffff", G: "#ffd24a", g: "#c08f1e" }, pieces: [onHead("HAT_LAUREL", 4)] },
  "labor-day": { gi: { K: "#3a5a8c", D: "#26406a", L: "#5f82b8", G: "#ff9a2e", g: "#c0661a" }, pieces: [onHead("HAT_HARD", 8)] },
  "indigenous-peoples": { gi: { K: "#5a3a2a", D: "#3d281d", L: "#86593f", G: "#3fc1b0", g: "#23877a" }, pieces: [] },
  "elections": { gi: { K: "#24305e", D: "#171f40", L: "#3e4f8f", G: "#e8434e", g: "#9b2735" }, pieces: [] },
  "halloween": { gi: { K: "#3b2457", D: "#25163a", L: "#5e3c86", G: "#ff8a1f", g: "#b55312" }, pieces: [onHead("HAT_WITCH", 17)] },
  "veterans-day": { gi: { K: "#3c4a33", D: "#283222", L: "#5c6e4e", G: "#d9434d", g: "#8e2732" }, pieces: [onChest("POPPY")] },
  "thanksgiving": { gi: { K: "#5a3622", D: "#3c2416", L: "#86553a", G: "#ff9a3c", g: "#b45a22" }, pieces: [onBand("BADGE_LEAF")] },
  "christmas": { gi: { K: "#1f5a3a", D: "#143d27", L: "#2f7d52", G: "#e8323c", g: "#9a1f28" }, pieces: [onHead("HAT_SANTA", 10)] },
};

const paletteCache = new WeakMap<Record<string, string>, Partial<Record<SeasonId, Record<string, string>>>>();
/** The season's costume colors over `base` (gi K/D/L and accent G/g; skin, eyes, steel and ink keep
 *  their contrast). null = `base` itself. Cached per base, so a per-frame call never allocates. */
export function seasonPalette(id: SeasonId | null, base: Record<string, string>): Record<string, string> {
  const c = id ? COSTUMES[id] : undefined;
  if (!id || !c) return base;
  let m = paletteCache.get(base);
  if (!m) { m = {}; paletteCache.set(base, m); }
  return (m[id] ??= { ...base, ...c.gi });
}

/** The costume pieces a season wears (sprite names; for tests and previews). */
export function seasonCostumePieces(id: SeasonId): readonly string[] {
  return COSTUMES[id].pieces.map((p) => p.sprite);
}

// ── act machinery ───────────────────────────────────────────────────────────────────────────────

type Beats = readonly (readonly [string, number])[];
interface At { frame: string; u: number }
function seq(beats: Beats, t: number): At {
  let t0 = 0;
  for (let i = 0; i < beats.length; i++) {
    const [frame, ms] = beats[i]!;
    if (t < t0 + ms || i === beats.length - 1) return { frame, u: Math.min(1, (t - t0) / ms) };
    t0 += ms;
  }
  return { frame: beats[0]![0], u: 0 };
}

interface ActDef {
  beats: Beats;
  props(t: number, b: At, out: SeasonProp[]): void;
  lift?(b: At): number;
}

const GROUND = 51;
const lerp = (a: number, b: number, u: number): number => a + (b - a) * u;
const clamp01 = (u: number): number => (u < 0 ? 0 : u > 1 ? 1 : u);
const span = (t: number, a: number, b: number): number => clamp01((t - a) / (b - a));
const smooth = (u: number): number => { const v = clamp01(u); return v * v * (3 - 2 * v); };
/** Ease out with a small overshoot (a pop). */
const outBack = (u: number): number => { const v = clamp01(u) - 1; return 1 + 2.4 * v * v * v + 1.4 * v * v; };
function put(out: SeasonProp[], sprite: string, x: number, y: number): void {
  out.push({ sprite, x: Math.round(x), y: Math.round(y) });
}
/** Center a sprite on a point. */
function putC(out: SeasonProp[], sprite: string, x: number, y: number): void {
  put(out, sprite, x - Math.floor(sw(sprite) / 2), y - Math.floor(sh(sprite) / 2));
}
/** A line of single pixels (`DOT_c` one cell, `PIX_c` two) from p0 to p1. */
function dots(out: SeasonProp[], x0: number, y0: number, x1: number, y1: number, sprite: string): void {
  const step = PX[sprite]!;
  const n = Math.max(Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) / step), 1);
  for (let i = 0; i <= n; i++) put(out, sprite, lerp(x0, x1, i / n), lerp(y0, y1, i / n));
}
/** A ballistic hop from p0 to p1 peaking `h` cells above the straight line. */
const hop = (x0: number, y0: number, x1: number, y1: number, h: number, u: number): [number, number] =>
  [lerp(x0, x1, u), lerp(y0, y1, u) - 4 * h * u * (1 - u)];
function h01(i: number, salt: number): number {
  let x = Math.imul(i | 0, 374761393) ^ Math.imul(salt | 0, 668265263);
  x = Math.imul(x ^ (x >>> 13), 1274126177);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}
const blink = (t: number, ms: number): boolean => Math.floor(t / ms) % 2 === 0;
function twinkle(out: SeasonProp[], x: number, y: number, t: number): void {
  putC(out, blink(t, 90) ? "TWINKLE" : "TWINKLE_S", x, y);
}

/** Right-hand centers (cells) for the frames the acts hold props in, read off the grids. */
const HAND: Record<string, readonly [number, number]> = {
  idleA: [30, 33], idleB: [30, 33], idleC: [30, 33], blink: [30, 33],
  guard: [27, 26], talkA: [30, 29], talkC: [30, 29], throwA: [31, 28], throwB: [32, 31],
  victoryA: [34, 26], victoryB: [36, 24], victoryC: [30, 33], hang: [30, 25], hangB: [32, 22],
  land: [30, 29], mantle: [30, 29], slashUp: [28, 25], slash: [34, 29], slashEnd: [34, 33],
  punchB: [36, 27], punchC: [32, 28], punchD: [28, 27], salute: [33, 14],
};
const LEFT_HAND: Record<string, readonly [number, number]> = {
  hang: [6, 25], hangB: [6, 25], land: [6, 29], victoryC: [6, 33], victoryB: [6, 33], talkC: [6, 29], idleA: [6, 33],
};
const hand = (frame: string): readonly [number, number] => HAND[frame] ?? HAND.idleA!;

/** The katana's extension for the three cutting frames (the grip itself is in the body frame). */
function blade(out: SeasonProp[], frame: string): void {
  if (frame === "slashUp") put(out, "BLADE_UP", 29, 5);
  else if (frame === "slash") put(out, "BLADE_FLAT", 36, 28);
  else if (frame === "slashEnd") put(out, "BLADE_DOWN", 36, 32);
}

/** Sparks shed by a burning tip: each 28 ms bucket spawns three sparks at where the tip WAS, flying
 *  outward and falling under gravity for a short life. A closed-form function of t (no state). */
function sparkler(out: SeasonProp[], t: number, from: number, to: number, tip: (tt: number) => readonly [number, number], colors: string, salt: number): void {
  const STEP = 28, LIFE = 420;
  const k0 = Math.max(Math.ceil(from / STEP), Math.ceil((t - LIFE) / STEP));
  const k1 = Math.floor(Math.min(t, to) / STEP);
  for (let k = k0; k <= k1; k++) {
    const [px, py] = tip(k * STEP);
    const age = (t - k * STEP) / 1000;
    for (let j = 0; j < 3; j++) {
      const n = k * 3 + j;
      const a = h01(n, salt) * Math.PI * 2, sp = 18 + h01(n, salt + 1) * 34;
      const vx = Math.cos(a) * sp, vy = Math.sin(a) * sp;
      const c = colors[Math.floor(h01(n, salt + 2) * colors.length)]!;
      const x = px + vx * age, y = py + vy * age + 45 * age * age;
      if (age < 0.2) { put(out, `DOT_${c}`, x - vx * 0.05, y - vy * 0.05); put(out, `PIX_${c}`, x - 1, y - 1); }
      else put(out, `DOT_${c}`, x, y);
    }
  }
  if (t >= from && t < to) { const [px, py] = tip(t); twinkle(out, px, py, t); }
}

const SALUTE = MASCOT_FRAMES.salute ? "salute" : "guard";

// ── the acts ────────────────────────────────────────────────────────────────────────────────────

// Super Bowl: a football spirals in from the right, he draws, and the cut lands mid-swing; the halves
// fall apart to the turf and he celebrates.
const superBowl: ActDef = {
  beats: [["idleA", 300], ["guard", 350], ["draw", 300], ["slashUp", 200], ["slash", 200], ["slashEnd", 450], ["victoryA", 250], ["victoryB", 450], ["victoryA", 200], ["idleA", 300]],
  props(t, b, out) {
    blade(out, b.frame);
    const CUT = 1220, BX = 44, BY = 23;
    if (t < CUT) {
      const u = span(t, 0, CUT);
      put(out, blink(t, 70) ? "FOOTBALL" : "FOOTBALL_B", lerp(130, BX, u), BY - 16 * (1 - u) * (1 - u) + 4 * Math.sin(u * Math.PI));
      return;
    }
    const dt = (t - CUT) / 1000;
    const land = GROUND - sh("FOOTBALL_L");
    const settle = (k: number): number => {
      const y = Math.min(land, BY + 0.5 * 200 * dt * dt * k);
      return y < land ? y : land - Math.max(0, 3 * Math.sin(clamp01((dt - 0.38 / Math.sqrt(k)) / 0.22) * Math.PI));
    };
    put(out, "FOOTBALL_L", BX - 10 * Math.min(1, dt / 0.6), settle(1));
    put(out, "FOOTBALL_R", BX + 12 + 26 * Math.min(1, dt / 0.6), settle(0.85));
    if (t < CUT + 160) twinkle(out, BX + 13, BY + 7, t);
  },
};

// World Cup: the ball drops in and is juggled foot, low touch, foot, then volleyed away off a high kick.
const worldCup: ActDef = {
  beats: [["guard", 380], ["kickC", 280], ["guard", 340], ["kickD", 260], ["guard", 300], ["kickC", 280], ["guard", 260], ["kickA", 160], ["kickB", 300], ["kickC", 200], ["guard", 200], ["victoryB", 440]],
  props(t, _b, out) {
    // Every touch is a foot (the knee sits too close to his big head at this scale); between touches
    // the ball loops out in front of him, never across his face.
    const FOOT: [number, number] = [20, 21], LOW: [number, number] = [23, 29], VOLLEY: [number, number] = [38, 22];
    const legs: [number, [number, number], number][] = [[500, FOOT, 0], [1130, LOW, 18], [1700, FOOT, 22], [2330, VOLLEY, 16]];
    let x: number, y: number;
    if (t < 500) { const u = t / 500; x = lerp(44, FOOT[0], u); y = lerp(-22, FOOT[1], u * u); }
    else if (t < 2330) {
      let i = 0;
      while (t >= legs[i + 1]![0]) i++;
      const [ta, pa] = legs[i]!, [tb, pb, h] = legs[i + 1]!;
      const u = (t - ta) / (tb - ta);
      [x, y] = hop(pa[0], pa[1], pb[0], pb[1], h, u);
      x += 18 * Math.sin(u * Math.PI);
    } else if (t < 2950) { const u = (t - 2330) / 620; x = lerp(VOLLEY[0], 130, u); y = lerp(VOLLEY[1], -40, u); }
    else return;
    put(out, blink(t, t > 2330 ? 40 : 90) ? "SOCCER" : "SOCCER_B", x, y);
    for (const [tc, p] of legs) if (t >= tc && t < tc + 100) twinkle(out, p[0] + 8, p[1] + 16, t);
  },
};

// Thanksgiving: three leaves flutter down; he catches two and the third lands on his head. He lets the
// two drift to the ground, then serves a pumpkin pie, still steaming.
const thanksgiving: ActDef = {
  beats: [["idleA", 400], ["idleC", 300], ["guard", 700], ["talkC", 500], ["idleB", 300], ["punchB", 1200]],
  props(t, b, out) {
    const head = headAnchor(b.frame);
    const caughtAt = (i: number): [number, number] =>
      i === 2 ? [head.x - 4, head.y - 10] : b.frame === "guard" ? (i === 0 ? [8, 20] : [26, 16]) : i === 0 ? [0, 22] : [30, 20];
    const leaves: [string, number, number, number][] = [["LEAF_O", 0, 6, 900], ["LEAF_R", 250, 36, 1150], ["LEAF_Y", 500, 22, 1400]];
    leaves.forEach(([name, born, x0, caught], i) => {
      if (t < born) return;
      const [rx, ry] = caughtAt(i);
      if (t < caught) {
        const u = (t - born) / (caught - born);
        put(out, blink(t + i * 70, 160) ? name : `${name}_F`, lerp(x0, rx, u) + 5 * Math.sin(u * 9 + i), lerp(-20, ry, u));
      } else if (i < 2 && t >= 1900) {
        // Let go: the two hand-held leaves see-saw down to the ground and rest there.
        const u = span(t, 1900, 2700);
        put(out, blink(t + i * 90, 180) && u < 1 ? name : `${name}_F`, rx + (i ? 10 : -4) * u + 4 * Math.sin(u * 8) * (1 - u), lerp(ry, GROUND - sh(name), u));
      } else put(out, name, rx, ry);
    });
    if (t >= 2200) {
      const [hx, hy] = hand(b.frame);
      const px = hx - 6, py = hy - 10;
      put(out, "PIE", px, py);
      if (t < 2320) twinkle(out, px + 12, py, t);
      for (let s = 0; s < 3; s++) {
        const ph = ((t - 2200) / 900 + s / 3) % 1;
        put(out, "PIX_x", px + 6 + s * 5 + Math.sin(ph * 6 + s) * 1.5, py - 2 - ph * 10);
      }
    }
  },
};

// Christmas: he taps the gift, the lid pops off, and a star rises out and twinkles over the box.
const christmas: ActDef = {
  beats: [["idleA", 400], ["idleC", 300], ["guard", 300], ["punchC", 220], ["punchD", 280], ["idleB", 300], ["victoryA", 250], ["victoryB", 700], ["idleA", 650]],
  props(t, _b, out) {
    const BX = 36, BY = GROUND - sh("GIFT_BOX");
    if (t >= 1150) {
      // Drawn before the box, so it emerges from INSIDE.
      const u = span(t, 1150, 1750);
      const y = lerp(BY + 2, 4, outBack(u)) + (t > 1750 ? Math.round(Math.sin((t - 1750) / 260) * 1.5) : 0);
      put(out, t > 1750 && blink(t, 180) ? "STAR_LIT" : "STAR", BX + 5, y);
      if (t > 1750) {
        const k = Math.floor(t / 220) % 4;
        const sp: [number, number][] = [[BX + 1, 6], [BX + 28, 12], [BX + 4, 22], [BX + 25, 2]];
        twinkle(out, sp[k]![0], sp[k]![1], t);
      }
    }
    put(out, "GIFT_BOX", BX, BY);
    const LX = BX - 2, LY = BY - sh("GIFT_LID");
    if (t < 1100) put(out, "GIFT_LID", LX, LY - (t > 1000 ? 2 : 0));
    else {
      const u = span(t, 1100, 1700);
      const [x, y] = hop(LX, LY, LX + 34, GROUND - sh("GIFT_LID"), 18, u);
      put(out, "GIFT_LID", x, y);
      if (t < 1280) for (let i = 0; i < 4; i++) twinkle(out, BX + 14 + (i - 1.5) * 10 * span(t, 1100, 1280), BY - 4 - 8 * span(t, 1100, 1280) * (i % 2 ? 1 : 0.4), t + i * 45);
    }
  },
};

// Halloween: he draws, rises, and cuts down through the jack-o'-lantern; the halves fall apart, the
// candle gutters between them, and a little ghost slips out and floats away.
const halloween: ActDef = {
  beats: [["idleA", 350], ["idleC", 250], ["draw", 300], ["slashUp", 250], ["slashEnd", 450], ["victoryA", 250], ["victoryB", 450], ["idleA", 500]],
  props(t, b, out) {
    blade(out, b.frame);
    const PX0 = 38, PY = GROUND - sh("PUMPKIN"), CUT = 1230;
    const lit = h01(Math.floor(t / 110), 7) > 0.35;
    if (t < CUT) { put(out, lit ? "PUMPKIN_LIT" : "PUMPKIN", PX0, PY); return; }
    const u = smooth(span(t, CUT, CUT + 420));
    if (t > 1450) {
      const g = span(t, 1450, 2800);
      put(out, "GHOST", PX0 + 6 + 22 * g + 3 * Math.sin(g * 12), PY - 4 - 50 * g);
    }
    put(out, lit ? "FLAME_S" : "PIX_o", PX0 + 10 + (lit ? 0 : 2), GROUND - (lit ? 6 : 2));
    put(out, "PUMPKIN_L", PX0 - 6 * u, PY + Math.round(2 * u));
    put(out, "PUMPKIN_R", PX0 + 12 + 10 * u, PY + Math.round(3 * u));
    if (t < CUT + 160) twinkle(out, PX0 + 13, PY + 4, t);
  },
};

// Veterans Day and Memorial Day: hand over hand he hoists the flag up the pole, then salutes. On
// Memorial Day the flag is raised to the peak, then lowered to half-staff.
function flagAct(halfStaff: boolean): ActDef {
  return {
    beats: [["idleA", 300], ["hang", 250], ["hangB", 250], ["hang", 250], ["hangB", 250], ["hang", 250], ["hangB", 250], ["idleA", 300], [SALUTE, 1500]],
    props(t, b, out) {
      const PX0 = 38, TOP = -14, LOW = GROUND - sh("FLAG_0") - 2, HALF = 8, ROPE = PX0 + 3;
      put(out, "POLE", PX0 - 1, TOP);
      put(out, "POLE_BASE", PX0 + 1 - sw("POLE_BASE") / 2, GROUND - sh("POLE_BASE"));
      put(out, "FINIAL", PX0 - 1.5, TOP - 4);
      // Six pulls: the flag climbs in steps, each pull easing in as the hand comes down.
      const pulls = clamp01((t - 300) / 1500) * 6;
      const k = Math.min(6, Math.floor(pulls) + smooth(pulls - Math.floor(pulls)));
      let y = lerp(LOW, TOP, k / 6);
      if (halfStaff) y = lerp(y, HALF, smooth(span(t, 2000, 2600)));
      // The halyard: from the flag's hoist down the pole, to his hands while he pulls, else to a cleat.
      const ropeTop = y + sh("FLAG_0") - 4;
      const pulling = b.frame === "hang" || b.frame === "hangB";
      const [hx, hy] = hand(b.frame);
      const end = pulling ? hy : 40;
      if (ropeTop < end) dots(out, ROPE, ropeTop, ROPE, end, "DOT_x");
      if (pulling) dots(out, ROPE, end, hx + 2, hy, "DOT_x");
      put(out, `FLAG_${Math.floor(t / 120) % 4}`, PX0 + 3, y - 2);
    },
  };
}

// Independence Day: he waves a sparkler through the air, shedding gold and white sparks.
const independenceDay: ActDef = (() => {
  const beats: Beats = [["idleA", 300], ["victoryA", 200], ["victoryB", 300], ["victoryA", 200], ["victoryB", 300], ["hangB", 250], ["victoryB", 300], ["victoryA", 200], ["victoryB", 450], ["victoryC", 400], ["idleA", 300]];
  const wire = (frame: string): [number, number, number, number] => { const [hx, hy] = hand(frame); return [hx, hy - 1, hx + 4, hy - 13]; };
  return {
    beats,
    props(t, b, out) {
      if (t < 300 || t >= 2900) return;
      const [x0, y0, x1, y1] = wire(b.frame);
      dots(out, x0, y0, x1, y1, "DOT_g");
      sparkler(out, t, 300, 2800, (tt) => { const w = wire(seq(beats, tt).frame); return [w[2], w[3]]; }, "ffyyow", 11);
    },
  };
})();

// Juneteenth: two sparklers, a celebration jump at the top of the act, sparks in red, gold and green.
const juneteenth: ActDef = (() => {
  const beats: Beats = [["idleA", 300], ["hang", 300], ["hangB", 250], ["hang", 250], ["land", 200], ["victoryC", 450], ["land", 200], ["hang", 300], ["hangB", 300], ["victoryB", 600], ["idleA", 250]];
  const liftAt = (b: At): number => (b.frame === "victoryC" ? Math.round(12 * Math.sin(b.u * Math.PI)) : 0);
  /** [right hand, right tip, left hand, left tip] with the jump applied. */
  const wires = (b: At): [number, number][] => {
    const [rx, ry] = hand(b.frame), [lx, ly] = LEFT_HAND[b.frame] ?? LEFT_HAND.idleA!, l = liftAt(b);
    return [[rx, ry - l], [rx + 9, ry - 9 - l], [lx, ly - l], [lx - 9, ly - 9 - l]];
  };
  return {
    beats,
    lift: liftAt,
    props(t, b, out) {
      if (t < 300 || t >= 3150) return;
      const [r0, r1, l0, l1] = wires(b);
      dots(out, r0![0], r0![1], r1![0], r1![1], "DOT_g");
      dots(out, l0![0], l0![1], l1![0], l1![1], "DOT_g");
      sparkler(out, t, 300, 3100, (tt) => wires(seq(beats, tt))[1]!, "rryyef", 21);
      sparkler(out, t, 300, 3100, (tt) => wires(seq(beats, tt))[3]!, "rryeef", 23);
    },
  };
})();

// New Year's: he raises a party popper and pops it; confetti bursts up and tumbles down around him.
const newYear: ActDef = {
  beats: [["idleA", 300], ["guard", 300], ["victoryA", 300], ["victoryB", 200], ["victoryB", 900], ["victoryC", 600], ["idleB", 300], ["idleA", 300]],
  props(t, b, out) {
    const POP = 950;
    const [mx, my] = [HAND.victoryB![0] + 1, HAND.victoryB![1] - 16];
    if (t >= 300 && t < 2000) {
      const [hx, hy] = hand(b.frame);
      put(out, "POPPER", hx - 6, hy - 15);
      if (t >= POP && t < POP + 120) twinkle(out, hx + 1, hy - 17, t);
    }
    if (t < POP) return;
    const age = (t - POP) / 1000;
    const COLORS = "ryupevcw";
    for (let i = 0; i < 30; i++) {
      const a = -Math.PI / 2 + (h01(i, 31) - 0.5) * 2.1, sp = 50 + h01(i, 32) * 60;
      // Fast up, then air drag hands them to a slow flutter.
      const drag = (1 - Math.exp(-age * 3.2)) / 3.2;
      const x = mx + Math.cos(a) * sp * drag + Math.sin(age * 7 + i) * 3 * age;
      const y = my + Math.sin(a) * sp * drag + 16 * age * age;
      if (y > GROUND - 2) continue;
      const c = COLORS[i % COLORS.length]!;
      put(out, (Math.floor(t / 90) + i) % 2 ? `CHIP_H_${c}` : `CHIP_V_${c}`, x, y);
    }
  },
};

// Valentine's: he throws a heart shuriken that spins off, shedding little hearts, then a big heart
// pops up over his head.
const valentines: ActDef = {
  beats: [["idleA", 350], ["guard", 300], ["throwA", 250], ["throwB", 350], ["idleB", 300], ["victoryA", 250], ["victoryC", 600], ["idleA", 600]],
  props(t, b, out) {
    const REL = 950;
    if (t >= 350 && t < REL) {
      const [hx, hy] = hand(b.frame);
      putC(out, "HEART_SHURI_0", hx + 5, hy - 4);
    } else if (t >= REL) {
      const fly = (tt: number): [number, number] => { const u = (tt - REL) / 900; return [44 + 100 * u, 25 + 3 * Math.sin(u * 10)]; };
      for (let k = 0; k < 6; k++) {
        const born = REL + 60 + k * 110, age = t - born;
        if (age < 0 || age > 520) continue;
        const [x, y] = fly(born);
        putC(out, "HEART_S", x, y - age / 40);
      }
      if (t < REL + 900) { const [x, y] = fly(t); putC(out, `HEART_SHURI_${Math.floor((t - REL) / 50) % 4}`, x, y); }
    }
    if (t >= 1550) {
      const head = headAnchor(b.frame);
      const u = span(t, 1550, 1800);
      const y = head.y - 6 - 10 * outBack(u) + (t > 1800 ? Math.round(Math.sin((t - 1800) / 200) * 1.5) : 0);
      putC(out, u < 0.4 ? "HEART_S" : "HEART_L", head.x + 1, y);
    }
  },
};

// Presidents' Day: hand to the brim, he lifts and tips the stovepipe hat forward, then sets it back.
const presidentsDay: ActDef = {
  beats: [["idleA", 500], [SALUTE, 300], [SALUTE, 900], [SALUTE, 200], ["idleA", 300], ["victoryA", 300], ["idleA", 500]],
  props(t, b, out) {
    if (t < 500 || t >= 1900) return;
    const a = headAnchor(b.frame);
    const raise = t < 800 ? span(t, 500, 800) * 2 : t < 1700 ? 2 + 4 * smooth(span(t, 800, 1050)) : 6 * (1 - span(t, 1700, 1900));
    const tilted = t >= 900 && t < 1700;
    const name = tilted ? "TOPHAT_TILT" : "TOPHAT";
    put(out, name, a.x - Math.floor(sw("TOPHAT") / 2) + (tilted ? 2 : 0), a.y - TOPHAT_SEAT - raise - (sh(name) - sh("TOPHAT")));
    if (t >= 1100 && t < 1500) twinkle(out, a.x + 16, a.y - 14, t);
  },
};

// St. Patrick's: a rainbow draws itself down to a pot of gold; coins burst out, he flips one and holds
// it high.
const COIN_SPIN = ["COIN", "COIN_MID", "COIN_EDGE", "COIN_MID"];
const stPatricks: ActDef = {
  beats: [["idleA", 600], ["idleC", 400], ["sneakA", 200], ["sneakB", 200], ["guard", 300], ["throwA", 250], ["idleB", 450], ["victoryB", 700], ["idleA", 300]],
  props(t, b, out) {
    const PX0 = 38, PY = GROUND - sh("POT"), MID = PX0 + sw("POT") / 2;
    put(out, `RAINBOW_${Math.min(7, Math.floor(t / 90))}`, MID - 6, PY + 3 - sh("RAINBOW_0"));
    put(out, "POT", PX0, PY);
    if (t >= 1500 && t < 2200) {
      for (let i = 0; i < 4; i++) {
        const u = span(t, 1500, 2100);
        const [x, y] = hop(MID - 5, PY - 6, MID - 5 + (i - 1.2) * 14, GROUND - 10, 16 + i * 4, u);
        if (u < 1) put(out, COIN_SPIN[Math.floor(t / 60 + i) % 4]!, x, y);
      }
    }
    if (t >= 1500) {
      // The one he keeps: to his hand, flipped high, caught, held up.
      let x: number, y: number;
      if (t < 1750) [x, y] = hop(MID - 5, PY - 6, 30, 18, 12, span(t, 1500, 1750));
      else if (t < 2400) [x, y] = hop(30, 18, 32, 13, 26, span(t, 1750, 2400));
      else { const [hx, hy] = hand(b.frame); x = hx - 4; y = hy - 11; }
      put(out, t < 2400 ? COIN_SPIN[Math.floor(t / 50) % 4]! : "COIN", x, y);
      if (t >= 2400 && t < 2900) twinkle(out, x + 9, y, t);
    }
  },
};

// Easter: he looks around, spots the painted egg in the grass, steps over, crouches and holds it up.
const easter: ActDef = {
  beats: [["idleA", 400], ["idleC", 350], ["talkB", 350], ["idleC", 250], ["sneakA", 200], ["sneakB", 200], ["land", 450], ["victoryB", 700], ["idleA", 300]],
  props(t, b, out) {
    const EX = 40, EY = GROUND - sh("EGG");
    if (t < 1950) put(out, "EGG", EX + (t > 1150 && t < 1350 && blink(t, 50) ? 1 : 0), EY);
    else {
      const [hx, hy] = hand(b.frame);
      const u = span(t, 1950, 2150);
      put(out, "EGG", lerp(EX, hx - 2, u), lerp(EY, hy - 15, u));
      if (t > 2300 && t < 2800) twinkle(out, hx + 8, hy - 16, t);
    }
    put(out, "GRASS", 34, GROUND - sh("GRASS"));
    put(out, "GRASS", 50, GROUND - sh("GRASS"));
    if (t >= 1150 && t < 1550) { const a = headAnchor(b.frame); put(out, "EXCLAIM", a.x + 16, a.y - 12 - (t < 1220 ? 3 : 0)); }
  },
};

// Mother's Day: a bouquet appears in his hand; he holds it out, petals drift, a heart floats up.
const mothersDay: ActDef = {
  beats: [["idleA", 400], ["idleB", 300], ["guard", 250], ["punchB", 1300], ["victoryA", 300], ["idleA", 650]],
  props(t, b, out) {
    if (t < 950) return;
    const [hx, hy] = hand(b.frame);
    const bx = hx - 8, by = hy - 18;
    put(out, "BOUQUET", bx, by);
    if (t < 1100) twinkle(out, bx + 12, by + 2, t);
    for (let i = 0; i < 4; i++) {
      const ph = ((t - 950) / 1600 + i / 4) % 1;
      put(out, i % 2 ? "CHIP_H_p" : "PIX_P", bx + 10 + i * 4 + 8 * ph + Math.sin(ph * 9 + i) * 3, by + 4 + ph * (GROUND - by - 6));
    }
    if (t >= 1700) {
      const a = headAnchor(b.frame);
      const u = span(t, 1700, 2700);
      if (u < 1) put(out, "HEART_S", a.x + 12 + 4 * Math.sin(u * 7), a.y - 22 * u);
    }
  },
};

// Father's Day: rod back, cast, the bobber settles, two nibbles, the strike, and he holds up the catch.
const fathersDay: ActDef = {
  beats: [["idleA", 300], ["slashUp", 400], ["slash", 250], ["slashEnd", 900], ["slashUp", 350], ["victoryB", 1000], ["idleA", 400]],
  props(t, b, out) {
    const WX = 58, BOB: [number, number] = [76, GROUND - 9];
    put(out, `WATER_${Math.floor(t / 200) % 4}`, WX, GROUND - sh("WATER_0"));
    const yank = t >= 1850;
    const rod: [number, number, number, number] =
      b.frame === "slashUp" ? (yank ? [28, 25, 42, 1] : [28, 25, 14, 3])
        : b.frame === "slash" ? [35, 29, 62, 14]
          : b.frame === "slashEnd" ? [35, 33, 64, 22] : [30, 33, 48, 16];
    const FISH_AT = 2200;
    if (t < FISH_AT) {
      const [gx, gy, tx, ty] = rod;
      dots(out, gx, gy, tx, ty, "PIX_n");
      // Bobber: rides the tip, flies with the cast, floats, nibbles twice, then the fish comes up.
      let bx: number, by: number;
      if (t < 700) { bx = tx - 3; by = ty + 2; }
      else if (t < 1000) [bx, by] = hop(tx, ty, BOB[0], BOB[1], 12, span(t, 700, 1000));
      else if (t < 1850) { bx = BOB[0]; by = BOB[1] + ((t > 1400 && t < 1480) || (t > 1650 && t < 1730) ? 3 : Math.round(Math.sin(t / 170))); }
      else [bx, by] = hop(BOB[0], BOB[1], 30, 4, 16, span(t, 1850, FISH_AT));
      if (t >= 700) {
        // The line sags between the rod tip and the bobber until the strike pulls it taut.
        const sag = t < 1850 ? 8 : 0;
        for (let i = 1; i < 16; i++) { const u = i / 16; put(out, "DOT_x", lerp(tx, bx + 3, u), lerp(ty, by, u) + sag * 4 * u * (1 - u)); }
      }
      if (t < 1850) put(out, "BOBBER", bx, by);
      else put(out, blink(t, 70) ? "FISH" : "FISH_F", bx - 2, by);
      if (t >= 1850 && t < 1970) twinkle(out, BOB[0] + 3, BOB[1], t);
      return;
    }
    const [hx, hy] = hand(b.frame);
    put(out, blink(t, 160) || t > 3000 ? "FISH" : "FISH_F", hx - 4, hy - 13);
    if (t > 2300 && t < 2900) twinkle(out, hx + 22, hy - 14, t);
  },
};

// Labor Day: three hammer blows drive the nail flush into the block; sparks on each hit; a proud pose.
const laborDay: ActDef = {
  beats: [["idleA", 300], ["slashUp", 300], ["slash", 300], ["slashUp", 300], ["slash", 300], ["slashUp", 300], ["slash", 300], ["victoryA", 300], ["victoryB", 600], ["idleA", 400]],
  props(t, b, out) {
    const BX = 40, BY = GROUND - sh("BLOCK") + 2, NX = 48;
    put(out, "BLOCK", BX, GROUND - sh("BLOCK"));
    const HITS = [600, 1200, 1800];
    let hits = 0;
    for (const h of HITS) if (t >= h + 20) hits++;
    const depth = [6, 4, 2, 0][hits]!;
    const nail = `NAIL_${depth}`;
    put(out, nail, NX - 2, BY - depth - 1);
    const headTop = BY - depth - 1;
    if (b.frame === "slashUp" || b.frame === "victoryA" || b.frame === "victoryB") {
      const [hx, hy] = hand(b.frame);
      put(out, "HAMMER_RAISED", hx - 2, hy - 20);
    } else if (b.frame === "slash") put(out, "HAMMER_STRIKE", NX - 17, headTop - 13);
    for (const h of HITS) {
      if (t < h + 20 || t > h + 140) continue;
      const r = (t - h) / 18;
      for (let i = 0; i < 5; i++) put(out, i % 2 ? "PIX_f" : "PIX_y", NX + Math.cos(i * 0.8 - 2.9) * (3 + r), headTop + Math.sin(i * 0.8 - 2.9) * (2 + r * 0.6));
    }
    if (t >= 1840 && t < 2300 && blink(t, 120)) twinkle(out, NX, headTop - 5, t);
  },
};

// Indigenous Peoples' Day: he kneels, plants a seed in the mound, pats the soil, and stands to watch it
// sprout and open in the light.
const indigenousPeoples: ActDef = {
  beats: [["idleA", 400], ["land", 500], ["mantle", 300], ["land", 300], ["idleA", 600], ["idleC", 500], ["idleB", 800]],
  props(t, _b, out) {
    const MX = 36, MY = GROUND - sh("MOUND"), MID = MX + sw("MOUND") / 2;
    if (t >= 450 && t < 800) { const u = span(t, 450, 800); put(out, "SEED", lerp(30, MID - 2, u), lerp(28, MY, u * u)); }
    if (t >= 1300) {
      const k = Math.min(5, Math.floor(span(t, 1300, 2700) * 6));
      const name = `SPROUT_${k}`;
      put(out, name, MID - sw(name) / 2, MY + 3 - sh(name));
      if (t < 2900 && blink(t, 300)) put(out, "PIX_m", MID - 8 + ((t / 300) % 4) * 5, MY - 6 - ((t % 300) / 300) * 10);
      if (t >= 2700 && t < 3100) twinkle(out, MID, MY + 3 - sh(name) + 2, t);
    }
    put(out, "MOUND", MX, MY);
  },
};

// MLK Jr. Day: the dove rests on his hand, he raises it, and it flies off into the light.
const mlkDay: ActDef = {
  beats: [["idleA", 400], ["punchB", 500], ["victoryA", 300], ["victoryB", 300], ["victoryB", 600], ["idleC", 600], ["idleA", 700]],
  props(t, b, out) {
    const REL = 1350;
    if (t < REL) {
      const [hx, hy] = hand(b.frame);
      put(out, t > 1100 && blink(t, 90) ? "DOVE_UP" : "DOVE_DOWN", hx - 4, hy - 17);
      return;
    }
    const u = span(t, REL, 3300);
    if (u >= 1) return;
    const [hx, hy] = HAND.victoryB!;
    put(out, blink(t, 110) ? "DOVE_UP" : "DOVE_DOWN", hx - 4 + 80 * u, hy - 17 - 50 * u + 4 * Math.sin(u * 10));
    for (let i = 0; i < 2; i++) {
      const f = span(t, REL + i * 150, REL + 1300 + i * 150);
      if (f > 0 && f < 1) put(out, "DOT_w", hx + 6 + i * 6 + 2 * Math.sin(f * 8 + i), hy - 8 + f * (GROUND - hy));
    }
  },
};

// Olympics: he holds the torch high, sets it in its stand, and the gold medal drops onto his chest.
const olympics: ActDef = {
  beats: [["victoryA", 300], ["victoryB", 1300], ["guard", 300], ["idleA", 400], ["victoryC", 400], ["victoryA", 250], ["victoryB", 650]],
  props(t, b, out) {
    const flame = `FLAME_${Math.floor(t / 90) % 3}`;
    if (t < 1600) {
      const [hx, hy] = hand(b.frame);
      put(out, "TORCH", hx - 6, hy - 16);
      put(out, flame, hx - 6, hy - 29);
    } else {
      const SX = 44, SY = GROUND - sh("PEDESTAL");
      put(out, "PEDESTAL", SX, SY);
      put(out, "TORCH", SX + 2, SY - 16);
      put(out, flame, SX + 2, SY - 29);
    }
    if (t >= 1900) {
      const a = headAnchor(b.frame);
      const u = span(t, 1900, 2300);
      const restY = a.y + 20;
      const y = u < 1 ? lerp(-24, restY, u * u) : restY - (t < 2420 ? 2 : 0);
      put(out, "MEDAL", a.x - 9, y);
      if ((t > 2300 && t < 2700) || (t > 3050 && t < 3450)) twinkle(out, a.x + 3, restY + 12, t);
    }
  },
};

// Elections: ballot in hand, he drops it in the box (which lights up), and earns an "I voted" sticker.
const elections: ActDef = {
  beats: [["idleA", 400], ["throwA", 600], ["throwB", 300], ["idleB", 400], ["guard", 300], ["victoryA", 300], ["victoryB", 600], ["idleA", 300]],
  props(t, b, out) {
    const BX = 36, BY = GROUND - sh("BALLOT_BOX"), SLOT = BX + 10;
    const [ax, ay] = HAND.throwA!;
    if (t < 1050) {
      const [hx, hy] = hand(b.frame);
      put(out, "BALLOT", hx + 1, hy - 16);
    } else if (t < 1300) {
      const u = span(t, 1050, 1300);
      put(out, "BALLOT", lerp(ax + 1, SLOT, u), lerp(ay - 16, BY + 2, u * u));
    }
    put(out, t >= 1300 && t < 1700 && blink(t, 100) ? "BALLOT_BOX_LIT" : "BALLOT_BOX", BX, BY);
    if (t >= 2000) {
      const a = headAnchor(b.frame);
      const x = a.x - 15, y = a.y + 24;
      if (t < 2080) put(out, "STICKER_S", x + 4, y + 2);
      else put(out, "STICKER", x, y);
      if (t > 2080 && t < 2500) twinkle(out, x + 14, y, t);
    }
  },
};

const ACTS: Record<SeasonId, ActDef> = {
  "new-year": newYear,
  "mlk-day": mlkDay,
  "super-bowl": superBowl,
  "valentines": valentines,
  "presidents-day": presidentsDay,
  "st-patricks": stPatricks,
  "easter": easter,
  "mothers-day": mothersDay,
  "memorial-day": flagAct(true),
  "fathers-day": fathersDay,
  "juneteenth": juneteenth,
  "world-cup": worldCup,
  "independence-day": independenceDay,
  "olympics": olympics,
  "labor-day": laborDay,
  "indigenous-peoples": indigenousPeoples,
  "elections": elections,
  "halloween": halloween,
  "veterans-day": flagAct(false),
  "thanksgiving": thanksgiving,
  "christmas": christmas,
};
const ACT_MS = Object.fromEntries(Object.entries(ACTS).map(([id, a]) => [id, a.beats.reduce((s, x) => s + x[1], 0)])) as Record<SeasonId, number>;

/** The whole act's length in ms (1800..3600). */
export function seasonActMs(id: SeasonId): number {
  return ACT_MS[id] ?? 0;
}

/** The act at `tMs` (clamped into [0, seasonActMs)). PURE: same t, same frame, same props. */
export function seasonActAt(id: SeasonId, tMs: number): SeasonActFrame {
  const act = ACTS[id];
  const t = Math.min(Math.max(0, Number.isFinite(tMs) ? tMs : 0), seasonActMs(id) - 1);
  const b = seq(act.beats, t);
  const props: SeasonProp[] = [];
  act.props(t, b, props);
  return { frame: b.frame, mirrored: false, lift: act.lift ? act.lift(b) : 0, props };
}

// ── painting ────────────────────────────────────────────────────────────────────────────────────

const mirrored = new Map<string, Rows>();

/** Paint the season's costume overlay (hat etc., tracking the head of `frame`) and the act's props.
 *  `act` null = costume only (walking/climbing). ox/oy = device-px top-left of the GROUND-anchored
 *  sprite box (paint the body itself at oy - act.lift * scale; the costume follows that lift here,
 *  props are ground-relative). `flip` = the mirroring the body was actually painted with. */
export function paintSeasonExtras(ctx: CanvasRenderingContext2D, id: SeasonId, act: SeasonActFrame | null, frame: string, flip: boolean, scale: number, ox: number, oy: number): void {
  const draw = (name: string, x: number, y: number): void => {
    let s: readonly string[] | undefined = S[name];
    if (!s) return;
    const px = PX[name]!;
    if (flip) {
      let m = mirrored.get(name);
      if (!m) { m = mirrorFrame(s as Rows); mirrored.set(name, m); }
      s = m;
    }
    const xx = flip ? MASCOT_W - x - s[0]!.length * px : x;
    paintRows(ctx, s, scale * px, ox + xx * scale, oy + y * scale, PROP_PALETTE);
  };
  const costume = COSTUMES[id];
  if (costume) {
    const a = headAnchor(frame);
    const lift = act ? act.lift : 0;
    for (const piece of costume.pieces) {
      let worn = true;
      if (act) for (const p of act.props) if (p.sprite.startsWith(piece.sprite)) { worn = false; break; }
      if (worn) draw(piece.sprite, a.x + piece.dx, a.y + piece.dy - lift);
    }
  }
  if (act) for (const p of act.props) draw(p.sprite, p.x, p.y);
}
