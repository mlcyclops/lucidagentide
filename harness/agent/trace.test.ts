// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/agent/trace.test.ts — P-AGENT.13 (ADR-0139): file-backed run traces. Round-trip, truncation,
// fail-soft reads, path-safety, spec scoping, newest-first ordering.

import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TraceRecorder, listTraces, loadTrace, snippet } from "./trace.ts";

function root(): string {
  return mkdtempSync(join(tmpdir(), "agent-traces-"));
}

function record(r: string, runId: string, specId: string, status: "completed" | "denied" = "completed"): TraceRecorder {
  const rec = new TraceRecorder(r, { run_id: runId, spec_id: specId, name: "researcher", model: "haiku", prompt: "find papers", lineage: [specId] });
  rec.step({ kind: "segment", node_ids: ["a", "b"], label: "part 1", started_at: 1, finished_at: 2, ok: true, detail: "found 3 papers" });
  rec.step({ kind: "approval", node_ids: ["g"], label: "Review", started_at: 3, finished_at: 4, ok: status === "completed", detail: status === "completed" ? "approved by the user" : "denied" });
  rec.status(status, "summary");
  return rec;
}

describe("run traces (P-AGENT.13)", () => {
  test("recorder → list → load round-trips steps, status, and final output", () => {
    const r = root();
    try {
      record(r, "run_1", "agent_x");
      const list = listTraces(r);
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ run_id: "run_1", spec_id: "agent_x", status: "completed", steps: 2 });
      const t = loadTrace(r, "run_1")!;
      expect(t.steps[0]!.detail).toBe("found 3 papers");
      expect(t.steps[1]!.kind).toBe("approval");
      expect(t.final_output).toBe("summary");
      expect(t.finished_at).toBeGreaterThan(0);
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });

  test("a parked run's trace is on disk as awaiting-approval BEFORE any human decision", () => {
    const r = root();
    try {
      const rec = new TraceRecorder(r, { run_id: "run_p", spec_id: "agent_x", name: "n", model: "m", prompt: "p", lineage: ["agent_x"] });
      rec.step({ kind: "segment", node_ids: ["a"], label: "part 1", started_at: 1, finished_at: 2, ok: true, detail: "work" });
      rec.status("awaiting-approval");
      const t = loadTrace(r, "run_p")!;
      expect(t.status).toBe("awaiting-approval");
      expect(t.finished_at).toBeUndefined(); // not terminal — the run is parked, not done
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });

  test("long outputs are truncated in steps, prompts, and final output — traces stay small", () => {
    const big = "x".repeat(10_000);
    expect(snippet(big).length).toBeLessThanOrEqual(2001); // cap + ellipsis
    const r = root();
    try {
      const rec = new TraceRecorder(r, { run_id: "run_b", spec_id: "s", name: "n", model: "m", prompt: big, lineage: ["s"] });
      rec.step({ kind: "segment", node_ids: [], label: "part 1", started_at: 1, finished_at: 2, ok: true, detail: big });
      rec.status("completed", big);
      const t = loadTrace(r, "run_b")!;
      expect(t.prompt.length).toBeLessThanOrEqual(2001);
      expect(t.steps[0]!.detail.length).toBeLessThanOrEqual(2001);
      expect(t.final_output!.length).toBeLessThanOrEqual(2001);
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });

  test("listing scopes by spec, orders newest-first, and skips corrupted files", () => {
    const r = root();
    try {
      const a = record(r, "run_old", "agent_a");
      a.trace.started_at = 1000;
      a.save();
      const b = record(r, "run_new", "agent_a");
      b.trace.started_at = 2000;
      b.save();
      record(r, "run_other", "agent_b");
      mkdirSync(join(r, ".omp", "agent-runs", "traces"), { recursive: true });
      writeFileSync(join(r, ".omp", "agent-runs", "traces", "junk.json"), "{not json");
      expect(listTraces(r, "agent_a").map((t) => t.run_id)).toEqual(["run_new", "run_old"]);
      expect(listTraces(r)).toHaveLength(3);
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });

  test("unsafe run ids never resolve (path traversal)", () => {
    const r = root();
    try {
      expect(loadTrace(r, "../../etc/passwd")).toBeNull();
      expect(loadTrace(r, "run_missing")).toBeNull();
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });
});
