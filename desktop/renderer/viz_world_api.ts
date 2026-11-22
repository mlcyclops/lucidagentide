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
// Also v2, additive: quality `tier` (ADR-0651), the `swatch` option type (ADR-0650), "plasma-light" edges with a
// packet `token` and `environmentFor(options)` (ADR-0652), the character kit (ADR-0654) and build sites (ADR-0653).

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
/** v2 (ADR-0651): the quality tier, a superset of WorldDetail. The host still passes `detail` ("full" for ultra and
 *  cinematic) so v1 checks like `detail === "full"` keep working; a v2 world reads `tier` to add more. */
export type WorldTier = WorldDetail | "ultra" | "cinematic";
/** v2 (ADR-0649): whether a role is cast as people or as something else. */
export type WorldCastRole = "human" | "creature";
/** v2 (ADR-0652): the packet shape that rides a world's edges. "custom" uses WorldEdges.paintToken. */
export type WorldToken = "orb" | "coin" | "petal" | "snowflake" | "spark" | "custom";

/** A user-set value from the world's options (WorldOption.key -> value). */
export type WorldOptionValues = Readonly<Record<string, string | boolean>>;

/** One option the host draws in the View menu (P-WORLDS.1: "details ironed on via the UI"). Changing one
 *  rebuilds the world's figures with the new values; values persist per world on this machine. */
export type WorldOption =
  | { key: string; label: string; type: "color"; default: string }
  | { key: string; label: string; type: "select"; default: string; choices: readonly { value: string; label: string }[] }
  | { key: string; label: string; type: "toggle"; default: boolean }
  /** v2 (ADR-0650): a named ramp of colors drawn as swatch buttons (uniform shades, kit colors); the value is the
   *  chosen swatch's `value` (#rrggbb). */
  | { key: string; label: string; type: "swatch"; default: string; swatches: readonly { value: string; label: string }[] };

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
  /** v2 (ADR-0651): the quality tier (ultra and cinematic come with `detail: "full"`). */
  tier?: WorldTier;
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

export interface WorldStageOptions { role: WorldRole; parentRole: WorldRole | null; seed: number; detail: WorldDetail; flat: boolean; options: WorldOptionValues; tier?: WorldTier }

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
  edges: WorldEdges;
  /** The node tint while charged after hits. */
  chargeColor: string;
  /** Optional ambient layer: built once per scene mount, spread over `radius` around the origin. v2 hosts pass the
   *  quality tier as the 4th argument. */
  createAmbient?(radius: number, flat: boolean, detail: WorldDetail, tier?: WorldTier): WorldAmbient;
}

/** The edges between nodes. v2 (ADR-0652) adds "plasma-light" (a plasma stream that reads on light skies: a saturated
 *  core, an outer sheath and normal-blended packets with a bright rim) and the packet `token`. */
export interface WorldEdges {
  style: "plasma" | "fiber" | "plasma-light";
  colorA: string;
  colorB: string;
  /** v2: the packet shape (default "orb"). */
  token?: WorldToken;
  /** v2: the packet color (default a mix of colorA and colorB). */
  tokenColor?: string;
  /** v2: paints the sprite for token "custom" into a square canvas (transparent background, centered). */
  paintToken?(ctx: CanvasRenderingContext2D, size: number): void;
  /** v2: paints the face stamp of a built-in token (a shamrock on a coin) into a square canvas. */
  tokenStamp?(ctx: CanvasRenderingContext2D, size: number): void;
}

/** v2 (ADR-0652): the parts of the environment that follow the user's options. The host calls it on load and on
 *  every option change, repaints the sky and re-applies edges, fog and the charge color. */
export type WorldEnvironmentPatch = Partial<Pick<WorldEnvironment, "light" | "paintSky" | "fog" | "edges" | "chargeColor">>;

/** v2 (ADR-0653): the host's scaffolding looks. "wireframe": glowing frame boxes that build up; "holo": the frames
 *  plus holo beams and a scan ring; "panels": the frames plus floating holo panels. Every look has the progress ring
 *  and the lock-in flash. */
export type WorldScaffoldStyle = "wireframe" | "holo" | "panels";

/** v2 (ADR-0653): a build site. Where a node's agents build and how the scaffolding looks. */
export interface WorldBuildSite {
  /** Which nodes build here (default: hub and agent). Subagents never get a site: their spawns ARE the pieces. */
  roles?: readonly ("hub" | "agent")[];
  /** From the node's center in cell units (kit.CELL, scaled by the node's size): x right, y up, z toward the front.
   *  Default [0.95, -0.5, 0]: beside the stage, on its floor. */
  anchor?: readonly [number, number, number];
  /** Default "holo". */
  style?: WorldScaffoldStyle;
  /** The scaffold color, #rrggbb (default: the world's edge colorA). */
  color?: string;
  /** What the site is called in the node's panel ("Construction pad"). */
  label?: string;
}

