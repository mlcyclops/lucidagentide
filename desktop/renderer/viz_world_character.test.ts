// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/viz_world_character.test.ts - P-WORLDS.KIT2 (ADR-0654): the shared character kit. Sleeve coverage
// at shoulder angles across the rig's range (no arm or ink-hull vertex above the sleeve top inside the sleeve, the
// round top held by the cap whichever joint carries it), body preset proportions, every hair style at every tier
// (cards from ultra, capSafe under a brim, the face left open), the torso lathe, face features and disposal.

import { describe, expect, test } from "bun:test";
import * as THREE from "three";
import { HAIR_STYLES } from "./viz_cast.ts";
import type { WorldAppearance, WorldBodyShape, WorldHairStyle, WorldSleeve, WorldTier } from "./viz_world_api.ts";
import {
  ARM, CAP_LINE, CAP_R, HAIR_IDS, HAIR_R, HEAD_R, TORSO_HEIGHTS, bodyShape, character, face, faceFeatures, hair, resolveHairStyle, sleeve, torso,
} from "./viz_world_character.ts";

const PRESENTATIONS = ["feminine", "masculine", "neutral"] as const;
const BUILDS = [0, 1, 2, 3] as const;
const SHAPES: WorldBodyShape[] = PRESENTATIONS.flatMap((presentation) => BUILDS.map((body) => bodyShape({ presentation, body })));
const TIERS: readonly WorldTier[] = ["minimal", "reduced", "full", "ultra", "cinematic"];
const NO_CARDS: readonly WorldHairStyle[] = ["buzz", "locs", "braids", "headscarf", "hijab"];

function verts(g: THREE.BufferGeometry): THREE.Vector3[] {
  const p = g.getAttribute("position");
  const out: THREE.Vector3[] = [];
  for (let i = 0; i < p.count; i++) out.push(new THREE.Vector3(p.getX(i), p.getY(i), p.getZ(i)));
  return out;
}
const radial = (v: THREE.Vector3): number => Math.hypot(v.x, v.z);
const thetaOf = (v: THREE.Vector3): number => Math.acos(Math.max(-1, Math.min(1, v.y / (v.length() || 1))));
/** Angle of a point from the face direction (+Z) around the vertical axis. */
const fromFront = (v: THREE.Vector3): number => Math.abs(Math.atan2(v.x, v.z));

/** The radius of an upright tube geometry at height y (linear between its top and bottom rims). */
function tubeRadius(g: THREE.BufferGeometry): (y: number) => number {
  const vs = verts(g);
  const yTop = Math.max(...vs.map((v) => v.y)), yBot = Math.min(...vs.map((v) => v.y));
  const rTop = Math.max(...vs.filter((v) => Math.abs(v.y - yTop) < 1e-6).map(radial));
  const rBot = Math.max(...vs.filter((v) => Math.abs(v.y - yBot) < 1e-6).map(radial));
  return (y) => rTop + (rBot - rTop) * ((yTop - y) / (yTop - yBot || 1));
}

/** An arm capsule as a pack draws it (soccer core.limb: y = 0 on the joint, hanging along -Y) and its ink hull (the
 *  vertices pushed out along the normals by `ink` in object space), then the pack's limb scale in x and z only, or in
 *  all three axes. */
function armHull(r: number, len: number, ink: number, limb: number, uniform: boolean): THREE.Vector3[] {
  const g = new THREE.CapsuleGeometry(r, len, 6, 16).translate(0, -len / 2, 0);
  const p = g.getAttribute("position"), n = g.getAttribute("normal");
  const out: THREE.Vector3[] = [];
  for (let i = 0; i < p.count; i++) {
    for (const w of [0, ink]) {
      const v = new THREE.Vector3(p.getX(i) + n.getX(i) * w, p.getY(i) + n.getY(i) * w, p.getZ(i) + n.getZ(i) * w);
      out.push(v.multiply(new THREE.Vector3(limb, uniform ? limb : 1, limb)));
    }
  }
  g.dispose();
  return out;
}

/** A convex mesh (or part of one, `keep`) as its face planes, flat [nx, ny, nz, d] with n unit and outward, so a
 *  point is inside when n.p <= d for every face. Degenerate triangles are skipped. */
