// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/viz_throw.ts - P-VIZ.6 (ADR-0636): things to throw at the agents and subagents in Visualize,
// and Storm.
//
// Two halves:
//   - createThrowFx (three.js, owned by viz_scene): the projectiles and their impacts, and Storm's VFX and its
//     staggered hits. Professional: a crumpled paper ball that tumbles and bounces off, a rubber band that snaps
//     and spins and flicks away, an energy drink can that tumbles in and is caught. Anime: a stream of three
//     spinning metal throwing stars that spark on the block, a lightning bolt that strikes from above with a
//     flash, a glowing energy ball with swirling rings that is absorbed. Each arrival calls the scene's sink,
//     which calls the figure's hit(); the figure plays the reaction. Storm (anime): the sky darkens, lightning
//     strikes walk across the team with sky flashes; (professional): a gust of papers sweeps across the office.
//     Every figure is hit("storm") as the front reaches it (viz_throw_math.stormSchedule).
//     Procedural geometry only, built lazily per kind and shared; projectiles are pooled (a hidden mesh is
//     reused, never rebuilt) and capped (THROW_CAP); the frame loop reuses scratch vectors and allocates
//     nothing. Sparks, flashes and bolts go through the scene's own pools (the sink), so the perf tier's
//     particle budget covers them too. Lower tiers get fewer sparks, strikes and papers; reduced motion never
//     reaches this module's flights (the scene applies the hit at once, viz_scene.throwAt).
//   - mountThrowTray (DOM, owned by viz_view): the small tray at the bottom center of the stage with the style's
//     three throwables and Storm. Click one to arm it (pressed; the cursor becomes it), then click an agent or
//     subagent to throw; it stays armed for more throws; Esc or a second click puts it down; a style switch puts
//     it down. A throwable can also be dragged from the tray and released over a node. Throwing is pointer
//     only (the nodes take no keyboard focus); the tray buttons are focusable and say so. Storm is a plain
//     button, rate limited (STORM_COOLDOWN_MS).

import * as THREE from "three";
import { esc } from "./format.ts";
import type { PerfTier } from "./perf_tier.ts";
import { tipValue } from "./tip_text.ts";
import { isBuiltinStyle, type BuiltinStyle, type VizStyle } from "./viz_model.ts";
import type { SceneHit, VizSceneHandle } from "./viz_scene.ts";
import { isThrowKind, STORM_TIP, throwsFor, type ThrowKind } from "./viz_throw_kinds.ts";
import type { WorldDefinition, WorldProjectile } from "./viz_world_api.ts";
import {
  arcApex, arcPoint, armState, armStep, createRateLimit, DRAG_PX, flightMs, rateLeft, rateTake, STORM_COOLDOWN_MS, stormFx, strikeTargets,
  THROW_CAP, type ArmAction, type ArmState, type StormHit,
} from "./viz_throw_math.ts";

// ------------------------------------------------------------------------------------------ the scene side

/** The scene's spark spray parameters (viz_scene.spawnFx). */
export interface SparkOpts { speed: number; up: number; spread: number; life: number; size: number; gravity: number; drag: number }

/** What the scene lends the throws: where a node is, the figure's hit, and its own effect pools. */
export interface ThrowSink {
  /** The node's impact point now (it may be moving), or false once the node is gone. */
  target(id: string, out: THREE.Vector3): boolean;
  /** Something reached the node's figure from `from` (world): the scene calls fig.hit. A built-in HitKind, or
   *  (P-WORLDS.1) one of the world's own kinds. */
  arrive(id: string, kind: string, from: THREE.Vector3): void;
  sparks(count: number, at: THREE.Vector3, color: THREE.Color, p: SparkOpts): void;
  burst(at: THREE.Vector3, color: THREE.Color, scale: number, ms: number): void;
  bolt(from: THREE.Vector3, to: THREE.Vector3, color: THREE.Color): void;
}

export interface ThrowFxOpts { detail: PerfTier; motion: boolean; light: boolean }

export interface ThrowFx {
  /** Launch one projectile at node `id` from `from` (world), `delay` ms after `now`. False when THROW_CAP
   *  projectiles are already out. */
  launch(id: string, kind: ThrowKind, from: THREE.Vector3, delay: number, now: number): boolean;
  /** P-WORLDS.1 (ADR-0648): fly a world's projectile (WorldDefinition.createProjectile) at node `id` on the same
   *  arc; on arrival it is removed and disposed and the figure is hit with `kind`. False when THROW_CAP
   *  projectiles are already out (the caller disposes `proj` then). */
  launchWorld(id: string, kind: string, proj: WorldProjectile, from: THREE.Vector3, delay: number, now: number): boolean;
  /** Storm's VFX and its staggered hits (`hits` from stormSchedule, swept along `dir`, a unit vector in the
   *  ground plane, across a scene of `radius` around `center`). Returns the time (ms, the `now` clock) it ends.
   *  A world style gets only the staggered hits, from the sky like the anime storm (the world draws its own). */
  storm(style: VizStyle, hits: readonly StormHit[], dir: THREE.Vector3, center: THREE.Vector3, radius: number, now: number): number;
  setFlat(on: boolean): void;
  /** One frame; true while anything is in flight or playing. */
  update(t: number, dt: number): boolean;
  dispose(): void;
}

/** Where a bolt or a storm strike comes from: high above the node in 3D; on the flat map, from the top of the
 *  screen (-Z is screen up) and above the figures, so the strike reads as one. */
