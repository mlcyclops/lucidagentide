// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/viz_plasma_math.test.ts - P-VIZ.4 (ADR-0626): the edge math. The conduit grows smoothly
// with intensity, idle plasma sends no pulses while idle fiber flickers, fiber light outruns plasma orbs,
// budgets shrink with the tier and vanish under reduced motion, and the tube geometry is round in 3D, flat in
// 2D, wound outward, and survives a vertical edge.

import { describe, expect, test } from "bun:test";
import {
  arcLengths, edgeBow, edgeBudget, edgeLift, edgeStyleFor, FIBER_IDLE_RATE, FLARE_MS, flareFront, flareLevel, plasmaLook, pointAt,
  pulseRate, pulseSize, pulseSpeed, raySegment, sampleCircle, sampleQuadratic, tokenOrbit, tokenRate, tokenSize, tokenSpeed,
  tubeIndex, writeTube, type PlasmaLook, type TubeOut,
} from "./viz_plasma_math.ts";

const look = (i: number): PlasmaLook => plasmaLook(i, { radius: 0, spin: 0, flow: 0, breath: 0 });

function tubeFor(n: number, radial: number): TubeOut {
  const v = n * (radial + 1);
  return { pos: new Float32Array(v * 3), nrm: new Float32Array(v * 3), dir: new Float32Array(v * 3), uv: new Float32Array(v * 2) };
}

describe("styles and budgets", () => {
  test("the scene style picks the edge style", () => {
    expect(edgeStyleFor("anime")).toBe("plasma");
    expect(edgeStyleFor("professional")).toBe("fiber");
  });

  test("budgets shrink with the tier; reduced motion has no pulses", () => {
    const full = edgeBudget("full", 6000, true), red = edgeBudget("reduced", 2500, true), min = edgeBudget("minimal", 600, true);
    expect(full.pulses).toBe(150);
    expect(red.pulses).toBeLessThan(full.pulses);
    expect(min.pulses).toBeLessThan(red.pulses);
    expect(min.pulses).toBeGreaterThan(0);
    expect(full.rings).toBeGreaterThan(red.rings);
    expect(red.rings).toBeGreaterThan(min.rings);
    expect(full.octaves).toBeGreaterThan(min.octaves);
    expect(full.halo && !red.halo && !min.halo).toBe(true);
    expect(min.warp).toBe(false);
    expect(edgeBudget("full", 0, false).pulses).toBe(0);
    // The stream particles come out of the same tier budget, many more of them than orbs, none without motion.
    expect(full.tokens).toBeGreaterThan(full.pulses * 4);
    expect(full.pulses + full.tokens).toBeLessThanOrEqual(6000);
    expect(red.tokens).toBeLessThan(full.tokens);
    expect(min.tokens).toBeLessThan(red.tokens);
    expect(min.tokens).toBeGreaterThan(0);
    expect(edgeBudget("full", 6000, false).tokens).toBe(0);
  });
});

describe("arcs", () => {
  test("an agent's stream arcs clearly over, scaling with distance; a subagent's link stays lower", () => {
    // a quadratic peaks at half its control lift: well above a tenth of the chord, double P-VIZ.4's 0.08
    expect(edgeLift(10, false) / 2).toBeGreaterThanOrEqual(10 * 0.15);
    expect(edgeLift(10, false)).toBeCloseTo(2 * edgeLift(5, false), 9);
    expect(edgeLift(4, true)).toBeLessThan(edgeLift(4, false));
    expect(edgeBow(4, true)).toBeLessThan(edgeBow(4, false));
    expect(edgeLift(-1, false)).toBe(0);
  });
});

