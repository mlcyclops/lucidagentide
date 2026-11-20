// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/viz_scene.ts - P-VIZ.1 (ADR-0622), P-VIZ.2 (ADR-0623): the Visualize view's three.js scene.
//
// Every node is a mini Lucid, dressed in its persona's color (viz_mini_look.lookFor).
//   3D: a procedural 3D mini Lucid (viz_mini3d.createMini3D, built at the perf tier's detail) inside a
//       translucent glass CUBE: a transmissive (or, below the full tier, clear reflective) rounded box with a
//       faint iridescence, thin bright accent edges and a dark floor plate he stands on. He runs his persona's
//       rotation of activities while the node works (viz_mini_look.activityAt), faster with the node's smoothed
//       est. tok/s, throws a rapid burst move on a surge, and plays the node's power-downs (failed, paused,
//       ended, killed). Subagents get smaller cubes, the hub a larger one. The role and task caption is a crisp
//       canvas sprite on the cube's lower front edge.
//   2D: the PIXEL mini Lucid typing (viz_mini2d.createMini2D, nearest-neighbor, never blurred) as a
//       camera-facing sprite on a flat rounded tile in the persona color, the caption on the tile's lower edge.
//
// Tokens are GPU points (one ShaderMaterial, additive) flowing along each active edge from the producer to
// its parent; count and speed follow the node's est. tok/s. A surge throws a jagged regenerated lightning
// bolt along the edge and a plasma burst (an expanding shader billboard plus a spark spray). Power-downs are
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
import { createMini2D, type Mini2D } from "./viz_mini2d.ts";
import { createMini3D, type Mini3D, type MiniActivity, type MiniLook, type MiniState } from "./viz_mini3d.ts";
import { activityAt, lookFor } from "./viz_mini_look.ts";
import { frameInterval, IDLE_FPS, PERSONAS, type Persona, type PowerKind, type Vec3, type VizEvent, type VizKind, type VizStatus, type VizTierOpts } from "./viz_model.ts";

export type VizViewMode = "2d" | "3d";

export interface SceneNode { id: string; kind: VizKind; persona: Persona; label: string; status: VizStatus; pos: Vec3; glow: number }
export interface SceneEdge { from: string; to: string; intensity: number; frozen: boolean; dead: boolean }
export type SceneHit = { kind: "node"; id: string } | { kind: "edge"; from: string; to: string };

/** Theme colors, already normalized to #rrggbb by the view (read from the CSS custom properties). */
export interface VizTheme { bg: string; txt: string; accent: string; cyan: string; light: boolean }