export function skyAbove(at: THREE.Vector3, flat: boolean, out: THREE.Vector3): THREE.Vector3 {
  return flat ? out.set(at.x + 0.35, at.y + 1.2, at.z - 2.6) : out.set(at.x + 0.5, at.y + 5.5, at.z + 0.25);
}

const PAPER = new THREE.Color("#f4f1ea");
const LIME = new THREE.Color("#8dff6a");
const STEEL_SPARK = new THREE.Color("#ffd27a");
const BOLT_C = new THREE.Color("#bfe6ff").multiplyScalar(2.2);
const ORB_C = new THREE.Color("#8fe3ff");
const FLASH = new THREE.Color("#ffffff").multiplyScalar(2);

const SKY_VS = /* glsl */ `void main() { gl_Position = vec4(position.xy, 0.9999, 1.0); }`;
const SKY_FS = /* glsl */ `
uniform float uDark;
uniform float uFlash;
void main() {
  vec3 c = mix(vec3(0.02, 0.03, 0.08), vec3(0.78, 0.86, 1.0), uFlash);
  gl_FragColor = vec4(c, max(uDark, uFlash * 0.55));
}`;

/** The storm's sky: dark ramp in, then held until the last hit, then this long to clear. */
const SKY_IN_MS = 250, SKY_OUT_MS = 650, SKY_FLASH_MS = 130;
/** The professional gust lasts this long. */
const GUST_MS = 2800;

interface Proj {
  kind: ThrowKind; obj: THREE.Object3D | null; ringA: THREE.Object3D | null; ringB: THREE.Object3D | null;
  id: string; active: boolean; phase: 0 | 1 | 2;
  start: number; dur: number; apex: number; from: THREE.Vector3; to: THREE.Vector3;
  axis: THREE.Vector3; spin: number; after: number; afterDur: number; vel: THREE.Vector3;
}

/** `sky`: the hit comes from the sky above the node (the anime storm, and a world's); else upwind (the gust). */
interface Pending { id: string; at: number; strike: boolean; sky: boolean }

/** P-WORLDS.1: a world's projectile in flight (pending until `start`). */
interface WorldFlight { id: string; kind: string; proj: WorldProjectile; start: number; dur: number; apex: number; from: THREE.Vector3; to: THREE.Vector3; shown: boolean }