/** v2 (ADR-0653): a mini-game template: a task brief a lane runs as an ordinary agent task. */
export interface WorldMiniGame {
  /** Stable id, [a-z0-9-], unique in the world. */
  id: string;
  /** The button label ("Bowling scorekeeper"). */
  label: string;
  /** The task brief sent to the agent as is. Ask for ONE self-contained HTML file (inline CSS and JS, no network,
   *  no external assets) in a fenced html block: that block becomes the artifact. */
  brief: string;
  /** Optional: a ready-made, playable example of what the brief produces (ONE self-contained HTML document, inline
   *  CSS and JS, no network, no external assets, at most 64 KB). The host shows it as a labeled sample: the
   *  `?vizDemo=1` builds end in it, and the node panel can play it as a preview. It passes the same security gate
   *  and sandbox as an agent-built artifact. */
  sample?: string;
}

/** v2 (ADR-0653): what kit.scaffold builds. */
export interface WorldScaffoldOptions {
  style: WorldScaffoldStyle;
  /** #rrggbb. */
  color: string;
  /** The quality tier: it decides how many pieces, beams, panels and ring segments are drawn. */
  tier: WorldTier;
  /** True in the 2D top-down map. */
  flat: boolean;
  /** Stable per node (layout jitter only). */
  seed: number;
}

/** v2 (ADR-0653): host-driven scaffolding. Feet at the origin; about one cell wide and tall. The host drives it from
 *  agent events; a world may also use one as a prop. Every call is safe at any time (a lock with nothing to lock does
 *  nothing). */
export interface WorldScaffold {
  readonly group: THREE_NS.Group;
  /** Pieces added so far (capped by the tier's budget), locked in so far, and whether the build is revealed. */
  readonly pieces: number;
  readonly locked: number;
  readonly revealed: boolean;
  /** Wireframe pieces build up (one per subagent). */
  addPieces(n: number): void;
  /** The oldest unlocked piece locks in with a flash. */
  lockIn(): void;
  /** The newest unlocked piece flickers red, then recovers. */
  fail(): void;
  /** Every piece locks in, the beams flare and the ring completes: the build stands revealed. */
  reveal(): void;
  /** Back to an empty site (a new build). */
  reset(): void;
  /** Jump to a state without animation (the scene was rebuilt). */
  restore(pieces: number, locked: number, revealed: boolean): void;
  /** One frame; true while something still animates. Allocation free. */
  update(tSec: number, dt: number, motion: boolean): boolean;
  dispose(): void;
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
  /** v2 (ADR-0652): the environment for the user's option values, merged over `environment`. */
  environmentFor?(options: WorldOptionValues): WorldEnvironmentPatch;
  /** v2 (ADR-0649): roles that are not people (reindeer, doves, a walking pin) are "creature": they take no part
   *  in the fleet's presentation and skin balance and get no `appearance`. A role left out is "human". */
  castRoles?: { hub?: WorldCastRole; agent?: WorldCastRole; subagent?: WorldCastRole };
  /** v2 (ADR-0653): where and how this world's agents build (a construction pad, a kitchen pass, a workbench). The
   *  host picks the first site whose `roles` include the node's role. A world that declares none (every v1 world)
   *  gets the host's default: a holo build ring beside the stage. */
  buildSites?: readonly WorldBuildSite[];
  /** v2 (ADR-0653): up to three mini-game templates. The user starts one from a node's panel; the brief runs on that
   *  lane as an ordinary agent task, and the single self-contained HTML file it ends with becomes the artifact. */
  miniGames?: readonly WorldMiniGame[];
  createFigure(o: WorldFigureOptions): WorldFigure;
  createStage?(o: WorldStageOptions): WorldStage;
  createProjectile(kind: string, flat: boolean): WorldProjectile;
  createStorm(ctx: WorldStormContext): WorldStorm;
}

// ---------------------------------------------------------------------------------------------------------------
// v2 (ADR-0654): the character kit (WorldKit.character). Parts for the shared template biped every pack forked from
// soccer (built BUILD_H 1.1 tall, then scaled to FIGURE_HEIGHT; joints root, spine, head, shL/elL/handL, shR/elR/handR,
// hipL/knL/footL, hipR/knR/footR; limbs are capsules hanging along -Y with y = 0 on the joint; +Z is the face, +X the
// figure's left). Every length below is in those build units. A pack keeps its own rig and dresses these parts.

