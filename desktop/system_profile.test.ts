// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/system_profile.test.ts — P-SYSRES.1 (ADR-0182): the system profile + guard verdict.
// Pins: cpu busy% math (delta of two aggregate readings, empty/regressed window → null), the closed
// verdict set with its threshold lines (weak CPU amplifies; crit lines block everywhere; a zeroed /
// unknown snapshot NEVER blocks - fail-open), the process-list parsers (powershell JSON incl. the
// single-object shape, unix `ps`, torn input → []), aggregation by name, and the fixed-argv,
// fail-quiet topProcesses seam. All io injected.

import { describe, expect, test } from "bun:test";
import {
  aggregateProcs, assessSystem, busyPct, cpuTotals, fmtMB, parsePsProcesses, parseUnixProcesses,
  sampleSystem, topProcesses, CPU_CRIT_PCT, CPU_HIGH_PCT, MEM_CRIT_MB, type ProfileIo, type SystemSnapshot,
} from "./system_profile.ts";

const snap = (over: Partial<SystemSnapshot> = {}): SystemSnapshot => ({
  cpuModel: "Test CPU", cores: 8, speedMHz: 3200, cpuBusyPct: 20, memTotalMB: 16384, memFreeMB: 8000, ...over,
});

describe("cpu sampling math", () => {
  test("busyPct is the busy share of the window, clamped to 0..100", () => {
    expect(busyPct({ busy: 100, total: 1000 }, { busy: 190, total: 1100 })).toBe(90);
    expect(busyPct({ busy: 0, total: 0 }, { busy: 50, total: 100 })).toBe(50);
  });
  test("an empty or regressed window is null - evidence only, never a guess", () => {
    expect(busyPct({ busy: 10, total: 100 }, { busy: 10, total: 100 })).toBeNull();
    expect(busyPct({ busy: 10, total: 100 }, { busy: 5, total: 90 })).toBeNull();
  });
  test("cpuTotals aggregates every core and counts everything but idle as busy", () => {
    const t = cpuTotals([
      { times: { user: 10, sys: 5, idle: 85 } },
      { times: { user: 20, sys: 5, idle: 75 } },
    ]);
    expect(t).toEqual({ busy: 40, total: 200 });
  });
  test("sampleSystem uses the injected io and never throws", async () => {
    let call = 0;
    const io: ProfileIo = {
      cpus: () => { call += 1; return [{ model: "Weak CPU", speed: 1600, times: { user: call * 100, idle: call * 100 } }]; },
      totalmem: () => 8 * 1024 ** 3, freemem: () => 1 * 1024 ** 3, sleep: async () => {},
    };
    const s = await sampleSystem(io, 0);
    expect(s.cpuModel).toBe("Weak CPU");
    expect(s.cores).toBe(1);
    expect(s.cpuBusyPct).toBe(50);
    expect(s.memTotalMB).toBe(8192);
    const broken = await sampleSystem({ ...io, cpus: () => { throw new Error("boom"); } }, 0);
    expect(broken.cpuBusyPct).toBeNull();
    expect(assessSystem(broken).level).toBe("ok"); // the fail-open contract, end to end
  });
});

