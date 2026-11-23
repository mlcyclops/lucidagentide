// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/viz_build.ts - P-WORLDS.BUILD1 (ADR-0653): the host's build-site scaffolding (WorldKit.scaffold and
// the scaffold every build site draws). Feet at the origin, about one cell wide:
//   pieces      wireframe boxes in a 2 x 2 stack that build up from the floor (one per subagent), lock in with a
//               translucent fill and a flash, flicker red on a failed tool
//   beams       thin holo beams at the corners, as tall as the build ("holo")
//   panels      floating holo panels orbiting the build ("panels")
//   ring        the progress ring on the floor: a dim track and a bright arc of locked / pieces (drawRange, no
//               geometry rebuilt), complete when revealed
//   flash       a small pool of additive spheres for lock-ins and the reveal
// The tier budget (viz_build_model.scaffoldBudget) caps every count. Reduced motion: no growth, no flicker, no
// flashes; the state changes show as color only. update() allocates nothing; dispose() frees every geometry and
// material this scaffold made (it owns all of them; nothing is shared across scaffolds).

import * as THREE from "three";
import { scaffoldBudget } from "./viz_build_model.ts";
import type { WorldScaffold, WorldScaffoldOptions } from "./viz_world_api.ts";

/** The edge of one piece, and the 2 x 2 stack's spacing. */
const PIECE = 0.34, GAP = 0.4;
const GROW_S = 0.5, FLASH_S = 0.45, FAIL_S = 0.9, REVEAL_S = 1.2, LOCK_S = 0.35;
const RING_IN = 0.5, RING_OUT = 0.56;
/** A piece's lockedAt before it locks (any real lock time compares below it). */
const UNLOCKED = Number.POSITIVE_INFINITY;
const RED = new THREE.Color("#ff3b30");
const WHITE = new THREE.Color("#ffffff");

interface Piece {
  group: THREE.Group;
  wireMat: THREE.LineBasicMaterial;
  fillMat: THREE.MeshBasicMaterial;
  /** Seconds on the scaffold's clock: when it started growing, locked (UNLOCKED = not yet), failing until. */
  bornAt: number; lockedAt: number; failUntil: number;
  on: boolean;
}

