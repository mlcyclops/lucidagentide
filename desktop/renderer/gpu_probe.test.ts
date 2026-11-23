// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-VIZ.GPU1 (ADR-0651): the GPU classifier decides whether Visualize starts at minimal, full or ultra, so it is
// proven over real renderer strings (ANGLE on Windows and macOS, Mesa on Linux, software rasterizers) and over
// Electron's feature status and PCI vendor ids.

import { describe, expect, test } from "bun:test";
import { classifyGpu, classifyRenderer, parseElectronGpu, probeGpu, shortGpuName, softwareByFeatureStatus, type ElectronGpuInfo } from "./gpu_probe.ts";

const ELECTRON: ElectronGpuInfo = { featureStatus: { gpu_compositing: "enabled", webgl: "enabled" }, devices: [], glRenderer: null, glVendor: null };

describe("classifyRenderer - known renderer strings", () => {
  const cases: [string, "software" | "integrated" | "discrete"][] = [
    ["Google SwiftShader", "software"],
    ["ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)", "software"],
    ["llvmpipe (LLVM 15.0.7, 256 bits)", "software"],
    ["ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0, D3D11)", "software"],
    ["ANGLE (Intel, Intel(R) UHD Graphics 620 (0x00005917) Direct3D11 vs_5_0 ps_5_0, D3D11)", "integrated"],
    ["ANGLE (Intel, Intel(R) Iris(R) Xe Graphics (0x00009A49) Direct3D11 vs_5_0 ps_5_0, D3D11)", "integrated"],
    ["ANGLE (Intel, Intel(R) Arc(TM) Graphics (0x00007D55) Direct3D11 vs_5_0 ps_5_0, D3D11)", "integrated"],
    ["Mesa Intel(R) UHD Graphics 620 (KBL GT2)", "integrated"],
    ["ANGLE (AMD, AMD Radeon(TM) Graphics (0x00001638) Direct3D11 vs_5_0 ps_5_0, D3D11)", "integrated"],
    ["ANGLE (AMD, AMD Radeon(TM) RX Vega 10 Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)", "integrated"],
    ["ANGLE (AMD, AMD Radeon 780M Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)", "integrated"],
    ["ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)", "integrated"],
    ["ANGLE (Qualcomm, Adreno (TM) 690, OpenGL ES 3.2)", "integrated"],
    ["Mali-G78", "integrated"],
    ["ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 (0x00002786) Direct3D11 vs_5_0 ps_5_0, D3D11)", "discrete"],
    ["ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Laptop GPU (0x00002560) Direct3D11 vs_5_0 ps_5_0, D3D11)", "discrete"],
    ["NVIDIA GeForce GTX 1080/PCIe/SSE2", "discrete"],
    ["ANGLE (NVIDIA, NVIDIA RTX A4000 Direct3D11 vs_5_0 ps_5_0, D3D11)", "discrete"],
    ["ANGLE (AMD, AMD Radeon RX 6800 XT Direct3D11 vs_5_0 ps_5_0, D3D11)", "discrete"],
    ["AMD Radeon Pro 5500M OpenGL Engine", "discrete"],
    ["ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Max, Unspecified Version)", "discrete"],
    ["ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Pro, Unspecified Version)", "discrete"],
    ["ANGLE (Intel, Intel(R) Arc(TM) A770 Graphics (0x000056A0) Direct3D11 vs_5_0 ps_5_0, D3D11)", "discrete"],
  ];
  for (const [s, cls] of cases) test(`${cls}: ${s}`, () => { expect(classifyRenderer(s)).toBe(cls); });
  test("empty or unknown strings are unknown (null), never a guess", () => {
    expect(classifyRenderer(null)).toBeNull();
    expect(classifyRenderer("")).toBeNull();
    expect(classifyRenderer("WebKit WebGL")).toBeNull();
  });
});

