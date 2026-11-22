// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/viz_cast.ts - P-WORLDS.CAST1 (ADR-0649): balanced casting for Lucid Agent World figures.
//
// The host owns casting. Pure: no DOM, no three.
//   nodeSeed:  the scene's per-node id hash (viz_scene NodeObj.seed). Anime and Office read it as is (through
//              viz_anime_pose.seededGender, which mixes it), so their casts never change.
//   worldSeed: what a world module gets as `seed`. The raw id hash gives ids that differ in the last character
//              (demo-1 to demo-6) seeds one apart, and packs that read high bits (`(seed >>> 9) % 6` for skin,
//              `(seed >>> 13) % n` for hair) then rolled one look for the whole fleet. worldSeed runs it through
//              mix32, so v1 packs vary without an update. WORLD_SEED_SALT is fixed so the demo fleet's six agents
//              land on six different v1 skin picks (viz_cast.test.ts checks it with the real hash).
//   CastBook:  one per scene. The first time a human-cast node is seen it takes the next slot of one shared
//              sequence (hub, agents and subagents alike). The sequence's presentation cycle (period 7: three
//              feminine, three masculine, one neutral) and skin order (period 10 over SKIN_RAMP, step 3) make
//              ANY 6 consecutive slots hold at least 2 feminine and 2 masculine figures and span the light,
//              medium and dark bands. It starts at offsets mixed from the first node's id, so fleets differ. A
//              node keeps its slot for the life of the book (release frees only its cached appearance), so
//              looks are stable as others come and go. Inside a slot, hair style (filtered by presentation),
//              hair color, body build and face variant come from mix32(seed ^ salt) per attribute.
// Creature roles (WorldDefinition.castRoles) take no slot and get no appearance, only the mixed seed.
//
// P-WORLDS.CAST2 (ADR-0650): the user's cast preferences (viz_cast_prefs, the View menu's Cast section and a
// node's "Customize look") reach the book through setPrefs. applyCastPrefs lays them over the balanced look:
// a node's pin wins (presentation, skin with its undertone, hair style, hair color), then the fleet mode
// ("same" gives every human figure the fleet's skin, hair style and hair color; "balanced" keeps the sequence),
// and the fleet undertone tints every skin not pinned with its own. Hair always suits the presentation. Each
// skin step has warm, neutral (the SKIN_RAMP hex) and cool variants (SKIN_TONES); hair color picks come from
// HAIR_SWATCHES (the natural HAIR_COLORS plus six fashion colors; the balance only draws natural ones).

import type { WorldAppearance, WorldCastRole, WorldDefinition, WorldRole } from "./viz_world_api.ts";
import type { CastPrefs } from "./viz_cast_prefs.ts";

export type Presentation = WorldAppearance["presentation"];
export type SkinBand = WorldAppearance["skinBand"];
export type CastGroup = WorldCastRole;
/** P-WORLDS.CAST2 (ADR-0650): a skin step's undertone (neutral is the SKIN_RAMP hex). */
export type Undertone = "warm" | "neutral" | "cool";

