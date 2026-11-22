// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/viz_world_api.ts - P-WORLDS.1 (ADR-0648): the contract between Visualize (the HOST) and a
// Lucid Agent World (a signed, purchasable add-on pack that brings its own cast, props, sky, throwables and storm).
//
// A world ships as a signed `.lplugin.zip` of kind "world" (harness/plugins/package.ts). Its `entry.module` is
// ONE ES module the engine serves same-origin under /worlds/<id>/<version>/ (CSP script-src 'self'), and its
// default export is `defineWorld(host) => WorldDefinition`. The module NEVER imports "three" (a bare specifier
// does not resolve in the renderer and a second copy of three would not share the scene's classes): it takes
// `host.THREE` and the helpers in `host.kit`. Type-only imports of three are fine (erased at build).
//
// Everything a world returns is used by the host the same way it uses the two built-in styles (anime, office):
// one figure per node (hub = the boss, agent = a fleet lane, subagent = a helper), a stage under each figure,
// three throwables plus a storm, a sky, ambient particles, and the edges between nodes. Versioned: a world built
// for a newer `apiVersion` than the host's WORLD_API_VERSION is listed but not offered.
//
// This file is a FROZEN CONTRACT (AGENTS.md): change it only through a new apiVersion and an ADR.
//
// Version 2 (P-WORLDS.CAST1, ADR-0649), additive: the host casts people (viz_cast.CastBook) and passes each human
// figure its `appearance`; a world may declare roles that are not people (`castRoles`). Every world, v1 included,
// now receives a mixed `seed`. v1 modules keep loading unchanged.

import type * as THREE_NS from "three";
import type { MiniActivity, MiniLook } from "./viz_mini_look.ts";
import type { VizBrand } from "./viz_brand.ts";

/** The contract version this host implements. A world declares the version it was built against. */
export const WORLD_API_VERSION = 2;

/** The three.js namespace the host renders with. */
export type ThreeNs = typeof THREE_NS;

/** Agent lifecycle, the same states the built-in figures play. */
export type WorldState = "idle" | "working" | "paused" | "ended" | "killed" | "failed";
/** A tap (stare) or a double tap (outburst) on the figure. */
export type WorldReaction = "stare" | "outburst";
export type WorldRole = "hub" | "agent" | "subagent";
export type WorldDetail = "full" | "reduced" | "minimal";
/** v2 (ADR-0649): whether a role is cast as people or as something else. */
export type WorldCastRole = "human" | "creature";

/** A user-set value from the world's options (WorldOption.key -> value). */
export type WorldOptionValues = Readonly<Record<string, string | boolean>>;

/** One option the host draws in the View menu (P-WORLDS.1: "details ironed on via the UI"). Changing one
 *  rebuilds the world's figures with the new values; values persist per world on this machine. */
export type WorldOption =
  | { key: string; label: string; type: "color"; default: string }
  | { key: string; label: string; type: "select"; default: string; choices: readonly { value: string; label: string }[] }
  | { key: string; label: string; type: "toggle"; default: boolean };

/** v2 (ADR-0649): who a human figure is, resolved by the host over the whole fleet (any 6 figures in a row hold at
 *  least 2 feminine and 2 masculine and span light, medium and dark skin). Stable per node for the session. */
export interface WorldAppearance {
  presentation: "feminine" | "masculine" | "neutral";
  /** Body build, slight to broad (0 to 3), independent of presentation. */
  body: 0 | 1 | 2 | 3;
  /** The skin tone, #rrggbb, from the host's 10-step ramp (viz_cast.SKIN_RAMP, light to deep). */
  skin: string;
  /** Its index on that ramp (0 lightest, 9 deepest), for a world with its own ramp of the same length. */
  skinIndex: number;
  skinBand: "light" | "medium" | "dark";
  /** A hair style id from the shared vocabulary (viz_cast.HAIR_STYLES: short, buzz, curls, coils, afro, puffs,
   *  locs, braids, long, wavy, bob, pixie, bun, ponytail, headscarf, hijab), always one that suits `presentation`.
   *  Map an id the world does not draw to its nearest style. */
  hair: string;
  /** The hair color, #rrggbb, black to platinum (viz_cast.HAIR_COLORS). */
  hairColor: string;
  /** A face variant, 0 to 7 (brows, eye shape, lips, freckles: the world decides what each one means). */
  face: number;
}

