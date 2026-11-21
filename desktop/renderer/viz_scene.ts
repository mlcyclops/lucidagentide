// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/viz_scene.ts - P-VIZ.1 (ADR-0622), P-VIZ.2 (ADR-0623), P-VIZ.3 (ADR-0624): the Visualize
// view's three.js scene.
//
// Every node is the anime mini Lucid (viz_anime.createAnimeFigure, built at the perf tier's detail), dressed in
// its persona's color (viz_mini_look.lookFor). He runs his persona's rotation of activities while the node works
// (viz_mini_look.activityAt), faster with the node's smoothed est. tok/s, powers up on a surge, hits a victory
// when a working turn ends, and plays the node's power-downs (failed, paused, ended, killed) with his eyes.
//   3D: the toon-shaded figure (3 steps, thin ink) inside a translucent glass CUBE: a clear rounded box with a
//       faint iridescence, thin bright accent edges and a dark floor plate he stands on, turning to face the
//       camera. Subagents get smaller cubes, the hub a larger one. The role and task caption is a crisp canvas
//       sprite on the cube's lower front edge.
//   2D: the same figure in the flat cel style (2 steps, thick ink), standing upright with his front turned up
//       to the top-down camera, filling about 80 percent of a flat rounded tile in the persona color; the
//       caption on the tile's lower edge.
// P-VIZ.4 (ADR-0627): setStyle("professional") rebuilds every node with the office cast instead
// (viz_office.createOfficeFigure: the hub is the boss at the central desk, everyone else a worker at a monitor).
// In 3D the cube becomes a low fabric cubicle riding the figure (the glass stays as an invisible pick box, its
// edge color draws the cubicle's top edges); 2D keeps the tile.
// Lighting follows the camera like the anime lab's sheet: a key from the upper front right, a cool rim light
// from behind, and the hemisphere fill.
//
// Edges are viz_plasma conduits from the producer to its parent (P-VIZ.4, ADR-0626; P-VIZ.5, ADR-0630): a thin
// spinning plasma conduit with token particles swirling around and through it and small plasma pulses (anime)
// or a thin line with streaming red light particles (professional), both scaling with the node's est. tok/s,
// arcing high between agents and lower to a subagent; the hub's own stream is a closed loop around it. A
// surge flares the edge, throws a jagged regenerated lightning bolt along it and a plasma burst (an expanding
// shader billboard plus a spark spray). Power-downs are
// distinct: tool-failed flickers red, sheds sparks and shakes, then recovers; paused freezes the flow under
// a frosty blue tint; ended dims gracefully with rising green embers and frosts the glass; killed implodes
// in a white flash, cracks the glass and leaves it dark gray.
//
// The camera: an AUTO camera (on by default) follows viz_director's focus, the node where the action is most,
// on critically damped springs: it frames the focused cube to about FILL of the view height with a gentle
// sway around it, or pulls back to the overview when nothing happens. The moment the user drags, pans or
// zooms (a real pointer move or wheel, not a click), auto turns off and the view is told (onUserCamera);
// setAuto(true) glides back from wherever the user left the camera.
//
// P-VIZ.6 (ADR-0636): throwAt flies a throwable at a node (viz_throw.createThrowFx: projectiles, impacts) and
// calls the figure's hit() on arrival; storm() plays the style's storm and hits every figure, staggered along
// the storm front. A figure's `charge` (a drink, a bolt, absorbed energy balls) brightens its node's edges and
// plate while it lasts. Reduced motion: no flight and no flashes, the hit lands at once.
//
// P-WORLDS.1 (ADR-0648): setStyle(`world:<key>`, world) builds every node with an installed Lucid Agent World
// (viz_world_api.WorldDefinition, loaded and validated by viz_worlds): its figures (hub, agent, subagent with its
// parent's role), its stage under each one (else the glass cube and plate; an invisible pick box either way; the
// stage gets the node's status color), its sky painted into the backdrop, its fog, its edge look and colors, its
// charge tint and its ambient layer (built on activation and on a 2D/3D switch, updated every frame). Its
// throwables fly the same arc (viz_throw.launchWorld) and its storm is its own effect (createStorm, updated until
// it ends) while the figures are hit("storm") along the front from the sky like the anime storm. The view passes
// a theme whose `light` follows the world's sky (it remounts when that flips), so lights, bloom and labels match.
//
// Resource contract (the orbit canvas's, ADR-0522): a DPR-capped canvas sized by a ResizeObserver, a frame
// loop capped by the perf tier (viz_model.vizTierOpts / frameInterval) that drops to an idle cadence when
// nothing moves and parks entirely when hidden or under reduced motion with nothing changing. destroy()
// disposes every geometry, material, texture, render target, figure, the controls and the WebGL context.

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { angleDelta, createDirector, cue, directorStep, frameDistance, springStep } from "./viz_director.ts";
import { ANIME_HEIGHT, createAnimeFigure, type AnimeState } from "./viz_anime.ts";
import { createOfficeFigure } from "./viz_office.ts";
import { vizBrandFor, type VizBrand } from "./viz_brand.ts"; // P-VIZ.7 (ADR-0641)
import { activityAt, lookFor, type MiniActivity, type MiniLook } from "./viz_mini_look.ts";
import { createEdgeFx, type EdgeConduit } from "./viz_plasma.ts";
import { edgeBow, edgeLift, edgeStyleFor } from "./viz_plasma_math.ts";
import { createThrowFx, skyAbove } from "./viz_throw.ts";
import { isThrowKind } from "./viz_throw_kinds.ts";
import { launchPx, stormSchedule, volley } from "./viz_throw_math.ts";
import { CUBE, frameInterval, IDLE_FPS, isBuiltinStyle, KIND_SCALE, PERSONAS, type Persona, type PowerKind, type Vec3, type VizEvent, type VizKind, type VizStatus, type VizStyle, type VizTierOpts } from "./viz_model.ts";
import type { WorldAmbient, WorldDefinition, WorldFigure, WorldOptionValues, WorldStage, WorldStorm } from "./viz_world_api.ts";

export type VizViewMode = "2d" | "3d";

/** P-VIZ.4 (ADR-0625): `team` = how many of the node's team work right now (viz_model.teamOf; an idle node
 *  with a working team supervises), `idleSec` = whole seconds since it last worked (figure.setIdleSeconds).
 *  `model` (P-VIZ.7, ADR-0641) picks the figure's sponsor, size and variant (viz_brand); `committing` plays the
 *  style's git commit animation while a commit or push call runs. `parentKind` (P-WORLDS.1, ADR-0648): the kind
 *  of a subagent's parent node (a world casts the hub's helpers and an agent's differently); null otherwise. */
export interface SceneNode { id: string; kind: VizKind; persona: Persona; label: string; status: VizStatus; pos: Vec3; glow: number; team: number; idleSec: number; model: string; committing: boolean; parentKind: VizKind | null }

/** P-WORLDS.1 (ADR-0648): the world a `world:<key>` style draws with, and the user's option values for it. A
 *  new object (new options) rebuilds the figures and stages. */
export interface SceneWorld { readonly def: WorldDefinition; readonly options: WorldOptionValues }
export interface SceneEdge { from: string; to: string; intensity: number; frozen: boolean; dead: boolean }
export type SceneHit = { kind: "node"; id: string } | { kind: "edge"; from: string; to: string };

/** Theme colors, already normalized to #rrggbb by the view (read from the CSS custom properties). */
export interface VizTheme { bg: string; txt: string; accent: string; cyan: string; light: boolean }

export interface VizSceneHandle {
  readonly canvas: HTMLCanvasElement;
  sync(nodes: readonly SceneNode[], edges: readonly SceneEdge[]): void;
  fire(events: readonly VizEvent[]): void;
  setView(mode: VizViewMode): void;
  /** P-VIZ.4 (ADR-0627): rebuild every node's figure in the style (anime mini Lucids in glass cubes, or the
   *  office cast in cubicles) and switch the edges with it (plasma or fiber, viz_plasma). P-WORLDS.1: a world
   *  style needs its `world` (ignored without it); calling it again with new options rebuilds the figures. */
  setStyle(style: VizStyle, world?: SceneWorld | null): void;
  /** Re-frame the camera on every node (after a layout switch, or on demand). Leaves auto as it is. */
  fit(): void;
  /** Auto camera on (glides from the current view to the action) or off (the user's controls only). */
  setAuto(on: boolean): void;
  /** The user took the camera (a drag, pan, pinch or wheel): auto has turned itself off. */
  onUserCamera(cb: () => void): void;
  setVisible(on: boolean): void;
  setRecording(on: boolean): void;
  onHover(cb: (hit: SceneHit | null, x: number, y: number) => void): void;
  /** A single click (delivered only once no second click followed within DOUBLE_MS). */
  onPick(cb: (hit: SceneHit | null, x: number, y: number) => void): void;
  /** P-VIZ.4 (ADR-0625): a double click (its first click is never delivered to onPick). */
  onDoublePick(cb: (hit: SceneHit | null, x: number, y: number) => void): void;
  /** P-VIZ.4: the node's figure reacts to the viewer (a stare, or an outburst); its work and state go on. */
  reactNode(id: string, kind: "stare" | "outburst"): void;
  /** P-VIZ.5 (ADR-0629): the node's frame on screen, in client pixels: its center and its half extent (r).
   *  Still reported when the node is off to a side (the panel docks at that edge); null when it is behind the
   *  camera or gone. The node panel sits beside it. */
  screenBoxOf(id: string): { x: number; y: number; r: number } | null;
  /** P-VIZ.6 (ADR-0636): throw `kind` at the node: it flies (an arc from `from`, stage px where the throw
   *  started, or the viewer's side; the bolt strikes from above) and the figure reacts on arrival. Reduced
   *  motion: no flight, the hit lands at once. False when there is no such node, or `kind` is not a built-in
   *  ThrowKind (built-in styles) or not one of the world's three kinds (a world style, P-WORLDS.1). */
  throwAt(nodeId: string, kind: string, from?: { x: number; y: number }): boolean;
  /** P-VIZ.6: the style's storm (anime: dark sky and lightning strikes; professional: a gust of papers) and every
   *  figure hit("storm") as the front reaches it. The caller rate limits it (viz_throw tray). */
  storm(): void;
  /** P-VIZ.7 (ADR-0641): a scripted camera shot for recorded demos (the view exposes it only with ?vizScript=1).
   *  The camera springs to `offset` in the node's own frame (its desk, its stapler, the cloud above it) at `dist`,
   *  `polar` and `az` (radians; az relative to the way the figure faces), drifting `azSpeed` radians a second; the
   *  node stops turning to the camera while it is the subject. null hands the camera back (to auto, if it is on). */
  scriptShot(id: string | null, opts?: { offset?: Vec3; dist?: number; polar?: number; az?: number; azSpeed?: number }): void;
  /** P-VIZ.6: the node under client (x, y), or null. */
  nodeAt(x: number, y: number): string | null;
  /** P-VIZ.6: a throwable is armed (`cursor`, a CSS cursor showing it) or not (null). While armed every click is
   *  delivered to onPick at once (no double click wait). */
  setThrowArmed(cursor: string | null): void;
  onLost(cb: () => void): void;
  destroy(): void;
}

// ------------------------------------------------------------------------------------------ shaders

const POINT_VS = /* glsl */ `
attribute float aSize;
attribute float aAlpha;
attribute vec3 aColor;
uniform float uScale;
uniform float uOrtho;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vColor = aColor;
  vAlpha = aAlpha;
  if (aAlpha <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float s = uOrtho > 0.5 ? aSize * uScale : aSize * uScale / max(0.001, -mv.z);
  gl_PointSize = clamp(s, 1.0, 72.0);
}`;

