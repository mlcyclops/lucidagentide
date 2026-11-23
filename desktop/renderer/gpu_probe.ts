// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/gpu_probe.ts - P-VIZ.GPU1 (ADR-0651): which GPU renders this window, and how strong it is.
//
// Two sources, both read-only:
//   - the page's WebGL `UNMASKED_RENDERER_WEBGL` string (WEBGL_debug_renderer_info), read once from a throwaway
//     context that asks for the same `powerPreference: "high-performance"` adapter Visualize renders on, then
//     released (WEBGL_lose_context). Fleet orbit's Lite gate reads the same string (fleet_orbit.ts).
//   - Electron's `app.getGPUFeatureStatus()` and `app.getGPUInfo("basic")`, read in main and passed through the
//     preload (`window.lucid.gpuInfo()`); absent in a plain browser.
// The result is classified software | integrated | discrete (null = unknown: callers never degrade on it).
// The classifier and the name shortener are pure and tested headlessly (gpu_probe.test.ts).

export type GpuClass = "software" | "integrated" | "discrete";

/** What main reports (sanitized again here: IPC data is untyped). */
export interface ElectronGpuInfo {
  /** app.getGPUFeatureStatus(): feature -> status ("enabled", "disabled_software", "unavailable_off", ...). */
  featureStatus: Record<string, string>;
  /** app.getGPUInfo("basic").gpuDevice: PCI vendor and device ids, and which one Chromium uses. */
  devices: { vendorId: number; deviceId: number; active: boolean }[];
  /** auxAttributes.glRenderer / glVendor when the basic info carries them (platform dependent). */
  glRenderer: string | null;
  glVendor: string | null;
}

export interface GpuProbe {
  /** null = not known (no WebGL string, no Electron info): the tier resolver ignores it. */
  cls: GpuClass | null;
  /** A short display name ("RTX 4070", "Apple M2 Max", "SwiftShader"), or null. */
  name: string | null;
  /** The raw renderer string the class came from, or null. */
  renderer: string | null;
  /** Which signal decided the class. */
  source: "feature-status" | "webgl" | "electron" | "vendor-id" | "none";
}

/** Software rasterizers: no GPU is coming (Fleet orbit's Lite gate uses the same rule, orbit_layout.ts). */
export const SOFTWARE_GL = /swiftshader|llvmpipe|softpipe|software|basic render/i;
/** AMD APUs name themselves "... Radeon(TM) Graphics", "Radeon Vega 8 Graphics", "Radeon 780M Graphics". */
const AMD_APU = /radeon.*\bgraphics\b/i;
const DISCRETE = /nvidia|geforce|quadro|\brtx\b|\bgtx\b|tesla|firepro|radeon\s*(\((tm|r)\)\s*)?(rx|pro|r9|r7|vii)\b|apple m\d+\s*(pro|max|ultra)\b|arc(\((tm|r)\))?\s*[ab]\d{3}\b/i;
const INTEGRATED = /intel|\bamd\b|radeon|apple|adreno|mali|powervr|qualcomm|vivante|videocore|\bati\b/i;

/** PCI vendor ids, for when no renderer string is readable. AMD (0x1002) is ambiguous (APU or card): unknown. */
const VENDOR_CLASS: ReadonlyMap<number, GpuClass> = new Map<number, GpuClass>([
  [0x10de, "discrete"], // NVIDIA
  [0x8086, "integrated"], // Intel (an Arc card reads integrated here: conservative)
  [0x106b, "integrated"], // Apple
  [0x5143, "integrated"], // Qualcomm
  [0x13b5, "integrated"], // ARM
  [0x1414, "software"], // Microsoft (Basic Render Driver, WARP)
  [0x1ae0, "software"], // Google (SwiftShader)
]);

/** The class a renderer string names, or null when it names nothing we know. */
export function classifyRenderer(renderer: string | null | undefined): GpuClass | null {
  const s = (renderer ?? "").trim();
  if (!s) return null;
  if (SOFTWARE_GL.test(s)) return "software";
  if (AMD_APU.test(s)) return "integrated";
  if (DISCRETE.test(s)) return "discrete";
  if (INTEGRATED.test(s)) return "integrated";
  return null;
}

/** Chromium reports no GPU compositing, or WebGL without hardware: software, whatever the device says. */
export function softwareByFeatureStatus(status: Readonly<Record<string, string>> | null | undefined): boolean {
  if (!status) return false;
  const comp = status.gpu_compositing ?? "";
  const webgl = status.webgl ?? "";
  return /software/.test(comp) || comp.startsWith("disabled") || /software/.test(webgl) || webgl.startsWith("unavailable") || webgl.startsWith("disabled");
}

/** A short, readable GPU name from a renderer string (the ANGLE wrapper, vendor words, API suffixes and PCI ids
 *  removed): "ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0, D3D11)" -> "RTX 4070". */
