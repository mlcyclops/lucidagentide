// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/subagent_activity.test.ts — P-TASK.5 (ADR-0180): subagent transcript tailing.
// Pins: the artifacts-dir rule (mirror of omp's sessionFile.slice(0,-6)), transcript parsing
// (assignment preamble strip, thinking/tool/text steps with the `_i` intent label preferred, step
// cap, tool count, model), corrupt-line tolerance, done-detection via the sibling .md, fail-quiet
// listing (no dir / unreadable run), and the big-transcript tail path. Fixtures mirror the REAL
// entry shapes observed in omp 16.x subtask transcripts. All fs injected.

import { describe, expect, test } from "bun:test";
import { listSubagentRuns, parseSubagentTranscript, subagentArtifactsDir, type SubagentIo } from "./subagent_activity.ts";

const line = (o: unknown) => JSON.stringify(o);
const msg = (role: string, content: unknown[]) => line({ type: "message", id: "x", message: { role, content } });
const FIX = [
  line({ type: "session", version: 3, id: "019f-child", cwd: "C:\\w" }),
  line({ type: "model_change", id: "m1", model: "anthropic/claude-haiku-4-5" }),
  msg("user", [{ type: "text", text: "Complete the assignment below, thoroughly:\n\n# Target\nBuild the slingshot golf game with orbital physics." }]),
  msg("assistant", [
    { type: "thinking", thinking: "I will read the existing file first to sample its style." },
    { type: "toolCall", id: "t1", name: "read", arguments: { path: "game.html:1-300", _i: "Sampling game style" } },
  ]),
  msg("toolResult", [{ type: "text", text: "…file contents…" }]),
  msg("assistant", [{ type: "toolCall", id: "t2", name: "bash", arguments: { command: "ls *.html" } }]),
  msg("toolResult", [{ type: "text", text: "a.html" }]),
  msg("assistant", [{ type: "text", text: "The game is complete: orbital gravity wells, 9 holes, par scoring." }]),
].join("\n");

describe("subagentArtifactsDir", () => {
  test("mirrors omp's rule and rejects non-jsonl", () => {
    expect(subagentArtifactsDir("C:/s/2026_id.jsonl")).toBe("C:/s/2026_id");
    expect(subagentArtifactsDir("C:/s/2026_id.txt")).toBeNull();
    expect(subagentArtifactsDir(null)).toBeNull();
  });
});

describe("parseSubagentTranscript", () => {
  test("assignment stripped of the executor preamble; model, steps and tool count extracted", () => {
    const p = parseSubagentTranscript(FIX);
    expect(p.assignment.startsWith("# Target")).toBe(true);
    expect(p.assignment).not.toContain("Complete the assignment below");
    expect(p.model).toBe("anthropic/claude-haiku-4-5");
    expect(p.tools).toBe(2);
    expect(p.steps.map((s) => s.kind)).toEqual(["thinking", "tool", "tool", "text"]);
    expect(p.steps[1]!.label).toBe("Sampling game style");         // the _i intent label wins
    expect(p.steps[2]!.label).toBe("ls *.html");                    // falls back to command
    expect(p.steps[1]!.tool).toBe("read");
  });
  test("keeps only the LAST maxSteps steps but counts every tool", () => {
    const many = [
      msg("user", [{ type: "text", text: "assignment" }]),
      ...Array.from({ length: 20 }, (_, i) => msg("assistant", [{ type: "toolCall", id: `t${i}`, name: "read", arguments: { _i: `step ${i}` } }])),
    ].join("\n");
    const p = parseSubagentTranscript(many, 5);
    expect(p.steps.length).toBe(5);
    expect(p.steps[4]!.label).toBe("step 19");
    expect(p.tools).toBe(20);
  });
  test("corrupt lines contribute nothing and never throw", () => {
    const p = parseSubagentTranscript(`{torn json\n${FIX}\nnot json at all`);
    expect(p.tools).toBe(2);
    expect(p.steps.length).toBeGreaterThan(0);
  });
  test("empty transcript → empty view", () => {
    const p = parseSubagentTranscript("");
    expect(p).toEqual({ assignment: "", model: null, tools: 0, steps: [] });
  });
});

describe("listSubagentRuns", () => {
  const files: Record<string, string> = {
    "C:/s/2026_parent/AbyssalBreakout.jsonl": FIX,
    "C:/s/2026_parent/AbyssalBreakout.md": "# report",
    "C:/s/2026_parent/NeonRampage.jsonl": FIX,
    "C:/s/2026_parent/notes.txt": "ignored",
  };
  const io: SubagentIo = {
    exists: (p) => p.replace(/\\/g, "/") in files || p.replace(/\\/g, "/") === "C:/s/2026_parent",
    readText: (p) => { const k = p.replace(/\\/g, "/"); if (!(k in files)) throw new Error("ENOENT"); return files[k]!; },
    list: () => ["AbyssalBreakout.jsonl", "AbyssalBreakout.md", "NeonRampage.jsonl", "notes.txt"],
    mtime: () => 1234,
    size: (p) => files[p.replace(/\\/g, "/")]?.length ?? 0,
  };
  test("lists runs with done-detection via the sibling .md", () => {
    const runs = listSubagentRuns("C:/s/2026_parent.jsonl", io);
    expect(runs.map((r) => r.name)).toEqual(["AbyssalBreakout", "NeonRampage"]);
    expect(runs[0]!.done).toBe(true);
    expect(runs[1]!.done).toBe(false);
    expect(runs[0]!.tools).toBe(2);
  });
  test("no artifacts dir → [] (a session that never delegated is not an error)", () => {
    expect(listSubagentRuns("C:/s/other.jsonl", io)).toEqual([]);
    expect(listSubagentRuns(null, io)).toEqual([]);
  });
  test("an unreadable transcript skips that run, never the list", () => {
    const io2: SubagentIo = { ...io, readText: (p) => { if (p.includes("Neon")) throw new Error("locked"); return io.readText(p); } };
    const runs = listSubagentRuns("C:/s/2026_parent.jsonl", io2);
    expect(runs.map((r) => r.name)).toEqual(["AbyssalBreakout"]);
  });
  test("big transcripts are tail-read (assignment may be lost, steps survive)", () => {
    const pad = msg("toolResult", [{ type: "text", text: "x".repeat(1024) }]);
    const big = [msg("user", [{ type: "text", text: "assignment" }]), ...Array.from({ length: 3000 }, () => pad),
      msg("assistant", [{ type: "toolCall", id: "t", name: "write", arguments: { _i: "final write" } }])].join("\n");
    const io3: SubagentIo = { ...io, list: () => ["Big.jsonl"], readText: () => big, size: () => big.length, exists: (p) => p.replace(/\\/g, "/") === "C:/s/2026_parent" };
    const runs = listSubagentRuns("C:/s/2026_parent.jsonl", io3);
    expect(runs.length).toBe(1);
    expect(runs[0]!.steps.some((s) => s.label === "final write")).toBe(true);
  });
});
