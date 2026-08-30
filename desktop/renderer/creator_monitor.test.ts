// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, test } from "bun:test";
import {
  coreGridHtml, creatorFlyoutHtml, fmtAge, fmtMemMB, fmtPct, gpuDevicesHtml, historyHtml,
  isCreatorResources, loadBand, odometerSvg, pressureChipHtml, pressureRailHtml, sparkPath,
  type CreatorResourcesView, type GpuTelemetryView, type TargetTelemetryView,
} from "./creator_monitor.ts";

const gpu = (over: Partial<GpuTelemetryView> = {}): GpuTelemetryView => ({
  available: true,
  source: "nvidia-smi",
  note: "",
  devices: [{ index: 0, name: "NVIDIA GB10", vendor: "nvidia", busyPct: 88, memTotalMB: 131072, memUsedMB: 65536, memPct: 50, tempC: 61, powerW: 118, powerCapW: 250 }],
  ...over,
});

const target = (over: Partial<TargetTelemetryView> = {}): TargetTelemetryView => ({
  id: "local",
  label: "This machine",
  kind: "local",
  sampledAt: 1000,
  ageMs: 900,
  freshness: "fresh",
  cpu: { model: "Intel Core i7-6700K", cores: 8, speedMHz: 4000, busyPct: 35, perCore: [{ id: 0, busyPct: 90 }, { id: 1, busyPct: 4 }, { id: 2, busyPct: null }] },
  mem: { totalMB: 16384, freeMB: 4096, usedPct: 75 },
  gpu: gpu(),
  procs: [{ name: "blender", count: 2, memMB: 3072, cpuSec: 412 }],
  error: "",
  ...over,
});

const view = (over: Partial<CreatorResourcesView> = {}): CreatorResourcesView => ({
  targets: [target()],
  history: [
    { at: 1, cpuPct: 20, memPct: 40, gpuPct: 10, vramPct: 20 },
    { at: 2, cpuPct: 60, memPct: 45, gpuPct: 80, vramPct: 40 },
    { at: 3, cpuPct: 95, memPct: 50, gpuPct: 88, vramPct: 50 },
  ],
  admission: { ok: true, reason: "", cpuPct: 35, memPct: 75, gpuPct: 88, vramPct: 50, cpuHotMs: 0, memHotMs: 0, gpuHotMs: 6000, pressurePct: 90, sustainMs: 30000, gpuEvidenceMissing: false },
  policy: { pressurePct: 90, warmPct: 70, sustainMs: 30000 },
  ...over,
});

describe("bands and formatting (CREATOR-0, ADR-0283)", () => {
  test("null is its OWN band - it is never the bottom of the scale", () => {
    expect(loadBand(null)).toBe("unknown");
    expect(loadBand(0)).toBe("cool");
    expect(loadBand(75)).toBe("warm");
    expect(loadBand(90)).toBe("hot");
    expect(loadBand(Number.NaN)).toBe("unknown");
  });

  test("unknown values render as unknown text, never as 0", () => {
    expect(fmtPct(null)).toBe("--");
    expect(fmtPct(101)).toBe("100%");
    expect(fmtMemMB(null)).toBe("unknown");
    expect(fmtMemMB(1536)).toBe("1.5 GB");
    expect(fmtAge(500)).toBe("just now");
    expect(fmtAge(90_000)).toBe("2m ago");
  });

  test("the payload shape gate rejects junk (fail-open reads as null upstream)", () => {
    expect(isCreatorResources(view())).toBe(true);
    expect(isCreatorResources(null)).toBe(false);
    expect(isCreatorResources({ targets: [], history: [] })).toBe(false);
  });
});

describe("the odometer dial", () => {
  test("a real value draws a value arc; a null value draws NO arc at all", () => {
    expect(odometerSvg(50)).toContain("cod-val");
    expect(odometerSvg(null)).not.toContain("cod-val");
    expect(odometerSvg(null)).toContain("cod-needle"); // the instrument still reads at rest
  });

  test("the dial carries its band class so green-to-red is CSS, not inline colour", () => {
    expect(odometerSvg(10)).toContain("cod-cool");
    expect(odometerSvg(80)).toContain("cod-warm");
    expect(odometerSvg(97)).toContain("cod-hot");
    expect(odometerSvg(null)).toContain("cod-unknown");
  });

  test("the sweep is a 270 degree arc with graduations, drawn inside the viewBox", () => {
    const svg = odometerSvg(100, { size: 68 });
    expect(svg).toContain('viewBox="0 0 68 68"');
    expect((svg.match(/cod-tick/g) ?? []).length).toBe(7);
    for (const n of svg.match(/-?\d+\.?\d*/g) ?? []) expect(Number(n)).toBeGreaterThan(-200);
  });

  test("the dial is aria-hidden - the chip owns the accessible label", () => {
    expect(odometerSvg(50)).toContain('aria-hidden="true"');
  });
});

