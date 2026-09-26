// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, test } from "bun:test";
import {
  BLIND_MS, CREATOR_PRESSURE_PCT, CREATOR_SUSTAIN_MS, DCGM_FIELDS, NVIDIA_SMI_ARGS,
  creatorAdmission, freshnessOf, gpuFromDcgm, gpuPeak, hotMsFor, parseNvidiaSmi, parsePrometheusText,
  perCoreBusy, pressureLevel, pushCreatorSample, sampleCreatorCpu, sampleLocalGpu, telemetryFromAgentJson,
  validateRemoteTarget, type CreatorSample, type GpuTelemetry,
} from "./creator_monitor.ts";

const times = (idle: number, user: number) => ({ idle, user, nice: 0, sys: 0, irq: 0 });
const cpu = (idle: number, user: number) => ({ model: "Test CPU", speed: 3600, times: times(idle, user) });

describe("per-core CPU (CREATOR-0, ADR-0283)", () => {
  test("each core gets its own busy%, so one pegged core is visible instead of averaged away", () => {
    const a = [cpu(100, 0), cpu(100, 0)];
    const b = [cpu(100, 100), cpu(200, 0)]; // core 0 fully busy, core 1 fully idle
    const cores = perCoreBusy(a, b);
    expect(cores).toEqual([{ id: 0, busyPct: 100 }, { id: 1, busyPct: 0 }]);
  });

  test("a regressed or empty window is null per core, never 0 (a gap is not spare capacity)", () => {
    expect(perCoreBusy([cpu(100, 100)], [cpu(100, 0)])[0]!.busyPct).toBeNull();
    expect(perCoreBusy([], [cpu(1, 1)])).toEqual([]);
  });

  test("sampleCreatorCpu reports aggregate + per core + memory percent", async () => {
    let calls = 0;
    const r = await sampleCreatorCpu({
      cpus: () => (calls++ === 0 ? [cpu(100, 0), cpu(100, 0)] : [cpu(150, 50), cpu(100, 100)]),
      totalmem: () => 16 * 1024 * 1024 * 1024,
      freemem: () => 4 * 1024 * 1024 * 1024,
      sleep: async () => {},
    }, 0);
    expect(r.cpu?.cores).toBe(2);
    expect(r.cpu?.busyPct).toBe(75); // 150 busy ticks of a 200-tick window across both cores
    expect(r.cpu?.perCore.map((c) => c.busyPct)).toEqual([50, 100]);
    expect(r.mem?.usedPct).toBe(75);
  });

  test("a throwing io yields nulls, never a crash and never a fake reading", async () => {
    const r = await sampleCreatorCpu({ cpus: () => { throw new Error("no"); }, totalmem: () => 1, freemem: () => 1, sleep: async () => {} }, 0);
    expect(r.cpu).toBeNull();
    expect(r.mem).toBeNull();
  });
});