const POINT_FS = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = dot(c, c) * 4.0;
  if (d > 1.0) discard;
  float core = exp(-d * 7.0);
  float halo = exp(-d * 2.4) * 0.45;
  float a = (core + halo) * vAlpha;
  gl_FragColor = vec4(vColor * (core * 1.7 + halo), a);
  gl_FragColor = linearToOutputTexel(gl_FragColor);
}`;

const BURST_VS = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

const BURST_FS = /* glsl */ `
uniform float uT;
uniform float uSeed;
uniform vec3 uColor;
varying vec2 vUv;
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  if (r > 1.0) discard;
  float ang = atan(p.y, p.x);
  float ring = smoothstep(uT - 0.24, uT, r) * (1.0 - smoothstep(uT, uT + 0.07, r));
  float streak = pow(max(0.0, sin(ang * 9.0 + uSeed * 6.2832 + r * 9.0)), 6.0) * (1.0 - r) * (1.0 - uT);
  float core = pow(max(0.0, 1.0 - r), 3.0) * (1.0 - uT) * 1.5;
  float a = (ring * 1.5 + streak + core) * (1.0 - uT * 0.85);
  gl_FragColor = vec4(uColor * a, a);
  gl_FragColor = linearToOutputTexel(gl_FragColor);
}`;

// ------------------------------------------------------------------------------------------ constants

const ICE = new THREE.Color("#9ad8ff");
const RED = new THREE.Color("#ff3b30");
const AMBER = new THREE.Color("#ffb020");
const EMBER = new THREE.Color("#5dff9a");
const DEAD = new THREE.Color("#2a2d33");
const WHITE = new THREE.Color("#ffffff");
const SPARK = new THREE.Color("#ffae42");
/** P-VIZ.6: an energized node's edges lean toward these (anime: electric cyan; professional: warm gold). */
const CHARGE_ANIME = new THREE.Color("#8fe3ff");
const CHARGE_PRO = new THREE.Color("#ffd166");

// KIND_SCALE and CUBE (the glass cube's side before the kind's scale) live in viz_model: the layout spaces
// the cubes by them.
const FLOOR_Y = -CUBE / 2;
const PLATE_H = 0.045;
/** The 2D tile's side (before the kind's scale). */
const TILE = 1.5;
/** The 2D figure fills about 80 percent of the tile's height, his feet a little above the caption. */
const FIG_2D_SCALE = (TILE * 0.8) / ANIME_HEIGHT;
/** In 3D he stands about 0.85 of the cube's height, so he reads as the subject and not a figurine in a box. */
const FIG_3D_SCALE = 1.15;
const FIG_2D_FEET_Z = 0.56;
/** 2D layers above the node's plane: the tile covers the edge ends; the figure lies face up high enough that
 *  his hair and the spikes behind his head clear the tile; the caption sits above the figure. */
const TILE_Y = 0.1, FIG_2D_Y = 0.55, LABEL_2D_Y = 1.6;
/** Camera-relative lights (the anime lab's sheet): key from the upper front right, rim from behind. */
const KEY_DIR = new THREE.Vector3(2.5, 3, 3);
const RIM_DIR = new THREE.Vector3(-2, 1.5, -3);
/** A tool failure: the figure flinches this long, then goes back to its status. */
const FAIL_MS = 900;
/** The figure's intensity follows the node's est. tok/s with this time constant (seconds). */
const POWER_TAU = 0.6;

/** Auto camera: the focused cube fills this share of the view height (padded for its depth). */
const FILL = 0.45;
/** 2D frames the focus looser: the flat map is about who is talking to whom, so the neighbors stay in view. */
const FILL_2D = 0.24;
const FRAME_PAD = 1.15;
/** Spring natural frequency (rad/s): a focus change glides in about 1.5 s, so the subject is centered most of the hold. */
const CAM_OMEGA = 3.2;
/** The sway around the focus: azimuth amplitude (rad), polar amplitude (rad), period (s). */
const SWAY_AZ = 0.42, SWAY_POLAR = 0.06, SWAY_S = 26;
/** Polar angles from straight up: a little above the figure's eyes when focused, the fit's angle for the overview. */
const FOCUS_POLAR = 1.12, OVERVIEW_POLAR = 0.77;
/** A press that moves this far (CSS px) is the user taking the camera, not a click. */
const GRAB_PX = 4;
/** P-VIZ.4: a second click this soon (ms) after the first, near it, is a double click. */
const DOUBLE_MS = 260;
/** P-VIZ.4: full-cadence frames after a reaction; covers the longest one (the office outburst plus its glare, 3.45 s). */
const REACT_MS = 3600;

const BOLT_PTS = 33;
const BRANCH_PTS = 9;
const BOLT_POOL = 8;
const BURST_POOL = 8;
const BOLT_MS = 380;
const BURST_MS = 650;
/** The hub's own stream: a closed loop this far out from its center, lifted a little. */
const LOOP_R = 1.55, LOOP_LIFT = 0.1;

interface NodeFx { flickerUntil: number; shakeUntil: number; shakeAmp: number; implodeAt: number; colorUntil: number; failUntil: number }

/** What drives a node's figure (both modes): the figure, the holder it rides, and what it was last told. The
 *  anime and office figures have the same surface as a world's (viz_world_api.WorldFigure). `stage`
 *  (P-WORLDS.1): the world's ground under the figure, when the world brings one. */
interface FigureSlot { fig: WorldFigure; holder: THREE.Group; activity: MiniActivity | null; state: AnimeState | null; committing: boolean; stage: WorldStage | null }

/** The 3D parts of a node: the figure in its glass cube. `office`: the professional style, where the glass is an
 *  invisible pick box, the cubicle rides the figure and `edgeMat` draws the cubicle's top edges. With a world's
 *  stage the glass is an invisible pick box too, `edgeMat` draws nothing (its color goes to the stage) and there
 *  is no plate. */
interface Node3D extends FigureSlot {
  glass: THREE.Mesh; glassMat: THREE.MeshPhysicalMaterial; edgeMat: THREE.LineBasicMaterial; plateMat: THREE.MeshStandardMaterial | null; office: boolean;
}

/** The 2D parts of a node: the flat figure on its tile. */
interface Node2D extends FigureSlot { tile: THREE.Mesh; tileMat: THREE.MeshBasicMaterial; rimMat: THREE.LineBasicMaterial }

interface NodeObj {
  id: string; kind: VizKind; parentKind: VizKind | null; persona: Persona; size: number; seed: number;
  look: MiniLook; base: THREE.Color; tileBase: THREE.Color;
  root: THREE.Group; pivot: THREE.Group;
  d3: Node3D | null; d2: Node2D | null;
  label: THREE.Sprite; labelMat: THREE.SpriteMaterial; labelText: string;
  cracks: THREE.LineSegments | null;
  status: VizStatus; glow: number; power: number;
  cur: THREE.Vector3; target: THREE.Vector3; placed: boolean;
  tone: { tint: number; dim: number; frost: number };
  fx: NodeFx;
  /** P-VIZ.4: working team members (an idle node with a team at work supervises) and idle seconds, with the
   *  figure that last heard the idle seconds (a rebuilt figure, after a mode or style switch, hears them again). */
  team: number; idleSec: number; idleTold: { fig: unknown; sec: number };
  /** P-VIZ.7 (ADR-0641): the sponsor the figure wears (from the node's model; null = model not known yet), its
   *  signature (a change rebuilds the figure), and whether a git commit or push is running. */
  brand: VizBrand | null; brandSig: string; committing: boolean;
}

/** A brand's rebuild signature: the emblem, the size class and the variant are baked into the figure. */
function brandSig(b: VizBrand | null): string { return b ? `${b.key}:${b.size}:${b.variant}` : ""; }

interface EdgeObj {
  key: string; from: string; to: string; ring: boolean; conduit: EdgeConduit;
  p0: THREE.Vector3; p1: THREE.Vector3; p2: THREE.Vector3; side: THREE.Vector3;
  intensity: number; frozen: boolean; dead: boolean; color: THREE.Color; colorTo: THREE.Color;
}

interface Bolt { line: THREE.Line; branches: THREE.Line[]; mat: THREE.LineBasicMaterial; from: THREE.Vector3; to: THREE.Vector3; start: number; next: number; active: boolean; color: THREE.Color }
interface Burst { mesh: THREE.Mesh; mat: THREE.ShaderMaterial; start: number; dur: number; scale: number; active: boolean }

/** Mount the scene into `host`. Throws when WebGL cannot start (the view shows that honestly). */
export function mountVizScene(host: HTMLElement, tier: VizTierOpts, theme: VizTheme, initialView: VizViewMode, initialAuto: boolean): VizSceneHandle {
  const o = tier;
  const renderer = new THREE.WebGLRenderer({ antialias: o.antialias, alpha: false, powerPreference: "high-performance" });
  const canvas = renderer.domElement;
  canvas.className = "viz-cv";
  canvas.setAttribute("aria-label", "Agent visualization. Drag to move the view, scroll to zoom, click a node for its panel.");
  canvas.tabIndex = 0;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, o.dprCap));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = theme.light ? 1.0 : 1.1;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  host.prepend(canvas);

  const scene = new THREE.Scene();
  let bgTex = backdrop(theme); // P-WORLDS.1: a world's sky replaces it (applyWorldEnvironment)
  scene.background = bgTex;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const envRT = pmrem.fromScene(room, 0.04);
  room.dispose();
  pmrem.dispose();
  scene.environment = envRT.texture;
  // The anime figures are toon shaded (MeshToonMaterial steps each directional light), so the lights follow the
  // camera like the lab's sheet: whichever way the view turns, the key lights his face from the upper front
  // right and the rim outlines him from behind. One cool rim for the whole scene (a per-node accent rim would
  // cost a light per node in every shader).
  const hemi = new THREE.HemisphereLight(0xc8d8ff, 0x1c1420, 1);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  scene.add(sun);
  const rimLight = new THREE.DirectionalLight(0xa8c8ff, 1.6);
  scene.add(rimLight);
  const lightDir = new THREE.Vector3();
  /** Aim the key and the rim from the camera's frame and set the mode's levels (3D: the lab's 3D sheet; 2D: the
   *  flat sheet, rim nearly off). */
  function aimLights(): void {
    const flat = mode === "2d";
    sun.position.copy(lightDir.copy(KEY_DIR).applyQuaternion(camera.quaternion));
    rimLight.position.copy(lightDir.copy(RIM_DIR).applyQuaternion(camera.quaternion));
    sun.intensity = flat ? 1.6 : 2.2;
    rimLight.intensity = flat ? 0.6 : 1.6;
    hemi.intensity = flat ? 1.0 : theme.light ? 1.1 : 0.95;
  }
  const world = new THREE.Group();
  scene.add(world);

  // Cameras: a perspective one orbiting in 3D, an orthographic one looking straight down in 2D.
  const persp = new THREE.PerspectiveCamera(45, 1, 0.05, 500);
  persp.position.set(0, 9, 15);
  const ortho = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 400);
  ortho.position.set(0, 60, 0);
  ortho.up.set(0, 0, -1);
  ortho.lookAt(0, 0, 0);
  let mode: VizViewMode = initialView;
  /** P-VIZ.4: which cast the nodes are built with (the view calls setStyle with the saved preference). */
  let style: VizStyle = "anime";
  /** P-WORLDS.1 (ADR-0648): the world a world style draws with (null for the built-ins), its charge tint, its
   *  ambient layer and its storms in progress. */
  let activeWorld: SceneWorld | null = null;
  const chargeWorld = new THREE.Color();
  let ambient: WorldAmbient | null = null;
  let worldFog: THREE.FogExp2 | null = null;
  const worldStorms: { group: THREE.Group; storm: WorldStorm }[] = [];
  let camera: THREE.PerspectiveCamera | THREE.OrthographicCamera = mode === "3d" ? persp : ortho;
  let controls = makeControls();
  let interacting = false;

  // Bloom: the full tier only, and never on the light theme (it would wash the page out).
  const bloomOn = o.bloom && !theme.light;
  let composer: EffectComposer | null = null;
  let renderPass: RenderPass | null = null;
  let bloom: UnrealBloomPass | null = null;
  if (bloomOn) {
    composer = new EffectComposer(renderer);
    renderPass = new RenderPass(scene, camera);
    bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.34, 0.4, 0.93); // glow on particles, arcs and cube edges; figures stay readable
    composer.addPass(renderPass);
    composer.addPass(bloom);
    composer.addPass(new OutputPass());
  }

  const geo = new Map<string, THREE.BufferGeometry>();
  const shared = <T extends THREE.BufferGeometry>(key: string, make: () => T): T => {
    let g = geo.get(key) as T | undefined;
    if (!g) { g = make(); geo.set(key, g); }
    return g;
  };

  const nodes = new Map<string, NodeObj>();
  const edges = new Map<string, EdgeObj>();
  const hitMeshes: THREE.Object3D[] = [];
  const edgeLines: THREE.Object3D[] = [];
  const blend = theme.light ? THREE.NormalBlending : THREE.AdditiveBlending;
  const bgColor = new THREE.Color(theme.bg);

  // ------------------------------------------------------------------ edges (viz_plasma) + effect particles
  // The scene starts in the anime style; setStyle switches the edges with the figures.
  const edgeFx = createEdgeFx(world, { detail: o.detail, particles: o.particles, motion: o.motion, light: theme.light, flat: mode === "2d", style: "plasma" });
  const fx = makePointPool(o.fx);
  const fxVel = new Float32Array(o.fx * 3);
  const fxLife = new Float32Array(o.fx);
  const fxMax = new Float32Array(o.fx);
  const fxGrav = new Float32Array(o.fx);
  const fxDrag = new Float32Array(o.fx);
  const fxSize0 = new Float32Array(o.fx);
  const fxFree: number[] = [];
  for (let i = o.fx - 1; i >= 0; i--) fxFree.push(i);

  function makePointPool(n: number): { points: THREE.Points | null; pos: Float32Array; col: Float32Array; alpha: Float32Array; size: Float32Array; attrs: THREE.BufferAttribute[]; mat: THREE.ShaderMaterial | null } {
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), alpha = new Float32Array(n), size = new Float32Array(n);
    if (n === 0) return { points: null, pos, col, alpha, size, attrs: [], mat: null };
    const g = new THREE.BufferGeometry();
    const attrs = [
      new THREE.BufferAttribute(pos, 3), new THREE.BufferAttribute(col, 3), new THREE.BufferAttribute(alpha, 1), new THREE.BufferAttribute(size, 1),
    ];
    for (const a of attrs) a.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute("position", attrs[0]!);
    g.setAttribute("aColor", attrs[1]!);
    g.setAttribute("aAlpha", attrs[2]!);
    g.setAttribute("aSize", attrs[3]!);
    const mat = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 800 }, uOrtho: { value: 0 } },
      vertexShader: POINT_VS, fragmentShader: POINT_FS, transparent: true, depthWrite: false, blending: blend,
    });
    const points = new THREE.Points(g, mat);
    points.frustumCulled = false;
    points.renderOrder = 5;
    scene.add(points);
    return { points, pos, col, alpha, size, attrs, mat };
  }

  // ------------------------------------------------------------------ lightning + plasma pools
  const bolts: Bolt[] = [];
  const bursts: Burst[] = [];
  if (o.motion) {
    for (let i = 0; i < BOLT_POOL; i++) {
      const mat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1, blending: blend, depthWrite: false, toneMapped: false });
      const mk = (n: number): THREE.Line => {
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
        const l = new THREE.Line(g, mat);
        l.frustumCulled = false; l.visible = false; l.renderOrder = 6;
        scene.add(l);
        return l;
      };
      bolts.push({ line: mk(BOLT_PTS), branches: [mk(BRANCH_PTS), mk(BRANCH_PTS)], mat, from: new THREE.Vector3(), to: new THREE.Vector3(), start: 0, next: 0, active: false, color: new THREE.Color() });
    }
    const plane = shared("burst-plane", () => new THREE.PlaneGeometry(1, 1));
    for (let i = 0; i < BURST_POOL; i++) {
      const mat = new THREE.ShaderMaterial({
        uniforms: { uT: { value: 0 }, uSeed: { value: Math.random() }, uColor: { value: new THREE.Color() } },
        vertexShader: BURST_VS, fragmentShader: BURST_FS, transparent: true, depthWrite: false, blending: blend,
      });
      const mesh = new THREE.Mesh(plane, mat);
      mesh.visible = false; mesh.renderOrder = 7; mesh.frustumCulled = false;
      scene.add(mesh);
      bursts.push({ mesh, mat, start: 0, dur: BURST_MS, scale: 1, active: false });
    }
  }

  // ------------------------------------------------------------------ state + loop plumbing
  let visible = true, stopped = false, recording = false;
  let raf = 0, last = 0, lastFrame = 0;
  let inFrame = false, wanted = false;
  let userMoved = false;
  let effectsUntil = 0;
  let needFit = true;
  let W = 0, H = 0;
  const clock = { now: performance.now() };
  let hoverCb: ((hit: SceneHit | null, x: number, y: number) => void) | null = null;
  let pickCb: ((hit: SceneHit | null, x: number, y: number) => void) | null = null;
  let doublePickCb: ((hit: SceneHit | null, x: number, y: number) => void) | null = null;
  let lostCb: (() => void) | null = null;
  let userCamCb: (() => void) | null = null;
  let pointer: { x: number; y: number; dirty: boolean } | null = null;
  let lastHitKey = "";

  // The director picks the focus (pure, viz_director.ts); the rig springs the camera toward it.
  let auto = initialAuto;
  const director = createDirector(performance.now());
  let focusId: string | null = null;
  const rig = { tx: 0, ty: 0, tz: 0, vx: 0, vy: 0, vz: 0, dist: 10, vd: 0, az: 0, va: 0, polar: OVERVIEW_POLAR, vp: 0, lz: 0, vlz: 0, settled: true };

  function makeControls(): OrbitControls {
    const c = new OrbitControls(camera, canvas);
    c.enableDamping = o.motion;
    c.dampingFactor = 0.08;
    if (mode === "3d") {
      c.enableRotate = true;
      c.minDistance = 0.5;
      c.maxDistance = 160;
      c.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
      c.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    } else {
      c.enableRotate = false;
      c.screenSpacePanning = true;
      c.minZoom = 0.05;
      c.maxZoom = 60;
      c.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
      c.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN };
    }
    // Zoom toward the cursor only on the flat map. In 3D OrbitControls moves the TARGET to where the cursor ray
    // meets a plane through it, and at the auto camera's low grazing angles that point is far away: one wheel
    // notch threw the camera off into empty space. In 3D the wheel dollies toward the target, which the auto
    // camera has already put on the bot in focus.
    c.zoomToCursor = mode === "2d";
    c.addEventListener("change", kick);
    c.addEventListener("start", () => { interacting = true; kick(); });
    c.addEventListener("end", () => { interacting = false; kick(); });
    return c;
  }

  /** The user really moved the camera (not a click, not the director): auto hands it over. */
  function userGrab(): void {
    userMoved = true;
    shot = null; // P-VIZ.7: the user's hand always beats a scripted shot
    if (!auto) return;
    auto = false;
    userCamCb?.();
  }

  // ------------------------------------------------------------------ nodes
  function buildNode(n: SceneNode): NodeObj {
    const color = PERSONAS[n.persona].color;
    const base = new THREE.Color(color);
    const root = new THREE.Group();
    const pivot = new THREE.Group();
    root.add(pivot);
    const size = KIND_SCALE[n.kind];
    root.scale.setScalar(size);

    const labelMat = new THREE.SpriteMaterial({ transparent: true, depthWrite: false, toneMapped: false });
    const label = new THREE.Sprite(labelMat);
    label.renderOrder = 10;
    pivot.add(label);

    world.add(root);
    let seed = 7;
    for (let i = 0; i < n.id.length; i++) seed = (seed * 31 + n.id.charCodeAt(i)) >>> 0;
    const obj: NodeObj = {
      id: n.id, kind: n.kind, parentKind: n.parentKind, persona: n.persona, size, seed,
      look: lookFor(color), base, tileBase: base.clone().lerp(bgColor, theme.light ? 0.8 : 0.74),
      root, pivot, d3: null, d2: null,
      label, labelMat, labelText: "", cracks: null,
      status: n.status, glow: n.glow, power: n.glow,
      cur: new THREE.Vector3(...n.pos), target: new THREE.Vector3(...n.pos), placed: false,
      tone: { tint: 0, dim: 0, frost: 0 },
      fx: { flickerUntil: 0, shakeUntil: 0, shakeAmp: 0, implodeAt: 0, colorUntil: 0, failUntil: 0 },
      team: n.team, idleSec: n.idleSec, idleTold: { fig: null, sec: -1 },
      brand: vizBrandFor(n.model), brandSig: "", committing: n.committing,
    };
    obj.brandSig = brandSig(obj.brand);
    paintLabel(obj, n.label);
    ensureParts(obj);
    return obj;
  }

  /** Build the current mode's parts and drop the other mode's (only one figure per node holds GPU memory). */
  function ensureParts(obj: NodeObj): void {
    if (mode === "3d") { drop2d(obj); if (!obj.d3) obj.d3 = build3d(obj); }
    else { drop3d(obj); if (!obj.d2) obj.d2 = build2d(obj); }
    placeLabel(obj);
  }

  function build3d(obj: NodeObj): Node3D {
    // The figure rides a holder of ours (standing on the plate; the kill implosion scales it), so the figure's
    // own transforms stay the figure's.
    // P-VIZ.4 (ADR-0627): the professional style seats the office cast in a low fabric cubicle that rides the
    // figure (it turns to the camera with him, open side front); the cube's glass stays as an invisible pick box,
    // and its edge material draws the cubicle's top edges, so every status color below still reads.
    const office = style === "professional";
    const wd = activeWorld;
    const edgeMat = new THREE.LineBasicMaterial({ color: obj.base.clone().lerp(WHITE, 0.35), transparent: true, opacity: 0.9, toneMapped: false, depthWrite: false });
    const fig: WorldFigure = wd
      ? worldFigure(wd, obj, false)
      : office
        ? createOfficeFigure({ look: obj.look, detail: o.detail, flat: false, role: obj.kind === "hub" ? "boss" : "worker", seed: obj.seed, brand: obj.brand, cubicle: { status: edgeMat } })
        : createAnimeFigure({ look: obj.look, detail: o.detail, flat: false, seed: obj.seed, brand: obj.brand });
    const holder = new THREE.Group();
    holder.position.y = FLOOR_Y + PLATE_H;
    holder.add(fig.group);
    obj.pivot.add(holder);
    // P-WORLDS.1: the world's own ground replaces the glass cube and plate; the glass stays as the pick box.
    const stage = wd ? worldStage(wd, obj, false) : null;
    if (stage) {
      stage.group.position.y = FLOOR_Y;
      obj.pivot.add(stage.group);
      const glassMat = new THREE.MeshPhysicalMaterial({ visible: false });
      const glass = new THREE.Mesh(shared("cube-glass", () => new RoundedBoxGeometry(CUBE, CUBE, CUBE, 3, 0.045)), glassMat);
      glass.userData.nodeId = obj.id;
      obj.pivot.add(glass);
      hitMeshes.push(glass);
      return { fig, holder, glass, glassMat, edgeMat, plateMat: null, office: false, activity: null, state: null, committing: false, stage };
    }
    if (office) {
      const glassMat = new THREE.MeshPhysicalMaterial({ visible: false });
      const glass = new THREE.Mesh(shared("cube-glass", () => new RoundedBoxGeometry(CUBE, CUBE, CUBE, 3, 0.045)), glassMat);
      glass.userData.nodeId = obj.id;
      obj.pivot.add(glass);
      hitMeshes.push(glass);
      // office carpet, with the same faint persona glow as the cube's plate
      const plateMat = new THREE.MeshStandardMaterial({ color: new THREE.Color("#3b4250").lerp(obj.base, 0.08), metalness: 0, roughness: 0.95, emissive: obj.base.clone(), emissiveIntensity: 0.03, envMapIntensity: 0.1 });
      const plate = new THREE.Mesh(shared("cube-plate", () => new RoundedBoxGeometry(CUBE * 0.84, PLATE_H, CUBE * 0.84, 2, 0.016)), plateMat);
      plate.position.y = FLOOR_Y + PLATE_H / 2;
      obj.pivot.add(plate);
      return { fig, holder, glass, glassMat, edgeMat, plateMat, office, activity: null, state: null, committing: false, stage: null };
    }

    // The glass: CLEAR, not transmissive. Transmission rendered the dark space behind it as a milky gray slab that
    // washed the figure out, and double-sided walls stacked two layers of haze in front of him. Front faces only,
    // a whisper of opacity, and the reflection (clearcoat + environment) is what reads as glass as you orbit.
    // It never writes depth and draws after the (opaque) figure, so he stays visible from any angle.
    const tint = obj.base.clone().lerp(WHITE, 0.85);
    const glassMat = new THREE.MeshPhysicalMaterial({ color: tint, metalness: 0, roughness: 0.04, clearcoat: 1, clearcoatRoughness: 0.03, iridescence: 0.3, iridescenceIOR: 1.3, envMapIntensity: 0.18, specularIntensity: 0.6, transparent: true, opacity: 0.025, depthWrite: false, side: THREE.FrontSide });
    const glass = new THREE.Mesh(shared("cube-glass", () => new RoundedBoxGeometry(CUBE, CUBE, CUBE, 3, 0.045)), glassMat);
    glass.renderOrder = 1;
    glass.userData.nodeId = obj.id;
    obj.pivot.add(glass);
    hitMeshes.push(glass);

    const rims = new THREE.LineSegments(shared("cube-edges", () => new THREE.EdgesGeometry(new THREE.BoxGeometry(CUBE, CUBE, CUBE))), edgeMat);
    rims.renderOrder = 2;
    obj.pivot.add(rims);

    // A dark plate with a faint persona glow: bright enough to ground him, dim enough that he, not the floor, is lit.
    const plateMat = new THREE.MeshStandardMaterial({ color: obj.base.clone().lerp(bgColor, 0.93), metalness: 0.2, roughness: 0.5, emissive: obj.base.clone(), emissiveIntensity: 0.03, envMapIntensity: 0.2 });
    const plate = new THREE.Mesh(shared("cube-plate", () => new RoundedBoxGeometry(CUBE * 0.84, PLATE_H, CUBE * 0.84, 2, 0.016)), plateMat);
    plate.position.y = FLOOR_Y + PLATE_H / 2;
    obj.pivot.add(plate);
    return { fig, holder, glass, glassMat, edgeMat, plateMat, office, activity: null, state: null, committing: false, stage: null };
  }

  /** P-WORLDS.1: the world's figure for the node (the hub, an agent, or a subagent with its parent's role). */
  function worldFigure(w: SceneWorld, obj: NodeObj, flat: boolean): WorldFigure {
    return w.def.createFigure({
      role: obj.kind, parentRole: obj.kind === "subagent" ? obj.parentKind : null, look: obj.look, detail: o.detail,
      flat, seed: obj.seed, brand: obj.brand, options: w.options,
    });
  }

  /** P-WORLDS.1: the world's ground for the node, when it brings one. */
  function worldStage(w: SceneWorld, obj: NodeObj, flat: boolean): WorldStage | null {
    return w.def.createStage?.({ role: obj.kind, parentRole: obj.kind === "subagent" ? obj.parentKind : null, seed: obj.seed, detail: o.detail, flat, options: w.options }) ?? null;
  }

  function build2d(obj: NodeObj): Node2D {
    const tileMat = new THREE.MeshBasicMaterial({ color: obj.tileBase.clone(), toneMapped: false });
    const tile = new THREE.Mesh(shared("tile", () => new THREE.ShapeGeometry(roundRectShape(TILE, TILE, 0.2), 6).rotateX(-Math.PI / 2)), tileMat);
    tile.position.y = TILE_Y;
    tile.userData.nodeId = obj.id;
    obj.pivot.add(tile);
    hitMeshes.push(tile);
    const rimMat = new THREE.LineBasicMaterial({ color: obj.base.clone(), transparent: true, opacity: 0.9, toneMapped: false, depthWrite: false });
    const rim = new THREE.LineLoop(shared("tile-rim", () => new THREE.BufferGeometry().setFromPoints(roundRectShape(TILE, TILE, 0.2).getPoints(6).map((p) => new THREE.Vector3(p.x, 0, -p.y)))), rimMat);
    rim.position.y = TILE_Y + 0.004;
    obj.pivot.add(rim);
    // The figure stands upright in its own frame; the holder tips him back so his front faces the top-down
    // camera, his head toward the top of the screen (the ortho camera's up is -Z). The office cast tips back the
    // same way with his desk (P-VIZ.4).
    const wd = activeWorld;
    const fig: WorldFigure = wd
      ? worldFigure(wd, obj, true)
      : style === "professional"
        ? createOfficeFigure({ look: obj.look, detail: o.detail, flat: true, role: obj.kind === "hub" ? "boss" : "worker", seed: obj.seed, brand: obj.brand })
        : createAnimeFigure({ look: obj.look, detail: o.detail, flat: true, seed: obj.seed, brand: obj.brand });
    const holder = new THREE.Group();
    holder.rotation.x = -Math.PI / 2;
    holder.position.set(0, FIG_2D_Y, FIG_2D_FEET_Z);
    holder.scale.setScalar(FIG_2D_SCALE);
    holder.add(fig.group);
    obj.pivot.add(holder);
    // P-WORLDS.1: the world's ground lies on the tile (seen from straight above); the tile stays the pick target.
    const stage = wd ? worldStage(wd, obj, true) : null;
    if (stage) {
      stage.group.position.y = TILE_Y + 0.006;
      obj.pivot.add(stage.group);
    }
    return { fig, holder, tile, tileMat, rimMat, activity: null, state: null, committing: false, stage };
  }

  /** Remove `x` from the node and dispose every material it holds (the geometries are shared or the figure's). */
  function detach(obj: NodeObj, x: THREE.Object3D): void {
    obj.pivot.remove(x);
    const i = hitMeshes.indexOf(x);
    if (i >= 0) hitMeshes.splice(i, 1);
    const m = (x as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(m)) m.forEach((mm) => mm.dispose()); else m?.dispose();
  }

  function drop3d(obj: NodeObj): void {
    const d = obj.d3;
    if (!d) return;
    obj.pivot.remove(d.holder);
    d.fig.dispose();
    for (const x of [...obj.pivot.children]) if (x === d.glass || (x as THREE.Mesh).material === d.edgeMat || (x as THREE.Mesh).material === d.plateMat) detach(obj, x);
    if (d.office || d.stage) d.edgeMat.dispose(); // its lines rode the figure's cubicle (or there are none), not the pivot
    if (d.stage) { obj.pivot.remove(d.stage.group); d.stage.dispose(); }
    obj.d3 = null;
  }

  function drop2d(obj: NodeObj): void {
    const d = obj.d2;
    if (!d) return;
    obj.pivot.remove(d.holder);
    d.fig.dispose();
    if (d.stage) { obj.pivot.remove(d.stage.group); d.stage.dispose(); }
    for (const x of [...obj.pivot.children]) if (x === d.tile || (x as THREE.Mesh).material === d.rimMat) detach(obj, x);
    obj.d2 = null;
  }

  function placeLabel(obj: NodeObj): void {
    if (mode === "3d") obj.label.position.set(0, FLOOR_Y, CUBE / 2 + 0.02);
    else obj.label.position.set(0, LABEL_2D_Y, TILE / 2 - 0.06);
  }

  function paintLabel(obj: NodeObj, text: string): void {
    const role = PERSONAS[obj.persona].label.toUpperCase();
    const key = `${role}|${text}`;
    if (obj.labelText === key) return;
    obj.labelText = key;
    const scale = 3;
    const cv = document.createElement("canvas");
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const font = `600 ${22 * scale}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    const roleFont = `700 ${15 * scale}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    ctx.font = font;
    const tw = ctx.measureText(text).width;
    ctx.font = roleFont;
    const rw = ctx.measureText(role).width;
    const padX = 14 * scale, gap = 10 * scale;
    const w = Math.ceil(padX * 2 + rw + (text ? gap + tw : 0));
    const h = 40 * scale;
    cv.width = w; cv.height = h;
    const c2 = cv.getContext("2d")!;
    c2.fillStyle = theme.light ? "rgba(255,255,255,0.86)" : "rgba(10,12,20,0.74)";
    roundRect(c2, 0, 0, w, h, h / 2);
    c2.fill();
    c2.strokeStyle = PERSONAS[obj.persona].color;
    c2.globalAlpha = 0.7; c2.lineWidth = 2 * scale;
    roundRect(c2, scale, scale, w - 2 * scale, h - 2 * scale, h / 2 - scale);
    c2.stroke();
    c2.globalAlpha = 1;
    c2.textBaseline = "middle";
    c2.font = roleFont;
    c2.fillStyle = PERSONAS[obj.persona].color;
    c2.fillText(role, padX, h / 2 + scale);
    if (text) {
      c2.font = font;
      c2.fillStyle = theme.txt;
      c2.fillText(text, padX + rw + gap, h / 2 + scale);
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    obj.labelMat.map?.dispose();
    obj.labelMat.map = tex;
    obj.labelMat.needsUpdate = true;
    const worldH = 0.2;
    obj.label.scale.set((w / h) * worldH, worldH, 1);
  }

  function disposeNode(obj: NodeObj): void {
    world.remove(obj.root);
    drop3d(obj);
    drop2d(obj);
    healCracks(obj);
    obj.labelMat.map?.dispose();
    obj.labelMat.dispose();
  }

  // ------------------------------------------------------------------ edges
  function edgeFor(e: SceneEdge, ring: boolean): EdgeObj {
    const key = ring ? `ring:${e.from}` : `${e.from}>${e.to}`;
    let ed = edges.get(key);
    if (ed) return ed;
    ed = {
      key, from: e.from, to: e.to, ring, conduit: edgeFx.add(ring),
      p0: new THREE.Vector3(), p1: new THREE.Vector3(), p2: new THREE.Vector3(), side: new THREE.Vector3(1, 0, 0),
      intensity: 0, frozen: false, dead: false, color: new THREE.Color(), colorTo: new THREE.Color(),
    };
    if (!ring) { // the hub's loop is not pickable (it was never an edge between two nodes)
      ed.conduit.mesh.userData.edge = { from: e.from, to: e.to };
      edgeLines.push(ed.conduit.mesh);
    }
    edges.set(key, ed);
    return ed;
  }

  function dropEdge(ed: EdgeObj): void {
    edges.delete(ed.key);
    const i = edgeLines.indexOf(ed.conduit.mesh);
    if (i >= 0) edgeLines.splice(i, 1);
    edgeFx.remove(ed.conduit);
  }

  /** Recompute an edge's curve from the nodes' current positions (a quadratic bezier lifted and bowed); the
   *  conduit rewrites its geometry only when the curve really moved. */
  const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3(), tmpC = new THREE.Vector3();
  function shapeEdge(ed: EdgeObj): void {
    const a = nodes.get(ed.from), b = nodes.get(ed.to);
    if (!a || !b) return;
    if (ed.ring) { ed.conduit.loop(a.cur, LOOP_R, LOOP_LIFT); return; }
    ed.p0.copy(a.cur).y += 0.05 * a.size;
    ed.p2.copy(b.cur).y += 0.05 * b.size;
    const dir = tmpA.subVectors(ed.p2, ed.p0);
    let len = Math.max(0.001, dir.length());
    dir.divideScalar(len);
    // The conduit starts and ends at the cube walls, not at the cube centers: centered endpoints piled a ball of
    // glow onto mini Lucid's head, and bloom turned him into a white blur.
    const ra = CUBE * a.size * 0.55, rb = CUBE * b.size * 0.55;
    if (len > (ra + rb) * 1.2) {
      ed.p0.addScaledVector(dir, ra);
      ed.p2.addScaledVector(dir, -rb);
      len -= ra + rb;
    }
    const side = ed.side.set(-dir.z, 0, dir.x);
    if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
    side.normalize();
    // P-VIZ.5: agents' streams loop clearly over; a subagent's link to its parent stays lower (viz_plasma_math).
    const sub = a.kind === "subagent" || b.kind === "subagent";
    ed.p1.copy(ed.p0).add(ed.p2).multiplyScalar(0.5).addScaledVector(side, edgeBow(len, sub));
    ed.p1.y += edgeLift(len, sub);
    ed.conduit.bezier(ed.p0, ed.p1, ed.p2, side);
  }

  // ------------------------------------------------------------------ effects
  function spawnFx(count: number, at: THREE.Vector3, color: THREE.Color, p: { speed: number; up: number; spread: number; life: number; size: number; gravity: number; drag: number }): void {
    for (let k = 0; k < count; k++) {
      const i = fxFree.pop();
      if (i === undefined) return;
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(2 * Math.random() - 1);
      const sp = p.speed * (0.4 + Math.random() * 0.8);
      fx.pos[i * 3] = at.x + (Math.random() - 0.5) * p.spread;
      fx.pos[i * 3 + 1] = at.y + (Math.random() - 0.5) * p.spread;
      fx.pos[i * 3 + 2] = at.z + (Math.random() - 0.5) * p.spread;
      fxVel[i * 3] = Math.sin(ph) * Math.cos(th) * sp;
      fxVel[i * 3 + 1] = Math.cos(ph) * sp * 0.6 + p.up * (0.6 + Math.random() * 0.8);
      fxVel[i * 3 + 2] = Math.sin(ph) * Math.sin(th) * sp;
      fxMax[i] = fxLife[i] = p.life * (0.6 + Math.random() * 0.8);
      fxGrav[i] = p.gravity; fxDrag[i] = p.drag;
      fxSize0[i] = p.size * (0.6 + Math.random() * 0.8);
      fx.col[i * 3] = color.r; fx.col[i * 3 + 1] = color.g; fx.col[i * 3 + 2] = color.b;
      fx.alpha[i] = 1;
      fx.size[i] = fxSize0[i]!;
    }
  }

  function burstAt(at: THREE.Vector3, color: THREE.Color, scale: number, dur = BURST_MS): void {
    const b = bursts.find((x) => !x.active) ?? bursts[0];
    if (!b) return;
    b.active = true; b.start = clock.now; b.dur = dur; b.scale = scale;
    (b.mat.uniforms.uColor!.value as THREE.Color).copy(color);
    b.mat.uniforms.uSeed!.value = Math.random();
    b.mesh.position.copy(at);
    b.mesh.visible = true;
  }

  function boltBetween(from: THREE.Vector3, to: THREE.Vector3, color: THREE.Color): void {
    if (o.lightning === 0) return;
    const b = bolts.find((x) => !x.active) ?? bolts[0];
    if (!b) return;
    b.active = true; b.start = clock.now; b.next = 0;
    b.from.copy(from); b.to.copy(to);
    b.color.copy(color);
    b.line.visible = true;
    for (const br of b.branches) br.visible = o.lightning === 2;
  }

  /** Midpoint displacement: a fresh jagged path every regen, so the bolt crackles. */
  function jag(line: THREE.Line, from: THREE.Vector3, to: THREE.Vector3, n: number, amp: number): void {
    const attr = line.geometry.getAttribute("position") as THREE.BufferAttribute;
    const arr = attr.array as Float32Array;
    const pts = new Array<number>(n * 3).fill(0);
    pts[0] = from.x; pts[1] = from.y; pts[2] = from.z;
    pts[(n - 1) * 3] = to.x; pts[(n - 1) * 3 + 1] = to.y; pts[(n - 1) * 3 + 2] = to.z;
    const split = (lo: number, hi: number, a: number): void => {
      if (hi - lo < 2) return;
      const mid = (lo + hi) >> 1;
      for (let c = 0; c < 3; c++) pts[mid * 3 + c] = (pts[lo * 3 + c]! + pts[hi * 3 + c]!) / 2 + (Math.random() - 0.5) * a;
      split(lo, mid, a * 0.55);
      split(mid, hi, a * 0.55);
    };
    split(0, n - 1, amp);
    for (let i = 0; i < n * 3; i++) arr[i] = pts[i]!;
    attr.needsUpdate = true;
  }

  /** Where a node's effects start: the figure's chest in 3D (the cube is centered on the node), just above the
   *  face-up figure in 2D (under the caption), so the figure never hides them from the top-down camera. */
  function nodeHead(obj: NodeObj, out: THREE.Vector3): THREE.Vector3 {
    return out.copy(obj.cur).setY(obj.cur.y + (mode === "3d" ? -0.18 : LABEL_2D_Y - 0.1) * obj.size);
  }

  const fxAt = new THREE.Vector3(), fxTo = new THREE.Vector3();
  function fireOne(ev: VizEvent): void {
    const obj = nodes.get(ev.node);
    if (!obj) return;
    const now = clock.now;
    cue(director, ev.node, ev.kind === "power" ? ev.power : ev.kind, performance.now());
    const color = obj.base.clone();
    if (ev.kind === "spawn") {
      if (o.motion) { burstAt(nodeHead(obj, fxAt), color.clone().lerp(WHITE, 0.4), 1.6 * obj.size, 500); spawnFx(24, fxAt, color, { speed: 1.4, up: 0.2, spread: 0.2, life: 0.7, size: 0.07, gravity: 0, drag: 2.5 }); }
      effectsUntil = Math.max(effectsUntil, now + 700);
      return;
    }
    if (ev.kind === "surge") {
      obj.fx.colorUntil = now + (o.motion ? 260 : 600);
      // the node's own edge flares (its link to the parent, or the hub's loop); reduced motion: color only
      const parent = [...edges.values()].find((e) => !e.ring && e.from === obj.id);
      (parent ?? edges.get(`ring:${obj.id}`))?.conduit.surge();
      if (!o.motion) { effectsUntil = Math.max(effectsUntil, now + 1150); return; }
      (obj.d3 ?? obj.d2)?.fig.burst();
      const hot = color.clone().lerp(WHITE, 0.45).multiplyScalar(2.2);
      nodeHead(obj, fxAt);
      const to = parent ? nodes.get(parent.to) : undefined;
      if (to) {
        nodeHead(to, fxTo);
        boltBetween(fxAt, fxTo, hot);
        burstAt(fxTo, color.clone().lerp(WHITE, 0.3), 1.4 * to.size, 520);
      } else {
        for (let k = 0; k < 2; k++) {
          const a = Math.random() * Math.PI * 2;
          fxTo.copy(fxAt).add(new THREE.Vector3(Math.cos(a) * 2.6, 0.6 + Math.random(), Math.sin(a) * 2.6));
          boltBetween(fxAt, fxTo, hot);
        }
      }
      burstAt(fxAt, color.clone().lerp(WHITE, 0.25), 1.9 * obj.size);
      spawnFx(40, fxAt, hot, { speed: 3.2, up: 0.3, spread: 0.15, life: 0.6, size: 0.08, gravity: -1.5, drag: 1.6 });
      effectsUntil = Math.max(effectsUntil, now + 900);
      return;
    }
    applyPower(obj, ev.power, now, color);
  }

  function applyPower(obj: NodeObj, kind: PowerKind, now: number, color: THREE.Color): void {
    nodeHead(obj, fxAt);
    effectsUntil = Math.max(effectsUntil, now + (o.motion ? 2600 : 1200));
    const s = obj.size;
    switch (kind) {
      case "tool-failed":
        obj.fx.flickerUntil = now + 950;
        obj.fx.failUntil = now + FAIL_MS;
        if (!o.motion) return;
        obj.fx.shakeUntil = now + 420; obj.fx.shakeAmp = 0.06;
        spawnFx(70, fxAt, SPARK, { speed: 2.4 * s, up: 1.6 * s, spread: 0.25 * s, life: 0.9, size: 0.06, gravity: -7, drag: 0.6 });
        spawnFx(20, fxAt, RED, { speed: 1.4 * s, up: 0.9 * s, spread: 0.25 * s, life: 0.6, size: 0.09, gravity: -5, drag: 1 });
        return;
      case "paused":
        if (!o.motion) return;
        burstAt(fxAt, ICE, 2.2 * s, 1100);
        spawnFx(30, fxAt, ICE, { speed: 0.4, up: 0.1, spread: CUBE * s, life: 2.2, size: 0.05, gravity: 0, drag: 0.8 });
        return;
      case "ended":
        if (!o.motion) return;
        spawnFx(50, fxAt.setY(obj.cur.y + FLOOR_Y * s), EMBER, { speed: 0.3, up: 0.9, spread: CUBE * 0.8 * s, life: 2.4, size: 0.055, gravity: 0.25, drag: 0.4 });
        burstAt(nodeHead(obj, fxAt), EMBER.clone().multiplyScalar(0.6), 1.6 * s, 900);
        return;
      case "killed":
        obj.fx.implodeAt = now;
        if (!o.motion) return;
        obj.fx.shakeUntil = now + 300; obj.fx.shakeAmp = 0.1;
        burstAt(fxAt, WHITE.clone().multiplyScalar(2.5), 3.2 * s, 420);
        spawnFx(90, fxAt, WHITE, { speed: 4 * s, up: 0.2, spread: 0.1, life: 0.55, size: 0.07, gravity: -2, drag: 2.2 });
        spawnFx(30, fxAt, color, { speed: 2 * s, up: 0.4, spread: 0.2, life: 0.9, size: 0.08, gravity: -4, drag: 1 });
        return;
    }
  }

  /** Fracture lines across the cube's front face (3D) or the tile (2D): jagged cracks from an impact point. */
  function crack(obj: NodeObj): void {
    if (obj.cracks) return;
    const pts: THREE.Vector3[] = [];
    const half = CUBE / 2 - 0.1;
    const ox = (Math.random() - 0.5) * half, oy = (Math.random() - 0.3) * half;
    const inside = (x: number, y: number): boolean => Math.abs(x) < half && Math.abs(y) < half;
    for (let k = 0; k < 7; k++) {
      let a = (k / 7) * Math.PI * 2 + Math.random() * 0.6;
      let x = ox, y = oy;
      for (let s = 0; s < 6; s++) {
        a += (Math.random() - 0.5) * 0.9;
        const step = 0.12 + Math.random() * 0.16;
        const nx = x + Math.cos(a) * step, ny = y + Math.sin(a) * step;
        if (!inside(nx, ny)) break;
        pts.push(new THREE.Vector3(x, y, 0), new THREE.Vector3(nx, ny, 0));
        if (s === 2 && Math.random() < 0.6) { // a side branch
          const ba = a + (Math.random() < 0.5 ? -1 : 1) * 0.9;
          const bx = nx + Math.cos(ba) * 0.15, by = ny + Math.sin(ba) * 0.15;
          if (inside(bx, by)) pts.push(new THREE.Vector3(nx, ny, 0), new THREE.Vector3(bx, by, 0));
        }
        x = nx; y = ny;
      }
    }
    const g = new THREE.BufferGeometry().setFromPoints(pts);
    const m = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, toneMapped: false, depthWrite: false });
    const lines = new THREE.LineSegments(g, m);
    lines.renderOrder = 3;
    obj.pivot.add(lines);
    obj.cracks = lines;
  }

  function healCracks(obj: NodeObj): void {
    if (!obj.cracks) return;
    obj.pivot.remove(obj.cracks);
    obj.cracks.geometry.dispose();
    (obj.cracks.material as THREE.Material).dispose();
    obj.cracks = null;
  }

  // ------------------------------------------------------------------ P-VIZ.6 (ADR-0636): throws and Storm
  const throwFx = createThrowFx(scene, {
    target(id, out) { const n = nodes.get(id); if (!n) return false; nodeHead(n, out); return true; },
    arrive: hitFigure,
    sparks: spawnFx,
    burst: burstAt,
    bolt: boltBetween,
  }, { detail: o.detail, motion: o.motion, light: theme.light });
  throwFx.setFlat(mode === "2d");
  const throwTo = new THREE.Vector3(), throwFrom = new THREE.Vector3(), stormDir = new THREE.Vector3(), stormCenter = new THREE.Vector3();
  const throwPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  let throwCursor: string | null = null;

  /** Something reached the node's figure: it reacts (viz_anime / viz_office hit), with frames for the reaction. */
  function hitFigure(id: string, kind: string, from: THREE.Vector3): void {
    const obj = nodes.get(id);
    const slot = obj?.d3 ?? obj?.d2;
    if (!slot) return;
    // P-WORLDS.1: a figure only hears the storm and its own style's throwables (a flight that left before a
    // style switch lands as nothing).
    if (kind !== "storm" && !(activeWorld ? activeWorld.def.throws.some((t) => t.kind === kind) : isThrowKind(kind))) return;
    slot.fig.hit(kind, from, camera);
    effectsUntil = Math.max(effectsUntil, clock.now + REACT_MS);
    kick();
  }

  /** Where a throw starting at stage px `px` begins in the world: along the view ray, a third of the way to the
   *  target (3D: from the viewer's side), or on a plane just above the target (2D). */
  function launchFrom(px: { x: number; y: number }, target: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    if (!W || !H) return out.copy(target).add(tmpC.set(0, 2, 2));
    ndc.set((px.x / W) * 2 - 1, -(px.y / H) * 2 + 1);
    rc.setFromCamera(ndc, camera);
    if (mode === "3d") return rc.ray.at(rc.ray.origin.distanceTo(target) * 0.3, out);
    throwPlane.constant = -(target.y + 0.4);
    return rc.ray.intersectPlane(throwPlane, out) ?? out.copy(target);
  }

  // ------------------------------------------------------------------ P-WORLDS.1 (ADR-0648): a world's environment
  /** The sky, fog, edge palette, charge tint and ambient layer of the active world, or the built-in backdrop with
   *  none of them. Runs only when the style moves to, from or between worlds (anime and professional share one
   *  backdrop, so a switch between them never touches it). */
  function applyWorldEnvironment(): void {
    bgTex.dispose();
    const w = activeWorld;
    if (!w) {
      bgTex = backdrop(theme);
      worldFog = null;
      scene.fog = null;
      edgeFx.setPalette(null, null);
    } else {
      const env = w.def.environment;
      bgTex = worldSky((c, width, height) => env.paintSky(c, width, height));
      worldFog = env.fog.density > 0 ? new THREE.FogExp2(env.fog.color, env.fog.density) : null;
      scene.fog = mode === "3d" ? worldFog : null; // the flat map's camera sits 60 units up: fog would wash it out
      edgeFx.setPalette(new THREE.Color(env.edges.colorA), new THREE.Color(env.edges.colorB));
      chargeWorld.set(env.chargeColor);
    }
    scene.background = bgTex;
    for (const ed of edges.values()) { edgeColors(ed); ed.conduit.set(ed.intensity, ed.frozen, ed.dead, ed.color, ed.colorTo); }
    rebuildAmbient();
  }

  /** The ambient layer: built for the active world (spread over the scene) and the current 2D/3D mode. */
  function rebuildAmbient(): void {
    if (ambient) { scene.remove(ambient.object); ambient.dispose(); ambient = null; }
    const make = activeWorld?.def.environment.createAmbient;
    if (!make) return;
    ambient = make(Math.max(8, sceneRadius() * 1.4), mode === "2d", o.detail);
    scene.add(ambient.object);
  }

  /** An edge's two colors: the persona colors of its ends (the built-ins), or the world's pair. */
  function edgeColors(ed: EdgeObj): void {
    const env = activeWorld?.def.environment;
    if (env) { ed.color.set(env.edges.colorA); ed.colorTo.set(env.edges.colorB); return; }
    if (ed.ring) { const hub = nodes.get(ed.from); if (hub) ed.color.set(PERSONAS[hub.persona].color); ed.colorTo.copy(ed.color); return; }
    const a = nodes.get(ed.from), b = nodes.get(ed.to);
    if (a) ed.color.copy(a.base);
    if (b) ed.colorTo.copy(b.base);
  }

  /** Start the world's storm over the nodes (its own effect; the figures are hit along the front separately). */
  function startWorldStorm(w: SceneWorld, center: THREE.Vector3, radius: number): void {
    const group = new THREE.Group();
    const targets = [...nodes.values()].map((n) => n.cur.clone());
    const storm = w.def.createStorm({ group, center: center.clone(), radius, targets, flat: mode === "2d", motion: o.motion });
    scene.add(group);
    worldStorms.push({ group, storm });
  }

  function endWorldStorm(i: number): void {
    const s = worldStorms[i]!;
    scene.remove(s.group);
    s.storm.dispose();
    worldStorms.splice(i, 1);
  }

  function clearWorldStorms(): void {
    for (let i = worldStorms.length - 1; i >= 0; i--) endWorldStorm(i);
  }

  /** One frame of the world's ambient layer and storms; true while anything there moves. */
  function updateWorldLayers(t: number, dt: number): boolean {
    let live = false;
    if (ambient) { ambient.update(t / 1000, dt, o.motion); if (o.motion) live = true; }
    for (let i = worldStorms.length - 1; i >= 0; i--) {
      if (worldStorms[i]!.storm.update(t / 1000, dt)) live = true;
      else endWorldStorm(i);
    }
    return live;
  }

  // ------------------------------------------------------------------ per-frame update
  const tmpColor = new THREE.Color();
  const tintTarget = new THREE.Color();
  const tileTint = new THREE.Color();
  const camPos = new THREE.Vector3();
  // P-VIZ.7: the scripted shot (scriptShot); while set it drives the camera instead of the director.
  let shot: { id: string; offset: THREE.Vector3; dist: number; polar: number; az: number; azSpeed: number; at: number } | null = null;

  /** What the figure plays: the node's status, with a tool failure's flinch on top while it lasts. */
  function figureState(obj: NodeObj, t: number): AnimeState {
    switch (obj.status) {
      case "paused": return "paused";
      case "ended": return "ended";
      case "killed": return "killed";
      default: return t < obj.fx.failUntil ? "failed" : obj.status === "active" ? "working" : "idle";
    }
  }

  function updateNode(obj: NodeObj, t: number, dt: number): void {
    const k = o.motion ? 1 - Math.exp(-dt * 5) : 1;
    if (!obj.placed) { obj.cur.copy(obj.target); obj.placed = true; } else obj.cur.lerp(obj.target, k);
    obj.root.position.copy(obj.cur);
    obj.power += (obj.glow - obj.power) * (o.motion ? 1 - Math.exp(-dt / POWER_TAU) : 1);

    // status tones: tint (ice for paused, gray for killed), dim, frost
    const st = obj.status;
    obj.tone.tint += ((st === "paused" ? 0.55 : st === "killed" ? 0.85 : 0) - obj.tone.tint) * k;
    obj.tone.dim += ((st === "ended" ? 0.55 : st === "killed" ? 0.3 : 0) - obj.tone.dim) * k;
    obj.tone.frost += ((st === "ended" ? 1 : st === "killed" ? 0.6 : st === "paused" ? 0.35 : 0) - obj.tone.frost) * k;
    tintTarget.copy(st === "killed" ? DEAD : ICE);
    const flicker = t < obj.fx.flickerUntil;
    const flickOn = flicker && (Math.floor(t / 70) % 2 === 0 || !o.motion);

    // the accent (cube edges in 3D, tile rim in 2D): glows with work, amber pulse while waiting, red flicker
    // on a tool failure, white flash on a surge, dim when ended, near-dark when killed
    let level: number;
    tmpColor.copy(obj.base).lerp(WHITE, 0.3);
    if (flicker) { tmpColor.copy(RED); level = flickOn ? 2.2 : 0.4; }
    else if (st === "paused") { tmpColor.copy(ICE); level = 0.6 + (o.motion ? 0.3 * Math.sin((t / 3000) * Math.PI * 2) : 0); }
    else if (st === "waiting") { tmpColor.copy(AMBER); level = 0.9 + (o.motion ? 0.6 * (0.5 + 0.5 * Math.sin(t / 260)) : 0.3); }
    else if (st === "ended") level = 0.35;
    else if (st === "killed") level = 0.18;
    else if (st === "idle") level = 0.6;
    else level = 0.85 + 1.1 * obj.power;
    if (t < obj.fx.colorUntil) { tmpColor.copy(WHITE); level = 2; }
    const slot = obj.d3 ?? obj.d2;
    if (slot) {
      const stateNow = figureState(obj, t);
      if (stateNow !== slot.state) { slot.fig.setState(stateNow); slot.state = stateNow; }
      // P-VIZ.4: an idle node whose team works supervises (Main while any agent works) instead of meditating.
      const act = activityAt(obj.persona, obj.kind, obj.seed, t, st === "active", st === "idle" && obj.team > 0);
      if (act !== slot.activity) { slot.fig.setActivity(act); slot.activity = act; }
      if (obj.idleTold.fig !== slot.fig || obj.idleTold.sec !== obj.idleSec) { slot.fig.setIdleSeconds(obj.idleSec); obj.idleTold = { fig: slot.fig, sec: obj.idleSec }; }
      slot.fig.setIntensity(obj.power);
      // P-VIZ.7 (ADR-0641): the git commit animation plays while the node commits (and keeps the busy cadence).
      if (slot.committing !== obj.committing) { slot.fig.setCommit(obj.committing); slot.committing = obj.committing; }
      if (obj.committing) busyNodes = true;
      slot.fig.update(t / 1000, dt, o.motion);
      // P-VIZ.5: a manager handover is a 3.4 s walk-off; at the idle cadence it would stutter.
      if ("handingOver" in slot.fig && slot.fig.handingOver) busyNodes = true;
    }
    // P-VIZ.6 (ADR-0636): energized (a drink, a bolt, absorbed energy balls): brighter edges and plate while the
    // figure's charge lasts (it decays inside the figure's update, so the frames keep coming until it is gone).
    const charge = slot && st !== "killed" && st !== "ended" && !flicker ? slot.fig.charge : 0;
    if (charge > 0.01) {
      tmpColor.lerp(activeWorld ? chargeWorld : style === "professional" ? CHARGE_PRO : CHARGE_ANIME, 0.6 * charge);
      level += 1.6 * charge;
      busyNodes = true;
    }

    if (obj.d3) {
      const d = obj.d3;
      d.edgeMat.color.copy(tmpColor).multiplyScalar(level);
      d.edgeMat.opacity = st === "killed" ? 0.35 : st === "ended" ? 0.5 : 0.95;
      if (d.plateMat) {
        d.plateMat.emissive.copy(flickOn ? RED : obj.base);
        d.plateMat.emissiveIntensity = flickOn ? 0.6 : st === "ended" || st === "killed" ? 0.02 : 0.03 + 0.07 * obj.power + 0.25 * charge;
      }
      // P-WORLDS.1: the world's ground shows the same status color the cube edges would.
      if (d.stage) { d.stage.setStatusColor(d.edgeMat.color); d.stage.update(t / 1000, dt, o.motion); }
      // glass: frosted when ended, dark gray when killed, icy when paused
      const g = d.glassMat;
      g.roughness = 0.04 + obj.tone.frost * 0.45;
      g.opacity = 0.025 + obj.tone.frost * 0.22;
      // He turns to face the camera (with a little lag) so the viewer sees him, not his back.
      camera.getWorldPosition(camPos);
      const face = Math.atan2(camPos.x - obj.cur.x, camPos.z - obj.cur.z);
      let dy = face - d.holder.rotation.y;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      if (shot?.id !== obj.id) d.holder.rotation.y += dy * (o.motion ? 1 - Math.exp(-dt * 3) : 1); // a scripted shot's subject holds still
      g.color.copy(obj.base).lerp(WHITE, 0.85).lerp(tintTarget, Math.max(obj.tone.tint, st === "ended" ? 0.25 : 0)).multiplyScalar(1 - obj.tone.dim * 0.3);
      // killed: a quick implosion of the figure (the figure's own slump plays inside it)
      let scale = 1;
      if (st === "killed" && o.motion && obj.fx.implodeAt) {
        const age = (t - obj.fx.implodeAt) / 1000;
        scale = age < 0.18 ? 1 - 0.55 * easeIn(age / 0.18) : age < 0.6 ? 0.45 + 0.55 * easeOut((age - 0.18) / 0.42) : 1;
      }
      d.holder.scale.setScalar(scale * FIG_3D_SCALE);
    }
    if (obj.d2) {
      const d = obj.d2;
      d.rimMat.color.copy(tmpColor).multiplyScalar(Math.min(1.4 + charge, level));
      d.rimMat.opacity = st === "killed" ? 0.4 : st === "ended" ? 0.55 : 0.95;
      if (d.stage) { d.stage.setStatusColor(d.rimMat.color); d.stage.update(t / 1000, dt, o.motion); }
      tileTint.copy(tintTarget).lerp(bgColor, 0.6);
      d.tileMat.color.copy(obj.tileBase).lerp(tileTint, obj.tone.tint).lerp(bgColor, obj.tone.dim * 0.5);
    }
    obj.labelMat.opacity = st === "ended" || st === "killed" ? 0.6 : 1;

    if (st === "killed" && !obj.d3?.office && !obj.d3?.stage) crack(obj); else healCracks(obj); // a cubicle (or a world's ground) has no glass to crack
    if (obj.cracks) {
      if (mode === "3d") { obj.cracks.rotation.set(0, 0, 0); obj.cracks.position.set(0, 0, CUBE / 2 + 0.004); }
      else { obj.cracks.rotation.set(-Math.PI / 2, 0, 0); obj.cracks.position.set(0, TILE_Y + 0.006, 0); }
      const age = (t - obj.fx.implodeAt) / 1000;
      (obj.cracks.material as THREE.LineBasicMaterial).color.setScalar(Math.max(0.45, 1.6 - age));
    }

    // shake
    let sx = 0, sz = 0;
    if (o.motion && t < obj.fx.shakeUntil) {
      const a = obj.fx.shakeAmp * ((obj.fx.shakeUntil - t) / 420);
      sx = (Math.random() - 0.5) * a * 2; sz = (Math.random() - 0.5) * a * 2;
    }
    obj.pivot.position.set(sx, 0, sz);
  }

  let busyFlow = false;
  /** Follow the nodes (the conduits rewrite only what moved), then run the conduits and their pulses. */
  function updateFlow(t: number, dt: number): void {
    busyFlow = false;
    for (const ed of edges.values()) {
      shapeEdge(ed);
      if (ed.intensity > 0 && !ed.frozen && !ed.dead) busyFlow = true;
    }
    if (edgeFx.update(t, dt)) busyFlow = true;
  }

  function updateFx(dt: number): boolean {
    let live = false;
    for (let i = 0; i < o.fx; i++) {
      if (fx.alpha[i]! <= 0) continue;
      fxLife[i] = fxLife[i]! - dt;
      if (fxLife[i]! <= 0) { fx.alpha[i] = 0; fxFree.push(i); continue; }
      live = true;
      const drag = Math.exp(-fxDrag[i]! * dt);
      fxVel[i * 3] = fxVel[i * 3]! * drag;
      fxVel[i * 3 + 1] = fxVel[i * 3 + 1]! * drag + fxGrav[i]! * dt;
      fxVel[i * 3 + 2] = fxVel[i * 3 + 2]! * drag;
      fx.pos[i * 3] = fx.pos[i * 3]! + fxVel[i * 3]! * dt;
      fx.pos[i * 3 + 1] = fx.pos[i * 3 + 1]! + fxVel[i * 3 + 1]! * dt;
      fx.pos[i * 3 + 2] = fx.pos[i * 3 + 2]! + fxVel[i * 3 + 2]! * dt;
      const f = fxLife[i]! / fxMax[i]!;
      fx.alpha[i] = Math.min(1, f * 1.6);
      fx.size[i] = fxSize0[i]! * (0.5 + 0.5 * f);
    }
    if (o.fx > 0) for (const a of fx.attrs) a.needsUpdate = true;
    return live;
  }

  const boltGlow = new THREE.Vector3();
  function updateBolts(t: number): boolean {
    let live = false;
    for (const b of bolts) {
      if (!b.active) continue;
      const age = t - b.start;
      if (age >= BOLT_MS) { b.active = false; b.line.visible = false; for (const br of b.branches) br.visible = false; continue; }
      live = true;
      b.mat.color.copy(b.color).multiplyScalar(1 - age / BOLT_MS * 0.7);
      b.mat.opacity = 1 - age / BOLT_MS;
      if (t >= b.next) {
        b.next = t + 45;
        const len = b.from.distanceTo(b.to);
        jag(b.line, b.from, b.to, BOLT_PTS, len * 0.28);
        if (o.lightning === 2) {
          const arr = (b.line.geometry.getAttribute("position") as THREE.BufferAttribute).array as Float32Array;
          for (const br of b.branches) {
            const k = 6 + Math.floor(Math.random() * (BOLT_PTS - 12));
            tmpA.set(arr[k * 3]!, arr[k * 3 + 1]!, arr[k * 3 + 2]!);
            tmpB.copy(tmpA).add(tmpC.set((Math.random() - 0.5) * len * 0.35, (Math.random() - 0.2) * len * 0.3, (Math.random() - 0.5) * len * 0.35));
            jag(br, tmpA, tmpB, BRANCH_PTS, len * 0.08);
          }
        }
        // glow beads along the bolt (the plasma around the arc)
        if (o.fx > 0) {
          for (let s = 0; s < 6; s++) {
            const arr = (b.line.geometry.getAttribute("position") as THREE.BufferAttribute).array as Float32Array;
            const k = Math.floor(Math.random() * BOLT_PTS);
            boltGlow.set(arr[k * 3]!, arr[k * 3 + 1]!, arr[k * 3 + 2]!);
            spawnFx(1, boltGlow, b.color, { speed: 0.2, up: 0, spread: 0.02, life: 0.12, size: 0.22, gravity: 0, drag: 0 });
          }
        }
      }
    }
    return live;
  }

  function updateBursts(t: number): boolean {
    let live = false;
    for (const b of bursts) {
      if (!b.active) continue;
      const u = (t - b.start) / b.dur;
      if (u >= 1) { b.active = false; b.mesh.visible = false; continue; }
      live = true;
      b.mat.uniforms.uT!.value = easeOut(u);
      b.mesh.scale.setScalar(b.scale * (0.6 + 0.8 * easeOut(u)));
      b.mesh.quaternion.copy(camera.quaternion);
    }
    return live;
  }

  // ------------------------------------------------------------------ camera
  /** The radius that holds every node (the fit and the auto overview frame it). */
  function sceneRadius(): number {
    let r = 3;
    for (const n of nodes.values()) r = Math.max(r, Math.hypot(n.target.x, n.target.y, n.target.z) + 1.6 * n.size);
    return r;
  }

  function fit(): void {
    const r = sceneRadius();
    if (mode === "3d") {
      const dist = (r / Math.sin((persp.fov * Math.PI) / 360)) * 0.78; // the bounding sphere is loose; frame the figures, not empty space
      persp.position.set(0, dist * 0.72, dist * 0.7); // ~46 degrees up, so the orbit ellipse reads as a ring, not a stack
      controls.target.set(0, 0, 0);
    } else {
      ortho.zoom = 1;
      ortho.position.set(0, 60, 0);
      controls.target.set(0, 0, 0);
      orthoFrame(r * 1.12);
    }
    controls.update();
    needFit = false;
    seedRig();
    kick();
  }

  /** Start the auto camera's springs from wherever the camera is now, at rest. */
  function seedRig(): void {
    const tg = controls.target;
    rig.tx = tg.x; rig.ty = tg.y; rig.tz = tg.z;
    rig.vx = rig.vy = rig.vz = rig.vd = rig.va = rig.vp = rig.vlz = 0;
    tmpA.subVectors(persp.position, tg);
    rig.dist = Math.max(0.5, tmpA.length());
    rig.polar = Math.acos(Math.max(-1, Math.min(1, tmpA.y / rig.dist)));
    rig.az = Math.atan2(tmpA.x, tmpA.z);
    rig.lz = Math.log(Math.max(1e-3, ortho.zoom));
    rig.settled = false;
  }

  /** One auto camera step: spring the target, distance (zoom in 2D) and angles toward the focus. */
  const aim = new THREE.Vector3();
  function driveCamera(t: number, dt: number): void {
    const f = focusId ? nodes.get(focusId) : undefined;
    const sec = t / 1000;
    const swayOn = o.motion && !!f;
    const sway = swayOn ? Math.sin((sec * Math.PI * 2) / SWAY_S) : 0;
    let moving = 0;
    const track = (x: number, v: number, to: number): [number, number] => {
      const r: [number, number] = o.motion ? springStep(x, v, to, CAM_OMEGA, dt) : [to, 0];
      moving = Math.max(moving, Math.abs(r[1]), Math.abs(to - r[0]));
      return r;
    };
    if (f) aim.copy(f.cur); else aim.set(0, 0, 0);
    const sn = shot ? nodes.get(shot.id) : undefined;
    if (shot && sn?.d3 && mode === "3d") {
      // P-VIZ.7: the scripted shot: a point in the subject's own frame, framed at the asked distance and angles.
      const h = sn.d3.holder;
      h.updateMatrixWorld();
      aim.copy(shot.offset);
      h.localToWorld(aim);
      const az = h.rotation.y + shot.az + shot.azSpeed * (sec - shot.at);
      [rig.tx, rig.vx] = track(rig.tx, rig.vx, aim.x);
      [rig.ty, rig.vy] = track(rig.ty, rig.vy, aim.y);
      [rig.tz, rig.vz] = track(rig.tz, rig.vz, aim.z);
      [rig.dist, rig.vd] = track(rig.dist, rig.vd, shot.dist);
      [rig.az, rig.va] = track(rig.az, rig.va, rig.az + angleDelta(rig.az, az));
      [rig.polar, rig.vp] = track(rig.polar, rig.vp, shot.polar);
      rig.dist = Math.max(0.05, rig.dist);
      const sp = Math.sin(rig.polar);
      persp.position.set(rig.tx + rig.dist * sp * Math.sin(rig.az), rig.ty + rig.dist * Math.cos(rig.polar), rig.tz + rig.dist * sp * Math.cos(rig.az));
      controls.target.set(rig.tx, rig.ty, rig.tz);
      rig.settled = shot.azSpeed === 0 && moving < 1e-3;
      return;
    }
    if (mode === "3d") {
      const wantDist = f ? frameDistance(CUBE * f.size * FRAME_PAD, persp.fov, FILL) : (sceneRadius() / Math.sin((persp.fov * Math.PI) / 360)) * 0.78;
      const wantAz = rig.az + angleDelta(rig.az, SWAY_AZ * sway);
      const wantPolar = f ? FOCUS_POLAR + (swayOn ? SWAY_POLAR * Math.sin((sec * Math.PI * 2) / (SWAY_S * 0.61)) : 0) : OVERVIEW_POLAR;
      [rig.tx, rig.vx] = track(rig.tx, rig.vx, aim.x);
      [rig.ty, rig.vy] = track(rig.ty, rig.vy, aim.y);
      [rig.tz, rig.vz] = track(rig.tz, rig.vz, aim.z);
      [rig.dist, rig.vd] = track(rig.dist, rig.vd, wantDist);
      [rig.az, rig.va] = track(rig.az, rig.va, wantAz);
      [rig.polar, rig.vp] = track(rig.polar, rig.vp, wantPolar);
      rig.dist = Math.max(controls.minDistance, rig.dist);
      const sp = Math.sin(rig.polar);
      persp.position.set(rig.tx + rig.dist * sp * Math.sin(rig.az), rig.ty + rig.dist * Math.cos(rig.polar), rig.tz + rig.dist * sp * Math.cos(rig.az));
      controls.target.set(rig.tx, rig.ty, rig.tz);
    } else {
      // Zoom springs in log space, so zooming in and out feel the same speed.
      const wantZoom = f ? ((ortho.top - ortho.bottom) * FILL_2D) / (TILE * f.size) : orthoHalf / (sceneRadius() * 1.12);
      if (f) aim.x += sway * 0.08 * f.size;
      [rig.tx, rig.vx] = track(rig.tx, rig.vx, aim.x);
      [rig.tz, rig.vz] = track(rig.tz, rig.vz, aim.z);
      [rig.lz, rig.vlz] = track(rig.lz, rig.vlz, Math.log(Math.min(controls.maxZoom, Math.max(controls.minZoom, wantZoom))));
      ortho.position.set(rig.tx, 60, rig.tz);
      controls.target.set(rig.tx, 0, rig.tz);
      ortho.zoom = Math.exp(rig.lz);
      ortho.updateProjectionMatrix();
    }
    rig.settled = !swayOn && moving < 1e-3;
  }

  let orthoHalf = 10;
  function orthoFrame(half: number): void {
    orthoHalf = half;
    const aspect = W && H ? W / H : 1;
    const hh = aspect >= 1 ? half : half / aspect;
    ortho.left = -hh * aspect; ortho.right = hh * aspect; ortho.top = hh; ortho.bottom = -hh;
    ortho.updateProjectionMatrix();
  }

  const bufSize = new THREE.Vector2();
  function pointScale(): void {
    renderer.getDrawingBufferSize(bufSize);
    const isOrtho = mode === "2d";
    const scale = isOrtho
      ? bufSize.y / ((ortho.top - ortho.bottom) / ortho.zoom)
      : bufSize.y / (2 * Math.tan((persp.fov * Math.PI) / 360));
    if (!fx.mat) return;
    fx.mat.uniforms.uScale!.value = scale;
    fx.mat.uniforms.uOrtho!.value = isOrtho ? 1 : 0;
  }

  function resize(): void {
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h || (w === W && h === H)) return;
    W = w; H = h;
    renderer.setSize(W, H, false);
    persp.aspect = W / H;
    persp.updateProjectionMatrix();
    orthoFrame(orthoHalf);
    if (composer && bloom) {
      composer.setPixelRatio(renderer.getPixelRatio());
      composer.setSize(W, H);
      bloom.resolution.set(W * renderer.getPixelRatio(), H * renderer.getPixelRatio());
    }
    kick();
  }

  // ------------------------------------------------------------------ hover + pick + taking the camera
  const rc = new THREE.Raycaster();
  rc.params.Line = { threshold: 0.12 };
  const ndc = new THREE.Vector2();
  function hitAt(x: number, y: number): SceneHit | null {
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    ndc.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
    rc.setFromCamera(ndc, camera);
    const nh = rc.intersectObjects(hitMeshes, false)[0];
    if (nh) return { kind: "node", id: String(nh.object.userData.nodeId) };
    const eh = rc.intersectObjects(edgeLines, false)[0];
    if (eh) { const e = eh.object.userData.edge as { from: string; to: string }; return { kind: "edge", from: e.from, to: e.to }; }
    return null;
  }
  function hoverNow(): void {
    if (!pointer || !pointer.dirty) return;
    pointer.dirty = false;
    const hit = hitAt(pointer.x, pointer.y);
    const key = hit ? (hit.kind === "node" ? `n:${hit.id}` : `e:${hit.from}>${hit.to}`) : "";
    canvas.style.cursor = throwCursor ?? (hit?.kind === "node" ? "pointer" : "");
    if (key || lastHitKey) hoverCb?.(hit, pointer.x, pointer.y);
    lastHitKey = key;
  }
  let down: { x: number; y: number; at: number } | null = null;
  const onMove = (e: PointerEvent): void => {
    pointer = { x: e.clientX, y: e.clientY, dirty: true };
    // A press that travels is a drag, pan or pinch the controls are acting on: the user has the camera.
    if (down && interacting && Math.hypot(e.clientX - down.x, e.clientY - down.y) > GRAB_PX) userGrab();
    if (!raf) hoverNow();
  };
  const onLeave = (): void => { pointer = null; lastHitKey = ""; canvas.style.cursor = ""; hoverCb?.(null, 0, 0); };
  const onDown = (e: PointerEvent): void => { down = { x: e.clientX, y: e.clientY, at: performance.now() }; };
  let clickWait: { x: number; y: number; hit: SceneHit | null; timer: number } | null = null;
  const anchorAt = new THREE.Vector3(); // screenBoxOf's scratch
  const onUp = (e: PointerEvent): void => {
    if (!down) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    const quick = performance.now() - down.at < 650;
    down = null;
    if (moved >= 6 || !quick || e.button !== 0) return;
    const x = e.clientX, y = e.clientY;
    if (throwCursor) { // P-VIZ.6: armed, every click is a throw, delivered now (no double click wait)
      if (clickWait) { window.clearTimeout(clickWait.timer); clickWait = null; }
      pickCb?.(hitAt(x, y), x, y);
      return;
    }
    // P-VIZ.4: a click waits DOUBLE_MS for a second one near it; a pair is one double click, never a single.
    if (clickWait && Math.hypot(x - clickWait.x, y - clickWait.y) < 12) {
      window.clearTimeout(clickWait.timer);
      const hit = clickWait.hit;
      clickWait = null;
      doublePickCb?.(hit, x, y);
      return;
    }
    if (clickWait) { window.clearTimeout(clickWait.timer); const c = clickWait; clickWait = null; pickCb?.(c.hit, c.x, c.y); }
    const hit = hitAt(x, y);
    const timer = window.setTimeout(() => { clickWait = null; pickCb?.(hit, x, y); }, DOUBLE_MS);
    clickWait = { x, y, hit, timer };
  };
  const onWheel = (): void => userGrab();
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerleave", onLeave);
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("wheel", onWheel, { passive: true });
  const onLostCtx = (e: Event): void => { e.preventDefault(); park(); lostCb?.(); };
  canvas.addEventListener("webglcontextlost", onLostCtx);

  // ------------------------------------------------------------------ the loop
  let busyNodes = false, busyCam = false;
  function render(t: number): void {
    const dt = Math.min(0.1, last ? (t - last) / 1000 : 0.016);
    last = t;
    clock.now = t;
    if (needFit && nodes.size) fit();
    busyCam = false;
    if ((auto || shot) && !interacting && nodes.size) { driveCamera(t, dt); busyCam = !rig.settled; }
    controls.update();
    busyNodes = false;
    for (const n of nodes.values()) {
      updateNode(n, t, dt);
      if (n.status === "active" || t < n.fx.failUntil) busyNodes = true;
    }
    updateFlow(t, dt);
    const throwLive = throwFx.update(t, dt); // before the sparks, so an impact's sparks move this frame
    const fxLive = updateFx(dt);
    const boltLive = updateBolts(t);
    const burstLive = updateBursts(t);
    const worldLive = updateWorldLayers(t, dt);
    if (fxLive || boltLive || burstLive || throwLive || worldLive) effectsUntil = Math.max(effectsUntil, t + 50);
    pointScale();
    hoverNow();
    aimLights();
    // No bloom in 2D: the flat map is cel-shaded figures on tiles and renders plain.
    if (composer && renderPass && mode === "3d") { renderPass.camera = camera; composer.render(dt); }
    else renderer.render(scene, camera);
  }

  /** One loop chain only: a kick() from inside a frame (controls damping, a fit) sets `wanted` and the frame
   *  continues, instead of starting a second chain. */
  function frame(t: number): void {
    raf = 0;
    if (stopped || !visible) return;
    const busy = busyFlow || busyNodes || busyCam || t < effectsUntil || interacting;
    let interval = frameInterval(o, busy, recording);
    if (interval === null && (t < effectsUntil || interacting || busyCam)) interval = 1000 / IDLE_FPS; // color transitions and a snap only
    if (interval !== null && t - lastFrame < interval - 1.5) { raf = requestAnimationFrame(frame); return; }
    lastFrame = t;
    inFrame = true; wanted = false;
    try { render(t); } finally { inFrame = false; }
    const after = busyFlow || busyNodes || busyCam || t < effectsUntil || interacting;
    if (stopped || !visible) return;
    if (wanted || frameInterval(o, after, recording) !== null || t < effectsUntil || interacting || busyCam) raf = requestAnimationFrame(frame);
  }

  function kick(): void {
    if (inFrame) { wanted = true; return; }
    if (stopped || !visible || raf) return;
    lastFrame = 0;
    raf = requestAnimationFrame(frame);
  }

  function park(): void {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
  }

  const ro = new ResizeObserver(resize);
  ro.observe(host);
  resize();

  return {
    canvas,
    sync(list, links) {
      const keep = new Set<string>();
      for (const n of list) {
        keep.add(n.id);
        let obj = nodes.get(n.id);
        if (obj && obj.persona !== n.persona) { disposeNode(obj); nodes.delete(n.id); obj = undefined; }
        if (!obj) { obj = buildNode(n); nodes.set(n.id, obj); if (!userMoved && !auto) needFit = true; } // keep everyone in frame until the user takes the camera
        obj.target.set(n.pos[0], n.pos[1], n.pos[2]);
        if (obj.status === "killed" && n.status !== "killed") obj.fx.implodeAt = 0;
        if (n.status === "killed" && obj.status !== "killed" && obj.fx.implodeAt === 0) obj.fx.implodeAt = clock.now;
        obj.status = n.status;
        obj.glow = n.glow;
        obj.team = n.team; obj.idleSec = n.idleSec; // P-VIZ.4: read by updateNode
        obj.committing = n.committing; // P-VIZ.7: read by updateNode
        // P-VIZ.7: the sponsor, size and variant are baked into the figure: a new model rebuilds it.
        const brand = vizBrandFor(n.model);
        if (brandSig(brand) !== obj.brandSig) { obj.brand = brand; obj.brandSig = brandSig(brand); drop3d(obj); drop2d(obj); ensureParts(obj); }
        // P-WORLDS.1: a world casts a subagent by its parent's role, so a late-known parent rebuilds it.
        if (obj.parentKind !== n.parentKind) { obj.parentKind = n.parentKind; if (activeWorld) { drop3d(obj); drop2d(obj); ensureParts(obj); } }
        paintLabel(obj, n.label);
      }
      for (const [id, obj] of [...nodes]) if (!keep.has(id)) { disposeNode(obj); nodes.delete(id); }
      const want = new Set<string>();
      for (const e of links) {
        if (!nodes.has(e.from) || !nodes.has(e.to)) continue;
        const ed = edgeFor(e, false);
        want.add(ed.key);
        ed.intensity = e.intensity; ed.frozen = e.frozen; ed.dead = e.dead;
        ed.color.copy(nodes.get(e.from)!.base);
        ed.colorTo.copy(nodes.get(e.to)!.base);
        if (activeWorld) edgeColors(ed); // P-WORLDS.1: the world's two edge colors
        ed.conduit.set(ed.intensity, ed.frozen, ed.dead, ed.color, ed.colorTo);
      }
      // Main's own tokens swirl around the hub.
      const hub = list.find((n) => n.kind === "hub");
      if (hub) {
        const ring = edgeFor({ from: hub.id, to: hub.id, intensity: 0, frozen: false, dead: false }, true);
        want.add(ring.key);
        ring.intensity = hub.status === "active" ? hub.glow : 0;
        ring.frozen = hub.status === "paused";
        ring.dead = false;
        ring.color.set(PERSONAS[hub.persona].color);
        if (activeWorld) { edgeColors(ring); ring.conduit.set(ring.intensity, ring.frozen, ring.dead, ring.color, ring.colorTo); }
        else ring.conduit.set(ring.intensity, ring.frozen, ring.dead, ring.color, ring.color);
      }
      for (const ed of [...edges.values()]) if (!want.has(ed.key)) dropEdge(ed);
      const prev = focusId;
      focusId = directorStep(director, list.map((n) => ({ id: n.id, activity: n.glow })), performance.now());
      if (focusId !== prev && auto) rig.settled = false;
      kick();
    },
    fire(events) {
      clock.now = performance.now(); // the loop may have been parked: effects start now, on the rAF timeline
      for (const ev of events) fireOne(ev);
      focusId = director.focus; // a kill or a tool failure grabs the camera now, not on the next sync
      if (events.length) kick();
    },
    setView(next) {
      if (next === mode) return;
      mode = next;
      camera = mode === "3d" ? persp : ortho;
      controls.dispose();
      controls = makeControls();
      interacting = false;
      for (const obj of nodes.values()) ensureParts(obj);
      edgeFx.setFlat(mode === "2d");
      throwFx.setFlat(mode === "2d");
      if (activeWorld) { rebuildAmbient(); scene.fog = mode === "3d" ? worldFog : null; } // P-WORLDS.1: the ambient layer is built for the mode; fog in 3D only
      fit();
    },
    setStyle(next, w = null) {
      if (isBuiltinStyle(next)) {
        if (next === style) return;
        const fromWorld = activeWorld !== null;
        style = next;
        activeWorld = null;
        if (fromWorld) { clearWorldStorms(); applyWorldEnvironment(); }
        edgeFx.setStyle(edgeStyleFor(next));
      } else {
        // P-WORLDS.1: a world style needs its definition; the same world with new options rebuilds the cast.
        if (!w || (next === style && w === activeWorld)) return;
        const sameWorld = next === style && activeWorld?.def === w.def;
        style = next;
        activeWorld = w;
        if (!sameWorld) { clearWorldStorms(); applyWorldEnvironment(); }
        edgeFx.setStyle(w.def.environment.edges.style);
      }
      for (const obj of nodes.values()) { drop3d(obj); drop2d(obj); ensureParts(obj); }
      kick();
    },
    fit,
    setAuto(on) {
      if (on === auto) return;
      auto = on;
      if (on) seedRig(); // glide from wherever the user left the camera
      kick();
    },
    onUserCamera(cb) { userCamCb = cb; },
    setVisible(on) {
      visible = on;
      if (on) kick(); else park();
    },
    setRecording(on) { recording = on; kick(); },
    onHover(cb) { hoverCb = cb; },
    onPick(cb) { pickCb = cb; },
    onDoublePick(cb) { doublePickCb = cb; },
    reactNode(id, kind) {
      const slot = nodes.get(id)?.d3 ?? nodes.get(id)?.d2;
      if (!slot) return;
      slot.fig.react(kind, camera);
      effectsUntil = Math.max(effectsUntil, performance.now() + REACT_MS); // frames for the reaction even when nothing else moves
      kick();
    },
    screenBoxOf(id) {
      const obj = nodes.get(id);
      const r = canvas.getBoundingClientRect();
      if (!obj || !r.width || !r.height) return null;
      anchorAt.copy(obj.cur).project(camera);
      if (anchorAt.z > 1 || anchorAt.z < -1) return null; // behind the camera or past the far plane
      const x = r.left + ((anchorAt.x + 1) / 2) * r.width, y = r.top + ((1 - anchorAt.y) / 2) * r.height;
      // The half extent: center to the top of the cube in 3D, to the top edge of the tile on the map (screen up is -Z there).
      anchorAt.copy(obj.cur);
      if (mode === "3d") anchorAt.y += (CUBE / 2) * obj.size; else anchorAt.z -= (TILE / 2) * obj.size;
      anchorAt.project(camera);
      const tx = r.left + ((anchorAt.x + 1) / 2) * r.width, ty = r.top + ((1 - anchorAt.y) / 2) * r.height;
      return { x, y, r: Math.max(8, Math.hypot(tx - x, ty - y)) };
    },
    throwAt(nodeId, kind, from) {
      const obj = nodes.get(nodeId);
      if (!obj) return false;
      const w = activeWorld;
      if (w) {
        // P-WORLDS.1: one of the world's own projectiles, on the same arc from the same launch point.
        if (!w.def.throws.some((t) => t.kind === kind)) return false;
        clock.now = performance.now();
        nodeHead(obj, throwTo);
        launchFrom(from ?? launchPx(W, H, 0, 1), throwTo, throwFrom);
        if (!o.motion) hitFigure(nodeId, kind, throwFrom);
        else {
          const proj = w.def.createProjectile(kind, mode === "2d");
          if (!throwFx.launchWorld(nodeId, kind, proj, throwFrom, 0, clock.now)) proj.dispose(); // THROW_CAP
        }
        effectsUntil = Math.max(effectsUntil, clock.now + REACT_MS);
        kick();
        return true;
      }
      if (!isThrowKind(kind)) return false;
      clock.now = performance.now(); // the loop may have been parked: the flight starts now, on the rAF timeline
      nodeHead(obj, throwTo);
      const shots = volley(kind);
      for (let i = 0; i < shots.length; i++) {
        if (kind === "bolt") skyAbove(throwTo, mode === "2d", throwFrom);
        else launchFrom(from ? { x: from.x + (i - (shots.length - 1) / 2) * 14, y: from.y } : launchPx(W, H, i, shots.length), throwTo, throwFrom);
        // Reduced motion: no flight, no flash; the hit lands at once (the stars' three, in order).
        if (!o.motion) hitFigure(nodeId, kind, throwFrom);
        else if (!throwFx.launch(nodeId, kind, throwFrom, shots[i]!, clock.now)) break; // THROW_CAP
      }
      effectsUntil = Math.max(effectsUntil, clock.now + REACT_MS);
      kick();
      return true;
    },
    scriptShot(id, opts = {}) {
      if (!id || !nodes.has(id)) { shot = null; kick(); return; }
      const off = opts.offset ?? [0, 0.5, 0];
      shot = {
        id, offset: new THREE.Vector3(off[0], off[1], off[2]), dist: opts.dist ?? 1.6, polar: opts.polar ?? FOCUS_POLAR,
        az: opts.az ?? 0, azSpeed: o.motion ? (opts.azSpeed ?? 0) : 0, at: performance.now() / 1000,
      };
      rig.settled = false;
      kick();
    },
    storm() {
      if (!nodes.size) return;
      clock.now = performance.now();
      // The front sweeps left to right across the screen: the camera's right vector, on the ground.
      stormDir.set(1, 0, 0).applyQuaternion(camera.quaternion).setY(0);
      if (stormDir.lengthSq() < 1e-6) stormDir.set(1, 0, 0);
      stormDir.normalize();
      const hits = stormSchedule([...nodes.values()].map((n) => ({ id: n.id, x: n.cur.x, z: n.cur.z })), stormDir);
      if (!o.motion) { // reduced motion: no sky, no strikes, no papers; every figure hit at once
        for (const h of hits) {
          const n = nodes.get(h.id);
          if (!n) continue;
          nodeHead(n, throwTo);
          if (style !== "professional") skyAbove(throwTo, mode === "2d", throwFrom); else throwFrom.copy(throwTo).addScaledVector(stormDir, -3); // anime and the worlds: from the sky
          hitFigure(h.id, "storm", throwFrom);
        }
        if (activeWorld) { // P-WORLDS.1: the world's short, still storm
          stormCenter.set(0, 0, 0);
          for (const n of nodes.values()) stormCenter.add(n.cur);
          startWorldStorm(activeWorld, stormCenter.divideScalar(nodes.size), sceneRadius());
          kick();
        }
        return;
      }
      stormCenter.set(0, 0, 0);
      for (const n of nodes.values()) stormCenter.add(n.cur);
      stormCenter.divideScalar(nodes.size);
      if (activeWorld) startWorldStorm(activeWorld, stormCenter, sceneRadius()); // P-WORLDS.1: the world's own storm
      const until = throwFx.storm(style, hits, stormDir, stormCenter, sceneRadius(), clock.now);
      effectsUntil = Math.max(effectsUntil, until + REACT_MS);
      kick();
    },
    nodeAt(x, y) {
      const hit = hitAt(x, y);
      return hit?.kind === "node" ? hit.id : null;
    },
    setThrowArmed(cursor) {
      throwCursor = cursor;
      canvas.style.cursor = cursor ?? "";
      if (pointer) pointer.dirty = true; // the hover pass restores the node pointer once disarmed
      kick();
    },
    onLost(cb) { lostCb = cb; },
    destroy() {
      stopped = true;
      park();
      if (clickWait) { window.clearTimeout(clickWait.timer); clickWait = null; }
      ro.disconnect();
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("webglcontextlost", onLostCtx);
      controls.dispose();
      for (const obj of nodes.values()) disposeNode(obj);
      nodes.clear();
      for (const ed of [...edges.values()]) dropEdge(ed);
      edgeFx.dispose();
      throwFx.dispose();
      clearWorldStorms(); // P-WORLDS.1
      if (ambient) { scene.remove(ambient.object); ambient.dispose(); ambient = null; }
      const mats = new Set<THREE.Material>();
      const sharedGeo = new Set<THREE.BufferGeometry>(geo.values());
      scene.traverse((x) => {
        const m = (x as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(m)) m.forEach((mm) => mats.add(mm)); else if (m) mats.add(m);
        const g = (x as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
        if (g && !(x instanceof THREE.Sprite) && !sharedGeo.has(g)) g.dispose(); // three's sprites share one module geometry
      });
      for (const m of mats) m.dispose();
      for (const g of geo.values()) g.dispose();
      geo.clear();
      bgTex.dispose();
      envRT.dispose();
      bloom?.dispose();
      composer?.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    },
  };
}

// ------------------------------------------------------------------------------------------ helpers

function easeIn(x: number): number { return x * x * x; }
function easeOut(x: number): number { return 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3); }

/** A w x h rounded rectangle centered on the origin (the 2D tile and its rim). */
function roundRectShape(w: number, h: number, r: number): THREE.Shape {
  const s = new THREE.Shape();
  const x = -w / 2, y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

/** The scene's own backdrop (so a recording looks like the live view): the orbit's nebula, as a texture. */
function backdrop(theme: VizTheme): THREE.CanvasTexture {
  const cv = document.createElement("canvas");
  cv.width = 1024; cv.height = 640;
  const c = cv.getContext("2d");
  if (c) {
    c.fillStyle = theme.bg;
    c.fillRect(0, 0, cv.width, cv.height);
    const glow = (x: number, y: number, r: number, color: string, a: number): void => {
      const g = c.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, hexA(color, a));
      g.addColorStop(1, hexA(color, 0));
      c.fillStyle = g;
      c.fillRect(0, 0, cv.width, cv.height);
    };
    const k = theme.light ? 0.5 : 1;
    glow(512, 300, 520, theme.accent, 0.16 * k);
    glow(180, 540, 420, theme.cyan, 0.08 * k);
    glow(860, 90, 380, theme.accent, 0.07 * k);
    if (!theme.light) { // a faint star field
      let seed = 7;
      const rnd = (): number => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
      for (let i = 0; i < 140; i++) {
        c.fillStyle = `rgba(255,255,255,${0.08 + rnd() * 0.25})`;
        c.fillRect(rnd() * cv.width, rnd() * cv.height, 1.2, 1.2);
      }
    }
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** P-WORLDS.1 (ADR-0648): a world's sky, painted by the world into the backdrop's canvas (no stars, no nebula). */
function worldSky(paint: (ctx: CanvasRenderingContext2D, width: number, height: number) => void): THREE.CanvasTexture {
  const cv = document.createElement("canvas");
  cv.width = 1024; cv.height = 640;
  const c = cv.getContext("2d");
  if (c) paint(c, cv.width, cv.height);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function hexA(hex: string, a: number): string {
  const n = parseInt(hex.replace("#", ""), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