function planesOf(g: THREE.BufferGeometry, keep: (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => boolean = () => true): Float64Array {
  const p = g.getAttribute("position"), idx = g.getIndex();
  const n = idx ? idx.count : p.count;
  const at = (k: number): THREE.Vector3 => new THREE.Vector3().fromBufferAttribute(p, idx ? idx.getX(k) : k);
  const out: number[] = [];
  for (let k = 0; k + 2 < n; k += 3) {
    const a = at(k), b = at(k + 1), c = at(k + 2);
    if (!keep(a, b, c)) continue;
    const nn = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
    const l = nn.length();
    if (l < 1e-12) continue;
    nn.divideScalar(l);
    out.push(nn.x, nn.y, nn.z, nn.dot(a));
  }
  return Float64Array.from(out);
}
function inside(pl: Float64Array, x: number, y: number, z: number): boolean {
  for (let i = 0; i < pl.length; i += 4) if (pl[i]! * x + pl[i + 1]! * y + pl[i + 2]! * z > pl[i + 3]! + 1e-9) return false;
  return pl.length > 0;
}

describe("sleeve coverage (the soccer sleeve bug)", () => {
  test("soccer's sleeve leaves the capsule's round top showing: the regression this kit fixes", () => {
    // player.ts: sleeve CylinderGeometry(0.056, 0.062, 0.1) translated -0.03 (top at +0.02), arm capsule radius 0.042
    const oldTop = 0.02, oldR = 0.056;
    const above = armHull(ARM.upperR, ARM.upperLen, 0, 1, false).filter((v) => radial(v) < oldR && v.y > oldTop);
    expect(above.length).toBeGreaterThan(0);
    expect(Math.max(...above.map((v) => v.y))).toBeCloseTo(0.042, 3);
  });

  /** The elbow ball and the forearm sleeve of a long sleeve's `fore`, each convex: the ball's triangles are the ones
   *  whose three corners sit on its radius. */
  function forePlanes(sl: WorldSleeve): { ball: Float64Array; cone: Float64Array; r: number } {
    const r = Math.max(...verts(sl.fore!).filter((v) => v.y >= -1e-6).map((v) => v.length()));
    const onBall = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3): boolean => [a, b, c].every((v) => Math.abs(v.length() - r) < 1e-5);
    return { ball: planesOf(sl.fore!, onBall), cone: planesOf(sl.fore!, (a, b, c) => !onBall(a, b, c)), r };
  }

  // The arm, the cap and the sleeve all hang from the shoulder joint (WorldSleeve: parent the cap to it), so a shoulder
  // angle turns them together and coverage is a property of the arm's frame: checked once per body there, against the
  // real meshes (every face, so the polygon's flats count), for the bare arm and its ink hull, the pack's limb scale in
  // x and z only or in all axes.
  for (const length of ["short", "long"] as const) {
    test(`${length}: no arm or ink-hull vertex above the sleeve top inside the sleeve, and none uncovered above the hem, every body`, () => {
      for (const shape of SHAPES) {
        for (const [ink, tier] of [[0.0065, "minimal"], [0.0065, "full"], [0.012, "full"]] as const) { // the hull list holds the bare arm too
          for (const uniform of [false, true]) {
            const sl: WorldSleeve = sleeve({ length, shape, ink, tier });
            const rTube = tubeRadius(sl.upper);
            const cap = planesOf(sl.cap), tube = planesOf(sl.upper);
            const fore = length === "long" ? forePlanes(sl) : null;
            const elbow = shape.spec.upper;
            // a short sleeve hides the arm down to its hem; a long one all of the upper arm (the elbow ball takes over
            // below the elbow joint)
            const tubeEnd = length === "long" ? -elbow : sl.hem;
            for (const a of armHull(ARM.upperR, ARM.upperLen, ink, shape.limb, uniform)) {
              // the literal rule: nothing inside the sleeve's radius rises above the cap's top
              if (radial(a) < rTube(0) && a.y > sl.top + 1e-9) throw new Error(`${length} ${shape.presentation}/${shape.body}: arm point ${a.y.toFixed(4)} above the sleeve top ${sl.top.toFixed(4)}`);
              if (length === "short" && a.y < sl.hem) continue; // below the hem the arm shows on purpose
              const covered = inside(cap, a.x, a.y, a.z)
                || (a.y <= 1e-6 && a.y >= tubeEnd - 1e-6 && inside(tube, a.x, a.y, a.z))
                || (fore !== null && inside(fore.ball, a.x, a.y + elbow, a.z));
              if (!covered) throw new Error(`${length} ${shape.presentation}/${shape.body} ink ${ink} ${uniform ? "uniform" : "xz"}: arm point ${a.toArray().map((n) => n.toFixed(4))} uncovered`);
            }
            sl.dispose();
          }
        }
      }
    });
  }

  // Coverage of the arm's volume is not enough: the inner faces of a sleeve are culled, so where one part ends with a
  // sliver between it and the next (the polygon lens sits a little inside its curve, the elbow ball inside its sphere),
  // a slanted view looks through the gap at the arm (the lineup demo caught 2 px at the long sleeve's ends). So every
  // tube end is capped, and the long sleeve's bottom rim sits strictly inside the elbow ball.
  test("the sleeve is sealed at every tier: both tube ends capped, the long sleeve's bottom rim inside the elbow ball", () => {
    for (const tier of TIERS) {
      for (const shape of SHAPES) {
        for (const length of ["short", "long"] as const) {
          for (const flat of [false, true]) {
            const sl = sleeve({ length, shape, tier, flat, ink: 0.0065 });
            const vs = verts(sl.upper);
            const yTop = Math.max(...vs.map((v) => v.y)), yBot = Math.min(...vs.map((v) => v.y));
            const tag = `${length} ${shape.presentation}/${shape.body} ${tier}${flat ? " 2D" : ""}`;
            if (!vs.some((v) => radial(v) < 1e-7 && Math.abs(v.y - yTop) < 1e-6)) throw new Error(`${tag}: the sleeve's top end is open`);
            if (!vs.some((v) => radial(v) < 1e-7 && Math.abs(v.y - yBot) < 1e-6)) throw new Error(`${tag}: the sleeve's bottom end is open`);
            if (length === "long") {
              const { ball } = forePlanes(sl);
              for (const v of vs.filter((p) => Math.abs(p.y - yBot) < 1e-6)) {
                if (!inside(ball, v.x, v.y - yBot, v.z)) throw new Error(`${tag}: the upper sleeve's rim point ${v.toArray().map((n) => n.toFixed(4))} sticks out of the elbow ball`);
              }
            }
            sl.dispose();
          }
        }
      }
    }
  });

  test("long: the forearm and its hull stay covered down to the cuff at every elbow bend", () => {
    for (const shape of SHAPES) {
      const sl = sleeve({ length: "long", shape, ink: 0.012 });
      // the ball and the forearm sleeve both ride the elbow joint with the forearm, so a bend changes nothing here
      const { ball, cone, r } = forePlanes(sl);
      for (const v of armHull(ARM.foreR, ARM.foreLen, 0.012, shape.limb, false)) {
        if (v.y < sl.hem) continue;
        if (!(inside(ball, v.x, v.y, v.z) || inside(cone, v.x, v.y, v.z))) throw new Error(`${shape.presentation}/${shape.body}: forearm point ${v.toArray().map((n) => n.toFixed(4))} outside the elbow ball and the forearm sleeve`);
      }
      // the elbow ball also closes the upper sleeve's open end at any bend
      expect(r).toBeGreaterThanOrEqual(tubeRadius(sl.upper)(-shape.spec.upper) - 1e-9);
      sl.dispose();
    }
  });

  test("the cap is a flat shirt lens on the joint: no higher or wider than the hull's round top needs", () => {
    for (const shape of SHAPES) {
      const sl = sleeve({ length: "short", shape, ink: 0.0065 });
      const cv = verts(sl.cap);
      const yMax = Math.max(...cv.map((v) => v.y)), yMin = Math.min(...cv.map((v) => v.y)), width = 2 * Math.max(...cv.map(radial));
      expect(yMax).toBeCloseTo(sl.top, 6);
      // the round top it holds: (0.042 + ink) tall (times the limb scale when it grows), plus the 0.002 clearance
      const need = (ARM.upperR + 0.0065) * Math.max(1, shape.limb) + 0.002;
      expect(sl.top).toBeGreaterThanOrEqual(need);
      expect(sl.top).toBeLessThanOrEqual(need * 1.02); // only the polygon's allowance on top
      // a lens, not a ball: 1.12 times the hull's width (a slim arm gets a slim cap) and 0.7 of its height either side
      // of a center 0.3 up, so it starts 0.4 of the way down and never puffs out round the shoulder
      const rxz = (ARM.upperR + 0.0065) * shape.limb + 0.002;
      expect(width / 2).toBeLessThanOrEqual(1.12 * rxz * 1.02);
      expect(yMax - yMin).toBeLessThanOrEqual(1.4 * need * 1.02);
      expect(yMin).toBeGreaterThan(-0.45 * need);
      // the sleeve tapers out of the lens: its top rim at the joint, no wider than the lens there
      const uv = verts(sl.upper);
      expect(Math.max(...uv.map((v) => v.y))).toBeCloseTo(0, 6);
      expect(Math.max(...uv.filter((v) => Math.abs(v.y) < 1e-6).map(radial))).toBeLessThanOrEqual(width / 2);
      expect(sl.fore).toBeNull();
      sl.dispose();
    }
  });
});