describe("NVIDIA collector", () => {
  test("the argv is fixed, queries no shell, and asks for unit-less CSV", () => {
    expect(NVIDIA_SMI_ARGS[0]).toBe("nvidia-smi");
    expect(NVIDIA_SMI_ARGS.join(" ")).toContain("--format=csv,noheader,nounits");
    for (const a of NVIDIA_SMI_ARGS) expect(a).not.toMatch(/[;&|`$><]/);
  });

  test("parses two devices with VRAM percent derived from used over total", () => {
    const out = parseNvidiaSmi([
      "0, NVIDIA GB10, 42, 131072, 65536, 61, 118.5, 250",
      "1, NVIDIA GB10, 0, 131072, 1024, 44, 30.0, 250",
    ].join("\n"));
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ index: 0, name: "NVIDIA GB10", vendor: "nvidia", busyPct: 42, memPct: 50, tempC: 61, powerW: 118.5, powerCapW: 250 });
    expect(out[1]!.memPct).toBe(1);
  });

  test("[N/A] and 'Not Supported' stay NULL - an unreported counter is not a zero reading", () => {
    const out = parseNvidiaSmi("0, Quadro P400, [N/A], 2048, 512, [N/A], Not Supported, [N/A]");
    expect(out[0]!.busyPct).toBeNull();
    expect(out[0]!.tempC).toBeNull();
    expect(out[0]!.powerW).toBeNull();
    expect(out[0]!.memPct).toBe(25); // memory WAS reported, so it stays a real number
  });

  test("torn and empty lines contribute nothing", () => {
    expect(parseNvidiaSmi("\n \nbroken\n0, GPU\n")).toEqual([]);
  });

  test("a missing binary is honest 'no evidence' with a platform hint, not an error", () => {
    const g = sampleLocalGpu(() => { throw new Error("ENOENT"); }, "win32");
    expect(g.available).toBe(false);
    expect(g.source).toBe("none");
    expect(g.devices).toEqual([]);
    expect(g.note).toContain("nvidia-smi");
    expect(sampleLocalGpu(() => { throw new Error("ENOENT"); }, "darwin").note).toContain("powermetrics");
  });

  test("a successful call is reported as measured", () => {
    const g = sampleLocalGpu(() => "0, NVIDIA GB10, 7, 131072, 1024, 40, 25, 250");
    expect(g.available).toBe(true);
    expect(g.source).toBe("nvidia-smi");
    expect(g.devices[0]!.busyPct).toBe(7);
  });
});

describe("remote targets", () => {
  test("a URL with embedded credentials is refused - the vault holds values", () => {
    const bad = validateRemoteTarget({ id: "dgx", label: "DGX", url: "https://user:pass@dgx.internal:9400/metrics", kind: "dcgm-exporter", enabled: true });
    expect(bad.ok).toBe(false);
    expect(bad.errors.join(" ")).toContain("credentials must never be embedded");
  });

  test("a vaultRef must look like a NAME, and a good target validates", () => {
    expect(validateRemoteTarget({ id: "dgx", label: "DGX Spark", url: "https://dgx.internal:9400/metrics", kind: "dcgm-exporter", vaultRef: "sk-abcdefghijklmnop", enabled: true }).ok).toBe(false);
    expect(validateRemoteTarget({ id: "dgx-a", label: "DGX Spark A", url: "https://dgx.internal:9400/metrics", kind: "dcgm-exporter", vaultRef: "dgx_a_token", enabled: true }).ok).toBe(true);
  });

  test("prometheus text parsing keeps labels and drops NaN / Inf", () => {
    const m = parsePrometheusText([
      "# HELP DCGM_FI_DEV_GPU_UTIL util",
      'DCGM_FI_DEV_GPU_UTIL{gpu="0",modelName="NVIDIA GB10"} 55',
      'DCGM_FI_DEV_GPU_UTIL{gpu="1"} NaN',
      "OTHER_METRIC 3",
    ].join("\n"), DCGM_FIELDS);
    expect(m.DCGM_FI_DEV_GPU_UTIL).toHaveLength(1);
    expect(m.DCGM_FI_DEV_GPU_UTIL![0]!.labels.modelName).toBe("NVIDIA GB10");
    expect(m.OTHER_METRIC).toBeUndefined();
  });

  test("a DCGM scrape folds into devices with VRAM total = used + free", () => {
    const g = gpuFromDcgm([
      'DCGM_FI_DEV_GPU_UTIL{gpu="0",modelName="NVIDIA GB10"} 61',
      'DCGM_FI_DEV_FB_USED{gpu="0"} 40000',
      'DCGM_FI_DEV_FB_FREE{gpu="0"} 60000',
      'DCGM_FI_DEV_GPU_TEMP{gpu="0"} 58',
      'DCGM_FI_DEV_POWER_USAGE{gpu="0"} 140.4',
    ].join("\n"));
    expect(g.available).toBe(true);
    expect(g.source).toBe("dcgm-exporter");
    expect(g.devices[0]).toMatchObject({ index: 0, name: "NVIDIA GB10", busyPct: 61, memTotalMB: 100000, memUsedMB: 40000, memPct: 40, tempC: 58, powerW: 140 });
  });

  test("an exporter that publishes nothing useful is unavailable, not idle", () => {
    const g = gpuFromDcgm("# nothing here\nOTHER 1");
    expect(g.available).toBe(false);
    expect(g.note).toContain("no DCGM GPU fields");
  });

  test("a partial agent payload keeps what it has and nulls the rest", () => {
    const t = telemetryFromAgentJson({ cpu: { busyPct: 12, cores: 20 }, gpu: { devices: [{ index: 0, name: "GB10", vendor: "nvidia", busyPct: 90 }] } }, { id: "spark", label: "Spark A" }, 1000);
    expect(t.cpu).toMatchObject({ busyPct: 12, cores: 20 });
    expect(t.mem).toBeNull();
    expect(t.gpu.devices[0]).toMatchObject({ busyPct: 90, memPct: null, tempC: null });
    expect(t.kind).toBe("remote");
  });

  test("junk in the agent payload never becomes a number", () => {
    const t = telemetryFromAgentJson({ cpu: { busyPct: "99" }, gpu: { devices: [{ busyPct: "80", vendor: "acme" }] } }, { id: "x", label: "X" }, 5);
    expect(t.cpu).toBeNull();
    expect(t.gpu.devices[0]!.busyPct).toBeNull();
    expect(t.gpu.devices[0]!.vendor).toBe("unknown");
  });
});

describe("freshness + pressure window", () => {
  test("fresh, stale, and blind are distinct - a stale reading is not a live one", () => {
    expect(freshnessOf(1000, 1500)).toBe("fresh");
    expect(freshnessOf(1000, 1000 + 9_000)).toBe("stale");
    expect(freshnessOf(1000, 1000 + BLIND_MS)).toBe("blind");
    expect(freshnessOf(0, 1)).toBe("blind");
  });

  test("the ring is bounded and a backwards clock resets rather than inventing a streak", () => {
    let h: CreatorSample[] = [];
    for (let i = 0; i < 400; i++) h = pushCreatorSample(h, { at: i * 3000, cpuPct: 10, memPct: 10, gpuPct: 10, vramPct: 10 });
    expect(h.length).toBeLessThanOrEqual(240);
    const reset = pushCreatorSample(h, { at: 0, cpuPct: 5, memPct: 5, gpuPct: 5, vramPct: 5 });
    expect(reset).toHaveLength(1);
  });

  test("a burst is free; only an unbroken streak accumulates", () => {
    const hot = (at: number) => ({ at, cpuPct: 96, memPct: 20, gpuPct: 95, vramPct: 50 });
    let h: CreatorSample[] = [];
    for (let i = 0; i <= 5; i++) h = pushCreatorSample(h, hot(i * 3000)); // 15s of pressure
    expect(hotMsFor(h, "cpuPct")).toBe(15_000);
    expect(creatorAdmission(h, { label: "a render" }, { available: false, source: "none", devices: [], note: "" }).ok).toBe(true);
  });

  test("a cool OR blind reading breaks the streak (a sampling gap can never read as load)", () => {
    const hot = (at: number) => ({ at, cpuPct: 96, memPct: 20, gpuPct: 20, vramPct: 20 });
    let h: CreatorSample[] = [];
    for (let i = 0; i <= 12; i++) h = pushCreatorSample(h, hot(i * 3000));
    expect(hotMsFor(h, "cpuPct")).toBeGreaterThanOrEqual(CREATOR_SUSTAIN_MS);
    const blind = pushCreatorSample(h, { at: 13 * 3000, cpuPct: null, memPct: 20, gpuPct: 20, vramPct: 20 });
    expect(hotMsFor(blind, "cpuPct")).toBe(0);
    const cool = pushCreatorSample(h, { at: 13 * 3000, cpuPct: 12, memPct: 20, gpuPct: 20, vramPct: 20 });
    expect(hotMsFor(cool, "cpuPct")).toBe(0);
  });

  test("pressureLevel keeps unknown as its own band", () => {
    expect(pressureLevel(null)).toBe("unknown");
    expect(pressureLevel(10)).toBe("cool");
    expect(pressureLevel(75)).toBe("warm");
    expect(pressureLevel(CREATOR_PRESSURE_PCT)).toBe("hot");
  });

  test("gpuPeak reports the WORST device, not an average", () => {
    const gpu: GpuTelemetry = { available: true, source: "nvidia-smi", note: "", devices: [
      { index: 0, name: "a", vendor: "nvidia", busyPct: 10, memTotalMB: 100, memUsedMB: 10, memPct: 10, tempC: null, powerW: null, powerCapW: null },
      { index: 1, name: "b", vendor: "nvidia", busyPct: 97, memTotalMB: 100, memUsedMB: 90, memPct: 90, tempC: null, powerW: null, powerCapW: null },
    ] };
    expect(gpuPeak(gpu)).toEqual({ busyPct: 97, vramPct: 90 });
  });
});

describe("Creator job admission", () => {
  const noGpu: GpuTelemetry = { available: false, source: "none", devices: [], note: "none" };
  const gpu = (totalMB: number): GpuTelemetry => ({ available: true, source: "nvidia-smi", note: "", devices: [
    { index: 0, name: "GB10", vendor: "nvidia", busyPct: 5, memTotalMB: totalMB, memUsedMB: 0, memPct: 0, tempC: null, powerW: null, powerCapW: null },
  ] });

  test("no evidence at all admits the job, but never claims a measured all-clear", () => {
    const a = creatorAdmission([], { label: "a video render", gpu: true }, noGpu);
    expect(a.ok).toBe(true);
    expect(a.gpuEvidenceMissing).toBe(true);
    expect(a.gpuPct).toBeNull();
  });

  test("thirty unbroken seconds of memory pressure refuses, naming the percent and the duration", () => {
    let h: CreatorSample[] = [];
    for (let i = 0; i <= 14; i++) h = pushCreatorSample(h, { at: i * 3000, cpuPct: 30, memPct: 94, gpuPct: 10, vramPct: 10 });
    const a = creatorAdmission(h, { label: "a Blender frame range" }, noGpu);
    expect(a.ok).toBe(false);
    expect(a.reason).toContain("94%");
    expect(a.reason).toContain("42s");
    expect(a.reason).toContain("a Blender frame range");
  });

  test("a sustained GPU render refuses a second one and says so in GPU terms", () => {
    let h: CreatorSample[] = [];
    for (let i = 0; i <= 14; i++) h = pushCreatorSample(h, { at: i * 3000, cpuPct: 20, memPct: 20, gpuPct: 99, vramPct: 80 });
    const a = creatorAdmission(h, { label: "a diffusion batch" }, gpu(24576));
    expect(a.ok).toBe(false);
    expect(a.reason).toContain("GPU has been at 99%");
  });

  test("a KNOWN VRAM shortfall refuses with both numbers, even on an idle GPU", () => {
    const a = creatorAdmission([{ at: 1, cpuPct: 3, memPct: 20, gpuPct: 0, vramPct: 0 }], { label: "a 40 GB video model", vramMB: 40960 }, gpu(8192));
    expect(a.ok).toBe(false);
    expect(a.reason).toContain("40 GB");
    expect(a.reason).toContain("8 GB");
  });

  test("a VRAM requirement that FITS passes, and an unmeasurable GPU never fabricates a shortfall", () => {
    expect(creatorAdmission([{ at: 1, cpuPct: 3, memPct: 10, gpuPct: 2, vramPct: 1 }], { label: "an image batch", vramMB: 8192 }, gpu(24576)).ok).toBe(true);
    expect(creatorAdmission([{ at: 1, cpuPct: 3, memPct: 10, gpuPct: null, vramPct: null }], { label: "an image batch", vramMB: 40960 }, noGpu).ok).toBe(true);
  });
});