describe("looks", () => {
  test("the plasma conduit grows continuously: thicker, faster spin and flow", () => {
    let prev = look(0);
    expect(prev.radius).toBeGreaterThan(0); // always present at idle
    for (let i = 0.1; i <= 1.0001; i += 0.1) {
      const l = look(i);
      expect(l.radius).toBeGreaterThan(prev.radius);
      expect(l.spin).toBeGreaterThan(prev.spin);
      expect(l.flow).toBeGreaterThan(prev.flow);
      prev = l;
    }
    expect(look(1).spin / look(0).spin).toBeGreaterThan(10); // a lazy drift at idle, a hard spin at a burst
    expect(look(2).radius).toBe(look(1).radius); // clamped
    // P-VIZ.5: thin: a hairline at idle, still modest at a burst
    expect(look(0).radius).toBeLessThan(0.025);
    expect(look(1).radius).toBeLessThan(0.07);
  });

  test("token particles: denser, faster, bigger and wider with intensity; never zero at idle", () => {
    expect(tokenRate(0)).toBeGreaterThan(0);
    expect(tokenRate(1)).toBeGreaterThan(tokenRate(0) * 20);
    expect(tokenRate(1)).toBeGreaterThan(pulseRate("plasma", 1) * 5); // a swarm around a few orbs
    expect(tokenSpeed(1, 6)).toBeGreaterThan(tokenSpeed(0, 6));
    expect(tokenSpeed(1, 0.2)).toBeLessThanOrEqual(4); // never a single-frame blink on a short edge
    expect(tokenSize(1)).toBeGreaterThan(tokenSize(0));
    expect(tokenSize(1)).toBeLessThan(pulseSize("plasma", 0)); // small next to the orbs
    expect(tokenOrbit(1)).toBeGreaterThan(tokenOrbit(0));
    expect(tokenOrbit(0)).toBeGreaterThan(look(0).radius); // they swirl around the conduit, not inside it
  });

  test("idle plasma sends no pulses; idle fiber flickers now and then", () => {
    expect(pulseRate("plasma", 0)).toBe(0);
    expect(pulseRate("fiber", 0)).toBe(FIBER_IDLE_RATE);
    expect(FIBER_IDLE_RATE).toBeLessThan(0.5);
  });

  test("pulse rate rises with intensity, fiber far faster than plasma", () => {
    for (const s of ["plasma", "fiber"] as const) {
      expect(pulseRate(s, 1)).toBeGreaterThan(pulseRate(s, 0.5));
      expect(pulseRate(s, 0.5)).toBeGreaterThan(pulseRate(s, 0.1));
    }
    expect(pulseRate("fiber", 1)).toBeGreaterThan(pulseRate("plasma", 1) * 3);
  });

  test("pulses speed up with intensity; fiber light outruns plasma orbs; orbs are bigger", () => {
    expect(pulseSpeed("plasma", 1, 6)).toBeGreaterThan(pulseSpeed("plasma", 0, 6));
    expect(pulseSpeed("fiber", 1, 6)).toBeGreaterThan(pulseSpeed("fiber", 0, 6));
    for (const i of [0, 0.5, 1]) expect(pulseSpeed("fiber", i, 6)).toBeGreaterThan(pulseSpeed("plasma", i, 6) * 2);
    expect(1 / pulseSpeed("fiber", 1, 0.5)).toBeGreaterThanOrEqual(0.18 - 1e-9); // never a single-frame blink
    expect(pulseSize("plasma", 1)).toBeGreaterThan(pulseSize("plasma", 0));
    expect(pulseSize("plasma", 0)).toBeGreaterThan(pulseSize("fiber", 1));
  });

  test("the surge flare peaks at once and fades out by FLARE_MS; its front crosses the edge", () => {
    expect(flareLevel(-1)).toBe(0);
    expect(flareLevel(0)).toBe(1);
    expect(flareLevel(200)).toBeLessThan(1);
    expect(flareLevel(600)).toBeLessThan(flareLevel(200));
    expect(flareLevel(FLARE_MS)).toBe(0);
    expect(flareFront(0)).toBe(0);
    expect(flareFront(10_000)).toBe(1);
  });
});

describe("paths", () => {
  test("a bezier sample starts and ends on its endpoints; a straight one has the chord's length", () => {
    const out = new Float32Array(9 * 3), arc = new Float32Array(9);
    sampleQuadratic([0, 0, 0, 2, 0, 0, 4, 0, 0], 9, out);
    expect([out[0], out[1], out[2]]).toEqual([0, 0, 0]);
    expect([out[24], out[25], out[26]]).toEqual([4, 0, 0]);
    expect(arcLengths(out, 9, arc)).toBeCloseTo(4, 5);
  });

  test("a loop closes onto itself and has the circle's length", () => {
    const n = 65, out = new Float32Array(n * 3), arc = new Float32Array(n);
    sampleCircle(1, 2, 3, 1.5, n, out);
    expect(out[(n - 1) * 3]).toBe(out[0]!);
    expect(out[(n - 1) * 3 + 2]).toBe(out[2]!);
    expect(out[1]).toBe(2);
    expect(arcLengths(out, n, arc)).toBeCloseTo(2 * Math.PI * 1.5, 1);
  });

  test("walking by arc length: the midpoint, the tangent, clamping open and wrapping closed", () => {
    const c = new Float32Array([0, 0, 0, 1, 0, 0, 3, 0, 0]), arc = new Float32Array(3);
    arcLengths(c, 3, arc);
    const p = new Float32Array(3), t = new Float32Array(3);
    pointAt(c, arc, 3, 2, false, p, t);
    expect(p[0]).toBeCloseTo(2, 6);
    expect(t[0]).toBeCloseTo(1, 6);
    pointAt(c, arc, 3, 9, false, p, t);
    expect(p[0]).toBeCloseTo(3, 6);
    pointAt(c, arc, 3, 3.5, true, p, t);
    expect(p[0]).toBeCloseTo(0.5, 6);
  });

  test("the ray-segment distance", () => {
    const out = new Float64Array(2);
    raySegment([0, 5, 0], [0, -1, 0], [-1, 0, 0], [1, 0, 0], out); // straight down onto the segment
    expect(out[0]).toBeCloseTo(0, 9);
    expect(out[1]).toBeCloseTo(5, 9);
    raySegment([0, 5, 2], [0, -1, 0], [-1, 0, 0], [1, 0, 0], out); // passes 2 units beside it
    expect(Math.sqrt(out[0]!)).toBeCloseTo(2, 9);
    raySegment([5, 5, 0], [0, -1, 0], [-1, 0, 0], [1, 0, 0], out); // beyond the end: distance to the endpoint
    expect(Math.sqrt(out[0]!)).toBeCloseTo(4, 9);
    raySegment([0, 5, 0], [0, 1, 0], [-1, 0, 0], [1, 0, 0], out); // pointing away: the origin is closest
    expect(Math.sqrt(out[0]!)).toBeCloseTo(5, 9);
    expect(out[1]).toBe(0);
  });
});