export interface WorldFigureOptions {
  role: WorldRole;
  /** For a subagent, the role of its parent: a world can make the hub's helpers one thing (Santa's reindeer)
   *  and an agent's helpers another. Null for the hub and agents. */
  parentRole: WorldRole | null;
  /** The persona colors the host assigns this node (accent, gi, shadows); a world may use or ignore them. */
  look: MiniLook;
  detail: WorldDetail;
  /** True in the 2D top-down map (the host tips the figure back to face the camera; keep it light). */
  flat: boolean;
  /** Stable per node and mixed over all 32 bits (v2: every bit range varies between nearby ids): pick variants
   *  (outfit, prop, name tag) from it, never from Math.random(). */
  seed: number;
  /** The model's sponsor (emblem colors and word, size class); null when unknown. kit.drawEmblem paints it. */
  brand: VizBrand | null;
  options: WorldOptionValues;
  /** v2 (ADR-0649): skin, hair, presentation, build and face for a human figure; draw these instead of rolling
   *  them from the seed. Absent for a role the world casts as a creature (castRoles). */
  appearance?: WorldAppearance;
}

/** One figure. Same surface as the built-in anime and office figures (viz_anime.AnimeFigure). */
export interface WorldFigure {
  /** Feet at the origin, facing +Z, about kit.FIGURE_HEIGHT tall (subagents are scaled by the host). */
  readonly group: THREE_NS.Group;
  setActivity(a: MiniActivity): void;
  /** 0..1 token rate: how hard the current activity plays. */
  setIntensity(x: number): void;
  setState(s: WorldState): void;
  /** A token surge one-shot. */
  burst(): void;
  /** A layer over the current activity; never changes the state. */
  react(kind: WorldReaction, camera: THREE_NS.Camera): void;
  /** A throwable (one of the world's WorldThrow kinds) or "storm" reached the figure from `from`. */
  hit(kind: string, from: THREE_NS.Vector3, camera: THREE_NS.Camera, strength?: number): void;
  /** 0..1, how charged the figure is after hits; decays inside update(). The host tints the node with it. */
  readonly charge: number;
  setIdleSeconds(sec: number): void;
  /** A git commit or push is running on this node: play the world's commit set piece for as long as it is on. */
  setCommit(on: boolean): void;
  setLook(l: MiniLook): void;
  update(tSec: number, dt: number, motion: boolean): void;
  dispose(): void;
}

/** The ground a figure stands on inside its cell (a snowy mound, a cloud, a turf patch). Optional: without it
 *  the host draws its glass cube and plate. The host keeps an invisible pick box either way. */
export interface WorldStage {
  readonly group: THREE_NS.Group;
  /** The node's status color (working, waiting, failed...), so the stage can show it (a rim, a lantern). */
  setStatusColor(c: THREE_NS.Color): void;
  update(tSec: number, dt: number, motion: boolean): void;
  dispose(): void;
}

export interface WorldStageOptions { role: WorldRole; parentRole: WorldRole | null; seed: number; detail: WorldDetail; flat: boolean; options: WorldOptionValues }

/** A throwable on the tray. `icon` is SVG path data in a 24x24 box, drawn as a 1.8px round stroke in the tray's
 *  ink color (the host sets it with setAttribute, never as markup). */
export interface WorldThrow { kind: string; label: string; tip: string; icon: string }

/** A thrown object in flight. The host flies `object` from the thrower to the target on an arc and calls
 *  update every frame; on arrival it removes the object, calls dispose, and calls the target figure's hit(kind). */
export interface WorldProjectile {
  readonly object: THREE_NS.Object3D;
  /** u: 0..1 along the flight. */
  update(u: number, dt: number): void;
  dispose(): void;
}

/** Everything a storm effect needs, in the scene's world space. */
export interface WorldStormContext {
  /** Add every object here; the host removes the group when the storm ends. */
  readonly group: THREE_NS.Group;
  /** The center and radius of the nodes it covers, and each node's position (figures get hit("storm")). */
  center: THREE_NS.Vector3;
  radius: number;
  targets: readonly THREE_NS.Vector3[];
  /** True in the 2D top-down map. */
  flat: boolean;
  /** False when the user prefers reduced motion: play a short, still version. */
  motion: boolean;
}

/** A running storm. update returns false when it is over (the host then disposes and removes it). */
export interface WorldStorm {
  update(tSec: number, dt: number): boolean;
  dispose(): void;
}

/** Something always present in the scene: snow flurries, drifting hearts, confetti, clover petals. */
export interface WorldAmbient {
  readonly object: THREE_NS.Object3D;
  update(tSec: number, dt: number, motion: boolean): void;
  dispose(): void;
}