export function createThrowFx(scene: THREE.Scene, sink: ThrowSink, o: ThrowFxOpts): ThrowFx {
  const geos = new Map<string, THREE.BufferGeometry>();
  const mats = new Map<string, THREE.Material>();
  const g = (key: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry => {
    let x = geos.get(key);
    if (!x) { x = make(); geos.set(key, x); }
    return x;
  };
  const m = (key: string, make: () => THREE.Material): THREE.Material => {
    let x = mats.get(key);
    if (!x) { x = make(); mats.set(key, x); }
    return x;
  };
  const sparkK = o.detail === "minimal" ? 0.25 : o.detail === "reduced" ? 0.5 : 1; // full, ultra, cinematic
  const glowBlend = o.light ? THREE.NormalBlending : THREE.AdditiveBlending;
  const projs: Proj[] = [];
  let active = 0;
  let flat = false;
  const pending: Pending[] = [];
  const flights: WorldFlight[] = [];
  const stormDir = new THREE.Vector3(1, 0, 0);
  const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3();
  const Z = new THREE.Vector3(0, 0, 1);

  // ------------------------------------------------ projectiles
  function makeObj(p: Proj): void {
    const mesh = (geo: THREE.BufferGeometry, mat: THREE.Material): THREE.Mesh => { const x = new THREE.Mesh(geo, mat); x.renderOrder = 8; return x; };
    let obj: THREE.Object3D | null = null; // the bolt has none: the scene's own lightning draws it
    switch (p.kind) {
      case "paper":
        obj = mesh(g("paper", crumpled), m("paper", () => new THREE.MeshStandardMaterial({ color: PAPER, roughness: 0.92, flatShading: true })));
        break;
      case "band":
        obj = mesh(g("band", () => new THREE.TorusGeometry(0.065, 0.008, 6, 24)), m("band", () => new THREE.MeshStandardMaterial({ color: 0xd2603a, roughness: 0.75 })));
        break;
      case "drink": {
        const can = new THREE.Group();
        can.add(mesh(g("can", () => new THREE.CylinderGeometry(0.034, 0.034, 0.115, 14)), m("can", () => new THREE.MeshStandardMaterial({ color: 0x2fbf71, metalness: 0.6, roughness: 0.35 }))));
        const top = mesh(g("can-top", () => new THREE.CylinderGeometry(0.029, 0.034, 0.014, 14)), m("can-top", () => new THREE.MeshStandardMaterial({ color: 0xd7dde3, metalness: 0.9, roughness: 0.25 })));
        top.position.y = 0.0645;
        can.add(top);
        obj = can;
        break;
      }
      case "stars":
        obj = mesh(g("star", shuriken), m("star", () => new THREE.MeshStandardMaterial({ color: 0xc9d1d9, metalness: 0.92, roughness: 0.28, side: THREE.DoubleSide })));
        break;
      case "orb": {
        const orb = new THREE.Group();
        orb.add(mesh(g("orb", () => new THREE.SphereGeometry(0.085, 16, 12)), m("orb", () => new THREE.MeshBasicMaterial({ color: ORB_C.clone().multiplyScalar(1.6), toneMapped: false }))));
        const ringMat = m("orb-ring", () => new THREE.MeshBasicMaterial({ color: new THREE.Color("#c79bff").multiplyScalar(1.4), transparent: true, opacity: 0.85, blending: glowBlend, depthWrite: false, toneMapped: false }));
        const ringGeo = g("orb-ring", () => new THREE.TorusGeometry(0.125, 0.006, 4, 40));
        const ringA = mesh(ringGeo, ringMat), ringB = mesh(ringGeo, ringMat);
        ringB.rotation.x = Math.PI / 2;
        orb.add(ringA, ringB);
        p.ringA = ringA; p.ringB = ringB;
        obj = orb;
        break;
      }
      case "bolt":
        break;
    }
    if (!obj) return;
    obj.visible = false;
    scene.add(obj);
    p.obj = obj;
  }

  function acquire(kind: ThrowKind): Proj | null {
    if (active >= THROW_CAP) return null;
    let p = projs.find((x) => !x.active && x.kind === kind);
    if (!p) {
      p = {
        kind, obj: null, ringA: null, ringB: null, id: "", active: false, phase: 0, start: 0, dur: 0, apex: 0,
        from: new THREE.Vector3(), to: new THREE.Vector3(), axis: new THREE.Vector3(0, 0, 1), spin: 0, after: 0, afterDur: 0, vel: new THREE.Vector3(),
      };
      makeObj(p);
      projs.push(p);
    }
    return p;
  }

  function end(p: Proj): void {
    if (!p.active) return;
    p.active = false;
    active--;
    if (p.obj) p.obj.visible = false;
  }

  function launch(id: string, kind: ThrowKind, from: THREE.Vector3, delay: number, now: number): boolean {
    if (!sink.target(id, tmpA)) return false;
    const p = acquire(kind);
    if (!p) return false;
    p.id = id; p.active = true; p.phase = 0;
    active++;
    p.from.copy(from); p.to.copy(tmpA);
    const dist = from.distanceTo(tmpA);
    p.start = now + delay;
    p.dur = flightMs(kind, dist);
    p.apex = arcApex(kind, dist);
    if (kind === "stars") { p.axis.copy(Z); p.spin = 26; }
    else if (kind === "band") { p.axis.set(Math.random() - 0.5, 1, Math.random() - 0.5).normalize(); p.spin = 14; }
    else if (kind === "orb") { p.axis.set(0, 1, 0); p.spin = 3; }
    else { p.axis.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize(); p.spin = kind === "paper" ? 7 : 9; }
    if (p.obj) {
      p.obj.visible = false;
      p.obj.position.copy(from);
      p.obj.scale.setScalar(flat ? 1.5 : 1);
      if (kind === "stars") p.obj.lookAt(tmpA); // the blade plane faces along the flight, spinning about it
      else p.obj.rotation.set(Math.random() * 6.28, Math.random() * 6.28, 0);
    }
    return true;
  }

  function impact(p: Proj, t: number): void {
    sink.arrive(p.id, p.kind, p.from);
    const at = p.to;
    switch (p.kind) {
      case "paper":
        // bounces off the head: back toward where it came from, up, then falls
        p.vel.subVectors(p.from, at).setY(0);
        if (p.vel.lengthSq() < 1e-6) p.vel.set(1, 0, 0);
        p.vel.normalize().multiplyScalar(1.1).setY(flat ? 0 : 2.1);
        if (flat) p.vel.z -= 0.6;
        sink.sparks(Math.round(4 * sparkK), at, PAPER, { speed: 0.8, up: 0.3, spread: 0.05, life: 0.3, size: 0.04, gravity: -3, drag: 2 });
        break;
      case "band":
        // flicks off sideways, spinning fast
        p.vel.set(Math.random() < 0.5 ? -1.6 : 1.6, flat ? 0 : 1.4, flat ? -0.6 : (Math.random() - 0.5) * 0.8);
        p.spin = 30;
        break;
      case "drink":
        // caught: the figure has it now
        sink.burst(at, LIME, 0.55, 360);
        sink.sparks(Math.round(8 * sparkK), at, LIME, { speed: 0.9, up: 0.6, spread: 0.06, life: 0.45, size: 0.045, gravity: -1, drag: 2 });
        end(p);
        return;
      case "stars":
        // blocked: a spray of sparks, the star drops
        sink.sparks(Math.round(10 * sparkK), at, STEEL_SPARK, { speed: 2.2, up: 0.6, spread: 0.04, life: 0.35, size: 0.05, gravity: -6, drag: 1.5 });
        p.vel.set(0, flat ? 0 : -0.8, flat ? 0.4 : 0);
        p.spin = 8;
        break;
      case "bolt":
        sink.burst(at, FLASH, 1.7, 300);
        sink.sparks(Math.round(18 * sparkK), at, BOLT_C, { speed: 2.6, up: 0.4, spread: 0.1, life: 0.4, size: 0.06, gravity: -2, drag: 1.8 });
        end(p);
        return;
      case "orb":
        // absorbed: a glow, a ring of motes rising, and the ball shrinks into the figure
        sink.burst(at, ORB_C, 1.3, 520);
        sink.sparks(Math.round(14 * sparkK), at, ORB_C, { speed: 0.9, up: 0.8, spread: 0.12, life: 0.7, size: 0.05, gravity: 0.5, drag: 1.4 });
        break;
    }
    p.phase = 2;
    p.after = t;
    p.afterDur = p.kind === "orb" ? 340 : p.kind === "stars" ? 320 : p.kind === "band" ? 460 : 650;
  }

  function updateProj(p: Proj, t: number, dt: number): void {
    if (p.phase === 0) {
      if (t < p.start) return;
      p.phase = 1;
      if (p.obj) p.obj.visible = true;
      if (p.kind === "bolt") { // the strike is drawn at once; the hit lands BOLT_LEAD_MS later
        sink.bolt(p.from, p.to, BOLT_C);
        sink.burst(p.to, FLASH, 2.2, 260);
      }
    }
    if (p.phase === 1) {
      if (!sink.target(p.id, p.to)) { end(p); return; }
      const u = (t - p.start) / p.dur;
      if (u >= 1) { impact(p, t); return; }
      const obj = p.obj;
      if (!obj) return;
      arcPoint(p.from, p.to, p.apex, u, obj.position);
      if (flat) { // the arc's lift shows on the flat map as a bow toward the top of the screen
        const lift = 4 * p.apex * u * (1 - u);
        obj.position.y -= lift * 0.5;
        obj.position.z -= lift * 0.7;
      }
      obj.rotateOnAxis(p.axis, p.spin * dt);
      const s = flat ? 1.5 : 1;
      if (p.kind === "band") { // the snap: stretched long off the finger, ringing back to round
        const e = Math.max(0, 1 - u * 4);
        obj.scale.set(s * (1 + 0.9 * e * Math.cos(u * 70)), s * (1 - 0.3 * e), s);
      } else if (p.kind === "orb") {
        p.ringA!.rotation.z += dt * 7;
        p.ringB!.rotation.y += dt * 5;
        obj.scale.setScalar(s * (1 + 0.08 * Math.sin(t / 60)));
      }
      return;
    }
    const a = (t - p.after) / p.afterDur;
    const obj = p.obj;
    if (a >= 1 || !obj) { end(p); return; }
    const s = flat ? 1.5 : 1;
    if (p.kind === "orb") { // sinks into the figure
      if (sink.target(p.id, p.to)) obj.position.lerp(p.to, 1 - Math.exp(-dt * 14));
      obj.scale.setScalar(s * (1 - a) * (1 - a));
      p.ringA!.rotation.z += dt * 14;
      p.ringB!.rotation.y += dt * 11;
      return;
    }
    if (!flat) p.vel.y -= 9 * dt;
    obj.position.addScaledVector(p.vel, dt);
    obj.rotateOnAxis(p.axis, p.spin * dt);
    if (p.kind === "band") obj.scale.setScalar(s * (1 - 0.5 * a));
    else if (a > 0.7) obj.scale.setScalar(s * (1 - (a - 0.7) / 0.3));
  }

  // ------------------------------------------------ P-WORLDS.1: a world's projectiles (its own objects, our arc)
  function launchWorld(id: string, kind: string, proj: WorldProjectile, from: THREE.Vector3, delay: number, now: number): boolean {
    if (active + flights.length >= THROW_CAP || !sink.target(id, tmpA)) return false;
    const dist = from.distanceTo(tmpA);
    // the built-in lob (a paper ball's arc and pace): a world's throwables are tossed things
    flights.push({ id, kind, proj, start: now + delay, dur: flightMs("paper", dist), apex: arcApex("paper", dist), from: from.clone(), to: tmpA.clone(), shown: false });
    proj.object.visible = false;
    proj.object.position.copy(from);
    if (flat) proj.object.scale.multiplyScalar(1.5);
    scene.add(proj.object);
    return true;
  }

  function endFlight(i: number): void {
    const f = flights[i]!;
    scene.remove(f.proj.object);
    f.proj.dispose();
    flights[i] = flights[flights.length - 1]!;
    flights.pop();
  }

  function updateFlights(t: number, dt: number): boolean {
    for (let i = flights.length - 1; i >= 0; i--) {
      const f = flights[i]!;
      if (t < f.start) continue;
      if (!sink.target(f.id, f.to)) { endFlight(i); continue; }
      const u = (t - f.start) / f.dur;
      if (u >= 1) {
        const kind = f.kind, id = f.id;
        tmpB.copy(f.from);
        endFlight(i);
        sink.arrive(id, kind, tmpB);
        continue;
      }
      const obj = f.proj.object;
      if (!f.shown) { obj.visible = true; f.shown = true; }
      arcPoint(f.from, f.to, f.apex, u, obj.position);
      if (flat) { // the same bow toward the top of the screen as the built-in flights
        const lift = 4 * f.apex * u * (1 - u);
        obj.position.y -= lift * 0.5;
        obj.position.z -= lift * 0.7;
      }
      f.proj.update(u, dt);
    }
    return flights.length > 0;
  }

  // ------------------------------------------------ storm: the sky (anime) and the gust (professional)
  let sky: { mesh: THREE.Mesh; mat: THREE.ShaderMaterial } | null = null;
  let skyStart = 0, skyHold = 0, flashAt = -1e9;
  function ensureSky(): void {
    if (sky) return;
    const mat = new THREE.ShaderMaterial({ uniforms: { uDark: { value: 0 }, uFlash: { value: 0 } }, vertexShader: SKY_VS, fragmentShader: SKY_FS, transparent: true, depthWrite: false, depthTest: true });
    const mesh = new THREE.Mesh(g("sky", () => new THREE.PlaneGeometry(2, 2)), mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = -10; // first of the transparent pass: the glass, edges and effects draw over it
    mesh.visible = false;
    scene.add(mesh);
    sky = { mesh, mat };
  }

  const gustMax = stormFx(o.detail, o.motion).papers;
  let gust: { mesh: THREE.InstancedMesh; seed: Float32Array } | null = null;
  let gustStart = -1e9, gustLen = 0;
  const gustC = new THREE.Vector3(), gustSide = new THREE.Vector3();
  const dummy = new THREE.Object3D();
  function ensureGust(): THREE.InstancedMesh {
    if (gust) return gust.mesh;
    const mesh = new THREE.InstancedMesh(
      g("gust-paper", () => new THREE.PlaneGeometry(0.17, 0.22)),
      m("gust-paper", () => new THREE.MeshStandardMaterial({ color: PAPER, roughness: 0.9, side: THREE.DoubleSide })),
      gustMax,
    );
    mesh.frustumCulled = false;
    mesh.renderOrder = 8;
    mesh.visible = false;
    scene.add(mesh);
    gust = { mesh, seed: new Float32Array(gustMax * 6) };
    return mesh;
  }

  function storm(style: VizStyle, hits: readonly StormHit[], dir: THREE.Vector3, center: THREE.Vector3, radius: number, now: number): number {
    const fx = stormFx(o.detail, o.motion);
    const anime = style === "anime";
    const world = !isBuiltinStyle(style);
    const struck = new Set(anime ? strikeTargets(hits.length, fx.strikes) : []);
    stormDir.copy(dir);
    for (let i = 0; i < hits.length; i++) pending.push({ id: hits[i]!.id, at: now + hits[i]!.at, strike: struck.has(i), sky: anime || world });
    const last = hits.length ? now + hits[hits.length - 1]!.at : now;
    if (world) return last + 300;
    if (anime) {
      ensureSky();
      skyStart = now; skyHold = last + 300;
      sky!.mesh.visible = true;
      return skyHold + SKY_OUT_MS;
    }
    if (fx.papers > 0) {
      const mesh = ensureGust();
      const seed = gust!.seed;
      for (let i = 0; i < fx.papers * 6; i++) seed[i] = Math.random();
      mesh.count = fx.papers;
      mesh.visible = true;
      gustStart = now; gustLen = Math.max(4, radius * 2 + 4);
      gustC.copy(center);
      gustSide.set(-dir.z, 0, dir.x);
    }
    return Math.max(last + 400, now + GUST_MS);
  }

  function updateSky(t: number): boolean {
    if (!sky?.mesh.visible) return false;
    if (t >= skyHold + SKY_OUT_MS) { sky.mesh.visible = false; return false; }
    const top = o.light ? 0.32 : 0.5;
    const dark = t < skyStart + SKY_IN_MS ? (t - skyStart) / SKY_IN_MS : t < skyHold ? 1 : 1 - (t - skyHold) / SKY_OUT_MS;
    sky.mat.uniforms.uDark!.value = top * Math.max(0, dark);
    sky.mat.uniforms.uFlash!.value = Math.max(0, 1 - (t - flashAt) / SKY_FLASH_MS);
    return true;
  }

  function updateGust(t: number): boolean {
    if (!gust?.mesh.visible) return false;
    const age = (t - gustStart) / 1000;
    if (age * 1000 >= GUST_MS) { gust.mesh.visible = false; return false; }
    const seed = gust.seed;
    const span = gustLen;
    const radius = (span - 4) / 2;
    for (let i = 0; i < gust.mesh.count; i++) {
      const s0 = seed[i * 6]!, s1 = seed[i * 6 + 1]!, s2 = seed[i * 6 + 2]!, s3 = seed[i * 6 + 3]!, s4 = seed[i * 6 + 4]!, s5 = seed[i * 6 + 5]!;
      const speed = (span / (GUST_MS / 1000)) * (0.75 + 0.5 * s0);
      const along = -span / 2 - s1 * 1.5 + speed * age;
      const across = (s2 - 0.5) * 2 * (radius + 1) + Math.sin(age * 2.2 + s3 * 6.28) * 0.4;
      const y = flat ? 2.4 + s4 : 0.1 + s4 * 2.2 + Math.sin(age * 3.1 + s5 * 6.28) * 0.25;
      dummy.position.copy(gustC).addScaledVector(stormDir, along).addScaledVector(gustSide, across);
      dummy.position.y = gustC.y + y;
      dummy.rotation.set(age * (3 + 4 * s3) + s5 * 6.28, age * (2 + 3 * s4), Math.sin(age * 4 + s0 * 6.28) * 0.8);
      dummy.scale.setScalar(flat ? 1.4 : 1);
      dummy.updateMatrix();
      gust.mesh.setMatrixAt(i, dummy.matrix);
    }
    gust.mesh.instanceMatrix.needsUpdate = true;
    return true;
  }

  function updatePending(t: number): boolean {
    for (let i = pending.length - 1; i >= 0; i--) {
      const h = pending[i]!;
      if (t < h.at) continue;
      pending[i] = pending[pending.length - 1]!;
      pending.pop();
      if (!sink.target(h.id, tmpA)) continue;
      if (h.sky) {
        skyAbove(tmpA, flat, tmpB);
        if (h.strike) {
          sink.bolt(tmpB, tmpA, BOLT_C);
          sink.burst(tmpA, FLASH, 1.9, 320);
          const n = Math.round(stormFx(o.detail, o.motion).sparks * 0.6);
          if (n) sink.sparks(n, tmpA, BOLT_C, { speed: 2.4, up: 0.5, spread: 0.1, life: 0.45, size: 0.06, gravity: -2, drag: 1.6 });
          flashAt = t;
        }
      } else {
        tmpB.copy(tmpA).addScaledVector(stormDir, -3); // upwind: the papers came from there
      }
      sink.arrive(h.id, "storm", tmpB);
    }
    return pending.length > 0;
  }

  return {
    launch,
    launchWorld,
    storm,
    setFlat(on) { flat = on; },
    update(t, dt) {
      let live = false;
      if (active > 0) for (const p of projs) if (p.active) { updateProj(p, t, dt); live = true; }
      if (flights.length && updateFlights(t, dt)) live = true;
      if (updatePending(t)) live = true;
      if (updateSky(t)) live = true;
      if (updateGust(t)) live = true;
      return live;
    },
    dispose() {
      pending.length = 0;
      for (let i = flights.length - 1; i >= 0; i--) endFlight(i);
      for (const p of projs) if (p.obj) scene.remove(p.obj);
      projs.length = 0;
      active = 0;
      if (sky) { scene.remove(sky.mesh); sky.mat.dispose(); sky = null; }
      if (gust) { scene.remove(gust.mesh); gust.mesh.dispose(); gust = null; }
      for (const x of geos.values()) x.dispose();
      for (const x of mats.values()) x.dispose();
      geos.clear(); mats.clear();
    },
  };
}

/** A crumpled paper ball: a low-poly sphere with every vertex pushed in or out by a hash of its position (the
 *  duplicated vertices of a face edge move together, so the ball has no cracks). */
function crumpled(): THREE.BufferGeometry {
  const geo = new THREE.IcosahedronGeometry(0.08, 1);
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const h = Math.sin(x * 91.7 + y * 47.3 + z * 13.1) * 43758.5453;
    const k = 0.78 + 0.34 * (h - Math.floor(h));
    pos.setXYZ(i, x * k, y * k, z * k);
  }
  geo.computeVertexNormals();
  return geo;
}

/** A four-bladed throwing star with a center hole, thin, in the XY plane. */
function shuriken(): THREE.BufferGeometry {
  const s = new THREE.Shape();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + (i % 2 ? 0.18 : 0); // the inner notches swept a little: blades, not a cross
    const r = i % 2 ? 0.028 : 0.1;
    if (i === 0) s.moveTo(Math.cos(a) * r, Math.sin(a) * r); else s.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  s.closePath();
  const hole = new THREE.Path();
  hole.absarc(0, 0, 0.012, 0, Math.PI * 2, true);
  s.holes.push(hole);
  const geo = new THREE.ExtrudeGeometry(s, { depth: 0.01, bevelEnabled: false, curveSegments: 6 });
  geo.translate(0, 0, -0.005);
  return geo;
}

// ------------------------------------------------------------------------------------------ the tray

const P = (d: string): string => `<path d="${d}"/>`;

/** Original line icons, 24 x 24, in the app's icon style (icons.ts: 1.6 stroke, round caps, currentColor). */
const ICONS: Readonly<Record<ThrowKind, string>> = {
  paper: P("M7 8.5 10.5 5l4 1.2 3.5 3.3-.6 4.6L14 18.5l-4.6.3L6 15.6 5.5 11z") + P("M10.5 5l.8 4.2 3.6 1.4") + P("M6 11.5l5.3-2.3") + P("M14.9 10.6 14 18.5") + P("M9.4 18.8l1.9-4.3"),
  band: P("M4.5 12c0-1.9 3.4-3.3 7.5-3.3s7.5 1.4 7.5 3.3-3.4 3.3-7.5 3.3-7.5-1.4-7.5-3.3z") + P("M3 6.5l1.8 1.3") + P("M21 6.5l-1.8 1.3") + P("M12 4v1.6"),
  drink: P("M8.5 7.5h7v11a2 2 0 0 1-2 2h-3a2 2 0 0 1-2-2z") + P("M9.5 7.5 10 4.5h4l.5 3") + P("M12.6 10.5l-1.6 2.6h2l-1.6 2.6"),
  stars: P("M12 3.5l1.6 6.9 6.9 1.6-6.9 1.6L12 20.5l-1.6-6.9L3.5 12l6.9-1.6z") + `<circle cx="12" cy="12" r="1.3"/>`,
  bolt: P("M13.5 3 6.5 13.5h5L10 21l7.5-11h-5z"),
  orb: `<circle cx="12" cy="12" r="4"/>` + P("M4.5 9.5a8 8 0 0 1 12-4.5") + P("M19.5 14.5a8 8 0 0 1-12 4.5"),
};
const STORM_ICONS: Readonly<Record<BuiltinStyle, string>> = {
  anime: P("M7 15.5a4 4 0 0 1 .4-8A5 5 0 0 1 17 8.6a3.5 3.5 0 0 1 .5 6.9") + P("M12.5 12.5l-2 3.5h3l-2 3.5"),
  professional: P("M3.5 9h8a2.5 2.5 0 1 0-2.5-2.5") + P("M3.5 13h12a2.5 2.5 0 1 1-2.5 2.5") + P("M15 3.5l4.5 1.2-1.2 4.5-4.5-1.2z"),
};

const svg = (body: string, size: number): string =>
  `<svg class="ic" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

/** P-WORLDS.1 (ADR-0648): a world's icon (SVG path data in a 24 x 24 box), built as DOM with the path data set by
 *  setAttribute, never as markup: a 1.8 px round stroke in the tray's ink color. */
function worldIcon(d: string, size: number): SVGSVGElement {
  const NS = "http://www.w3.org/2000/svg";
  const s = document.createElementNS(NS, "svg");
  for (const [k, v] of [["class", "ic"], ["viewBox", "0 0 24 24"], ["width", String(size)], ["height", String(size)], ["fill", "none"], ["stroke", "currentColor"], ["stroke-width", "1.8"], ["stroke-linecap", "round"], ["stroke-linejoin", "round"], ["aria-hidden", "true"]] as const) s.setAttribute(k, v);
  const p = document.createElementNS(NS, "path");
  p.setAttribute("d", d);
  s.appendChild(p);
  return s;
}

/** The armed cursor: the throwable's icon, white over a dark halo so it reads on any part of the scene. A world's
 *  icon is path data viz_worlds.validateWorld allowed (commands, digits and separators only), so it cannot leave
 *  the attribute. */
function cursorFor(kind: string, world: WorldDefinition | null): string {
  const wd = world?.throws.find((t) => t.kind === kind)?.icon;
  const body = wd !== undefined ? (/^[MmLlHhVvCcSsQqTtAaZz0-9 ,.\-]+$/.test(wd) ? P(wd) : "") : isThrowKind(kind) ? ICONS[kind] : "";
  const s = `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round"><g stroke="#000" stroke-opacity=".75" stroke-width="3.6">${body}</g><g stroke="#fff" stroke-width="1.6">${body}</g></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(s)}") 14 14, crosshair`;
}