/** A 32-bit integer finalizer (murmur3 fmix32 over a golden-ratio offset). Shared with viz_anime_pose. */
export function mix32(x: number): number {
  let h = (x + 0x9e3779b9) | 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** The scene's id hash for a node (unchanged since P-VIZ.1; the built-in casts read it). */
export function nodeSeed(id: string): number {
  let seed = 7;
  for (let i = 0; i < id.length; i++) seed = (seed * 31 + id.charCodeAt(i)) >>> 0;
  return seed;
}

/** Chosen so demo-1 to demo-6 get six different `(seed >>> 9) % 6` picks and all five `(seed >>> 13) % 5`. */
const WORLD_SEED_SALT = 0x512;

/** The seed a world module receives: the node seed, mixed, so every bit range varies between nearby ids. */
export function worldSeed(seed: number): number {
  return mix32((seed ^ WORLD_SEED_SALT) | 0);
}

/** Ten skin tones, light to deep, on a perceptually even ramp. */
export const SKIN_RAMP: readonly { readonly hex: string; readonly band: SkinBand }[] = Object.freeze([
  { hex: "#f6d7c3", band: "light" },
  { hex: "#f1c6a6", band: "light" },
  { hex: "#e3b08a", band: "light" },
  { hex: "#d39d74", band: "medium" },
  { hex: "#c08560", band: "medium" },
  { hex: "#a96f4c", band: "medium" },
  { hex: "#93603f", band: "medium" },
  { hex: "#7a4c31", band: "dark" },
  { hex: "#613b26", band: "dark" },
  { hex: "#4a2b1b", band: "dark" },
] as const);

/** Eight natural hair colors, black to platinum. */
export const HAIR_COLORS: readonly string[] = Object.freeze([
  "#16110e", // black
  "#2e1f16", // soft black
  "#4a301e", // dark brown
  "#6b4429", // medium brown
  "#8a3f22", // auburn
  "#9a6a3e", // light brown
  "#c9a25f", // blonde
  "#e6d8b8", // platinum
]);

/** P-WORLDS.CAST2 (ADR-0650): a name per SKIN_RAMP step (swatch labels). */
export const SKIN_NAMES: readonly string[] = Object.freeze(["Porcelain", "Ivory", "Beige", "Honey", "Golden", "Caramel", "Bronze", "Chestnut", "Mocha", "Espresso"]);

export const UNDERTONES: readonly { readonly id: Undertone; readonly label: string }[] = Object.freeze([
  { id: "warm", label: "Warm" }, { id: "neutral", label: "Neutral" }, { id: "cool", label: "Cool" },
] as const);

/** Per-channel offsets: warm leans golden (more red, less blue), cool leans rosy (less green, more blue). Small
 *  enough that every step keeps its place on the light-to-deep ramp. */
const UNDERTONE_SHIFT: Readonly<Record<Undertone, readonly [number, number, number]>> = { warm: [8, 3, -14], neutral: [0, 0, 0], cool: [-6, -4, 12] };

function shiftHex(hex: string, d: readonly [number, number, number]): string {
  const v = parseInt(hex.slice(1), 16);
  const ch = (x: number, k: number): string => Math.max(0, Math.min(255, x + d[k]!)).toString(16).padStart(2, "0");
  return `#${ch((v >> 16) & 255, 0)}${ch((v >> 8) & 255, 1)}${ch(v & 255, 2)}`;
}

/** Every SKIN_RAMP step in each undertone (neutral is the ramp itself). */
export const SKIN_TONES: Readonly<Record<Undertone, readonly string[]>> = Object.freeze({
  warm: Object.freeze(SKIN_RAMP.map((s) => shiftHex(s.hex, UNDERTONE_SHIFT.warm))),
  neutral: Object.freeze(SKIN_RAMP.map((s) => s.hex)),
  cool: Object.freeze(SKIN_RAMP.map((s) => shiftHex(s.hex, UNDERTONE_SHIFT.cool))),
});

/** The hex of skin step `index` (0 lightest, 9 deepest) in an undertone. */
export function skinTone(index: number, undertone: Undertone): string {
  return SKIN_TONES[undertone][index] ?? SKIN_RAMP[0]!.hex;
}

/** P-WORLDS.CAST2 (ADR-0650): the hair-color picker's ramp: the eight natural HAIR_COLORS (black to platinum),
 *  then six fashion colors. A pick is one of these values. */
export const HAIR_SWATCHES: readonly { readonly value: string; readonly label: string; readonly fashion: boolean }[] = Object.freeze([
  ...["Black", "Soft black", "Dark brown", "Medium brown", "Auburn", "Light brown", "Blonde", "Platinum"].map((label, i) => ({ value: HAIR_COLORS[i]!, label, fashion: false })),
  { value: "#d9609a", label: "Pink", fashion: true },
  { value: "#9277d1", label: "Lavender", fashion: true },
  { value: "#3466cf", label: "Blue", fashion: true },
  { value: "#1f948a", label: "Teal", fashion: true },
  { value: "#b3203a", label: "Cherry", fashion: true },
  { value: "#a9b0bc", label: "Silver", fashion: true },
]);

export type HairStyle =
  | "short" | "buzz" | "curls" | "coils" | "afro" | "puffs" | "locs" | "braids"
  | "long" | "wavy" | "bob" | "pixie" | "bun" | "ponytail" | "headscarf" | "hijab";

/** The shared hair vocabulary (ADR-0654's library uses the same ids), the presentations each one suits (the
 *  first is the one a fixed style moves an unpinned figure to when its own does not suit) and a chip label. */
export const HAIR_STYLES: readonly { readonly id: HairStyle; readonly suits: readonly Presentation[]; readonly label: string }[] = Object.freeze([
  { id: "short", suits: ["masculine", "neutral", "feminine"], label: "Short" },
  { id: "buzz", suits: ["masculine", "neutral"], label: "Buzz" },
  { id: "curls", suits: ["feminine", "masculine", "neutral"], label: "Curls" },
  { id: "coils", suits: ["feminine", "masculine", "neutral"], label: "Coils" },
  { id: "afro", suits: ["feminine", "masculine", "neutral"], label: "Afro" },
  { id: "puffs", suits: ["feminine", "neutral"], label: "Puffs" },
  { id: "locs", suits: ["feminine", "masculine", "neutral"], label: "Locs" },
  { id: "braids", suits: ["feminine", "masculine", "neutral"], label: "Braids" },
  { id: "long", suits: ["feminine", "neutral"], label: "Long" },
  { id: "wavy", suits: ["feminine", "neutral"], label: "Wavy" },
  { id: "bob", suits: ["feminine", "neutral"], label: "Bob" },
  { id: "pixie", suits: ["feminine", "neutral"], label: "Pixie" },
  { id: "bun", suits: ["feminine", "neutral"], label: "Bun" },
  { id: "ponytail", suits: ["feminine", "neutral"], label: "Ponytail" },
  { id: "headscarf", suits: ["feminine"], label: "Headscarf" },
  { id: "hijab", suits: ["feminine"], label: "Hijab" },
] as const);

/** Whether a hair style suits a presentation (an unknown id suits none). */
export function hairSuits(hair: string, p: Presentation): boolean {
  return HAIR_STYLES.some((h) => h.id === hair && h.suits.includes(p));
}

/** How many face variants `WorldAppearance.face` ranges over (0 to FACE_VARIANTS - 1). */
export const FACE_VARIANTS = 8;

/** Period 7, three feminine, three masculine, one neutral, no two neighbors alike (around the wrap too): any 6
 *  consecutive entries are the cycle minus one, so they hold at least 2 feminine and 2 masculine. */
const PRESENTATION_CYCLE: readonly Presentation[] = ["feminine", "masculine", "feminine", "masculine", "feminine", "neutral", "masculine"];
/** SKIN_RAMP indices stepping by 3 (coprime with 10): every tone once per period, and any 6 consecutive entries
 *  (cyclic) cover the light, medium and dark bands. */
const SKIN_ORDER: readonly number[] = [0, 3, 6, 9, 2, 5, 8, 1, 4, 7];

const HAIR_BY_PRESENTATION: Readonly<Record<Presentation, readonly HairStyle[]>> = {
  feminine: HAIR_STYLES.filter((h) => h.suits.includes("feminine")).map((h) => h.id),
  masculine: HAIR_STYLES.filter((h) => h.suits.includes("masculine")).map((h) => h.id),
  neutral: HAIR_STYLES.filter((h) => h.suits.includes("neutral")).map((h) => h.id),
};

/** The hair styles that suit a presentation. */
export function hairStylesFor(p: Presentation): readonly HairStyle[] { return HAIR_BY_PRESENTATION[p]; }

const SALT_PRESENTATION_OFFSET = 0x27d4eb2f;
const SALT_SKIN_OFFSET = 0x165667b1;
const SALT_HAIR = 0x68e31da4;
const SALT_HAIR_COLOR = 0x1b873593;
const SALT_BODY = 0x7feb352d;
const SALT_FACE = 0x4cf5ad43;

/** Whether a world casts a role as people ("human", the default) or as something else (reindeer, a pin). */
export function castGroupOf(roles: WorldDefinition["castRoles"], role: WorldRole): CastGroup {
  return roles?.[role] === "creature" ? "creature" : "human";
}

/** The appearance of slot `slot` for a node with seed `seed`, given the book's sequence offsets. */
function appearanceAt(slot: number, presentationOffset: number, skinOffset: number, seed: number): WorldAppearance {
  const presentation = PRESENTATION_CYCLE[(slot + presentationOffset) % PRESENTATION_CYCLE.length]!;
  const skinIndex = SKIN_ORDER[(slot + skinOffset) % SKIN_ORDER.length]!;
  const skin = SKIN_RAMP[skinIndex]!;
  const hairs = HAIR_BY_PRESENTATION[presentation];
  return Object.freeze({
    presentation,
    body: (mix32((seed ^ SALT_BODY) | 0) % 4) as WorldAppearance["body"],
    skin: skin.hex,
    skinIndex,
    skinBand: skin.band,
    hair: hairs[mix32((seed ^ SALT_HAIR) | 0) % hairs.length]!,
    hairColor: HAIR_COLORS[mix32((seed ^ SALT_HAIR_COLOR) | 0) % HAIR_COLORS.length]!,
    face: mix32((seed ^ SALT_FACE) | 0) % FACE_VARIANTS,
  });
}

/** P-WORLDS.CAST2 (ADR-0650): the user's preferences over a node's balanced look. The node's pin wins, then the
 *  fleet mode; body and face stay the node's own. A fixed hair style that does not suit an unpinned presentation
 *  moves the figure to the style's first presentation; a pinned presentation keeps it and the figure draws the
 *  style its seed picks for that presentation instead. */
export function applyCastPrefs(base: WorldAppearance, prefs: CastPrefs, nodeId: string, seed: number): WorldAppearance {
  const fleet = prefs.fleet;
  const pin = Object.prototype.hasOwnProperty.call(prefs.pinned, nodeId) ? prefs.pinned[nodeId] : undefined;
  const same = fleet.mode === "same";
  const skinIndex = pin?.skin ?? (same ? fleet.skin : base.skinIndex);
  const fixedHair = pin?.hair ?? (same ? fleet.hair : null);
  let presentation = pin?.presentation ?? base.presentation;
  let hair = base.hair;
  if (fixedHair && (hairSuits(fixedHair, presentation) || pin?.presentation === undefined)) {
    hair = fixedHair;
    if (!hairSuits(fixedHair, presentation)) presentation = HAIR_STYLES.find((h) => h.id === fixedHair)!.suits[0]!;
  } else if (!hairSuits(hair, presentation)) {
    const hairs = HAIR_BY_PRESENTATION[presentation];
    hair = hairs[mix32((seed ^ SALT_HAIR) | 0) % hairs.length]!;
  }
  return Object.freeze({
    ...base,
    presentation,
    skin: skinTone(skinIndex, pin?.undertone ?? fleet.undertone),
    skinIndex,
    skinBand: SKIN_RAMP[skinIndex]!.band,
    hair,
    hairColor: pin?.hairColor ?? (same ? fleet.hairColor : base.hairColor),
  });
}

/** One scene's cast: slots handed out in first-seen order, kept for the book's life. */
export class CastBook {
  private readonly slots = new Map<string, number>();
  private readonly cache = new Map<string, WorldAppearance>();
  private presentationOffset = 0;
  private skinOffset = 0;
  /** P-WORLDS.CAST2 (ADR-0650): the user's preferences; null casts the pure balance. */
  private prefs: CastPrefs | null = null;

  /** New preferences: every look is resolved again (slots are kept, so the balance under them does not move).
   *  The caller rebuilds the figures. */
  setPrefs(prefs: CastPrefs | null): void {
    this.prefs = prefs;
    this.cache.clear();
  }

  /** The node's appearance (a slot is taken the first time a human-cast node is seen); null for a creature. */
  appearanceFor(nodeId: string, group: CastGroup): WorldAppearance | null {
    if (group === "creature") return null;
    const hit = this.cache.get(nodeId);
    if (hit) return hit;
    let slot = this.slots.get(nodeId);
    if (slot === undefined) {
      if (this.slots.size === 0) {
        const first = nodeSeed(nodeId);
        this.presentationOffset = mix32((first ^ SALT_PRESENTATION_OFFSET) | 0) % PRESENTATION_CYCLE.length;
        this.skinOffset = mix32((first ^ SALT_SKIN_OFFSET) | 0) % SKIN_ORDER.length;
      }
      slot = this.slots.size;
      this.slots.set(nodeId, slot);
    }
    const seed = nodeSeed(nodeId);
    const balanced = appearanceAt(slot, this.presentationOffset, this.skinOffset, seed);
    const a = this.prefs ? applyCastPrefs(balanced, this.prefs, nodeId, seed) : balanced;
    this.cache.set(nodeId, a);
    return a;
  }

  /** The node left the scene: its cached appearance goes, its slot stays reserved (it looks the same if it comes
   *  back, and nobody else takes its look this session). */
  release(nodeId: string): void {
    this.cache.delete(nodeId);
  }

  /** Forget every slot (the world or the scene was torn down). The preferences stay: they follow the lane. */
  clear(): void {
    this.slots.clear();
    this.cache.clear();
    this.presentationOffset = 0;
    this.skinOffset = 0;
  }
}
