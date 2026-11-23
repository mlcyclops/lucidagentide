// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/viz_build.test.ts - P-WORLDS.BUILD1 (ADR-0653): the scaffold's lifecycle (pieces within the tier
// budget, lock-in, the red flicker, the reveal, restore, reduced motion) and its disposal (every geometry and material
// it made is freed, once, and it leaves its parent).

import { describe, expect, test } from "bun:test";
import * as THREE from "three";
import { createScaffold } from "./viz_build.ts";
import { scaffoldBudget } from "./viz_build_model.ts";
import type { WorldScaffold, WorldScaffoldOptions } from "./viz_world_api.ts";

const opts = (o: Partial<WorldScaffoldOptions> = {}): WorldScaffoldOptions => ({ style: "holo", color: "#8fe3ff", tier: "full", flat: false, seed: 1, ...o });

/** Run frames until nothing animates (or a cap); returns how many ran. */
function settle(s: WorldScaffold, motion = true): number {
  let n = 0;
  while (s.update(n / 60, 1 / 60, motion) && n < 600) n++;
  return n;
}

/** Every geometry and material under the group, with a dispose counter on each. */
function track(group: THREE.Object3D): { geos: Set<THREE.BufferGeometry>; mats: Set<THREE.Material>; disposed: Map<object, number> } {
  const geos = new Set<THREE.BufferGeometry>(), mats = new Set<THREE.Material>(), disposed = new Map<object, number>();
  group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry) geos.add(m.geometry);
    const mm = m.material as THREE.Material | THREE.Material[] | undefined;
    for (const x of Array.isArray(mm) ? mm : mm ? [mm] : []) mats.add(x);
  });
  for (const r of [...geos, ...mats]) r.addEventListener("dispose", () => disposed.set(r, (disposed.get(r) ?? 0) + 1));
  return { geos, mats, disposed };
}

describe("scaffold lifecycle", () => {
  test("pieces build up, lock in and reveal; counts follow", () => {
    const s = createScaffold(opts());
    expect([s.pieces, s.locked, s.revealed]).toEqual([0, 0, false]);
    s.addPieces(3);
    expect(s.update(0, 1 / 60, true)).toBe(true); // growing
    s.lockIn();
    expect([s.pieces, s.locked]).toEqual([3, 1]);
    s.fail();
    expect(s.update(0.1, 1 / 60, true)).toBe(true); // flickering
    expect(settle(s)).toBeLessThan(600); // the flicker and the growth end
    s.reveal();
    expect([s.pieces, s.locked, s.revealed]).toEqual([3, 3, true]);
    expect(settle(s)).toBeGreaterThan(0);
    expect(s.update(20, 1 / 60, true)).toBe(false); // revealed and still
    s.addPieces(2); s.lockIn(); s.fail(); // a revealed build takes no more steps until reset
    expect([s.pieces, s.locked]).toEqual([3, 3]);
    s.reset();
    expect([s.pieces, s.locked, s.revealed]).toEqual([0, 0, false]);
    s.dispose();
  });

  test("the drawn pieces stay within the tier budget", () => {
    for (const tier of ["minimal", "reduced", "full", "ultra", "cinematic"] as const) {
      const s = createScaffold(opts({ tier }));
      s.addPieces(40);
      s.update(0, 1 / 60, true);
      const visible = s.group.children.filter((c) => c instanceof THREE.Group && c.visible).length;
      expect(visible).toBe(scaffoldBudget(tier).pieces);
      s.dispose();
    }
  });

  test("beams for holo, panels for panels, neither for wireframe or minimal", () => {
    const count = (o: Partial<WorldScaffoldOptions>): { beams: number; panels: number } => {
      const s = createScaffold(opts(o));
      let beams = 0, panels = 0;
      s.group.traverse((x) => {
        const m = x as THREE.Mesh;
        if (m.geometry instanceof THREE.CylinderGeometry) beams++;
        if (m.geometry instanceof THREE.PlaneGeometry) panels++;
      });
      s.dispose();
      return { beams, panels };
    };
    expect(count({ style: "holo" })).toEqual({ beams: scaffoldBudget("full").beams, panels: 0 });
    expect(count({ style: "panels" })).toEqual({ beams: 0, panels: scaffoldBudget("full").panels });
    expect(count({ style: "wireframe" })).toEqual({ beams: 0, panels: 0 });
    expect(count({ style: "holo", tier: "minimal" })).toEqual({ beams: 0, panels: 0 });
  });

  test("reduced motion: every change lands at once", () => {
    const s = createScaffold(opts());
    s.addPieces(2);
    s.lockIn();
    expect(s.update(0, 1 / 60, false)).toBe(false);
    s.reveal();
    expect(s.update(0.02, 1 / 60, false)).toBe(false);
    s.dispose();
  });

  test("restore jumps to a state without animating", () => {
    const s = createScaffold(opts());
    s.restore(4, 2, false);
    expect([s.pieces, s.locked, s.revealed]).toEqual([4, 2, false]);
    expect(s.update(0, 1 / 60, true)).toBe(false);
    s.restore(3, 0, true);
    expect([s.pieces, s.locked, s.revealed]).toEqual([3, 3, true]);
    expect(s.update(0, 1 / 60, true)).toBe(false);
    s.dispose();
  });

  test("a reveal with no pieces still stands one up", () => {
    const s = createScaffold(opts());
    s.reveal();
    expect([s.pieces, s.locked, s.revealed]).toEqual([1, 1, true]);
    s.dispose();
  });
});

describe("scaffold disposal", () => {
  test("every geometry and material it made is disposed exactly once, and it leaves its parent", () => {
    for (const style of ["wireframe", "holo", "panels"] as const) {
      const s = createScaffold(opts({ style, tier: "ultra" }));
      const parent = new THREE.Group();
      parent.add(s.group);
      s.addPieces(5); s.lockIn(); s.reveal(); settle(s);
      const t = track(s.group);
      expect(t.geos.size).toBeGreaterThan(0);
      s.dispose();
      s.dispose(); // a second call is a no-op
      for (const r of [...t.geos, ...t.mats]) expect(t.disposed.get(r)).toBe(1);
      expect(s.group.parent).toBeNull();
      expect(s.update(1, 1 / 60, true)).toBe(false);
      s.addPieces(1); s.lockIn(); s.reveal(); s.reset(); s.restore(1, 1, true); // safe after dispose
    }
  });
});
