// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/system_guard.test.ts — P-SYSRES.1 (ADR-0182): the guard notice + panel builders.
// Pins: the payload shape gate (malformed → false, the fail-open seam), the machine line, the
// blocked card (reasons + BOTH actions + NO render-anyway escape hatch), the panel body (verdict
// chip, process rows with counts, empty state), and escaping of every external string (process
// names and CPU models are external text).

import { describe, expect, test } from "bun:test";
import {
  fmtMemMB, guardBlockedHtml, isSystemStatus, machineLine, resourcePanelBodyHtml, resourcePanelHtml,
  type SystemStatusView,
} from "./system_guard.ts";

const status = (over: Partial<SystemStatusView> = {}): SystemStatusView => ({
  snap: { cpuModel: "Intel i5-7200U", cores: 4, speedMHz: 2500, cpuBusyPct: 92, memTotalMB: 8192, memFreeMB: 1100 },
  verdict: { level: "blocked", weakCpu: true, reasons: ["CPU is at 92% across 4 cores", "only 1.1 GB of 8 GB RAM is free"] },
  procs: [
    { name: "chrome", count: 24, memMB: 3800, cpuSec: 1200 },
    { name: "Teams", count: 3, memMB: 900, cpuSec: null },
  ],
  ...over,
});

describe("isSystemStatus", () => {
  test("accepts the real shape; rejects malformed payloads (the fail-open seam)", () => {
    expect(isSystemStatus(status())).toBe(true);
    expect(isSystemStatus(null)).toBe(false);
    expect(isSystemStatus({})).toBe(false);
    expect(isSystemStatus({ snap: {}, verdict: { level: "nuked", reasons: [] }, procs: [] })).toBe(false);
  });
});

describe("machineLine", () => {
  test("joins the known parts; unknown parts drop out", () => {
    expect(machineLine(status().snap)).toBe("Intel i5-7200U · 4 cores @ 2.5 GHz · 1.1 GB of 8 GB free · CPU 92%");
    expect(machineLine({ cpuModel: "", cores: 0, speedMHz: 0, cpuBusyPct: null, memTotalMB: 0, memFreeMB: 0 })).toBe("");
  });
  test("fmtMemMB matches the backend rendering", () => {
    expect(fmtMemMB(1100)).toBe("1.1 GB");
    expect(fmtMemMB(512)).toBe("512 MB");
  });
});

describe("guardBlockedHtml", () => {
  test("names the paused feature, lists the reasons, offers panel + re-check and NO render-anyway", () => {
    const h = guardBlockedHtml(status(), "code graph");
    expect(h).toContain("The code graph is paused");
    expect(h).toContain("CPU is at 92%");
    expect(h).toContain("data-sys-panel");
    expect(h).toContain("data-sys-recheck");
    expect(h).not.toContain("Render anyway"); // the P-PERF.2 escape hatch deliberately does NOT exist here
  });
  test("external strings are escaped", () => {
    const evil = status({ verdict: { level: "blocked", weakCpu: true, reasons: ["<img src=x onerror=alert(1)>"] } });
    evil.snap.cpuModel = "<script>cpu</script>";
    const h = guardBlockedHtml(evil, "knowledge graph");
    expect(h).not.toContain("<img");
    expect(h).not.toContain("<script>cpu");
  });
});

describe("resource panel", () => {
  test("body: machine line + verdict chip + rows (with instance counts) + footer", () => {
    const b = resourcePanelBodyHtml(status());
    expect(b).toContain("Heavy features paused");
    expect(b).toContain("chrome");
    expect(b).toContain("×24");
    expect(b).toContain("3.7 GB");     // 3800 MB summed working set
    expect(b).toContain("1200s CPU");
    expect(b).toContain("Refresh");    // the footer tells the user the loop: close things, refresh
  });
  test("levels map to their chips; an empty process list shows the honest empty state", () => {
    expect(resourcePanelBodyHtml(status({ verdict: { level: "ok", weakCpu: false, reasons: [] }, procs: [] }))).toContain("Healthy");
    expect(resourcePanelBodyHtml(status({ verdict: { level: "strained", weakCpu: false, reasons: ["x"] } }))).toContain("Strained");
    expect(resourcePanelBodyHtml(status({ procs: [] }))).toContain("Couldn't read the process list");
  });
  test("modal: dialog + close + refresh controls; process names are escaped", () => {
    const withEvil = status({ procs: [{ name: "<b>evil</b>", count: 1, memMB: 100, cpuSec: null }] });
    const h = resourcePanelHtml(withEvil);
    expect(h).toContain('role="dialog"');
    expect(h).toContain("data-sys-close");
    expect(h).toContain("data-sys-refresh");
    expect(h).toContain('id="sysresBody"');
    expect(h).not.toContain("<b>evil</b>");
  });
});
