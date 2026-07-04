// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/agent/segments.test.ts — P-AGENT.11a (ADR-0137): the segment runner. The KEYSTONE property —
// no post-approval segment is reachable without an explicit approve() — is stop-the-line (AGENTS.md):
// treat a regression here like a failing scanner test.

import { test, expect, describe } from "bun:test";
import { splitSegments, renderSegmentPrompt, SegmentedRun } from "./segments.ts";
import { newSpecId, SPEC_VERSION, type AgentSpec } from "./spec.ts";

function spec(over: Partial<AgentSpec> = {}): AgentSpec {
  const now = 1_700_000_000_000;
  return {
    spec_id: newSpecId(),
    spec_version: SPEC_VERSION,
    name: "researcher",
    mode: "built-agent",
    tools: ["web_search"],
    egress: [],
    selfEdit: "individual",
    nodes: [
      { id: "a", kind: "prompt", label: "Plan", prompt: "Plan the research" },
      { id: "b", kind: "tool", label: "Search", tool: "web_search" },
      { id: "g", kind: "approval", label: "Review findings" },
      { id: "c", kind: "prompt", label: "Publish", prompt: "Write the final summary" },
    ],
    edges: [
      { id: "e1", from: "a", to: "b" },
      { id: "e2", from: "b", to: "g" },
      { id: "e3", from: "g", to: "c" },
    ],
    created_at: now,
    updated_at: now,
    ...over,
  };
}

describe("splitSegments (P-AGENT.11a)", () => {
  test("no approvals → one segment, no boundary", () => {
    const s = spec({ nodes: spec().nodes.filter((n) => n.kind !== "approval"), edges: [{ id: "e1", from: "a", to: "b" }, { id: "e2", from: "b", to: "c" }] });
    const segs = splitSegments(s);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.nodeIds).toEqual(["a", "b", "c"]);
    expect(segs[0]!.approvalAfter).toBeUndefined();
  });

  test("a middle approval splits into pre/post segments; the approval is a boundary, not a step", () => {
    const segs = splitSegments(spec());
    expect(segs).toHaveLength(2);
    expect(segs[0]!.nodeIds).toEqual(["a", "b"]);
    expect(segs[0]!.approvalAfter).toEqual({ nodeId: "g", label: "Review findings" });
    expect(segs[1]!.nodeIds).toEqual(["c"]);
    expect(segs[1]!.approvalAfter).toBeUndefined();
  });

  test("approval-first and approval-last shapes produce checkpoint segments, never lost steps", () => {
    const s = spec({
      nodes: [
        { id: "g0", kind: "approval", label: "Pre-flight sign-off" },
        { id: "a", kind: "prompt", label: "Work", prompt: "do it" },
        { id: "g1", kind: "approval", label: "Final sign-off" },
      ],
      edges: [
        { id: "e1", from: "g0", to: "a" },
        { id: "e2", from: "a", to: "g1" },
      ],
    });
    const segs = splitSegments(s);
    expect(segs.map((x) => x.nodeIds)).toEqual([[], ["a"]]);
    expect(segs[0]!.approvalAfter!.label).toBe("Pre-flight sign-off");
    expect(segs[1]!.approvalAfter!.label).toBe("Final sign-off");
  });
});

describe("renderSegmentPrompt (P-AGENT.11a)", () => {
  test("carries ONLY the segment's steps (global numbering), the halt notice, and prior output", () => {
    const s = spec();
    const segs = splitSegments(s);
    const first = renderSegmentPrompt(s, segs[0]!, 0, 2, "");
    expect(first).toContain("1. [Prompt] Plan");
    expect(first).toContain("2. [Tool] Search");
    expect(first).not.toContain("Publish"); // post-approval step is NOT in the pre-approval prompt
    expect(first).toContain('approval checkpoint "Review findings"');
    const second = renderSegmentPrompt(s, segs[1]!, 1, 2, "findings: 3 candidate papers");
    expect(second).toContain("4. [Prompt] Publish"); // global topo index survives segmentation
    expect(second).toContain("findings: 3 candidate papers");
    expect(second).toContain("final steps");
  });
});

describe("SegmentedRun — KEYSTONE: no post-approval execution without approve()", () => {
  test("the post-approval prompt is UNREACHABLE while awaiting approval", () => {
    const run = new SegmentedRun(spec());
    const seg0 = run.currentSegment();
    expect(seg0.systemPrompt).not.toContain("Publish");
    run.recordSegmentOutput("found 3 papers");
    expect(run.state).toBe("awaiting-approval");
    expect(run.pendingApproval()).toEqual({ nodeId: "g", label: "Review findings" });
    // the ONLY source of an executable prompt refuses in this state — the halt is structural
    expect(() => run.currentSegment()).toThrow(/awaiting-approval/);
    expect(() => run.recordSegmentOutput("smuggled")).toThrow(/awaiting-approval/);
  });

  test("deny is terminal: the workflow can never produce post-approval output", () => {
    const run = new SegmentedRun(spec());
    run.recordSegmentOutput("found 3 papers");
    run.deny("looks wrong");
    expect(run.state).toBe("denied");
    expect(run.denyReason).toBe("looks wrong");
    expect(() => run.currentSegment()).toThrow(/denied/);
    expect(() => run.approve()).toThrow(/denied/);
    expect(run.finalOutput()).toBe("found 3 papers"); // what existed before the halt, nothing more
  });

  test("approve resumes exactly at the next segment and completes", () => {
    const run = new SegmentedRun(spec());
    run.recordSegmentOutput("found 3 papers");
    run.approve();
    expect(run.state).toBe("running");
    const seg1 = run.currentSegment();
    expect(seg1.systemPrompt).toContain("Publish");
    expect(seg1.systemPrompt).toContain("found 3 papers"); // prior work carried forward
    run.recordSegmentOutput("summary written");
    expect(run.state).toBe("completed");
    expect(run.finalOutput()).toBe("summary written");
    expect(run.transcript()).toEqual(["found 3 papers", "summary written"]);
  });

  test("approval-first spec halts IMMEDIATELY — nothing runnable before the first human decision", () => {
    const s = spec({
      nodes: [
        { id: "g0", kind: "approval", label: "Pre-flight sign-off" },
        { id: "a", kind: "prompt", label: "Work", prompt: "do it" },
      ],
      edges: [{ id: "e1", from: "g0", to: "a" }],
    });
    const run = new SegmentedRun(s);
    expect(run.state).toBe("awaiting-approval");
    expect(() => run.currentSegment()).toThrow();
    run.approve();
    expect(run.currentSegment().systemPrompt).toContain("Work");
  });

  test("approvals may not be approved pre-emptively while a segment is still running", () => {
    const run = new SegmentedRun(spec());
    expect(() => run.approve()).toThrow(/running/);
    expect(() => run.deny()).toThrow(/running/);
  });

  test("an invalid spec is refused fail-closed", () => {
    expect(() => new SegmentedRun({ ...spec(), nodes: [] } as unknown as AgentSpec)).toThrow(/invalid spec/);
  });
});
