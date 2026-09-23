// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-RECOVER.1 (ADR-0384): the ownership proof that lets startup stop leftovers WITHOUT asking. A wrong
// "ours" force-kills a user's process; a wrong "not ours" strands the port and the omp session. Both
// directions are pinned, including the Windows quirks (recycled pids, stale ParentProcessId).

import { describe, expect, test } from "bun:test";
import { parseProcessList, planLeftovers, processListSpec, taskkillArgs, type ProcRow } from "./leftover_reaper.ts";
import type { EngineRecord } from "./run_ledger.ts";

const T0 = 1_790_000_000_000; // recorded engine start
const ENGINE_EXE = "C:\\Users\\u\\AppData\\Local\\Programs\\LucidAgentIDE\\resources\\repo\\bin\\lucid-engine.exe";
const BUN_EXE = "C:\\Users\\u\\.bun\\bin\\bun.exe";
const SELF = 7000;
const row = (pid: number, ppid: number, name: string, exe: string | null, startedAt: number | null): ProcRow =>
  ({ pid, ppid, name, exe, command: null, startedAt });
const prev: EngineRecord = { pid: 100, startedAt: T0, exe: ENGINE_EXE };
const win = { selfPid: SELF, platform: "win32" };
const pids = (rows: { pid: number }[]): number[] => rows.map((r) => r.pid).sort((a, b) => a - b);

// The previous run's live tree: engine -> omp shim -> bun (real omp) -> python; engine -> whisper.
const liveTree = (): ProcRow[] => [
  row(100, 50, "lucid-engine.exe", ENGINE_EXE.toUpperCase(), T0 + 40), // case differs: still the same image on win32
  row(101, 100, "omp.exe", "C:\\x\\omp.exe", T0 + 900),
  row(102, 101, "bun.exe", BUN_EXE, T0 + 950),
  row(103, 102, "python.exe", "C:\\py\\python.exe", T0 + 5000),
  row(104, 100, "whisper-server.exe", "C:\\w\\whisper-server.exe", T0 + 1200),
];
// Things that must never be touched.
const bystanders = (): ProcRow[] => [
  row(SELF, 1, "LucidAgentIDE.exe", "C:\\app\\LucidAgentIDE.exe", T0 + 60_000),
  row(SELF + 1, SELF, "lucid-engine.exe", ENGINE_EXE, T0 + 61_000), // the CURRENT run's engine
  row(900, 1, "lucid-engine.exe", ENGINE_EXE, T0 - 3_600_000), // same name and image, different process
  row(901, 1, "bun.exe", BUN_EXE, T0 + 2000),
];