describe("assessSystem - the closed verdict set", () => {
  test("a healthy strong machine is ok with no reasons", () => {
    expect(assessSystem(snap())).toEqual({ level: "ok", weakCpu: false, reasons: [] });
  });
  test("weak CPU + high load → blocked, with human reasons", () => {
    const v = assessSystem(snap({ cores: 4, cpuBusyPct: CPU_HIGH_PCT }));
    expect(v.level).toBe("blocked");
    expect(v.weakCpu).toBe(true);
    expect(v.reasons.length).toBeGreaterThanOrEqual(2);
  });
  test("weak CPU + low memory → blocked; the same pressure on a strong machine is only strained", () => {
    expect(assessSystem(snap({ cores: 2, memFreeMB: 900 })).level).toBe("blocked");
    expect(assessSystem(snap({ memFreeMB: 1200 })).level).toBe("strained");
  });
  test("critical lines block even a strong machine", () => {
    expect(assessSystem(snap({ cpuBusyPct: CPU_CRIT_PCT })).level).toBe("blocked");
    expect(assessSystem(snap({ memFreeMB: MEM_CRIT_MB - 1 })).level).toBe("blocked");
  });
  test("a slow clock counts as weak even with many cores", () => {
    expect(assessSystem(snap({ cores: 8, speedMHz: 1500, cpuBusyPct: 90 })).level).toBe("blocked");
  });
  test("no evidence never raises the level (unknown busy%, zeroed snapshot)", () => {
    expect(assessSystem(snap({ cpuBusyPct: null })).level).toBe("ok");
    expect(assessSystem({ cpuModel: "", cores: 0, speedMHz: 0, cpuBusyPct: null, memTotalMB: 0, memFreeMB: 0 }).level).toBe("ok");
  });
  test("fmtMB renders GB with one decimal under 10", () => {
    expect(fmtMB(1536)).toBe("1.5 GB");
    expect(fmtMB(16384)).toBe("16 GB");
    expect(fmtMB(900)).toBe("900 MB");
  });
});

describe("process listing", () => {
  test("powershell JSON parses (array and the single-object shape); torn input → []", () => {
    const rows = parsePsProcesses(JSON.stringify([
      { ProcessName: "chrome", Id: 1, CPU: 120.7, WorkingSet64: 500 * 1024 ** 2 },
      { ProcessName: "chrome", Id: 2, CPU: 60.2, WorkingSet64: 300 * 1024 ** 2 },
      { ProcessName: "Code", Id: 3, WorkingSet64: 900 * 1024 ** 2 },
    ]));
    expect(rows).toHaveLength(3);
    expect(rows[2]).toEqual({ name: "Code", memMB: 900, cpuSec: null });
    expect(parsePsProcesses(JSON.stringify({ ProcessName: "one", WorkingSet64: 1024 ** 2 }))).toHaveLength(1);
    expect(parsePsProcesses("{torn")).toEqual([]);
  });
  test("unix ps parses comm/pid/pcpu/rss; the header and torn lines contribute nothing", () => {
    const rows = parseUnixProcesses("COMMAND PID %CPU RSS\nnode 100 12.5 2048000\nnot a row\nbash 7 0.0 4096");
    expect(rows[0]).toEqual({ name: "node", memMB: 2000, cpuSec: null });
    expect(rows).toHaveLength(2);
  });
  test("aggregateProcs groups by name, sums, sorts by memory and caps", () => {
    const g = aggregateProcs([
      { name: "chrome", memMB: 500, cpuSec: 120 },
      { name: "chrome", memMB: 300, cpuSec: 60 },
      { name: "Code", memMB: 900, cpuSec: null },
    ], 2);
    expect(g.map((x) => x.name)).toEqual(["Code", "chrome"]);
    expect(g[1]).toEqual({ name: "chrome", count: 2, memMB: 800, cpuSec: 180 });
  });
  test("topProcesses uses a FIXED argv per platform and fails quiet to []", () => {
    let seen: string[] = [];
    const win = topProcesses("win32", (argv) => { seen = argv; return JSON.stringify([{ ProcessName: "x", WorkingSet64: 1024 ** 2 }]); });
    expect(seen[0]).toBe("powershell");
    expect(seen).toContain("-NoProfile");
    expect(win).toHaveLength(1);
    const unix = topProcesses("linux", (argv) => { seen = argv; return "H\nnode 1 1.0 1024"; });
    expect(seen[0]).toBe("ps");
    expect(unix[0]!.name).toBe("node");
    expect(topProcesses("win32", () => { throw new Error("denied"); })).toEqual([]);
  });
});