describe("bodyShape", () => {
  test("every presentation and build lands in range, and the spec follows the shape", () => {
    for (const s of SHAPES) {
      expect(s.shoulder).toBeGreaterThanOrEqual(0.12);
      expect(s.shoulder).toBeLessThanOrEqual(0.19);
      expect(s.chest).toBeGreaterThanOrEqual(0.11);
      expect(s.chest).toBeLessThanOrEqual(0.165);
      expect(s.waist).toBeGreaterThanOrEqual(0.075);
      expect(s.waist).toBeLessThan(s.chest);
      expect(s.hip).toBeGreaterThanOrEqual(0.095);
      expect(s.hip).toBeLessThanOrEqual(0.14);
      expect(s.height).toBeGreaterThanOrEqual(0.93);
      expect(s.height).toBeLessThanOrEqual(1.05);
      expect(s.limb).toBeGreaterThanOrEqual(0.78);
      expect(s.limb).toBeLessThanOrEqual(1.25);
      expect(s.neck).toBeGreaterThanOrEqual(0.033);
      expect(s.neck).toBeLessThanOrEqual(0.055);
      expect(s.jaw).toBeGreaterThanOrEqual(0.85);
      expect(s.jaw).toBeLessThanOrEqual(1.12);
      expect(s.depth).toBeGreaterThan(0.7);
      expect(s.depth).toBeLessThan(0.85);
      expect(s.bust).toBeGreaterThanOrEqual(0);
      expect(s.bust).toBeLessThanOrEqual(1);
      const sp = s.spec;
      expect(sp.shX).toBe(s.shoulder);
      expect(sp.hipY).toBeCloseTo(0.07 + sp.thigh + sp.shin, 9); // feet on the ground, the boot under the ankle
      // feet to the top of the hair: soccer's player is 1.0575 under BUILD_H 1.1
      const top = sp.hipY + sp.spineUp + sp.headY + 0.105 + HAIR_R;
      expect(top).toBeGreaterThan(1.0);
      expect(top).toBeLessThanOrEqual(1.1);
      // the arm hangs from a shoulder that sits on the torso's edge
      expect(s.shoulder).toBeGreaterThan(s.chest * 0.95);
    }
  });

  test("builds go slight to broad, presentations differ the way the ADR says", () => {
    for (const presentation of PRESENTATIONS) {
      const b = BUILDS.map((body) => bodyShape({ presentation, body }));
      for (let i = 1; i < b.length; i++) {
        expect(b[i]!.shoulder).toBeGreaterThan(b[i - 1]!.shoulder);
        expect(b[i]!.limb).toBeGreaterThan(b[i - 1]!.limb);
        expect(b[i]!.waist).toBeGreaterThan(b[i - 1]!.waist);
      }
    }
    for (const body of BUILDS) {
      const f = bodyShape({ presentation: "feminine", body }), n = bodyShape({ presentation: "neutral", body }), m = bodyShape({ presentation: "masculine", body });
      expect(f.shoulder).toBeLessThan(n.shoulder);
      expect(n.shoulder).toBeLessThan(m.shoulder);
      expect(f.hip / f.waist).toBeGreaterThan(m.hip / m.waist);
      expect(f.height).toBeLessThan(m.height);
      expect(f.jaw).toBeLessThan(m.jaw);
      expect(f.bust).toBeGreaterThan(m.bust);
    }
    // the masculine average build stays close to soccer's player (shoulders 0.15)
    expect(Math.abs(bodyShape({ presentation: "masculine", body: 1 }).shoulder - 0.15)).toBeLessThan(0.01);
  });

  test("no appearance, or a bad one: neutral, average build", () => {
    for (const s of [bodyShape(), bodyShape(null), bodyShape({ presentation: "other" as never, body: 9 as never })]) {
      expect(s.presentation).toBe("neutral");
      expect(s.body).toBe(1);
    }
  });
});