export interface WorldEnvironment {
  /** True when the world's sky is light (the host lights the scene and picks label colors for a light sky). */
  light: boolean;
  /** Paint the sky into a 2D canvas the host turns into the scene background (no stars, no theme nebula). */
  paintSky(ctx: CanvasRenderingContext2D, width: number, height: number): void;
  /** Fog color and density (0 for none). */
  fog: { color: string; density: number };
  /** The lines between nodes: the anime plasma or the office fiber look, in the world's two colors. */
  edges: { style: "plasma" | "fiber"; colorA: string; colorB: string };
  /** The node tint while charged after hits. */
  chargeColor: string;
  /** Optional ambient layer: built once per scene mount, spread over `radius` around the origin. */
  createAmbient?(radius: number, flat: boolean, detail: WorldDetail): WorldAmbient;
}

export interface WorldDefinition {
  apiVersion: number;
  /** The pack id without the "world-" prefix ("christmas"); the host keys preferences by it. */
  id: string;
  /** The button label in the View menu ("Christmas"). */
  label: string;
  /** One line for the tooltip and the store ("Santa runs the workshop, elves build, reindeer fly the helpers"). */
  tagline: string;
  /** Exactly three, in tray order. */
  throws: readonly [WorldThrow, WorldThrow, WorldThrow];
  /** The storm button ("Blizzard"). */
  storm: { label: string; tip: string; icon: string };
  options: readonly WorldOption[];
  environment: WorldEnvironment;
  /** v2 (ADR-0649): roles that are not people (reindeer, doves, a walking pin) are "creature": they take no part
   *  in the fleet's presentation and skin balance and get no `appearance`. A role left out is "human". */
  castRoles?: { hub?: WorldCastRole; agent?: WorldCastRole; subagent?: WorldCastRole };
  createFigure(o: WorldFigureOptions): WorldFigure;
  createStage?(o: WorldStageOptions): WorldStage;
  createProjectile(kind: string, flat: boolean): WorldProjectile;
  createStorm(ctx: WorldStormContext): WorldStorm;
}

/** Shared building blocks, the same ones the built-in figures use, so a world matches their finish. */
export interface WorldKit {
  /** The figure height the host frames (feet to head) for hub and agent figures. */
  readonly FIGURE_HEIGHT: number;
  /** The cell edge (the anime glass cube) a figure and its stage must fit inside. */
  readonly CELL: number;
  /** A cel-shaded material on the host's stepped ramp (2 steps flat, 3 in 3D). */
  toon(params: { color: THREE_NS.ColorRepresentation; map?: THREE_NS.Texture | null; emissive?: THREE_NS.ColorRepresentation; emissiveIntensity?: number; transparent?: boolean; opacity?: number; side?: THREE_NS.Side }, flat: boolean): THREE_NS.MeshToonMaterial;
  /** The inverted-hull ink outline material (`width` in object units), shared per width. */
  ink(width: number): THREE_NS.Material;
  /** Add an ink hull for `mesh` (same geometry, ink material, drawn behind). Returns the hull. */
  outline(mesh: THREE_NS.Mesh, width: number): THREE_NS.Mesh;
  /** A rounded box geometry (three's RoundedBoxGeometry). */
  roundedBox(w: number, h: number, d: number, segments: number, radius: number): THREE_NS.BufferGeometry;
  /** Merge geometries into one (three's mergeGeometries); null when they cannot merge. */
  merge(geos: THREE_NS.BufferGeometry[]): THREE_NS.BufferGeometry | null;
  /** A canvas texture in sRGB with mipmaps, from a 2D painter. */
  canvasTexture(width: number, height: number, paint: (ctx: CanvasRenderingContext2D) => void): THREE_NS.CanvasTexture;
  /** Paint a model's sponsor emblem (mark plus word) into a square region of a 2D canvas. */
  drawEmblem(ctx: CanvasRenderingContext2D, brand: VizBrand, x: number, y: number, size: number): void;
  /** A deterministic 0..1 generator from a seed. */
  random(seed: number): () => number;
  /** Smooth value noise in 1D, -1..1. */
  noise1(x: number): number;
  ease: { inOut(t: number): number; out(t: number): number; in(t: number): number; back(t: number): number };
}

export interface WorldHost {
  readonly THREE: ThreeNs;
  readonly apiVersion: number;
  readonly kit: WorldKit;
}

/** What a world module's default export is. */
export type DefineWorld = (host: WorldHost) => WorldDefinition;

/** The manifest fields the host reads from an installed world (engine /api/worlds). */
export interface InstalledWorld {
  /** The package id ("world-christmas"). */
  id: string;
  version: string;
  name: string;
  /** The module URL, same-origin (/worlds/world-christmas/1.0.0/world.js). */
  module: string;
  apiVersion: number;
  installedAt: string;
}

/** "world-christmas" -> "christmas"; anything else -> null. */
export function worldKey(packageId: string): string | null {
  const m = /^world-([a-z0-9][a-z0-9-]{0,40})$/.exec(packageId);
  return m ? m[1]! : null;
}