describe("the tube", () => {
  const n = 9, radial = 8, R = 0.05;
  const centers = new Float32Array(n * 3), arc = new Float32Array(n);
  sampleQuadratic([0, 0, 0, 2, 1, 0.5, 4, 0, 0], n, centers);
  arcLengths(centers, n, arc);

  test("3D: every vertex sits on the radius, with a unit outward normal", () => {
    const out = tubeFor(n, radial);
    writeTube(centers, arc, n, radial, R, 1, false, [0, 0, 1], out);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j <= radial; j++) {
        const k = (i * (radial + 1) + j) * 3;
        const dx = out.pos[k]! - centers[i * 3]!, dy = out.pos[k + 1]! - centers[i * 3 + 1]!, dz = out.pos[k + 2]! - centers[i * 3 + 2]!;
        expect(Math.hypot(dx, dy, dz)).toBeCloseTo(R, 5);
        expect(Math.hypot(out.nrm[k]!, out.nrm[k + 1]!, out.nrm[k + 2]!)).toBeCloseTo(1, 5);
        expect(out.nrm[k]! * dx + out.nrm[k + 1]! * dy + out.nrm[k + 2]! * dz).toBeGreaterThan(0);
      }
    }
    expect(out.uv[(n - 1) * (radial + 1) * 2]).toBeCloseTo(arc[n - 1]!, 5); // u is the arc length
  });

  test("2D: the squashed tube is a flat ribbon, as wide as the 3D tube", () => {
    const flat = new Float32Array(n * 3), farc = new Float32Array(n);
    sampleQuadratic([0, 0, 0, 2, 0, 0.5, 4, 0, 0], n, flat);
    arcLengths(flat, n, farc);
    const out = tubeFor(n, radial);
    writeTube(flat, farc, n, radial, R, 0.2, false, [0, 0, 1], out);
    let maxY = 0, maxW = 0;
    for (let v = 0; v < n * (radial + 1); v++) {
      maxY = Math.max(maxY, Math.abs(out.pos[v * 3 + 1]!));
      maxW = Math.max(maxW, Math.abs(out.dir[v * 3]!), Math.abs(out.dir[v * 3 + 2]!));
    }
    expect(maxY).toBeLessThanOrEqual(R * 0.2 + 1e-6);
    expect(maxW).toBeCloseTo(1, 2);
  });

  test("a vertical edge (no horizontal side) uses the fallback and stays finite", () => {
    const up = new Float32Array([0, 0, 0, 0, 1, 0, 0, 2, 0]), uarc = new Float32Array(3);
    arcLengths(up, 3, uarc);
    const out = tubeFor(3, radial);
    writeTube(up, uarc, 3, radial, R, 1, false, [1, 0, 0], out);
    for (const x of out.pos) expect(Number.isFinite(x)).toBe(true);
    expect(Math.hypot(out.pos[0]!, out.pos[1]!, out.pos[2]!)).toBeCloseTo(R, 5);
  });

  test("triangles face outward", () => {
    const out = tubeFor(n, radial);
    writeTube(centers, arc, n, radial, R, 1, false, [0, 0, 1], out);
    const idx = tubeIndex(n, radial);
    expect(idx.length).toBe((n - 1) * radial * 6);
    for (let f = 0; f < idx.length; f += 3) {
      const a = idx[f]! * 3, b = idx[f + 1]! * 3, c = idx[f + 2]! * 3;
      const ux = out.pos[b]! - out.pos[a]!, uy = out.pos[b + 1]! - out.pos[a + 1]!, uz = out.pos[b + 2]! - out.pos[a + 2]!;
      const vx = out.pos[c]! - out.pos[a]!, vy = out.pos[c + 1]! - out.pos[a + 1]!, vz = out.pos[c + 2]! - out.pos[a + 2]!;
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const avg = (out.nrm[a]! + out.nrm[b]! + out.nrm[c]!) * nx + (out.nrm[a + 1]! + out.nrm[b + 1]! + out.nrm[c + 1]!) * ny + (out.nrm[a + 2]! + out.nrm[b + 2]! + out.nrm[c + 2]!) * nz;
      expect(avg).toBeGreaterThan(0);
    }
  });
});