export interface VizSceneHandle {
  readonly canvas: HTMLCanvasElement;
  sync(nodes: readonly SceneNode[], edges: readonly SceneEdge[]): void;
  fire(events: readonly VizEvent[]): void;
  setView(mode: VizViewMode): void;
  /** Re-frame the camera on every node (after a layout switch, or on demand). Leaves auto as it is. */
  fit(): void;
  /** Auto camera on (glides from the current view to the action) or off (the user's controls only). */
  setAuto(on: boolean): void;
  /** The user took the camera (a drag, pan, pinch or wheel): auto has turned itself off. */
  onUserCamera(cb: () => void): void;
  setVisible(on: boolean): void;
  setRecording(on: boolean): void;
  onHover(cb: (hit: SceneHit | null, x: number, y: number) => void): void;
  onPick(cb: (hit: SceneHit | null, x: number, y: number) => void): void;
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

const KIND_SCALE: Record<VizKind, number> = { hub: 1.35, agent: 1, subagent: 0.58 };
/** The glass cube's side (before the kind's scale). The figure is about 1 unit tall. */
const CUBE = 1.5;
const FLOOR_Y = -CUBE / 2;
const PLATE_H = 0.045;
/** The 2D tile's side and the pixel figure's height on it (before the kind's scale). */
const TILE = 1.5;
const FIG_2D = 1.18;
/** 2D layers above the node's plane: the tile covers the edge ends, the sprites sit on the tile. */
const TILE_Y = 0.1, SPRITE_Y = 0.13;
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

const SEG = 32; // points per edge curve
const BOLT_PTS = 33;
const BRANCH_PTS = 9;
const BOLT_POOL = 8;
const BURST_POOL = 8;
const BOLT_MS = 380;
const BURST_MS = 650;
const FLOW_SPAWN_MAX = 420; // particles per second on a full-intensity edge at the full budget

interface NodeFx { flickerUntil: number; shakeUntil: number; shakeAmp: number; implodeAt: number; colorUntil: number; failUntil: number }

/** The 3D parts of a node: the figure in its glass cube. */
interface Node3D {
  mini: Mini3D; holder: THREE.Group; glass: THREE.Mesh; glassMat: THREE.MeshPhysicalMaterial; edgeMat: THREE.LineBasicMaterial; plateMat: THREE.MeshStandardMaterial;
  activity: MiniActivity | null; state: MiniState | null;
}

/** The 2D parts of a node: the pixel figure on its tile. */
interface Node2D { mini: Mini2D; tile: THREE.Mesh; tileMat: THREE.MeshBasicMaterial; rimMat: THREE.LineBasicMaterial; figMat: THREE.SpriteMaterial }

interface NodeObj {
  id: string; kind: VizKind; persona: Persona; size: number; seed: number;
  look: MiniLook; base: THREE.Color; tileBase: THREE.Color;
  root: THREE.Group; pivot: THREE.Group;
  d3: Node3D | null; d2: Node2D | null;
  label: THREE.Sprite; labelMat: THREE.SpriteMaterial; labelText: string;
  cracks: THREE.LineSegments | null;
  status: VizStatus; glow: number; power: number;
  cur: THREE.Vector3; target: THREE.Vector3; placed: boolean;
  tone: { tint: number; dim: number; frost: number };
  fx: NodeFx;
}

interface EdgeObj {
  key: string; from: string; to: string; slot: number; ring: boolean;
  line: THREE.Line | null; mat: THREE.LineBasicMaterial | null; posAttr: THREE.BufferAttribute | null;
  p0: THREE.Vector3; p1: THREE.Vector3; p2: THREE.Vector3; n1: THREE.Vector3; n2: THREE.Vector3; len: number;
  intensity: number; frozen: boolean; dead: boolean; color: THREE.Color; acc: number;
}

interface Bolt { line: THREE.Line; branches: THREE.Line[]; mat: THREE.LineBasicMaterial; from: THREE.Vector3; to: THREE.Vector3; start: number; next: number; active: boolean; color: THREE.Color }
interface Burst { mesh: THREE.Mesh; mat: THREE.ShaderMaterial; start: number; dur: number; scale: number; active: boolean }

/** Mount the scene into `host`. Throws when WebGL cannot start (the view shows that honestly). */
export function mountVizScene(host: HTMLElement, tier: VizTierOpts, theme: VizTheme, initialView: VizViewMode, initialAuto: boolean): VizSceneHandle {
  const o = tier;
  const renderer = new THREE.WebGLRenderer({ antialias: o.antialias, alpha: false, powerPreference: "high-performance" });
  const canvas = renderer.domElement;
  canvas.className = "viz-cv";
  canvas.setAttribute("aria-label", "Agent visualization. Drag to move the view, scroll to zoom, click a node for its actions.");
  canvas.tabIndex = 0;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, o.dprCap));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = theme.light ? 1.0 : 1.1;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  host.prepend(canvas);

  const scene = new THREE.Scene();
  const bgTex = backdrop(theme);
  scene.background = bgTex;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const envRT = pmrem.fromScene(room, 0.04);
  room.dispose();
  pmrem.dispose();
  scene.environment = envRT.texture;
  scene.add(new THREE.HemisphereLight(0xc8d8ff, 0x1c1420, theme.light ? 1.1 : 0.7));
  const sun = new THREE.DirectionalLight(0xffffff, 1.5);
  sun.position.set(5, 10, 7);
  scene.add(sun);
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
  const slots: (EdgeObj | null)[] = [];
  const hitMeshes: THREE.Object3D[] = [];
  const edgeLines: THREE.Object3D[] = [];
  const blend = theme.light ? THREE.NormalBlending : THREE.AdditiveBlending;
  const bgColor = new THREE.Color(theme.bg);

  // ------------------------------------------------------------------ flow particles (GPU points)
  const flow = makePointPool(o.particles);
  const fx = makePointPool(o.fx);
  const fxVel = new Float32Array(o.fx * 3);
  const fxLife = new Float32Array(o.fx);
  const fxMax = new Float32Array(o.fx);
  const fxGrav = new Float32Array(o.fx);
  const fxDrag = new Float32Array(o.fx);
  const fxSize0 = new Float32Array(o.fx);
  const flowSlot = new Int16Array(o.particles).fill(-1);
  const flowT = new Float32Array(o.particles);
  const flowO1 = new Float32Array(o.particles);
  const flowO2 = new Float32Array(o.particles);
  const flowFree: number[] = [];
  for (let i = o.particles - 1; i >= 0; i--) flowFree.push(i);
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
      id: n.id, kind: n.kind, persona: n.persona, size, seed,
      look: lookFor(color), base, tileBase: base.clone().lerp(bgColor, theme.light ? 0.8 : 0.74),
      root, pivot, d3: null, d2: null,
      label, labelMat, labelText: "", cracks: null,
      status: n.status, glow: n.glow, power: n.glow,
      cur: new THREE.Vector3(...n.pos), target: new THREE.Vector3(...n.pos), placed: false,
      tone: { tint: 0, dim: 0, frost: 0 },
      fx: { flickerUntil: 0, shakeUntil: 0, shakeAmp: 0, implodeAt: 0, colorUntil: 0, failUntil: 0 },
    };
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
    const mini = createMini3D({ look: obj.look, detail: o.detail });
    const holder = new THREE.Group();
    holder.position.y = FLOOR_Y + PLATE_H;
    holder.add(mini.group);
    obj.pivot.add(holder);

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

    const edgeMat = new THREE.LineBasicMaterial({ color: obj.base.clone().lerp(WHITE, 0.35), transparent: true, opacity: 0.9, toneMapped: false, depthWrite: false });
    const rims = new THREE.LineSegments(shared("cube-edges", () => new THREE.EdgesGeometry(new THREE.BoxGeometry(CUBE, CUBE, CUBE))), edgeMat);
    rims.renderOrder = 2;
    obj.pivot.add(rims);

    // A dark plate with a faint persona glow: bright enough to ground him, dim enough that he, not the floor, is lit.
    const plateMat = new THREE.MeshStandardMaterial({ color: obj.base.clone().lerp(bgColor, 0.93), metalness: 0.2, roughness: 0.5, emissive: obj.base.clone(), emissiveIntensity: 0.03, envMapIntensity: 0.2 });
    const plate = new THREE.Mesh(shared("cube-plate", () => new RoundedBoxGeometry(CUBE * 0.84, PLATE_H, CUBE * 0.84, 2, 0.016)), plateMat);
    plate.position.y = FLOOR_Y + PLATE_H / 2;
    obj.pivot.add(plate);
    return { mini, holder, glass, glassMat, edgeMat, plateMat, activity: null, state: null };
  }

  function build2d(obj: NodeObj): Node2D {
    const mini = createMini2D(obj.look);
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
    const figMat = new THREE.SpriteMaterial({ map: mini.texture, transparent: true, alphaTest: 0.5, toneMapped: false, depthWrite: false });
    const fig = new THREE.Sprite(figMat);
    fig.scale.set(FIG_2D * mini.aspect, FIG_2D, 1);
    fig.position.set(0, SPRITE_Y, -0.08);
    fig.renderOrder = 9;
    obj.pivot.add(fig);
    return { mini, tile, tileMat, rimMat, figMat };
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
    d.mini.dispose();
    for (const x of [...obj.pivot.children]) if (x === d.glass || (x as THREE.Mesh).material === d.edgeMat || (x as THREE.Mesh).material === d.plateMat) detach(obj, x);
    obj.d3 = null;
  }

  function drop2d(obj: NodeObj): void {
    const d = obj.d2;
    if (!d) return;
    for (const x of [...obj.pivot.children]) {
      const m = (x as THREE.Mesh).material;
      if (x === d.tile || m === d.rimMat || m === d.figMat) detach(obj, x);
    }
    d.mini.dispose();
    obj.d2 = null;
  }

  function placeLabel(obj: NodeObj): void {
    if (mode === "3d") obj.label.position.set(0, FLOOR_Y, CUBE / 2 + 0.02);
    else obj.label.position.set(0, SPRITE_Y + 0.01, TILE / 2 - 0.06);
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
    let slot = slots.indexOf(null);
    if (slot < 0) { slot = slots.length; slots.push(null); }
    ed = {
      key, from: e.from, to: e.to, slot, ring, line: null, mat: null, posAttr: null,
      p0: new THREE.Vector3(), p1: new THREE.Vector3(), p2: new THREE.Vector3(), n1: new THREE.Vector3(1, 0, 0), n2: new THREE.Vector3(0, 1, 0), len: 1,
      intensity: 0, frozen: false, dead: false, color: new THREE.Color(), acc: 0,
    };
    if (!ring) {
      const g = new THREE.BufferGeometry();
      const attr = new THREE.BufferAttribute(new Float32Array(SEG * 3), 3).setUsage(THREE.DynamicDrawUsage);
      g.setAttribute("position", attr);
      const mat = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.2, depthWrite: false, toneMapped: false });
      const line = new THREE.Line(g, mat);
      line.frustumCulled = false;
      line.userData.edge = { from: e.from, to: e.to };
      world.add(line);
      edgeLines.push(line);
      ed.line = line; ed.mat = mat; ed.posAttr = attr;
    }
    slots[slot] = ed;
    edges.set(key, ed);
    return ed;
  }

  function dropEdge(ed: EdgeObj): void {
    edges.delete(ed.key);
    slots[ed.slot] = null;
    for (let i = 0; i < o.particles; i++) if (flowSlot[i] === ed.slot) killFlow(i);
    if (ed.line) {
      world.remove(ed.line);
      const i = edgeLines.indexOf(ed.line);
      if (i >= 0) edgeLines.splice(i, 1);
      ed.line.geometry.dispose();
      ed.mat?.dispose();
    }
  }

  /** Recompute an edge's curve from the nodes' current positions (a quadratic bezier lifted and bowed). */
  const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3(), tmpC = new THREE.Vector3();
  function shapeEdge(ed: EdgeObj): void {
    const a = nodes.get(ed.from), b = nodes.get(ed.to);
    if (!a || !b) return;
    if (ed.ring) { ed.p0.copy(a.cur); ed.len = 2 * Math.PI * 1.5; return; }
    ed.p0.copy(a.cur).y += 0.05 * a.size;
    ed.p2.copy(b.cur).y += 0.05 * b.size;
    const dir = tmpA.subVectors(ed.p2, ed.p0);
    let len = Math.max(0.001, dir.length());
    dir.divideScalar(len);
    // The flow starts and ends at the cube walls, not at the cube centers: centered endpoints piled a ball of
    // glowing particles onto mini Lucid's head, and bloom turned him into a white blur.
    const ra = CUBE * a.size * 0.55, rb = CUBE * b.size * 0.55;
    if (len > (ra + rb) * 1.2) {
      ed.p0.addScaledVector(dir, ra);
      ed.p2.addScaledVector(dir, -rb);
      len -= ra + rb;
    }
    ed.len = len;
    const side = tmpB.set(-dir.z, 0, dir.x);
    if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
    side.normalize();
    ed.p1.copy(ed.p0).add(ed.p2).multiplyScalar(0.5).addScaledVector(side, len * 0.09);
    ed.p1.y += len * 0.16;
    ed.n1.copy(side);
    ed.n2.crossVectors(dir, side).normalize();
    if (ed.posAttr) {
      const arr = ed.posAttr.array as Float32Array;
      for (let i = 0; i < SEG; i++) {
        bez(ed, i / (SEG - 1), tmpC);
        arr[i * 3] = tmpC.x; arr[i * 3 + 1] = tmpC.y; arr[i * 3 + 2] = tmpC.z;
      }
      ed.posAttr.needsUpdate = true;
    }
  }

  function bez(ed: EdgeObj, t: number, out: THREE.Vector3): THREE.Vector3 {
    const u = 1 - t;
    out.set(
      u * u * ed.p0.x + 2 * u * t * ed.p1.x + t * t * ed.p2.x,
      u * u * ed.p0.y + 2 * u * t * ed.p1.y + t * t * ed.p2.y,
      u * u * ed.p0.z + 2 * u * t * ed.p1.z + t * t * ed.p2.z,
    );
    return out;
  }

  function killFlow(i: number): void {
    if (flowSlot[i] === -1) return;
    flowSlot[i] = -1;
    flow.alpha[i] = 0;
    flowFree.push(i);
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

  /** Where a node's effects start: the figure's chest in 3D (the cube is centered on the node), just above
   *  the tile in 2D. */
  function nodeHead(obj: NodeObj, out: THREE.Vector3): THREE.Vector3 {
    return out.copy(obj.cur).setY(obj.cur.y + (mode === "3d" ? -0.18 : 0.2) * obj.size);
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
      if (!o.motion) { effectsUntil = Math.max(effectsUntil, now + 700); return; }
      obj.d3?.mini.burst();
      const hot = color.clone().lerp(WHITE, 0.45).multiplyScalar(2.2);
      nodeHead(obj, fxAt);
      const parent = [...edges.values()].find((e) => !e.ring && e.from === obj.id);
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

  // ------------------------------------------------------------------ per-frame update
  const tmpColor = new THREE.Color();
  const tintTarget = new THREE.Color();
  const tileTint = new THREE.Color();
  const camPos = new THREE.Vector3();
  const flowColor = new THREE.Color();

  /** What the figure plays: the node's status, with a tool failure's flinch on top while it lasts. */
  function miniState(obj: NodeObj, t: number): MiniState {
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
    const stateNow = miniState(obj, t);

    if (obj.d3) {
      const d = obj.d3;
      if (stateNow !== d.state) { d.mini.setState(stateNow); d.state = stateNow; }
      const act = activityAt(obj.persona, obj.kind, obj.seed, t, st === "active");
      if (act !== d.activity) { d.mini.setActivity(act); d.activity = act; }
      d.mini.setIntensity(obj.power);
      d.mini.update(t / 1000, dt, o.motion);
      d.edgeMat.color.copy(tmpColor).multiplyScalar(level);
      d.edgeMat.opacity = st === "killed" ? 0.35 : st === "ended" ? 0.5 : 0.95;
      d.plateMat.emissive.copy(flickOn ? RED : obj.base);
      d.plateMat.emissiveIntensity = flickOn ? 0.6 : st === "ended" || st === "killed" ? 0.02 : 0.03 + 0.07 * obj.power;
      // glass: frosted when ended, dark gray when killed, icy when paused
      const g = d.glassMat;
      g.roughness = 0.04 + obj.tone.frost * 0.45;
      g.opacity = 0.025 + obj.tone.frost * 0.22;
      // He turns to face the camera (with a little lag) so the viewer sees him, not his back.
      camera.getWorldPosition(camPos);
      const face = Math.atan2(camPos.x - obj.cur.x, camPos.z - obj.cur.z);
      let dy = face - d.holder.rotation.y;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      d.holder.rotation.y += dy * (o.motion ? 1 - Math.exp(-dt * 3) : 1);
      g.color.copy(obj.base).lerp(WHITE, 0.85).lerp(tintTarget, Math.max(obj.tone.tint, st === "ended" ? 0.25 : 0)).multiplyScalar(1 - obj.tone.dim * 0.3);
      // killed: a quick implosion of the figure (the figure's own slump plays inside it)
      let scale = 1;
      if (st === "killed" && o.motion && obj.fx.implodeAt) {
        const age = (t - obj.fx.implodeAt) / 1000;
        scale = age < 0.18 ? 1 - 0.55 * easeIn(age / 0.18) : age < 0.6 ? 0.45 + 0.55 * easeOut((age - 0.18) / 0.42) : 1;
      }
      d.holder.scale.setScalar(scale);
    }
    if (obj.d2) {
      const d = obj.d2;
      d.mini.update(t, stateNow, obj.power);
      d.rimMat.color.copy(tmpColor).multiplyScalar(Math.min(1.4, level));
      d.rimMat.opacity = st === "killed" ? 0.4 : st === "ended" ? 0.55 : 0.95;
      tileTint.copy(tintTarget).lerp(bgColor, 0.6);
      d.tileMat.color.copy(obj.tileBase).lerp(tileTint, obj.tone.tint).lerp(bgColor, obj.tone.dim * 0.5);
      d.figMat.color.setRGB(1, flickOn ? 0.55 : 1, flickOn ? 0.55 : 1);
    }
    obj.labelMat.opacity = st === "ended" || st === "killed" ? 0.6 : 1;

    if (st === "killed") crack(obj); else healCracks(obj);
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
  function updateFlow(dt: number): void {
    busyFlow = false;
    for (const ed of edges.values()) {
      if (!ed.ring) {
        shapeEdge(ed);
        const childDead = ed.dead;
        if (ed.mat) {
          ed.mat.color.copy(childDead ? DEAD : ed.frozen ? ICE : ed.color).multiplyScalar(theme.light ? 0.7 : 1.2);
          ed.mat.opacity = childDead ? 0.12 : 0.16 + 0.55 * ed.intensity;
        }
      } else shapeEdge(ed);
      if (ed.intensity > 0 && !ed.frozen && !ed.dead) busyFlow = true;
      if (o.particles === 0 || ed.frozen || ed.dead || ed.intensity <= 0) continue;
      const budgetShare = o.particles / 6000;
      ed.acc += ed.intensity * ed.intensity * FLOW_SPAWN_MAX * budgetShare * dt * (ed.ring ? 0.6 : 1) + ed.intensity * 6 * dt;
      while (ed.acc >= 1) {
        ed.acc -= 1;
        const i = flowFree.pop();
        if (i === undefined) { ed.acc = 0; break; }
        flowSlot[i] = ed.slot;
        flowT[i] = 0;
        flowO1[i] = (Math.random() - 0.5) * 2;
        flowO2[i] = (Math.random() - 0.5) * 2;
        flow.size[i] = 0.07 + Math.random() * 0.07 + ed.intensity * 0.05;
      }
    }
    if (o.particles === 0) return;
    for (let i = 0; i < o.particles; i++) {
      const s = flowSlot[i]!;
      if (s === -1) continue;
      const ed = slots[s];
      if (!ed) { killFlow(i); continue; }
      if (ed.dead) { flow.alpha[i] = flow.alpha[i]! * 0.85; if (flow.alpha[i]! < 0.02) killFlow(i); continue; }
      if (!ed.frozen) {
        const traverse = ed.ring ? 2.8 - ed.intensity * 1.6 : (1.7 - ed.intensity * 1.25) * Math.max(0.6, ed.len / 6);
        flowT[i] = flowT[i]! + dt / Math.max(0.25, traverse);
      }
      const tt = flowT[i]!;
      if (tt >= 1) { killFlow(i); continue; }
      const env = Math.sin(Math.PI * tt);
      if (ed.ring) {
        const a = tt * Math.PI * 2 + flowO1[i]! * Math.PI;
        const r = 1.55 + flowO2[i]! * 0.18;
        flow.pos[i * 3] = ed.p0.x + Math.cos(a) * r;
        flow.pos[i * 3 + 1] = ed.p0.y + 0.1 + Math.sin(a * 2 + flowO2[i]!) * 0.14;
        flow.pos[i * 3 + 2] = ed.p0.z + Math.sin(a) * r;
      } else {
        bez(ed, tt, tmpA);
        const w = 0.13 * env;
        flow.pos[i * 3] = tmpA.x + (ed.n1.x * flowO1[i]! + ed.n2.x * flowO2[i]!) * w;
        flow.pos[i * 3 + 1] = tmpA.y + (ed.n1.y * flowO1[i]! + ed.n2.y * flowO2[i]!) * w;
        flow.pos[i * 3 + 2] = tmpA.z + (ed.n1.z * flowO1[i]! + ed.n2.z * flowO2[i]!) * w;
      }
      flowColor.copy(ed.frozen ? ICE : ed.color).lerp(WHITE, 0.15 + 0.35 * ed.intensity * env);
      if (theme.light) flowColor.multiplyScalar(0.75);
      flow.col[i * 3] = flowColor.r; flow.col[i * 3 + 1] = flowColor.g; flow.col[i * 3 + 2] = flowColor.b;
      flow.alpha[i] = (ed.frozen ? 0.45 : 0.55 + 0.45 * ed.intensity) * env;
    }
    for (const a of flow.attrs) a.needsUpdate = true;
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
    for (const m of [flow.mat, fx.mat]) {
      if (!m) continue;
      m.uniforms.uScale!.value = scale;
      m.uniforms.uOrtho!.value = isOrtho ? 1 : 0;
    }
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
    canvas.style.cursor = hit?.kind === "node" ? "pointer" : "";
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
  const onUp = (e: PointerEvent): void => {
    if (!down) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    const quick = performance.now() - down.at < 650;
    down = null;
    if (moved < 6 && quick && e.button === 0) pickCb?.(hitAt(e.clientX, e.clientY), e.clientX, e.clientY);
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
    if (auto && !interacting && nodes.size) { driveCamera(t, dt); busyCam = !rig.settled; }
    controls.update();
    busyNodes = false;
    for (const n of nodes.values()) {
      updateNode(n, t, dt);
      if (n.status === "active" || t < n.fx.failUntil) busyNodes = true;
    }
    updateFlow(dt);
    const fxLive = updateFx(dt);
    const boltLive = updateBolts(t);
    const burstLive = updateBursts(t);
    if (fxLive || boltLive || burstLive) effectsUntil = Math.max(effectsUntil, t + 50);
    pointScale();
    hoverNow();
    // No bloom in 2D: the flat map is pixel art on tiles and renders plain.
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
      fit();
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
    onLost(cb) { lostCb = cb; },
    destroy() {
      stopped = true;
      park();
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

function hexA(hex: string, a: number): string {
  const n = parseInt(hex.replace("#", ""), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