/** The 16 shared hair style ids (viz_cast.HAIR_STYLES uses the same ids). */
export type WorldHairStyle =
  | "short" | "buzz" | "curls" | "coils" | "afro" | "puffs" | "locs" | "braids"
  | "long" | "wavy" | "bob" | "pixie" | "bun" | "ponytail" | "headscarf" | "hijab";

/** The template rig's joint offsets (soccer's BipedSpec), resized for a body shape. */
export interface WorldBipedSpec { hipY: number; hipX: number; thigh: number; shin: number; spineUp: number; shY: number; shX: number; upper: number; fore: number; headY: number }

/** Body proportions for a presentation and a build. Template values (soccer's player) in brackets. */
export interface WorldBodyShape {
  presentation: WorldAppearance["presentation"];
  body: WorldAppearance["body"];
  /** Shoulder joint distance from the spine axis [0.15]. */
  shoulder: number;
  /** Torso radius at the chest, the waist and the hips [0.134, 0.108, 0.113]. */
  chest: number;
  waist: number;
  hip: number;
  /** Torso depth over width (the lathe's z scale) [0.78]. */
  depth: number;
  /** Forward chest fullness, 0 (flat) to 1. */
  bust: number;
  /** Height scale [1]: legs, spine, neck and arm lengths (spec); the head keeps its size. */
  height: number;
  /** Limb radius scale [1] (upper arm 0.042, forearm 0.038, thigh 0.056): scale capsules by it in x and z. */
  limb: number;
  /** Neck radius [0.044]. */
  neck: number;
  /** Width scale of the lower half of the head (below its center) [1]. */
  jaw: number;
  /** The rig offsets for these proportions: shX = shoulder, legs and spine scaled by height. */
  spec: WorldBipedSpec;
}

export interface WorldHairOptions {
  /** Detail: minimal, reduced and full change segments and extras; ultra and cinematic add strand cards. */
  tier?: WorldTier;
  /** The 2D map: fewer segments, no cards. */
  flat?: boolean;
  /** Worn under a hat or helmet: nothing above the brim line (CAP_LINE radians from the top of the head) reaches past
   *  CAP_RADIUS, while hair below the brim still shows (a low bun, the ponytail at the nape, a ring of curls). */
  capSafe?: boolean;
  /** The head sphere's radius the hair is fitted to [0.112]; the hair scales with it. */
  headRadius?: number;
  /** Varies strand placement (locs, braids, cards). */
  seed?: number;
}

/** A hair (or a head covering) in head-center space: the head sphere's center, +Y up, +Z the face. */
export interface WorldHair {
  /** The style drawn (an unknown id maps to its nearest style). */
  readonly style: WorldHairStyle;
  /** One merged geometry for the hair mass. */
  readonly geometry: THREE_NS.BufferGeometry;
  /** Strand cards (ribbons with uv: u across, v from root to tip) from tier ultra, else null; also null for buzz,
   *  locs, braids, headscarf and hijab. Draw with the hair material and side DoubleSide. */
  readonly cards: THREE_NS.BufferGeometry | null;
  /** True for headscarf and hijab: cloth, so dress it in a fabric color rather than the hair color. */
  readonly cloth: boolean;
  dispose(): void;
}

export interface WorldSleeveOptions {
  length: "short" | "long";
  /** Limb scale and height from a body shape (default the template). */
  shape?: WorldBodyShape;
  tier?: WorldTier;
  flat?: boolean;
  /** The pack's arm capsule radii before the limb scale [0.042, 0.038]. */
  armRadius?: number;
  foreRadius?: number;
  /** The widest ink hull the arm wears [0.012, the flat width]; the cap clears it. */
  ink?: number;
}

/** Sleeve-safe parts. The cap is a flat lens over the upper arm capsule's round top (no higher than that top, a
 *  little wider), so it turns with the arm: parent it to the SHOULDER JOINT, like the sleeve, and draw it in the
 *  shirt's material; it then holds the round top at every shoulder angle, and the torso's shoulder yoke
 *  (WorldCharacterKit.torso) carries the shirt out to it. Never scale these parts: they are sized for the shape's limbs
 *  already. */
export interface WorldSleeve {
  /** Shoulder-joint space, shirt material; parented to the shoulder joint. */
  readonly cap: THREE_NS.BufferGeometry;
  /** Shoulder-joint space, sleeve material: from the joint down to the hem (short) or the elbow (long). */
  readonly upper: THREE_NS.BufferGeometry;
  /** Elbow-joint space (long only, else null): an elbow ball and the forearm sleeve down to the cuff. */
  readonly fore: THREE_NS.BufferGeometry | null;
  /** The cap's top above the joint, and the hem below the joint (short) or the cuff below the elbow. */
  readonly top: number;
  readonly hem: number;
  dispose(): void;
}