describe("hair", () => {
  test("the library is the shared vocabulary: viz_cast.HAIR_STYLES, all 16", () => {
    expect([...HAIR_IDS]).toEqual(HAIR_STYLES.map((h) => h.id));
    expect(HAIR_IDS.length).toBe(16);
    expect(character.HAIR_STYLES).toBe(HAIR_IDS);
  });

  test("every style builds at every tier: in bounds, more detail up the tiers, cards from ultra", () => {
    for (const style of HAIR_IDS) {
      const counts: number[] = [];
      let ultraCards = 0;
      for (const tier of TIERS) {
        const h = hair(style, { tier, seed: 7 });
        expect(h.style).toBe(style);
        const vs = verts(h.geometry);
        expect(vs.length).toBeGreaterThan(0);
        // finite and on the head: within 0.25 sideways and back, from the shoulders to above the crown
        const out = vs.find((v) => !(Math.abs(v.x) <= 0.25 && Math.abs(v.z) <= 0.25 && v.y <= 0.22 && v.y >= -0.25));
        expect(out ? `${style} at ${tier}: ${out.toArray().join(",")}` : null).toBeNull();
        expect(h.geometry.getAttribute("normal").count).toBe(vs.length);
        expect(h.geometry.getAttribute("uv").count).toBe(vs.length);
        counts.push(vs.length);
        const wantCards = (tier === "ultra" || tier === "cinematic") && !NO_CARDS.includes(style);
        expect(h.cards !== null).toBe(wantCards);
        if (h.cards) {
          const n = h.cards.getIndex()!.count;
          if (tier === "ultra") ultraCards = n;
          else expect(n).toBeGreaterThan(ultraCards);
          expect(h.cards.getAttribute("uv").count).toBe(h.cards.getAttribute("position").count);
        }
        expect(h.cloth).toBe(style === "headscarf" || style === "hijab");
        h.dispose();
      }
      expect(counts[0]!).toBeLessThan(counts[2]!);
      expect(counts[1]!).toBeLessThanOrEqual(counts[2]!);
      // the 2D map: fewer segments, no cards
      const flat = hair(style, { tier: "cinematic", flat: true });
      expect(flat.cards).toBeNull();
      expect(verts(flat.geometry).length).toBeLessThan(counts[4]!);
      flat.dispose();
    }
  });

  test("the face stays open: no hair or card over the eyes and mouth", () => {
    for (const style of HAIR_IDS) {
      for (const tier of ["minimal", "full", "cinematic"] as const) {
        const h = hair(style, { tier });
        for (const g of [h.geometry, h.cards]) {
          if (!g) continue;
          for (const v of verts(g)) {
            const th = thetaOf(v);
            if (v.z > 0 && th > 1.15 && th < 1.95 && fromFront(v) < 0.55 && v.length() < HEAD_R + 0.06) {
              throw new Error(`${style} at ${tier} covers the face at ${v.toArray().map((n) => n.toFixed(3))}`);
            }
          }
        }
        h.dispose();
      }
    }
  });

  test("capSafe: nothing above the brim reaches past CAP_RADIUS, and hair still shows below it", () => {
    for (const style of HAIR_IDS) {
      for (const tier of TIERS) {
        const h = hair(style, { tier, capSafe: true });
        let shows = false;
        for (const g of [h.geometry, h.cards]) {
          if (!g) continue;
          for (const v of verts(g)) {
            const th = thetaOf(v);
            if (th < CAP_LINE && v.length() > CAP_R + 1e-9) throw new Error(`${style} capSafe at ${tier} pokes through a hat at ${v.toArray().map((n) => n.toFixed(4))}`);
            if (th > CAP_LINE && v.length() > HEAD_R + 0.002) shows = true;
          }
        }
        expect(shows).toBe(true);
        h.dispose();
      }
    }
  });

  test("unknown ids map to the nearest style; headRadius scales; dispose frees both geometries", () => {
    expect(resolveHairStyle("tail")).toBe("ponytail");
    expect(resolveHairStyle("Dreadlocks")).toBe("locs");
    expect(resolveHairStyle("mohawk")).toBe("short");
    expect(hair("curly", { tier: "minimal" }).style).toBe("curls");
    const a = hair("bob", { tier: "minimal" }), b = hair("bob", { tier: "minimal", headRadius: HEAD_R * 2 });
    a.geometry.computeBoundingSphere();
    b.geometry.computeBoundingSphere();
    expect(b.geometry.boundingSphere!.radius).toBeCloseTo(a.geometry.boundingSphere!.radius * 2, 6);
    a.dispose();
    b.dispose();
    const h = hair("long", { tier: "ultra" });
    let freed = 0;
    h.geometry.addEventListener("dispose", () => freed++);
    h.cards!.addEventListener("dispose", () => freed++);
    h.dispose();
    expect(freed).toBe(2);
  });
});