describe("the chips", () => {
  test("a chip states its own value and freshness for a screen reader", () => {
    const html = pressureChipHtml({ metric: "gpu", label: "GPU", pct: 88, freshness: "fresh", detail: "NVIDIA GB10", hotMs: 6000, sustainMs: 30000 });
    expect(html).toContain('aria-label="GPU pressure 88%"');
    expect(html).toContain("data-cod-chip=\"gpu\"");
    expect(html).toContain("Held at the line for 6s of 30s");
  });

  test("a blind chip says no signal instead of showing a healthy dial", () => {
    const html = pressureChipHtml({ metric: "gpu", label: "GPU", pct: null, freshness: "blind", detail: "No nvidia-smi on PATH.", hotMs: 0, sustainMs: 30000 });
    expect(html).toContain("no signal");
    expect(html).toContain("cod-blind");
    expect(html).toContain("No live reading");
    expect(html).not.toContain("cod-val");
  });

  test("the rail shows exactly two chips and surfaces a refusal", () => {
    const ok = pressureRailHtml(view());
    expect((ok.match(/data-cod-chip=/g) ?? []).length).toBe(2);
    expect(ok).not.toContain("cod-refusal");
    const refused = pressureRailHtml(view({ admission: { ...view().admission, ok: false, reason: "the GPU has been at 99% for 34s" } }));
    expect(refused).toContain("cod-refusal");
    expect(refused).toContain("34s");
  });

  test("no telemetry yet says so plainly", () => {
    expect(pressureRailHtml(null)).toContain("has not reported yet");
    expect(pressureRailHtml(view({ targets: [] }))).toContain("has not reported yet");
  });
});

describe("the flyout", () => {
  test("per-core bars appear one per core, and an unmeasured core is not a zero bar", () => {
    const html = coreGridHtml(target().cpu);
    expect((html.match(/class="cod-core /g) ?? []).length).toBe(3);
    expect(html).toContain("cod-unknown");
    expect(coreGridHtml(null)).toContain("not exposed on this platform");
  });

  test("GPU rows carry load, VRAM, thermals, and power when the vendor reports them", () => {
    const html = gpuDevicesHtml(gpu());
    expect(html).toContain("0: NVIDIA GB10");
    expect(html).toContain("64 GB of 128 GB");
    expect(html).toContain("61 C");
    expect(html).toContain("118 W of 250 W");
  });

  test("an unavailable GPU says unknown is not idle", () => {
    const html = gpuDevicesHtml(gpu({ available: false, devices: [], note: "No nvidia-smi on PATH." }));
    expect(html).toContain("No nvidia-smi on PATH.");
    expect(html).toContain("Unknown is not idle");
  });

  test("the history line BREAKS across a gap rather than interpolating over it", () => {
    const d = sparkPath([10, null, 90], 100, 50);
    expect((d.match(/M/g) ?? []).length).toBe(2);
    expect(sparkPath([null, null], 100, 50)).toBe("");
    expect(historyHtml(view().history, 90)).toContain("cod-limit");
    expect(historyHtml([], 90)).toContain("Not enough samples");
  });

  test("the flyout names the policy and refuses to call missing evidence an all-clear", () => {
    const html = creatorFlyoutHtml(view({ admission: { ...view().admission, gpuEvidenceMissing: true } }));
    expect(html).toContain("not a measured all-clear");
    expect(html).toContain("holds at 90% for 30s");
    expect(html).toContain("never that the load is zero");
    expect(creatorFlyoutHtml(null)).toContain("Nothing is throttled");
  });

  test("a target error is shown as the reason, not as load", () => {
    const html = creatorFlyoutHtml(view({ targets: [target({ kind: "remote", label: "DGX Spark A", error: "connection refused", freshness: "blind" })] }));
    expect(html).toContain("DGX Spark A");
    expect(html).toContain("connection refused");
    expect(html).toContain("no signal");
  });

  test("external device, model, and process names are escaped", () => {
    const evil = "<img src=x onerror=alert(1)>";
    const html = creatorFlyoutHtml(view({ targets: [target({
      label: evil,
      cpu: { model: evil, cores: 1, speedMHz: 0, busyPct: 1, perCore: [] },
      gpu: gpu({ devices: [{ index: 0, name: evil, vendor: "nvidia", busyPct: 1, memTotalMB: 1, memUsedMB: 1, memPct: 1, tempC: null, powerW: null, powerCapW: null }] }),
      procs: [{ name: evil, count: 1, memMB: 1, cpuSec: null }],
    })] }));
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });
});