export interface WorldTorsoOptions {
  shape: WorldBodyShape;
  tier?: WorldTier;
  flat?: boolean;
}

/** What a face variant and presentation turn into. Beards only come from WorldFaceOptions.beard, never a role. */
export interface WorldFaceFeatures {
  /** 0 none, 1 a few, 2 full lashes. */
  lashes: 0 | 1 | 2;
  browColor: string;
  /** Stroke width and arch height in face canvas units. */
  browWidth: number;
  browArch: number;
  /** A lip color under a closed mouth, or null. */
  lipTint: string | null;
  freckles: boolean;
  blush: string | null;
  /** A frame color, or null. */
  glasses: string | null;
  beard: "none" | "stubble" | "short" | "full" | "mustache";
}

/** The template face canvas layout (soccer face.ts: 256 x 168 units, eyes 46 either side of center at y 72, mouth at
 *  y 128, eye ellipses 11 x 16) and the explicit choices. */
export interface WorldFaceOptions {
  width?: number;
  height?: number;
  eyeY?: number;
  eyeDX?: number;
  mouthY?: number;
  eyeW?: number;
  eyeH?: number;
  /** Only an explicit option draws a beard (default "none"). */
  beard?: WorldFaceFeatures["beard"];
  /** A frame color, or true / false to force glasses on or off (default: by face variant). */
  glasses?: string | boolean;
}

/** The expression the world is painting (its own eyes and mouth), so the features follow it. */
export interface WorldFaceState {
  /** 0 open, 1 half shut, 2 shut. */
  blink?: 0 | 1 | 2;
  /** Eyes drawn as happy arcs. */
  smile?: boolean;
  /** Brow raise and inner-end tilt in canvas units (soccer's brow: positive tilt raises the inner end). */
  browLift?: number;
  browTilt?: number;
  /** An open mouth hides the lip tint. */
  mouthOpen?: boolean;
}

/** Paints a figure's face features onto the template's canvas face, in two passes around the world's own eyes and
 *  mouth: skin fill, under(), the world's eyes and mouth (without its brows), over(). Both set `scale` themselves. */
export interface WorldFacePainter {
  readonly features: WorldFaceFeatures;
  /** Blush, freckles, a beard and the lip tint. */
  under(ctx: CanvasRenderingContext2D, scale: number, state?: WorldFaceState): void;
  /** Lashes, brows, glasses and a mustache. */
  over(ctx: CanvasRenderingContext2D, scale: number, state?: WorldFaceState): void;
}

export interface WorldCharacterKit {
  readonly HAIR_STYLES: readonly WorldHairStyle[];
  /** The template head sphere radius (0.112) and the hair shell radius (0.1175). */
  readonly HEAD_RADIUS: number;
  readonly HAIR_RADIUS: number;
  /** The brim line, radians from the top of the head, and the radius capSafe hair stays inside above it: a hat or
   *  helmet at least CAP_RADIUS in radius that reaches CAP_LINE hides nothing a capSafe hair shows. */
  readonly CAP_LINE: number;
  readonly CAP_RADIUS: number;
  /** The torso lathe's ring heights in spine space at height 1 (place shirt decals with them, times shape.height). */
  readonly TORSO_HEIGHTS: readonly number[];
  /** Proportions for an appearance (presentation and build); absent: neutral, average build. */
  bodyShape(appearance?: Pick<WorldAppearance, "presentation" | "body"> | null): WorldBodyShape;
  /** A hair style (any WorldAppearance.hair id; unknown ids map to the nearest style). The caller disposes it. */
  hair(style: string, opts?: WorldHairOptions): WorldHair;
  /** Sleeve-safe shoulder cap and short or long sleeve. The caller disposes it. */
  sleeve(opts: WorldSleeveOptions): WorldSleeve;
  /** The shirt lathe in spine space (the template's ring heights, seam at the side, uv like soccer's torso), shaped
   *  for chest, waist, hips and shoulders. The caller disposes it. */
  torso(opts: WorldTorsoOptions): THREE_NS.BufferGeometry;
  /** Face features for an appearance and face variant (null: neutral, variant 0). */
  face(appearance: WorldAppearance | null | undefined, opts?: WorldFaceOptions): WorldFacePainter;
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
  /** v2 (ADR-0653): host scaffolding (wireframe build-up, holo beams, panels, a progress ring, a lock-in flash),
   *  the same one the host draws at build sites. The caller disposes it. */
  scaffold(o: WorldScaffoldOptions): WorldScaffold;
  /** v2 (ADR-0654): body shapes, the hair library, sleeve-safe shoulders, the torso lathe and face features for the
   *  shared template biped. Absent on a v1 host. */
  readonly character: WorldCharacterKit;
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