export function shortGpuName(renderer: string | null | undefined): string | null {
  const raw = (renderer ?? "").trim();
  if (!raw) return null;
  const soft = raw.match(/swiftshader|llvmpipe|softpipe|basic render driver/i);
  if (soft) return soft[0].toLowerCase() === "swiftshader" ? "SwiftShader" : soft[0].toLowerCase() === "basic render driver" ? "Basic Render Driver" : soft[0].toLowerCase();
  let d = raw;
  const angle = d.match(/^ANGLE \((.*)\)$/i);
  if (angle) {
    const parts = angle[1]!.split(/,\s*/);
    d = parts.length >= 2 ? parts[1]! : parts[0]!;
  }
  d = d
    .replace(/^ANGLE Metal Renderer:\s*/i, "")
    .replace(/\s*(Direct3D\d*|OpenGL|Vulkan|Metal)\b.*$/i, "")
    .replace(/\/.*$/, "") // "GeForce GTX 1080/PCIe/SSE2"
    .replace(/\((tm|r)\)/gi, "")
    .replace(/\s*\([^)]*\)/g, "") // PCI ids, codenames: "(0x00002684)", "(KBL GT2)"
    .replace(/\b(nvidia|geforce|amd|intel|ati|mesa|corporation|inc\.?|unspecified version)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!d) return null;
  return d.length > 28 ? `${d.slice(0, 27).trimEnd()}\u2026` : d;
}

/** The one classification rule. Precedence: Chromium's own software verdict, a missing WebGL, the page's WebGL
 *  string, Electron's GL string, the active device's PCI vendor; else unknown. */
export function classifyGpu(input: { renderer: string | null; webglMissing?: boolean; electron: ElectronGpuInfo | null }): GpuProbe {
  const { renderer, electron } = input;
  const name = shortGpuName(renderer) ?? shortGpuName(electron?.glRenderer);
  if (softwareByFeatureStatus(electron?.featureStatus)) return { cls: "software", name, renderer: renderer ?? electron?.glRenderer ?? null, source: "feature-status" };
  if (input.webglMissing) return { cls: "software", name, renderer: null, source: "webgl" };
  const web = classifyRenderer(renderer);
  if (web) return { cls: web, name, renderer, source: "webgl" };
  const gl = classifyRenderer(electron?.glRenderer);
  if (gl) return { cls: gl, name, renderer: electron?.glRenderer ?? null, source: "electron" };
  const devices = electron?.devices ?? [];
  const dev = devices.find((d) => d.active) ?? devices[0];
  const byVendor = dev ? VENDOR_CLASS.get(dev.vendorId) ?? null : null;
  if (byVendor) return { cls: byVendor, name, renderer: renderer ?? null, source: "vendor-id" };
  return { cls: null, name, renderer: renderer ?? null, source: "none" };
}

/** Validate what the preload handed over (null when it is not the shape main sends). */
export function parseElectronGpu(raw: unknown): ElectronGpuInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { featureStatus?: unknown; devices?: unknown; glRenderer?: unknown; glVendor?: unknown };
  const featureStatus: Record<string, string> = {};
  if (r.featureStatus && typeof r.featureStatus === "object") {
    for (const [k, v] of Object.entries(r.featureStatus as Record<string, unknown>)) if (typeof v === "string") featureStatus[k] = v;
  }
  const devices: ElectronGpuInfo["devices"] = [];
  if (Array.isArray(r.devices)) {
    for (const d of r.devices as unknown[]) {
      const x = d as { vendorId?: unknown; deviceId?: unknown; active?: unknown } | null;
      if (x && typeof x.vendorId === "number" && typeof x.deviceId === "number") devices.push({ vendorId: x.vendorId, deviceId: x.deviceId, active: x.active === true });
    }
  }
  return {
    featureStatus, devices,
    glRenderer: typeof r.glRenderer === "string" && r.glRenderer ? r.glRenderer : null,
    glVendor: typeof r.glVendor === "string" && r.glVendor ? r.glVendor : null,
  };
}

// ── runtime (DOM) ────────────────────────────────────────────────────────────

let webgl: { renderer: string | null; missing: boolean } | undefined;

/** The unmasked WebGL renderer of the adapter Visualize renders on (`missing`: this page cannot create a WebGL
 *  context at all). Read once: context creation is not free and the answer does not change mid-session. Outside a
 *  DOM (tests) both are empty. */
export function webglRenderer(): { renderer: string | null; missing: boolean } {
  if (webgl) return webgl;
  if (typeof document === "undefined") return (webgl = { renderer: null, missing: false });
  try {
    const gl = document.createElement("canvas").getContext("webgl", { powerPreference: "high-performance" }) as WebGLRenderingContext | null;
    if (!gl) return (webgl = { renderer: null, missing: true });
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    const s = String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    gl.getExtension("WEBGL_lose_context")?.loseContext(); // give the context back now, not at GC
    webgl = { renderer: s || null, missing: false };
  } catch {
    webgl = { renderer: null, missing: true };
  }
  return webgl;
}

let pending: Promise<GpuProbe> | null = null;

/** Probe once per session: the WebGL string plus Electron's info (when the preload offers it). Never rejects. */
export function probeGpu(): Promise<GpuProbe> {
  pending ??= (async (): Promise<GpuProbe> => {
    const web = webglRenderer();
    let electron: ElectronGpuInfo | null = null;
    try {
      const shell = typeof window !== "undefined" ? window.lucid : undefined;
      electron = parseElectronGpu(shell?.gpuInfo ? await shell.gpuInfo() : null);
    } catch { /* no preload, or main refused: the WebGL string decides */ }
    return classifyGpu({ renderer: web.renderer, webglMissing: web.missing, electron });
  })();
  return pending;
}