const HOW = "Click it, then click an agent or subagent to throw (it stays ready for more), or drag it onto one. Esc or a second click puts it down. Throwing needs a pointer: the agents in the view take no keyboard focus.";

export interface ThrowTray {
  /** The style changed: show its throwables (anything armed is put down). A world style shows `world`'s three
   *  throwables and its storm (P-WORLDS.1); a new definition of the same world (its options changed) repaints. */
  setStyle(style: VizStyle, world?: WorldDefinition | null): void;
  /** A click on the stage while something is armed: throws it at a node (nothing on empty space). False when
   *  nothing is armed, so the click means what it always did (the node panel). */
  release(hit: SceneHit | null): boolean;
  /** Put down whatever is armed; false when nothing was (Esc then means what it always did). */
  disarm(): boolean;
  /** A new scene was mounted: tell it what is armed. */
  attach(): void;
}

/** Mount the tray at the bottom center of `stage`. `scene` is read on every use (the view remounts it). */
export function mountThrowTray(stage: HTMLElement, scene: () => VizSceneHandle | null, style: VizStyle, initialWorld: WorldDefinition | null = null): ThrowTray {
  const root = document.createElement("div");
  root.className = "viz-throw";
  root.setAttribute("role", "toolbar");
  root.setAttribute("aria-label", "Throw something at an agent");
  stage.appendChild(root);
  const ghost = document.createElement("div");
  ghost.className = "viz-throw-ghost";
  ghost.hidden = true;
  ghost.setAttribute("aria-hidden", "true");
  stage.appendChild(ghost);

  // A world style without its definition (still loading) shows the anime tray until it arrives.
  let world: WorldDefinition | null = isBuiltinStyle(style) ? null : initialWorld;
  let st: ArmState = armState(isBuiltinStyle(style) || world ? style : "anime");
  const limit = createRateLimit(STORM_COOLDOWN_MS);
  let coolTimer = 0;
  let press: { kind: string; btn: HTMLElement; x: number; y: number; pid: number; drag: boolean } | null = null;
  let eatClick = false;

  /** What the tray offers now: the built-in style's throwables, or the world's. */
  function looks(): readonly { kind: string; label: string; tip: string }[] {
    return world ? world.throws : isBuiltinStyle(st.style) ? throwsFor(st.style) : [];
  }

  /** P-WORLDS.1: a world's tray, built as DOM (its labels and tips are text, its icons path data). */
  function paintWorld(w: WorldDefinition): void {
    root.replaceChildren();
    for (const t of w.throws) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "viz-throw-b";
      b.dataset.vizThrow = t.kind;
      b.setAttribute("aria-pressed", "false");
      b.setAttribute("aria-label", `${t.label}: pick it, then click an agent or subagent`);
      b.setAttribute("data-tip", tipValue(t.label, `${t.tip} ${HOW}`));
      b.appendChild(worldIcon(t.icon, 16));
      root.appendChild(b);
    }
    const sep = document.createElement("i");
    sep.className = "viz-throw-sep";
    sep.setAttribute("aria-hidden", "true");
    const sb = document.createElement("button");
    sb.type = "button";
    sb.className = "viz-throw-b viz-throw-storm";
    sb.dataset.vizStorm = "";
    sb.setAttribute("aria-label", w.storm.label);
    sb.setAttribute("data-tip", tipValue(w.storm.label, `${w.storm.tip} Once every ${STORM_COOLDOWN_MS / 1000} seconds.`));
    const label = document.createElement("span");
    label.textContent = w.storm.label;
    sb.append(worldIcon(w.storm.icon, 15), label);
    const sr = document.createElement("span");
    sr.className = "viz-throw-sr";
    sr.dataset.vizThrowSr = "";
    sr.setAttribute("aria-live", "polite");
    root.append(sep, sb, sr);
    paintArmed();
    paintStorm();
  }

  function paint(): void {
    if (world) { paintWorld(world); return; }
    if (!isBuiltinStyle(st.style)) return;
    const items = throwsFor(st.style).map((t) =>
      `<button type="button" class="viz-throw-b" data-viz-throw="${t.kind}" aria-pressed="false" aria-label="${esc(`${t.label}: pick it, then click an agent or subagent`)}" data-tip="${esc(tipValue(t.label, `${t.tip} ${HOW}`))}">${svg(ICONS[t.kind], 16)}</button>`).join("");
    root.innerHTML = `${items}<i class="viz-throw-sep" aria-hidden="true"></i>`
      + `<button type="button" class="viz-throw-b viz-throw-storm" data-viz-storm aria-label="Storm" data-tip="${esc(tipValue("Storm", `${STORM_TIP[st.style]} Once every ${STORM_COOLDOWN_MS / 1000} seconds.`))}">${svg(STORM_ICONS[st.style], 15)}<span>Storm</span></button>`
      + `<span class="viz-throw-sr" data-viz-throw-sr aria-live="polite"></span>`;
    paintArmed();
    paintStorm();
  }

  function paintArmed(): void {
    for (const b of root.querySelectorAll<HTMLElement>("[data-viz-throw]")) {
      const on = b.dataset.vizThrow === st.armed;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", String(on));
    }
    scene()?.setThrowArmed(st.armed ? cursorFor(st.armed, world) : null);
    const armed = st.armed;
    const look = armed ? looks().find((t) => t.kind === armed) : undefined;
    say(look ? `${look.label} ready: click an agent or subagent to throw it. Esc puts it down.` : "");
  }

  function paintStorm(): void {
    const b = root.querySelector<HTMLElement>("[data-viz-storm]");
    if (!b) return;
    const left = rateLeft(limit, performance.now());
    b.classList.toggle("cool", left > 0);
    b.setAttribute("aria-disabled", String(left > 0));
    window.clearTimeout(coolTimer);
    coolTimer = left > 0 ? window.setTimeout(paintStorm, left + 20) : 0;
  }

  function say(text: string): void {
    const sr = root.querySelector<HTMLElement>("[data-viz-throw-sr]");
    if (sr && sr.textContent !== text) sr.textContent = text;
  }

  function step(a: ArmAction): void {
    const r = armStep(st, a);
    if (r.state !== st) { st = r.state; paintArmed(); }
  }

  function placeGhost(x: number, y: number): void {
    const r = stage.getBoundingClientRect();
    ghost.style.transform = `translate(${x - r.left - 14}px, ${y - r.top - 14}px)`;
  }

  function endPress(): void {
    if (press && press.btn.hasPointerCapture(press.pid)) press.btn.releasePointerCapture(press.pid);
    press = null;
    ghost.hidden = true;
    ghost.classList.remove("on");
  }

  root.addEventListener("pointerdown", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-viz-throw]");
    if (!b || e.button !== 0) return;
    press = { kind: b.dataset.vizThrow ?? "", btn: b, x: e.clientX, y: e.clientY, pid: e.pointerId, drag: false };
    b.setPointerCapture(e.pointerId);
  });
  root.addEventListener("pointermove", (e) => {
    if (!press || e.pointerId !== press.pid) return;
    if (!press.drag && Math.hypot(e.clientX - press.x, e.clientY - press.y) < DRAG_PX) return;
    if (!press.drag) {
      press.drag = true;
      const kind = press.kind;
      const wicon = world?.throws.find((t) => t.kind === kind)?.icon;
      if (wicon !== undefined) ghost.replaceChildren(worldIcon(wicon, 22));
      else ghost.innerHTML = isThrowKind(kind) ? svg(ICONS[kind], 22) : "";
      ghost.hidden = false;
    }
    placeGhost(e.clientX, e.clientY);
    ghost.classList.toggle("on", !!scene()?.nodeAt(e.clientX, e.clientY));
  });
  root.addEventListener("pointerup", (e) => {
    if (!press || e.pointerId !== press.pid) return;
    if (press.drag) {
      eatClick = true; // the click that follows a drag is not an arm
      const id = scene()?.nodeAt(e.clientX, e.clientY);
      if (id) {
        const r = stage.getBoundingClientRect(), br = press.btn.getBoundingClientRect();
        scene()?.throwAt(id, press.kind, { x: br.left + br.width / 2 - r.left, y: br.top + br.height / 2 - r.top });
      }
    }
    endPress();
  });
  root.addEventListener("pointercancel", endPress);
  root.addEventListener("click", (e) => {
    if (eatClick) { eatClick = false; return; }
    const t = e.target as HTMLElement;
    const b = t.closest<HTMLElement>("[data-viz-throw]");
    if (b) { step({ type: "arm", kind: b.dataset.vizThrow ?? "" }); return; }
    if (!t.closest("[data-viz-storm]")) return;
    const sc = scene();
    if (!sc || !rateTake(limit, performance.now())) return;
    sc.storm();
    paintStorm();
    say(`Storm. Ready again in ${STORM_COOLDOWN_MS / 1000} seconds.`);
  });

  paint();

  return {
    setStyle(next, w = null) {
      const nextWorld = isBuiltinStyle(next) ? null : w;
      if (!isBuiltinStyle(next) && !nextWorld) return; // a world without its definition: keep the tray as it is
      if (next === st.style && nextWorld === world) return;
      endPress();
      // a new definition of the same world (its options changed) keeps what is armed; another style puts it down
      if (next !== st.style) st = armStep(st, { type: "style", style: next }).state;
      world = nextWorld;
      paint();
    },
    release(hit) {
      if (!st.armed) return false;
      const r = armStep(st, { type: "release", onNode: hit?.kind === "node" });
      if (r.fire && hit?.kind === "node") scene()?.throwAt(hit.id, r.fire);
      return true;
    },
    disarm() {
      if (!st.armed) return false;
      step({ type: "disarm" });
      return true;
    },
    attach() { scene()?.setThrowArmed(st.armed ? cursorFor(st.armed, world) : null); },
  };
}
