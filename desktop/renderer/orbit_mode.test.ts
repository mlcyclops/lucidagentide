// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/orbit_mode.test.ts - P-FLEET.L17: the motion-vs-Lite gate, pinned as a spec. Each
// rule exists because a real class of machine needs it; the precedence (user > accessibility > GPU
// evidence > memory > measurement) is the contract fleet_orbit renders by.

import { describe, expect, test } from "bun:test";
import { ORBIT_FPS_FLOOR, orbitMode, type OrbitEnv } from "./orbit_layout.ts";

const capable: OrbitEnv = { override: null, reducedMotion: false, webglRenderer: "ANGLE (NVIDIA GeForce RTX 4090 Direct3D11)", deviceMemoryGB: 32 };

describe("orbitMode", () => {
  test("a capable machine gets motion", () => {
    expect(orbitMode(capable)).toBe("motion");
  });
  test("an explicit user override beats every probe, both ways", () => {
    expect(orbitMode({ ...capable, override: "static" })).toBe("static");
    expect(orbitMode({ override: "motion", reducedMotion: true, webglRenderer: "Google SwiftShader", deviceMemoryGB: 1, measuredFps: 5 })).toBe("motion");
  });
  test("prefers-reduced-motion is an accessibility contract, not a suggestion", () => {
    expect(orbitMode({ ...capable, reducedMotion: true })).toBe("static");
  });
  test("a software rasterizer (or no WebGL at all) means static", () => {
    expect(orbitMode({ ...capable, webglRenderer: "Google SwiftShader" })).toBe("static");
    expect(orbitMode({ ...capable, webglRenderer: "llvmpipe (LLVM 15.0.7, 256 bits)" })).toBe("static");
    expect(orbitMode({ ...capable, webglRenderer: null })).toBe("static");
  });
  test("2GB or less of reported memory means static; unreported memory is NOT a signal", () => {
    expect(orbitMode({ ...capable, deviceMemoryGB: 2 })).toBe("static");
    expect(orbitMode({ ...capable, deviceMemoryGB: undefined })).toBe("motion");
  });
  test("a measured frame rate under the floor overrides an otherwise capable probe", () => {
    expect(orbitMode({ ...capable, measuredFps: ORBIT_FPS_FLOOR - 1 })).toBe("static");
    expect(orbitMode({ ...capable, measuredFps: ORBIT_FPS_FLOOR })).toBe("motion");
  });
});