describe("planLeftovers", () => {
  test("the recorded engine and its whole descendant chain are selected, nothing else", () => {
    const plan = planLeftovers([...liveTree(), ...bystanders()], prev, win);
    expect(plan.engineVerdict).toBe("alive-ours");
    expect(pids(plan.targets)).toEqual([100, 101, 102, 103, 104]);
    expect(plan.targets[0]!.pid).toBe(100);
    expect(plan.targets.find((t) => t.pid === 100)!.role).toBe("engine");
    expect(plan.targets.find((t) => t.pid === 102)!.role).toBe("agent (omp)");
    expect(plan.targets.find((t) => t.pid === 103)!.role).toBe("scanner");
    expect(plan.targets.find((t) => t.pid === 104)!.role).toBe("speech (whisper)");
  });

  test("a recycled pid running a different image is not ours, and neither are its children", () => {
    const rows = [row(100, 50, "chrome.exe", "C:\\Program Files\\Google\\Chrome\\chrome.exe", T0 + 30_000), row(150, 100, "chrome.exe", "C:\\Program Files\\Google\\Chrome\\chrome.exe", T0 + 31_000), ...bystanders()];
    const plan = planLeftovers(rows, prev, win);
    expect(plan.engineVerdict).toBe("pid-reused");
    expect(plan.targets).toEqual([]);
  });

  test("a recycled pid with the same image but a different start time is not ours", () => {
    const rows = [row(100, 50, "lucid-engine.exe", ENGINE_EXE, T0 + 5_001), row(151, 100, "bun.exe", BUN_EXE, T0 + 6_000), ...bystanders()];
    expect(planLeftovers(rows, prev, win)).toEqual({ engineVerdict: "pid-reused", targets: [] });
    // ...while a start inside the tolerance is the same process.
    expect(planLeftovers([row(100, 50, "lucid-engine.exe", ENGINE_EXE, T0 - 4_000)], prev, win).engineVerdict).toBe("alive-ours");
  });

  test("a stale ParentProcessId older than the engine is not a descendant", () => {
    // Windows never clears ParentProcessId: pid 160 was a child of an EARLIER holder of pid 100.
    const rows = [...liveTree(), row(160, 100, "notepad.exe", "C:\\Windows\\notepad.exe", T0 - 10_000), row(161, 160, "cmd.exe", "C:\\Windows\\cmd.exe", T0 - 9_000)];
    expect(pids(planLeftovers(rows, prev, win).targets)).toEqual([100, 101, 102, 103, 104]);
  });

  test("the current main and its descendants are never selected, even if they look like engine children", () => {
    // Contrived: the current main claims the dead engine as parent and was created after it.
    const rows = [
      row(SELF, 100, "LucidAgentIDE.exe", "C:\\app\\LucidAgentIDE.exe", T0 + 60_000),
      row(SELF + 1, SELF, "lucid-engine.exe", ENGINE_EXE, T0 + 61_000),
      row(101, 100, "omp.exe", "C:\\x\\omp.exe", T0 + 900),
    ];
    const plan = planLeftovers(rows, prev, win);
    expect(plan.engineVerdict).toBe("gone");
    expect(pids(plan.targets)).toEqual([101]);
    // A ledger that names the current main itself as the engine selects nothing.
    const self = planLeftovers([row(SELF, 1, "bun.exe", BUN_EXE, T0)], { pid: SELF, startedAt: T0, exe: BUN_EXE }, win);
    expect(self.targets).toEqual([]);
  });

  test("orphaned children of the dead engine are selected with their descendants", () => {
    const rows = [
      row(101, 100, "omp.exe", "C:\\x\\omp.exe", T0 + 900),
      row(102, 101, "bun.exe", BUN_EXE, T0 + 950),
      row(170, 100, "cmd.exe", "C:\\Windows\\cmd.exe", T0 - 1), // created BEFORE the engine: not its child
      ...bystanders(),
    ];
    const plan = planLeftovers(rows, prev, win);
    expect(plan.engineVerdict).toBe("gone");
    expect(pids(plan.targets)).toEqual([101, 102]);
    expect(plan.targets.find((t) => t.pid === 101)!.why).toContain("orphaned child");
  });

  test("when a stranger now holds the engine pid, only orphans created before the stranger are ours", () => {
    const rows = [
      row(100, 50, "chrome.exe", "C:\\chrome.exe", T0 + 20_000),
      row(101, 100, "omp.exe", "C:\\x\\omp.exe", T0 + 900), // the dead engine's
      row(180, 100, "chrome.exe", "C:\\chrome.exe", T0 + 21_000), // the stranger's own child
    ];
    expect(pids(planLeftovers(rows, prev, win).targets)).toEqual([101]);
  });

  test("no engine record means no claim at all", () => {
    expect(planLeftovers(liveTree(), null, win)).toEqual({ engineVerdict: "no-record", targets: [] });
  });

  test("POSIX matches the recorded command on a token boundary and compares start times in seconds", () => {
    const px = { selfPid: SELF, platform: "linux" };
    const start = Math.floor(T0 / 1000) * 1000; // lstart resolution
    const p = (pid: number, ppid: number, command: string, s: number): ProcRow => ({ pid, ppid, name: "", exe: null, command, startedAt: s });
    const rec: EngineRecord = { pid: 100, startedAt: T0 + 400, exe: "/opt/Lucid Agent/bin/lucid-engine" };
    const ours = planLeftovers([p(100, 1, "/opt/Lucid Agent/bin/lucid-engine", start), p(101, 100, "/home/u/.bun/bin/bun omp acp", start)], rec, px);
    expect(pids(ours.targets)).toEqual([100, 101]);
    const other = planLeftovers([p(100, 1, "/opt/Lucid Agent/bin/lucid-engine-old", start)], rec, px);
    expect(other.engineVerdict).toBe("pid-reused");
  });
});

describe("parseProcessList", () => {
  test("win32 JSON: one object or an array; null creation time survives as null", () => {
    const one = parseProcessList("win32", `{"p":100,"pp":50,"n":"lucid-engine.exe","x":"C:\\\\a\\\\lucid-engine.exe","c":${T0}}`);
    expect(one).toEqual([row(100, 50, "lucid-engine.exe", "C:\\a\\lucid-engine.exe", T0)]);
    const many = parseProcessList("win32", `[{"p":4,"pp":0,"n":"System","x":null,"c":null},{"p":9,"pp":4,"n":"x.exe","x":"","c":${T0}}]`);
    expect(many).toEqual([row(4, 0, "System", null, null), row(9, 4, "x.exe", null, T0)]);
    expect(parseProcessList("win32", "not json")).toEqual([]);
  });

  test("POSIX ps: lstart becomes local epoch ms and the command keeps its spaces", () => {
    const out = "  4242     1 Wed Sep  3 10:04:05 2026 /opt/Lucid Agent/bin/lucid-engine --x\n";
    const rows = parseProcessList("linux", out);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      pid: 4242, ppid: 1, command: "/opt/Lucid Agent/bin/lucid-engine --x",
      startedAt: new Date(2026, 8, 3, 10, 4, 5).getTime(),
    });
  });
});

describe("kill commands", () => {
  test("taskkill names every proven pid and never walks the tree itself", () => {
    expect(taskkillArgs([100, 101])).toEqual(["/F", "/PID", "100", "/PID", "101"]);
  });
  test("a single-pid probe refuses a non-integer pid (it is interpolated into the query)", () => {
    expect(() => processListSpec("win32", 1.5)).toThrow();
    expect(processListSpec("win32", 42).args.at(-1)).toContain("-Filter 'ProcessId=42'");
  });
});