describe("torso", () => {
  test("the template's ring heights, the shape's chest, waist and depth", () => {
    for (const shape of SHAPES) {
      // ultra: 28 segments, so a column sits straight behind (the depth check reads it)
      const g = torso({ shape, tier: "ultra" });
      const vs = verts(g);
      const ys = [...new Set(vs.map((v) => v.y))].sort((p, q) => p - q);
      expect(ys.length).toBe(TORSO_HEIGHTS.length);
      ys.forEach((y, i) => expect(y).toBeCloseTo(TORSO_HEIGHTS[i]! * shape.height, 6));
      const ringX = (y: number): number => Math.max(...vs.filter((v) => Math.abs(v.y - y * shape.height) < 1e-6).map((v) => Math.abs(v.x)));
      expect(ringX(0.18)).toBeCloseTo(shape.chest, 4);
      expect(ringX(-0.02)).toBeCloseTo(shape.waist, 4);
      // the shoulder yoke carries the shirt out under the sleeve cap, short of the joint
      expect(ringX(0.235)).toBeLessThan(shape.shoulder);
      expect(ringX(0.235)).toBeGreaterThanOrEqual(0.9 * shape.shoulder);
      const back = Math.max(...vs.filter((v) => Math.abs(v.y - 0.18 * shape.height) < 1e-6).map((v) => -v.z));
      expect(back).toBeCloseTo(shape.chest * shape.depth, 3);
      g.dispose();
    }
    const fem = torso({ shape: bodyShape({ presentation: "feminine", body: 1 }), tier: "minimal" });
    const full = torso({ shape: bodyShape({ presentation: "feminine", body: 1 }), tier: "full" });
    expect(fem.getAttribute("position").count).toBeLessThan(full.getAttribute("position").count);
    fem.dispose();
    full.dispose();
  });
});

