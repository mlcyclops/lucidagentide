// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/viz_scene.ts - P-VIZ.1 (ADR-0622): the Visualize view's three.js scene.
//
// Every node is a small procedural bot (head, visor, eyes, ears or antenna per persona; no binary assets)
// standing in front of a liquid-glass frame: a rounded transparent slab with a thin bright rim cage that
// catches the room environment's reflections as the camera orbits, plus a tiny role and task caption.
// Agents get a tall rounded frame, subagents a small round one, the hub a large frame with a halo.
//
// Tokens are GPU points (one ShaderMaterial, additive) flowing along each active edge from the producer to
// its parent; count and speed follow the node's est. tok/s. A surge throws a jagged regenerated lightning
// bolt along the edge and a plasma burst (an expanding shader billboard plus a spark spray). Power-downs are
// distinct: tool-failed flickers red, sheds sparks and shakes, then recovers; paused freezes the flow under
// a frosty blue tint with a slow breathing glow; ended dims gracefully with rising green embers and frosts
// the glass; killed implodes in a white flash, cracks the glass and leaves it dark gray.
//
// Resource contract (the orbit canvas's, ADR-0522): a DPR-capped canvas sized by a ResizeObserver, a frame
// loop capped by the perf tier (viz_model.vizTierOpts / frameInterval) that drops to an idle cadence when
// nothing flows and parks entirely when hidden or under reduced motion with nothing changing. destroy()
// disposes every geometry, material, texture, render target, the controls and the WebGL context.

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
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
  /** Re-frame the camera on every node (after a layout switch, or on demand). */
  fit(): void;
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
const SEG = 32; // points per edge curve
const BOLT_PTS = 33;
const BRANCH_PTS = 9;
const BOLT_POOL = 8;
const BURST_POOL = 8;
const BOLT_MS = 380;
const BURST_MS = 650;
const FLOW_SPAWN_MAX = 420; // particles per second on a full-intensity edge at the full budget

interface NodeFx { flickerUntil: number; shakeUntil: number; shakeAmp: number; implodeAt: number; colorUntil: number }

interface NodeObj {
  id: string; kind: VizKind; persona: Persona; size: number;
  root: THREE.Group; pivot: THREE.Group; bot: THREE.Group;
  cage: THREE.Mesh; cageMat: THREE.MeshPhysicalMaterial; rimMat: THREE.LineBasicMaterial;
  cageW: number; cageH: number; cageZ: number; round: boolean;
  label: THREE.Sprite; labelMat: THREE.SpriteMaterial; labelText: string;
  shells: THREE.MeshStandardMaterial[]; shellBase: THREE.Color[];
  eyes: THREE.MeshBasicMaterial; eyeBase: THREE.Color;
  scanner: THREE.Object3D | null;
  cracks: THREE.LineSegments | null;
  status: VizStatus; glow: number;
  cur: THREE.Vector3; target: THREE.Vector3; placed: boolean;
  phase: number; yaw: number;
  look: { tint: number; dim: number; frost: number };
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
export function mountVizScene(host: HTMLElement, tier: VizTierOpts, theme: VizTheme, initialView: VizViewMode): VizSceneHandle {
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
  const persp = new THREE.PerspectiveCamera(45, 1, 0.1, 400);
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
    bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.38, 0.45, 0.86); // glow on particles and arcs, bots stay readable
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
  let pointer: { x: number; y: number; dirty: boolean } | null = null;
  let lastHitKey = "";