describe("shortGpuName - the Quality label's GPU name", () => {
  test("strips the ANGLE wrapper, vendor words, API suffixes and PCI ids", () => {
    expect(shortGpuName("ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 (0x00002786) Direct3D11 vs_5_0 ps_5_0, D3D11)")).toBe("RTX 4070");
    expect(shortGpuName("ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Laptop GPU (0x00002560) Direct3D11 vs_5_0 ps_5_0, D3D11)")).toBe("RTX 3060 Laptop GPU");
    expect(shortGpuName("ANGLE (Intel, Intel(R) UHD Graphics 620 (0x00005917) Direct3D11 vs_5_0 ps_5_0, D3D11)")).toBe("UHD Graphics 620");
    expect(shortGpuName("ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Max, Unspecified Version)")).toBe("Apple M2 Max");
    expect(shortGpuName("ANGLE (AMD, AMD Radeon RX 6800 XT Direct3D11 vs_5_0 ps_5_0, D3D11)")).toBe("Radeon RX 6800 XT");
    expect(shortGpuName("NVIDIA GeForce GTX 1080/PCIe/SSE2")).toBe("GTX 1080");
    expect(shortGpuName("Mesa Intel(R) UHD Graphics 620 (KBL GT2)")).toBe("UHD Graphics 620");
  });
  test("software rasterizers get their own name", () => {
    expect(shortGpuName("Google SwiftShader")).toBe("SwiftShader");
    expect(shortGpuName("ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0, D3D11)")).toBe("Basic Render Driver");
    expect(shortGpuName("llvmpipe (LLVM 15.0.7, 256 bits)")).toBe("llvmpipe");
  });
  test("long names are capped with an ellipsis; nothing gives null", () => {
    const n = shortGpuName("A Very Long Experimental Accelerator Name Model 9000 Ti Super");
    expect(n!.length).toBeLessThanOrEqual(28);
    expect(n!.endsWith("\u2026")).toBe(true);
    expect(shortGpuName(null)).toBeNull();
    expect(shortGpuName("   ")).toBeNull();
  });
});

describe("softwareByFeatureStatus - Chromium's own verdict", () => {
  test("software compositing or WebGL without hardware is software", () => {
    expect(softwareByFeatureStatus({ gpu_compositing: "disabled_software", webgl: "enabled" })).toBe(true);
    expect(softwareByFeatureStatus({ gpu_compositing: "enabled", webgl: "unavailable_software" })).toBe(true);
    expect(softwareByFeatureStatus({ gpu_compositing: "enabled", webgl: "unavailable_off" })).toBe(true);
  });
  test("hardware compositing and WebGL are not; missing info is not", () => {
    expect(softwareByFeatureStatus({ gpu_compositing: "enabled", webgl: "enabled" })).toBe(false);
    expect(softwareByFeatureStatus({})).toBe(false);
    expect(softwareByFeatureStatus(null)).toBe(false);
  });
});

describe("classifyGpu - signal precedence", () => {
  test("Chromium's software verdict beats a discrete-looking string", () => {
    const p = classifyGpu({ renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0, D3D11)", electron: { ...ELECTRON, featureStatus: { gpu_compositing: "disabled_software" } } });
    expect(p.cls).toBe("software");
    expect(p.source).toBe("feature-status");
  });
  test("no WebGL context at all is software", () => {
    expect(classifyGpu({ renderer: null, webglMissing: true, electron: null }).cls).toBe("software");
  });
  test("the page's WebGL string decides next, with its short name", () => {
    const p = classifyGpu({ renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0, D3D11)", electron: ELECTRON });
    expect(p).toEqual({ cls: "discrete", name: "RTX 4070", renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0, D3D11)", source: "webgl" });
  });
  test("then Electron's GL string, then the active device's PCI vendor", () => {
    expect(classifyGpu({ renderer: null, electron: { ...ELECTRON, glRenderer: "Intel(R) UHD Graphics 630" } })).toMatchObject({ cls: "integrated", source: "electron" });
    const devices = [{ vendorId: 0x8086, deviceId: 0x3e92, active: false }, { vendorId: 0x10de, deviceId: 0x2786, active: true }];
    expect(classifyGpu({ renderer: null, electron: { ...ELECTRON, devices } })).toMatchObject({ cls: "discrete", source: "vendor-id" });
    expect(classifyGpu({ renderer: null, electron: { ...ELECTRON, devices: [{ vendorId: 0x1414, deviceId: 0x8c, active: true }] } }).cls).toBe("software");
  });
  test("an ambiguous vendor (AMD) or nothing at all stays unknown", () => {
    expect(classifyGpu({ renderer: null, electron: { ...ELECTRON, devices: [{ vendorId: 0x1002, deviceId: 0x73bf, active: true }] } }).cls).toBeNull();
    expect(classifyGpu({ renderer: null, electron: null })).toEqual({ cls: null, name: null, renderer: null, source: "none" });
  });
});

describe("parseElectronGpu - the IPC payload is validated", () => {
  test("keeps only well-typed fields", () => {
    const p = parseElectronGpu({ featureStatus: { webgl: "enabled", junk: 3 }, devices: [{ vendorId: 0x10de, deviceId: 1, active: true }, { vendorId: "x" }], glRenderer: "GL", glVendor: 7 });
    expect(p).toEqual({ featureStatus: { webgl: "enabled" }, devices: [{ vendorId: 0x10de, deviceId: 1, active: true }], glRenderer: "GL", glVendor: null });
  });
  test("non-objects are null", () => {
    expect(parseElectronGpu(null)).toBeNull();
    expect(parseElectronGpu("gpu")).toBeNull();
  });
});

describe("probeGpu - outside a DOM", () => {
  test("answers unknown without throwing (no document, no preload)", async () => {
    expect((await probeGpu()).cls).toBeNull();
  });
});