/** A 2D context that records calls (no DOM in bun test). */
function recorder(): { ctx: CanvasRenderingContext2D; calls: string[] } {
  const calls: string[] = [];
  const grad = { addColorStop: () => undefined };
  const state: Record<string, unknown> = {};
  const ctx = new Proxy(state, {
    get: (_t, k: string) => (k in state ? state[k] : (...args: unknown[]) => { calls.push(`${k}(${args.map((a) => (typeof a === "number" ? a.toFixed(1) : String(a))).join(",")})`); return k.startsWith("create") ? grad : undefined; }),
    set: (_t, k: string, v: unknown) => { state[k] = v; calls.push(`${k}=${String(v)}`); return true; },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

const look = (presentation: WorldAppearance["presentation"], f: number, hairColor = "#2e1f16"): WorldAppearance => ({
  presentation, body: 1, skin: "#c08560", skinIndex: 4, skinBand: "medium", hair: "short", hairColor, face: f,
});

describe("face features", () => {
  test("no role-locked beards: only the explicit option draws one", () => {
    for (const p of PRESENTATIONS) for (let v = 0; v < 8; v++) expect(faceFeatures(look(p, v)).beard).toBe("none");
    expect(faceFeatures(look("feminine", 0), { beard: "full" }).beard).toBe("full");
  });

  test("lashes, lip tint and blush by presentation; freckles and glasses by variant", () => {
    for (let v = 0; v < 8; v++) {
      const f = faceFeatures(look("feminine", v)), m = faceFeatures(look("masculine", v));
      expect(f.lashes).toBeGreaterThan(0);
      expect(f.blush).not.toBeNull();
      expect(f.lipTint === null).toBe(v === 5);
      expect(m.lashes).toBe(v === 5 ? 1 : 0);
      expect(m.lipTint).toBeNull();
      expect(f.browWidth).toBeLessThan(m.browWidth);
      for (const p of PRESENTATIONS) {
        const x = faceFeatures(look(p, v));
        expect(x.freckles).toBe(v === 2 || v === 6);
        expect(x.glasses !== null).toBe(v === 4 || v === 7);
      }
    }
    expect(faceFeatures(look("neutral", 4), { glasses: false }).glasses).toBeNull();
    expect(faceFeatures(look("neutral", 0), { glasses: "#ff0000" }).glasses).toBe("#ff0000");
    expect(faceFeatures(look("neutral", 0), { glasses: true }).glasses).not.toBeNull();
  });

  test("brows: natural hair darkens, fashion colors get a natural brown", () => {
    expect(faceFeatures(look("neutral", 0, "#3fa7ff")).browColor).toBe("#3b2a20");
    const plat = faceFeatures(look("neutral", 0, "#e6d8b8")).browColor;
    expect(parseInt(plat.slice(1, 3), 16)).toBeLessThan(0xe6);
    expect(faceFeatures(null).lashes).toBe(1); // neutral, variant 0
  });

  test("the painter wraps the world's own eyes and mouth: balanced state, scaled, features follow the expression", () => {
    const paint = (a: WorldAppearance, opts = {}, st = {}): string[] => {
      const r = recorder();
      const p = face(a, opts);
      p.under(r.ctx, 2, st);
      p.over(r.ctx, 2, st);
      expect(r.calls.filter((c) => c.startsWith("save(")).length).toBe(2);
      expect(r.calls.filter((c) => c.startsWith("restore(")).length).toBe(2);
      expect(r.calls.filter((c) => c === "setTransform(2.0,0.0,0.0,2.0,0.0,0.0)").length).toBe(2);
      return r.calls;
    };
    const strokes = (c: string[]): number => c.filter((x) => x === "stroke()").length;
    // lashes add strokes; a masculine variant 0 face only draws its brows
    expect(strokes(paint(look("feminine", 0)))).toBeGreaterThan(strokes(paint(look("masculine", 0))));
    expect(strokes(paint(look("masculine", 0)))).toBe(2);
    // the lip tint sits under a closed mouth only
    const tint = (c: string[]): boolean => c.some((x) => x.startsWith("ellipse(128.0,132.0"));
    expect(tint(paint(look("feminine", 0)))).toBe(true);
    expect(tint(paint(look("feminine", 0), {}, { mouthOpen: true }))).toBe(false);
    // a beard only when asked, and the full one adds the mustache over the mouth
    const fills = (c: string[]): number => c.filter((x) => x === "fill()").length;
    expect(fills(paint(look("masculine", 0), { beard: "full" }))).toBe(fills(paint(look("masculine", 0))) + 2);
    // glasses (variant 4) frame both eyes
    expect(paint(look("neutral", 4)).filter((x) => x.startsWith("roundRect(")).length).toBe(2);
  });
});
