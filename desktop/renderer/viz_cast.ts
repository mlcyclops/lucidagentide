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

import type { WorldAppearance, WorldCastRole, WorldDefinition, WorldRole } from "./viz_world_api.ts";

export type Presentation = WorldAppearance["presentation"];
export type SkinBand = WorldAppearance["skinBand"];
export type CastGroup = WorldCastRole;

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

export type HairStyle =
  | "short" | "buzz" | "curls" | "coils" | "afro" | "puffs" | "locs" | "braids"
  | "long" | "wavy" | "bob" | "pixie" | "bun" | "ponytail" | "headscarf" | "hijab";

/** The shared hair vocabulary (ADR-0654's library uses the same ids) and the presentations each one suits. */
export const HAIR_STYLES: readonly { readonly id: HairStyle; readonly suits: readonly Presentation[] }[] = Object.freeze([
  { id: "short", suits: ["masculine", "neutral", "feminine"] },
  { id: "buzz", suits: ["masculine", "neutral"] },
  { id: "curls", suits: ["feminine", "masculine", "neutral"] },
  { id: "coils", suits: ["feminine", "masculine", "neutral"] },
  { id: "afro", suits: ["feminine", "masculine", "neutral"] },
  { id: "puffs", suits: ["feminine", "neutral"] },
  { id: "locs", suits: ["feminine", "masculine", "neutral"] },
  { id: "braids", suits: ["feminine", "masculine", "neutral"] },
  { id: "long", suits: ["feminine", "neutral"] },
  { id: "wavy", suits: ["feminine", "neutral"] },
  { id: "bob", suits: ["feminine", "neutral"] },
  { id: "pixie", suits: ["feminine", "neutral"] },
  { id: "bun", suits: ["feminine", "neutral"] },
  { id: "ponytail", suits: ["feminine", "neutral"] },
  { id: "headscarf", suits: ["feminine"] },
  { id: "hijab", suits: ["feminine"] },
] as const);

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

/** One scene's cast: slots handed out in first-seen order, kept for the book's life. */
export class CastBook {
  private readonly slots = new Map<string, number>();
  private readonly cache = new Map<string, WorldAppearance>();
  private presentationOffset = 0;
  private skinOffset = 0;

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
    const a = appearanceAt(slot, this.presentationOffset, this.skinOffset, nodeSeed(nodeId));
    this.cache.set(nodeId, a);
    return a;
  }

  /** The node left the scene: its cached appearance goes, its slot stays reserved (it looks the same if it comes
   *  back, and nobody else takes its look this session). */
  release(nodeId: string): void {
    this.cache.delete(nodeId);
  }

  /** Forget every slot (the world or the scene was torn down). */
  clear(): void {
    this.slots.clear();
    this.cache.clear();
    this.presentationOffset = 0;
    this.skinOffset = 0;
  }
}