  function makeControls(): OrbitControls {
    const c = new OrbitControls(camera, canvas);
    c.enableDamping = o.motion;
    c.dampingFactor = 0.08;
    if (mode === "3d") {
      c.enableRotate = true;
      c.minDistance = 3;
      c.maxDistance = 80;
      c.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
      c.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    } else {
      c.enableRotate = false;
      c.screenSpacePanning = true;
      c.minZoom = 0.2;
      c.maxZoom = 8;
      c.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
      c.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN };
    }
    c.zoomToCursor = true;
    c.addEventListener("change", kick);
    c.addEventListener("start", () => { interacting = true; userMoved = true; kick(); });
    c.addEventListener("end", () => { interacting = false; kick(); });
    return c;
  }

  // ------------------------------------------------------------------ nodes
  function buildNode(n: SceneNode): NodeObj {
    const look = PERSONAS[n.persona];
    const size = KIND_SCALE[n.kind];
    const base = new THREE.Color(look.color);
    const sub = n.kind === "subagent";
    const shellColor = base.clone().lerp(WHITE, sub ? 0.55 : 0.28);
    const bodyColor = sub ? base.clone().lerp(WHITE, 0.3) : base.clone();
    const root = new THREE.Group();
    const pivot = new THREE.Group();
    const bot = new THREE.Group();
    root.add(pivot);
    pivot.add(bot);
    root.scale.setScalar(size);

    const shellMat = new THREE.MeshStandardMaterial({ color: shellColor, metalness: 0.25, roughness: 0.28, envMapIntensity: 1.1 });
    const bodyMat = new THREE.MeshStandardMaterial({ color: bodyColor, metalness: 0.45, roughness: 0.32, envMapIntensity: 1.1 });
    const visorMat = new THREE.MeshPhysicalMaterial({ color: 0x0a0e18, metalness: 0.3, roughness: 0.12, clearcoat: 1, clearcoatRoughness: 0.05, envMapIntensity: 1.4 });
    const eyeBase = base.clone().lerp(WHITE, 0.35);
    const eyes = new THREE.MeshBasicMaterial({ color: eyeBase.clone(), toneMapped: false });

    // body
    const body = new THREE.Mesh(shared("body", () => new RoundedBoxGeometry(0.62, 0.48, 0.42, 3, 0.12)), bodyMat);
    body.position.y = -0.42;
    bot.add(body);
    const chest = new THREE.Mesh(shared("chest", () => new THREE.CircleGeometry(0.06, 20)), eyes);
    chest.position.set(0, -0.38, 0.215);
    bot.add(chest);

    // head
    let front = 0.27;
    let head: THREE.Mesh;
    switch (look.head) {
      case "dome": {
        head = new THREE.Mesh(shared("head-dome", () => new THREE.SphereGeometry(0.38, 28, 18, 0, Math.PI * 2, 0, Math.PI / 2)), shellMat);
        const rim = new THREE.Mesh(shared("head-dome-base", () => new THREE.CylinderGeometry(0.38, 0.36, 0.2, 28)), shellMat);
        rim.position.y = -0.1;
        head.add(rim);
        head.position.y = 0.12;
        front = 0.36;
        break;
      }
      case "box": head = new THREE.Mesh(shared("head-box", () => new RoundedBoxGeometry(0.68, 0.5, 0.52, 4, 0.14)), shellMat); head.position.y = 0.16; front = 0.26; break;
      case "capsule": head = new THREE.Mesh(shared("head-capsule", () => new THREE.CapsuleGeometry(0.25, 0.26, 8, 18)), shellMat); head.rotation.z = Math.PI / 2; head.position.y = 0.16; front = 0.25; break;
      case "hex": head = new THREE.Mesh(shared("head-hex", () => new THREE.CylinderGeometry(0.37, 0.37, 0.5, 6)), shellMat); head.rotation.x = Math.PI / 2; head.position.y = 0.16; front = 0.25; break;
      default: head = new THREE.Mesh(shared("head-round", () => new THREE.SphereGeometry(0.35, 30, 22)), shellMat); head.position.y = 0.16; front = 0.3; break;
    }
    bot.add(head);
    const vy = head.position.y + 0.02;
    const vz = front + 0.012;

    // visor + eyes
    let scanner: THREE.Object3D | null = null;
    const eye = (x: number, y: number, r: number, sx = 1): void => {
      const m = new THREE.Mesh(shared("eye", () => new THREE.SphereGeometry(1, 14, 10)), eyes);
      m.scale.set(r * sx, r, r * 0.5);
      m.position.set(x, y, vz + 0.035);
      bot.add(m);
    };
    switch (look.visor) {
      case "band": {
        const v = new THREE.Mesh(shared("visor-band", () => new RoundedBoxGeometry(0.56, 0.18, 0.06, 2, 0.03)), visorMat);
        v.position.set(0, vy, vz);
        bot.add(v);
        eye(-0.12, vy, 0.042, 1.7); eye(0.12, vy, 0.042, 1.7);
        break;
      }
      case "twin": {
        for (const x of [-0.13, 0.13]) {
          const v = new THREE.Mesh(shared("visor-twin", () => new THREE.CylinderGeometry(0.1, 0.1, 0.05, 24)), visorMat);
          v.rotation.x = Math.PI / 2;
          v.position.set(x, vy, vz);
          bot.add(v);
          eye(x, vy, 0.055);
        }
        break;
      }
      case "mono": {
        const v = new THREE.Mesh(shared("visor-mono", () => new THREE.CylinderGeometry(0.15, 0.15, 0.05, 28)), visorMat);
        v.rotation.x = Math.PI / 2;
        v.position.set(0, vy, vz);
        bot.add(v);
        const ring = new THREE.Mesh(shared("mono-ring", () => new THREE.TorusGeometry(0.15, 0.018, 8, 32)), bodyMat);
        ring.position.set(0, vy, vz + 0.02);
        bot.add(ring);
        eye(0, vy, 0.07);
        break;
      }
      default: { // grille: a dark band with slats and a scanning light bar
        const v = new THREE.Mesh(shared("visor-band", () => new RoundedBoxGeometry(0.56, 0.18, 0.06, 2, 0.03)), visorMat);
        v.position.set(0, vy, vz);
        bot.add(v);
        for (const dy of [-0.05, 0, 0.05]) {
          const slat = new THREE.Mesh(shared("slat", () => new THREE.BoxGeometry(0.5, 0.012, 0.012)), bodyMat);
          slat.position.set(0, vy + dy, vz + 0.035);
          bot.add(slat);
        }
        const bar = new THREE.Mesh(shared("scan", () => new THREE.BoxGeometry(0.07, 0.15, 0.02)), eyes);
        bar.position.set(0, vy, vz + 0.04);
        bot.add(bar);
        scanner = bar;
        break;
      }
    }

    // ears, antenna, halo
    const top = head.position.y + (look.head === "dome" ? 0.38 : 0.27);
    const antenna = (x: number, tilt: number): void => {
      const stalk = new THREE.Mesh(shared("stalk", () => new THREE.CylinderGeometry(0.014, 0.018, 0.26, 8)), bodyMat);
      stalk.position.set(x + Math.sin(tilt) * 0.13, top + Math.cos(tilt) * 0.13, 0);
      stalk.rotation.z = -tilt;
      bot.add(stalk);
      const tip = new THREE.Mesh(shared("tip", () => new THREE.SphereGeometry(0.048, 14, 10)), eyes);
      tip.position.set(x + Math.sin(tilt) * 0.27, top + Math.cos(tilt) * 0.27, 0);
      bot.add(tip);
    };
    switch (look.ears) {
      case "halo": {
        const halo = new THREE.Mesh(shared("halo", () => new THREE.TorusGeometry(0.3, 0.024, 10, 48)), eyes);
        halo.rotation.x = Math.PI / 2;
        halo.position.y = top + 0.16;
        bot.add(halo);
        break;
      }
      case "antenna": antenna(0, 0); break;
      case "twin": antenna(-0.16, -0.32); antenna(0.16, 0.32); break;
      case "dish": {
        for (const s of [-1, 1]) {
          const dish = new THREE.Mesh(shared("dish", () => new THREE.ConeGeometry(0.13, 0.1, 22, 1, true)), bodyMat);
          dish.rotation.z = s * Math.PI / 2;
          dish.position.set(s * 0.42, head.position.y, 0);
          bot.add(dish);
          const nub = new THREE.Mesh(shared("tip", () => new THREE.SphereGeometry(0.048, 14, 10)), eyes);
          nub.position.set(s * 0.47, head.position.y, 0);
          bot.add(nub);
        }
        break;
      }
      case "horns": {
        for (const s of [-1, 1]) {
          const horn = new THREE.Mesh(shared("horn", () => new THREE.ConeGeometry(0.06, 0.24, 12)), bodyMat);
          horn.position.set(s * 0.22, top + 0.08, 0);
          horn.rotation.z = -s * 0.45;
          bot.add(horn);
        }
        break;
      }
      default: { // fins
        for (const s of [-1, 1]) {
          const fin = new THREE.Mesh(shared("fin", () => new RoundedBoxGeometry(0.05, 0.3, 0.24, 2, 0.02)), bodyMat);
          fin.position.set(s * 0.4, head.position.y + 0.04, -0.02);
          fin.rotation.z = s * 0.18;
          bot.add(fin);
        }
        break;
      }
    }

    // the liquid-glass frame behind: rounded slab + a thin bright rim cage (front and back rims, corner posts)
    const round = n.kind === "subagent";
    const cageW = n.kind === "hub" ? 2.1 : round ? 1.8 : 1.6;
    const cageH = n.kind === "hub" ? 2.5 : round ? 1.8 : 1.95;
    const depth = 0.14;
    const cageZ = -0.55;
    const tint = base.clone().lerp(WHITE, 0.82);
    const cageMat = new THREE.MeshPhysicalMaterial(o.transmission
      ? { color: tint, metalness: 0, roughness: 0.08, transmission: 1, thickness: 0.4, ior: 1.4, clearcoat: 1, clearcoatRoughness: 0.04, iridescence: 0.3, iridescenceIOR: 1.3, envMapIntensity: 1.4, specularIntensity: 1, transparent: true, depthWrite: false }
      : { color: tint, metalness: 0.1, roughness: 0.07, clearcoat: 1, clearcoatRoughness: 0.05, iridescence: 0.2, envMapIntensity: 1.8, transparent: true, opacity: 0.24, depthWrite: false });
    const slabGeo = round
      ? shared("cage-disc", () => new THREE.CylinderGeometry(0.9, 0.9, depth, 56).rotateX(Math.PI / 2))
      : shared(`cage-${cageW}x${cageH}`, () => new RoundedBoxGeometry(cageW, cageH, depth, 5, 0.24));
    const cage = new THREE.Mesh(slabGeo, cageMat);
    cage.position.set(0, -0.08, cageZ);
    cage.userData.nodeId = n.id;
    cage.renderOrder = 1;
    pivot.add(cage);
    hitMeshes.push(cage);
    const rimMat = new THREE.LineBasicMaterial({ color: base.clone().lerp(WHITE, 0.5), transparent: true, opacity: 0.9, toneMapped: false, depthWrite: false });
    const outline = round ? circlePts(0.9, 64) : roundRectPts(cageW, cageH, 0.24);
    const rimGeo = shared(round ? "rim-disc" : `rim-${cageW}x${cageH}`, () => new THREE.BufferGeometry().setFromPoints(outline.map((p) => new THREE.Vector3(p.x, p.y, 0))));
    for (const z of [depth / 2 + 0.004, -depth / 2 - 0.004]) {
      const rim = new THREE.LineLoop(rimGeo, rimMat);
      rim.position.set(0, -0.08, cageZ + z);
      pivot.add(rim);
    }
    const posts = shared(round ? "posts-disc" : `posts-${cageW}x${cageH}`, () => {
      const pts: THREE.Vector3[] = [];
      const corners = round
        ? [0, 1, 2, 3, 4, 5].map((k) => new THREE.Vector2(Math.cos((k / 6) * Math.PI * 2) * 0.9, Math.sin((k / 6) * Math.PI * 2) * 0.9))
        : [new THREE.Vector2(-cageW / 2 + 0.07, -cageH / 2 + 0.07), new THREE.Vector2(cageW / 2 - 0.07, -cageH / 2 + 0.07), new THREE.Vector2(cageW / 2 - 0.07, cageH / 2 - 0.07), new THREE.Vector2(-cageW / 2 + 0.07, cageH / 2 - 0.07)];
      for (const c of corners) { pts.push(new THREE.Vector3(c.x, c.y, depth / 2 + 0.004), new THREE.Vector3(c.x, c.y, -depth / 2 - 0.004)); }
      return new THREE.BufferGeometry().setFromPoints(pts);
    });
    const postLines = new THREE.LineSegments(posts, rimMat);
    postLines.position.set(0, -0.08, cageZ);
    pivot.add(postLines);

    // the tiny caption: role and task, a crisp canvas sprite at the frame's foot
    const labelMat = new THREE.SpriteMaterial({ transparent: true, depthWrite: false, toneMapped: false });
    const label = new THREE.Sprite(labelMat);
    label.renderOrder = 10;
    label.position.set(0, -cageH / 2 - 0.08 - 0.22, cageZ + 0.2);
    pivot.add(label);

    world.add(root);
    const obj: NodeObj = {
      id: n.id, kind: n.kind, persona: n.persona, size,
      root, pivot, bot, cage, cageMat, rimMat, cageW, cageH, cageZ, round, label, labelMat, labelText: "",
      shells: [shellMat, bodyMat], shellBase: [shellColor, bodyColor], eyes, eyeBase, scanner, cracks: null,
      status: n.status, glow: n.glow,
      cur: new THREE.Vector3(...n.pos), target: new THREE.Vector3(...n.pos), placed: false,
      phase: Math.random() * Math.PI * 2, yaw: 0,
      look: { tint: 0, dim: 0, frost: 0 },
      fx: { flickerUntil: 0, shakeUntil: 0, shakeAmp: 0, implodeAt: 0, colorUntil: 0 },
    };
    paintLabel(obj, n.label);
    return obj;
  }

  function paintLabel(obj: NodeObj, text: string): void {
    const role = PERSONAS[obj.persona].label.toUpperCase();
    const key = `${role}|${text}`;
    if (obj.labelText === key) return;
    obj.labelText = key;
    const scale = 2;
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
    c2.fillStyle = theme.light ? "rgba(255,255,255,0.78)" : "rgba(10,12,20,0.62)";
    roundRect(c2, 0, 0, w, h, h / 2);
    c2.fill();
    c2.strokeStyle = PERSONAS[obj.persona].color;
    c2.globalAlpha = 0.6; c2.lineWidth = 2 * scale;
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
    const worldH = 0.26;
    obj.label.scale.set((w / h) * worldH, worldH, 1);
  }

  function disposeNode(obj: NodeObj): void {
    world.remove(obj.root);
    const i = hitMeshes.indexOf(obj.cage);
    if (i >= 0) hitMeshes.splice(i, 1);
    const mats = new Set<THREE.Material>();
    obj.root.traverse((x) => {
      const m = (x as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(m)) m.forEach((mm) => mats.add(mm)); else if (m) mats.add(m);
    });
    for (const m of mats) m.dispose();
    obj.labelMat.map?.dispose();
    obj.cracks?.geometry.dispose();
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
    const len = Math.max(0.001, dir.length());
    ed.len = len;
    dir.divideScalar(len);
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

  function nodeHead(obj: NodeObj, out: THREE.Vector3): THREE.Vector3 {
    return out.copy(obj.cur).setY(obj.cur.y + 0.15 * obj.size);
  }

  const fxAt = new THREE.Vector3(), fxTo = new THREE.Vector3();
  function fireOne(ev: VizEvent): void {
    const obj = nodes.get(ev.node);
    if (!obj) return;
    const now = clock.now;
    const color = new THREE.Color(PERSONAS[obj.persona].color);
    if (ev.kind === "spawn") {
      if (o.motion) { burstAt(nodeHead(obj, fxAt), color.clone().lerp(WHITE, 0.4), 1.6 * obj.size, 500); spawnFx(24, fxAt, color, { speed: 1.4, up: 0.2, spread: 0.2, life: 0.7, size: 0.07, gravity: 0, drag: 2.5 }); }
      effectsUntil = Math.max(effectsUntil, now + 700);
      return;
    }
    if (ev.kind === "surge") {
      if (!o.motion) { obj.fx.colorUntil = now + 600; effectsUntil = Math.max(effectsUntil, now + 700); return; }
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
      burstAt(fxAt, color.clone().lerp(WHITE, 0.25), 2.2 * obj.size);
      spawnFx(40, fxAt, hot, { speed: 3.2, up: 0.3, spread: 0.15, life: 0.6, size: 0.08, gravity: -1.5, drag: 1.6 });
      effectsUntil = Math.max(effectsUntil, now + 900);
      return;
    }
    applyPower(obj, ev.power, now, color);
  }

  function applyPower(obj: NodeObj, kind: PowerKind, now: number, color: THREE.Color): void {
    nodeHead(obj, fxAt);
    effectsUntil = Math.max(effectsUntil, now + (o.motion ? 2600 : 1200));
    switch (kind) {
      case "tool-failed":
        obj.fx.flickerUntil = now + 950;
        if (!o.motion) return;
        obj.fx.shakeUntil = now + 420; obj.fx.shakeAmp = 0.07;
        spawnFx(70, fxAt, SPARK, { speed: 2.6, up: 1.8, spread: 0.2, life: 0.9, size: 0.06, gravity: -7, drag: 0.6 });
        spawnFx(20, fxAt, RED, { speed: 1.6, up: 1, spread: 0.2, life: 0.6, size: 0.09, gravity: -5, drag: 1 });
        return;
      case "paused":
        if (!o.motion) return;
        burstAt(fxAt, ICE, 2.4 * obj.size, 1100);
        spawnFx(30, fxAt, ICE, { speed: 0.5, up: 0.1, spread: 0.9 * obj.size, life: 2.2, size: 0.05, gravity: 0, drag: 0.8 });
        return;
      case "ended":
        if (!o.motion) return;
        spawnFx(50, fxAt.setY(fxAt.y - 0.2 * obj.size), EMBER, { speed: 0.35, up: 0.9, spread: 0.9 * obj.size, life: 2.4, size: 0.055, gravity: 0.25, drag: 0.4 });
        burstAt(fxAt, EMBER.clone().multiplyScalar(0.6), 1.6 * obj.size, 900);
        return;
      case "killed":
        obj.fx.implodeAt = now;
        if (!o.motion) return;
        obj.fx.shakeUntil = now + 300; obj.fx.shakeAmp = 0.12;
        burstAt(fxAt, WHITE.clone().multiplyScalar(2.5), 3.4 * obj.size, 420);
        spawnFx(90, fxAt, WHITE, { speed: 4.2, up: 0.2, spread: 0.1, life: 0.55, size: 0.07, gravity: -2, drag: 2.2 });
        spawnFx(30, fxAt, color, { speed: 2.2, up: 0.4, spread: 0.2, life: 0.9, size: 0.08, gravity: -4, drag: 1 });
        return;
    }
  }

  /** Fracture lines across the glass: a few jagged cracks radiating from an impact point. */
  function crackCage(obj: NodeObj): void {
    if (obj.cracks) return;
    const pts: THREE.Vector3[] = [];
    const hw = obj.cageW / 2 - 0.12, hh = obj.cageH / 2 - 0.12;
    const ox = (Math.random() - 0.5) * hw, oy = (Math.random() - 0.3) * hh;
    const z = 0.075;
    const inside = (x: number, y: number): boolean => obj.round ? Math.hypot(x, y) < 0.82 : Math.abs(x) < hw && Math.abs(y) < hh;
    for (let k = 0; k < 7; k++) {
      let a = (k / 7) * Math.PI * 2 + Math.random() * 0.6;
      let x = ox, y = oy;
      for (let s = 0; s < 6; s++) {
        a += (Math.random() - 0.5) * 0.9;
        const step = 0.12 + Math.random() * 0.16;
        const nx = x + Math.cos(a) * step, ny = y + Math.sin(a) * step;
        if (!inside(nx, ny)) break;
        pts.push(new THREE.Vector3(x, y, z), new THREE.Vector3(nx, ny, z));
        if (s === 2 && Math.random() < 0.6) { // a side branch
          const ba = a + (Math.random() < 0.5 ? -1 : 1) * 0.9;
          const bx = nx + Math.cos(ba) * 0.15, by = ny + Math.sin(ba) * 0.15;
          if (inside(bx, by)) pts.push(new THREE.Vector3(nx, ny, z), new THREE.Vector3(bx, by, z));
        }
        x = nx; y = ny;
      }
    }
    const g = new THREE.BufferGeometry().setFromPoints(pts);
    const m = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, toneMapped: false, depthWrite: false });
    const lines = new THREE.LineSegments(g, m);
    lines.position.set(0, -0.08, obj.cageZ);
    obj.pivot.add(lines);
    obj.cracks = lines;
  }

  function healCage(obj: NodeObj): void {
    if (!obj.cracks) return;
    obj.pivot.remove(obj.cracks);
    obj.cracks.geometry.dispose();
    (obj.cracks.material as THREE.Material).dispose();
    obj.cracks = null;
  }

  // ------------------------------------------------------------------ per-frame update
  const tmpColor = new THREE.Color();
  const tintTarget = new THREE.Color();
  const camPos = new THREE.Vector3();
  const flowColor = new THREE.Color();

  function updateNode(obj: NodeObj, t: number, dt: number): void {
    const k = o.motion ? 1 - Math.exp(-dt * 5) : 1;
    if (!obj.placed) { obj.cur.copy(obj.target); obj.placed = true; } else obj.cur.lerp(obj.target, k);
    obj.root.position.copy(obj.cur);

    // status looks: tint (ice for paused, gray for killed), dim, frost, cracks
    const st = obj.status;
    const want = {
      tint: st === "paused" ? 0.55 : st === "killed" ? 0.85 : 0,
      dim: st === "ended" ? 0.55 : st === "killed" ? 0.3 : 0,
      frost: st === "ended" ? 1 : st === "killed" ? 0.6 : st === "paused" ? 0.35 : 0,
    };
    obj.look.tint += (want.tint - obj.look.tint) * k;
    obj.look.dim += (want.dim - obj.look.dim) * k;
    obj.look.frost += (want.frost - obj.look.frost) * k;
    tintTarget.copy(st === "killed" ? DEAD : ICE);
    const flicker = t < obj.fx.flickerUntil;
    const flickOn = flicker && (Math.floor(t / 70) % 2 === 0 || !o.motion);
    for (let i = 0; i < obj.shells.length; i++) {
      const m = obj.shells[i]!;
      m.color.copy(obj.shellBase[i]!).lerp(tintTarget, obj.look.tint).multiplyScalar(1 - obj.look.dim * 0.6);
      m.emissive.copy(RED).multiplyScalar(flickOn ? 0.55 : 0);
    }

    // eyes: glow with activity; amber pulse when waiting; ice breathing when paused; out when ended/killed
    let level: number;
    tmpColor.copy(obj.eyeBase);
    if (flicker) { tmpColor.copy(RED); level = flickOn ? 2.4 : 0.4; }
    else if (st === "paused") { tmpColor.copy(ICE); level = 0.5 + (o.motion ? 0.45 * Math.sin((t / 3000) * Math.PI * 2) : 0.2); }
    else if (st === "waiting") { tmpColor.copy(AMBER); level = 0.9 + (o.motion ? 0.7 * (0.5 + 0.5 * Math.sin(t / 260)) : 0.3); }
    else if (st === "ended") level = 0.1;
    else if (st === "killed") level = 0;
    else if (st === "idle") level = 0.55;
    else level = 0.9 + 1.8 * obj.glow;
    if (t < obj.fx.colorUntil) { tmpColor.copy(WHITE); level = 2.2; }
    obj.eyes.color.copy(tmpColor).multiplyScalar(level);

    // glass: frosted when ended, dark gray when killed, icy when paused
    const cm = obj.cageMat;
    cm.roughness = 0.07 + obj.look.frost * 0.5;
    if (o.transmission) cm.transmission = 1 - obj.look.frost * 0.5;
    else cm.opacity = 0.24 + obj.look.frost * 0.22;
    cm.color.copy(obj.shellBase[0]!).lerp(WHITE, 0.6).lerp(tintTarget, Math.max(obj.look.tint, st === "ended" ? 0.25 : 0));
    obj.rimMat.opacity = st === "killed" ? 0.18 : st === "ended" ? 0.35 : 0.9;
    obj.rimMat.color.copy(obj.shellBase[1]!).lerp(WHITE, 0.5).lerp(tintTarget, obj.look.tint);
    obj.labelMat.opacity = st === "ended" || st === "killed" ? 0.6 : 1;
    if (st === "killed") crackCage(obj); else healCage(obj);
    if (obj.cracks) {
      const age = (t - obj.fx.implodeAt) / 1000;
      const cmat = obj.cracks.material as THREE.LineBasicMaterial;
      cmat.color.setScalar(Math.max(0.45, 1.6 - age));
    }

    // motion: bob, shake, implode collapse, scanner sweep, facing
    let scale = 1, sag = 0, tilt = 0;
    if (st === "killed") {
      const age = o.motion ? (t - obj.fx.implodeAt) / 1000 : 9;
      scale = age < 0.22 ? 1 - 0.85 * easeIn(age / 0.22) : age < 0.6 ? 0.15 + 0.6 * easeOut((age - 0.22) / 0.38) : 0.75;
      sag = -0.18 * Math.min(1, age / 0.6); tilt = 0.35 * Math.min(1, age / 0.6);
    }
    obj.bot.scale.setScalar(scale);
    obj.bot.rotation.z = tilt;
    const bob = o.motion && st !== "killed" && st !== "ended" && st !== "paused" ? Math.sin(t / 1000 * 1.7 + obj.phase) * 0.055 : 0;
    obj.bot.position.y = bob + sag;
    let sx = 0, sz = 0;
    if (o.motion && t < obj.fx.shakeUntil) {
      const a = obj.fx.shakeAmp * ((obj.fx.shakeUntil - t) / 420);
      sx = (Math.random() - 0.5) * a * 2; sz = (Math.random() - 0.5) * a * 2;
    }
    obj.pivot.position.set(sx, 0, sz);
    if (obj.scanner) obj.scanner.position.x = o.motion && st === "active" ? Math.sin(t / 380 + obj.phase) * 0.2 : 0;
    if (mode === "2d") {
      obj.pivot.rotation.set(-Math.PI / 2, 0, 0);
    } else {
      // Face the camera with a little lag and only most of the way, so the glass turns against the room as you orbit.
      camera.getWorldPosition(camPos);
      const full = Math.atan2(camPos.x - obj.cur.x, camPos.z - obj.cur.z);
      let d = full * 0.82 - obj.yaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      obj.yaw += d * (o.motion ? 1 - Math.exp(-dt * 4) : 1);
      obj.pivot.rotation.set(0, obj.yaw, 0);
    }
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
  function fit(): void {
    let r = 3;
    for (const n of nodes.values()) r = Math.max(r, Math.hypot(n.target.x, n.target.y, n.target.z) + 1.6 * n.size);
    if (mode === "3d") {
      const dist = (r / Math.sin((persp.fov * Math.PI) / 360)) * 0.78; // the bounding sphere is loose; frame the bots, not empty space
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
    userMoved = false;
    kick();
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

  // ------------------------------------------------------------------ hover + pick
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
  const onMove = (e: PointerEvent): void => {
    pointer = { x: e.clientX, y: e.clientY, dirty: true };
    if (!raf) hoverNow();
  };
  const onLeave = (): void => { pointer = null; lastHitKey = ""; canvas.style.cursor = ""; hoverCb?.(null, 0, 0); };
  let down: { x: number; y: number; at: number } | null = null;
  const onDown = (e: PointerEvent): void => { down = { x: e.clientX, y: e.clientY, at: performance.now() }; };
  const onUp = (e: PointerEvent): void => {
    if (!down) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    const quick = performance.now() - down.at < 650;
    down = null;
    if (moved < 6 && quick && e.button === 0) pickCb?.(hitAt(e.clientX, e.clientY), e.clientX, e.clientY);
  };
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerleave", onLeave);
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointerup", onUp);
  const onLostCtx = (e: Event): void => { e.preventDefault(); park(); lostCb?.(); };
  canvas.addEventListener("webglcontextlost", onLostCtx);

  // ------------------------------------------------------------------ the loop
  function render(t: number): void {
    const dt = Math.min(0.1, last ? (t - last) / 1000 : 0.016);
    last = t;
    clock.now = t;
    if (needFit && nodes.size) fit();
    controls.update();
    for (const n of nodes.values()) updateNode(n, t, dt);
    updateFlow(dt);
    const fxLive = updateFx(dt);
    const boltLive = updateBolts(t);
    const burstLive = updateBursts(t);
    if (fxLive || boltLive || burstLive) effectsUntil = Math.max(effectsUntil, t + 50);
    pointScale();
    hoverNow();
    // No bloom in 2D: looking straight down, every glass frame faces the camera and mirrors the bright room, and
    // bloom turns those into white blocks. The flat map renders plain.
    if (composer && renderPass && mode === "3d") { renderPass.camera = camera; composer.render(dt); }
    else renderer.render(scene, camera);
  }

  /** One loop chain only: a kick() from inside a frame (controls damping, a fit) sets `wanted` and the frame
   *  continues, instead of starting a second chain. */
  function frame(t: number): void {
    raf = 0;
    if (stopped || !visible) return;
    const busy = busyFlow || t < effectsUntil || interacting;
    let interval = frameInterval(o, busy, recording);
    if (interval === null && (t < effectsUntil || interacting)) interval = 1000 / IDLE_FPS; // color transitions only
    if (interval !== null && t - lastFrame < interval - 1.5) { raf = requestAnimationFrame(frame); return; }
    lastFrame = t;
    inFrame = true; wanted = false;
    try { render(t); } finally { inFrame = false; }
    const after = busyFlow || t < effectsUntil || interacting;
    if (stopped || !visible) return;
    if (wanted || frameInterval(o, after, recording) !== null || t < effectsUntil || interacting) raf = requestAnimationFrame(frame);
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
        if (!obj) { obj = buildNode(n); nodes.set(n.id, obj); if (!userMoved) needFit = true; } // keep everyone in frame until the user takes the camera
        obj.target.set(n.pos[0], n.pos[1], n.pos[2]);
        if (obj.status !== n.status && n.status !== "killed") obj.fx.implodeAt = obj.status === "killed" ? 0 : obj.fx.implodeAt;
        if (obj.status === "killed" && n.status !== "killed") obj.bot.rotation.z = 0;
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
        ed.color.set(PERSONAS[nodes.get(e.from)!.persona].color);
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
      kick();
    },
    fire(events) {
      clock.now = performance.now(); // the loop may have been parked: effects start now, on the rAF timeline
      for (const ev of events) fireOne(ev);
      if (events.length) kick();
    },
    setView(next) {
      if (next === mode) return;
      mode = next;
      camera = mode === "3d" ? persp : ortho;
      controls.dispose();
      controls = makeControls();
      fit();
    },
    fit,
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

function roundRectPts(w: number, h: number, r: number): THREE.Vector2[] {
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
  return s.getPoints(6);
}

function circlePts(r: number, n: number): THREE.Vector2[] {
  const out: THREE.Vector2[] = [];
  for (let i = 0; i < n; i++) out.push(new THREE.Vector2(Math.cos((i / n) * Math.PI * 2) * r, Math.sin((i / n) * Math.PI * 2) * r));
  return out;
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