/** Build the scaffold. Every resource it makes is listed in `owned` and freed by dispose(). */
export function createScaffold(o: WorldScaffoldOptions): WorldScaffold {
  const budget = scaffoldBudget(o.tier);
  const color = new THREE.Color(o.color);
  const fillColor = color.clone().lerp(WHITE, 0.25);
  const tmp = new THREE.Color();
  const group = new THREE.Group();
  group.name = "scaffold";
  const geos: THREE.BufferGeometry[] = [];
  const mats: THREE.Material[] = [];
  const own = <T extends THREE.BufferGeometry>(g: T): T => { geos.push(g); return g; };
  const mat = <T extends THREE.Material>(m: T): T => { mats.push(m); return m; };
  const additive = o.flat ? THREE.NormalBlending : THREE.AdditiveBlending;

  // ---- pieces (all made up front, hidden until added: no allocation while the build runs)
  const box = own(new THREE.BoxGeometry(PIECE, PIECE, PIECE));
  const edges = own(new THREE.EdgesGeometry(box));
  const fillBox = own(new THREE.BoxGeometry(PIECE * 0.9, PIECE * 0.9, PIECE * 0.9));
  const pieces: Piece[] = [];
  for (let i = 0; i < budget.pieces; i++) {
    const layer = Math.floor(i / 4), slot = i % 4;
    const g = new THREE.Group();
    g.position.set((slot % 2 ? 1 : -1) * GAP / 2, layer * GAP, (slot < 2 ? 1 : -1) * GAP / 2);
    const wireMat = mat(new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0, depthWrite: false, toneMapped: false, blending: additive }));
    const wire = new THREE.LineSegments(edges, wireMat);
    wire.position.y = PIECE / 2;
    const fillMat = mat(new THREE.MeshBasicMaterial({ color: fillColor, transparent: true, opacity: 0, depthWrite: false, toneMapped: false }));
    const fill = new THREE.Mesh(fillBox, fillMat);
    fill.position.y = PIECE / 2;
    g.add(fill, wire);
    g.visible = false;
    group.add(g);
    pieces.push({ group: g, wireMat, fillMat, bornAt: 0, lockedAt: -1, failUntil: 0, on: false });
  }

  // ---- holo beams ("holo"), one material for all
  const beamCount = o.style === "holo" ? budget.beams : 0;
  const beamGeo = beamCount ? own(new THREE.CylinderGeometry(0.012, 0.012, 1, 6, 1, true)) : null;
  const beamMat = beamCount ? mat(new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, depthWrite: false, toneMapped: false, blending: additive })) : null;
  const beams: THREE.Mesh[] = [];
  for (let i = 0; i < beamCount && beamGeo && beamMat; i++) {
    const a = (i / beamCount) * Math.PI * 2 + Math.PI / 4;
    const m = new THREE.Mesh(beamGeo, beamMat);
    m.position.set(Math.cos(a) * 0.42, 0.5, Math.sin(a) * 0.42);
    m.visible = false;
    beams.push(m);
    group.add(m);
  }

  // ---- floating panels ("panels"): a quad and its frame, orbiting on one group
  const panelCount = o.style === "panels" ? budget.panels : 0;
  const panelRig = new THREE.Group();
  const panelGeo = panelCount ? own(new THREE.PlaneGeometry(0.26, 0.17)) : null;
  const panelEdge = panelGeo ? own(new THREE.EdgesGeometry(panelGeo)) : null;
  const panelMat = panelCount ? mat(new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false, toneMapped: false })) : null;
  const panelLineMat = panelCount ? mat(new THREE.LineBasicMaterial({ color: fillColor, transparent: true, opacity: 0, depthWrite: false, toneMapped: false })) : null;
  for (let i = 0; i < panelCount && panelGeo && panelEdge && panelMat && panelLineMat; i++) {
    const a = (i / panelCount) * Math.PI * 2;
    const quad = new THREE.Mesh(panelGeo, panelMat);
    quad.add(new THREE.LineSegments(panelEdge, panelLineMat));
    quad.position.set(Math.cos(a) * 0.62, 0.45 + 0.18 * (i % 2), Math.sin(a) * 0.62);
    quad.rotation.y = -a + Math.PI / 2;
    panelRig.add(quad);
  }
  panelRig.visible = false;
  group.add(panelRig);

  // ---- progress ring: a dim track and the bright arc (drawRange over the same segment order)
  const segs = budget.ringSegments;
  const trackGeo = own(new THREE.RingGeometry(RING_IN, RING_OUT, segs, 1));
  const arcGeo = own(new THREE.RingGeometry(RING_IN, RING_OUT, segs, 1, Math.PI / 2));
  const trackMat = mat(new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false, toneMapped: false }));
  const arcMat = mat(new THREE.MeshBasicMaterial({ color: fillColor, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false, toneMapped: false, blending: additive }));
  const track = new THREE.Mesh(trackGeo, trackMat);
  const arc = new THREE.Mesh(arcGeo, arcMat);
  track.rotation.x = arc.rotation.x = -Math.PI / 2;
  track.position.y = 0.004; arc.position.y = 0.006;
  arcGeo.setDrawRange(0, 0);
  group.add(track, arc);

  // ---- flash pool
  const flashGeo = own(new THREE.SphereGeometry(0.2, 12, 8));
  const flashes: { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; at: number; scale: number }[] = [];
  for (let i = 0; i < budget.flashes; i++) {
    const fm = mat(new THREE.MeshBasicMaterial({ color: WHITE, transparent: true, opacity: 0, depthWrite: false, toneMapped: false, blending: additive }));
    const mesh = new THREE.Mesh(flashGeo, fm);
    mesh.visible = false;
    group.add(mesh);
    flashes.push({ mesh, mat: fm, at: -1, scale: 1 });
  }
  let flashNext = 0;

  let clock = 0;
  let count = 0, lockedN = 0, revealed = false, revealAt = -1;
  /** The arc's shown fraction eases toward the target. */
  let arcShown = 0;
  let disposed = false;

  function flashAt(x: number, y: number, z: number, scale: number): void {
    if (!flashes.length) return;
    const f = flashes[flashNext]!;
    flashNext = (flashNext + 1) % flashes.length;
    f.mesh.position.set(x, y, z);
    f.at = clock; f.scale = scale;
    f.mesh.visible = true;
  }

  function lockPiece(p: Piece, at: number, flash: boolean): void {
    if (p.lockedAt !== UNLOCKED) return;
    p.lockedAt = at;
    p.failUntil = 0;
    if (flash) flashAt(p.group.position.x, p.group.position.y + PIECE / 2, p.group.position.z, 1);
  }

  function setCount(n: number): void {
    count = Math.max(0, Math.min(n, pieces.length)); // the tier's budget caps what is drawn and counted
    for (let i = 0; i < pieces.length; i++) {
      const p = pieces[i]!;
      const on = i < count;
      if (on && !p.on) { p.bornAt = clock; p.lockedAt = UNLOCKED; p.failUntil = 0; }
      p.on = on;
      p.group.visible = on;
    }
  }

  const api: WorldScaffold = {
    group,
    get pieces() { return count; },
    get locked() { return lockedN; },
    get revealed() { return revealed; },
    addPieces(n) {
      if (disposed || revealed || !(n > 0)) return;
      setCount(count + Math.floor(n));
    },
    lockIn() {
      if (disposed || revealed || lockedN >= count) return;
      const p = pieces[lockedN];
      lockedN++;
      if (p) lockPiece(p, clock, true);
    },
    fail() {
      if (disposed || revealed || lockedN >= count) return;
      const p = pieces[count - 1];
      if (p && p.lockedAt === UNLOCKED) p.failUntil = clock + FAIL_S;
    },
    reveal() {
      if (disposed || revealed) return;
      if (count === 0) setCount(1);
      revealed = true; revealAt = clock; lockedN = count;
      for (let i = 0; i < count; i++) lockPiece(pieces[i]!, clock + i * 0.06, false);
      flashAt(0, Math.ceil(count / 4) * GAP * 0.5, 0, 2.2);
    },
    reset() {
      if (disposed) return;
      revealed = false; revealAt = -1; lockedN = 0; arcShown = 0;
      setCount(0);
      for (const f of flashes) { f.at = -1; f.mesh.visible = false; }
    },
    restore(n, locked, rev) {
      if (disposed) return;
      api.reset();
      setCount(n);
      lockedN = Math.min(locked, count);
      for (let i = 0; i < pieces.length; i++) {
        const p = pieces[i]!;
        p.bornAt = clock - GROW_S; // already grown
        if (i < (rev ? count : lockedN)) p.lockedAt = clock - LOCK_S;
      }
      if (rev) { revealed = true; lockedN = count; revealAt = clock - REVEAL_S; }
      arcShown = rev ? 1 : count ? lockedN / count : 0;
    },
    update(tSec, dt, motion) {
      if (disposed) return false;
      clock += Math.max(0, Math.min(dt, 0.1));
      let live = false;
      const n = count;
      // pieces
      for (let i = 0; i < n; i++) {
        const p = pieces[i]!;
        const grow = motion ? Math.min(1, (clock - p.bornAt) / GROW_S) : 1;
        if (grow < 1) live = true;
        p.group.scale.set(1, Math.max(0.001, 1 - Math.pow(1 - grow, 3)), 1);
        const failing = clock < p.failUntil;
        if (failing) live = true;
        const lockK = p.lockedAt === UNLOCKED ? 0 : !motion ? 1 : clock < p.lockedAt ? 0 : Math.min(1, (clock - p.lockedAt) / LOCK_S);
        if (p.lockedAt !== UNLOCKED && lockK < 1) live = true;
        if (failing) {
          const on = !motion || Math.floor(clock / 0.07) % 2 === 0;
          p.wireMat.color.copy(RED);
          p.wireMat.opacity = on ? 1 : 0.25;
          p.fillMat.color.copy(RED);
          p.fillMat.opacity = on ? 0.25 : 0.05;
        } else {
          p.wireMat.color.copy(tmp.copy(color).lerp(WHITE, 0.4 * lockK));
          const shimmer = motion && lockK === 0 ? 0.15 * Math.sin(tSec * 6 + i) : 0;
          p.wireMat.opacity = (0.55 + shimmer) * (0.4 + 0.6 * grow) + 0.25 * lockK;
          p.fillMat.color.copy(fillColor);
          p.fillMat.opacity = 0.5 * lockK;
        }
      }
      const height = Math.max(1, Math.ceil(n / 4)) * GAP;
      const revealK = revealed ? (motion ? Math.min(1, (clock - revealAt) / REVEAL_S) : 1) : 0;
      if (revealed && revealK < 1) live = true;
      // beams: as tall as the build, flaring on the reveal
      if (beamMat) {
        const flare = revealed ? Math.max(0, 1 - revealK) : 0;
        beamMat.opacity = n ? (0.35 + 0.5 * flare + (motion ? 0.08 * Math.sin(tSec * 3) : 0)) : 0;
        for (const b of beams) { b.visible = n > 0; b.scale.y = height + 0.2; b.position.y = (height + 0.2) / 2; }
      }
      // panels: orbit slowly while building, settle once revealed
      if (panelMat && panelLineMat) {
        panelRig.visible = n > 0;
        panelMat.opacity = n ? (revealed ? 0.18 : 0.32) : 0;
        panelLineMat.opacity = n ? 0.8 : 0;
        if (motion && !revealed) panelRig.rotation.y += dt * 0.4;
      }
      // progress ring
      const target = revealed ? 1 : count ? lockedN / count : 0;
      arcShown += (target - arcShown) * (motion ? 1 - Math.exp(-dt * 6) : 1);
      if (Math.abs(target - arcShown) > 0.002) live = true; else arcShown = target;
      arcGeo.setDrawRange(0, Math.round(arcShown * segs) * 6);
      trackMat.opacity = n ? 0.22 : 0.12;
      // flashes
      for (const f of flashes) {
        if (f.at < 0) continue;
        const k = (clock - f.at) / FLASH_S;
        if (!motion || k >= 1) { f.at = -1; f.mesh.visible = false; f.mat.opacity = 0; continue; }
        live = true;
        f.mesh.scale.setScalar(f.scale * (0.4 + 1.2 * k));
        f.mat.opacity = 0.9 * (1 - k);
      }
      return live;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      group.removeFromParent();
      for (const g of geos) g.dispose();
      for (const m of mats) m.dispose();
      geos.length = 0; mats.length = 0;
    },
  };
  return api;
}
