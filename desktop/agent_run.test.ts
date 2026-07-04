// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/agent_run.test.ts — P-AGENT.4-live (ADR-0133): the fail-closed guards BEFORE a built agent is
// spawned. The live-spawn path is covered by demo_p_agent_4_live* (needs a model); these hermetic tests prove
// the refusal paths never reach omp.

import { test, expect, describe } from "bun:test";
import { runBuiltAgent } from "./agent_run.ts";
import { newSpecId, SPEC_VERSION, type AgentSpec } from "../harness/agent/spec.ts";

function spec(over: Partial<AgentSpec> = {}): AgentSpec {
  return {
    spec_id: newSpecId(),
    spec_version: SPEC_VERSION,
    name: "researcher",
    mode: "built-agent",
    tools: [],
    egress: [],
    selfEdit: "individual",
    nodes: [{ id: "a", kind: "prompt", label: "Answer", prompt: "Answer" }],
    edges: [],
    created_at: 1,
    updated_at: 1,
    ...over,
  };
}

describe("runBuiltAgent guards (P-AGENT.4-live)", () => {
  test("a non-runnable-trust spec is BLOCKED before any spawn (P-AGENT.5 gate)", async () => {
    for (const trust of ["untrusted", "suspicious", "quarantined"] as const) {
      const r = await runBuiltAgent({ spec: spec(), prompt: "hi", model: "haiku", workspace: "/tmp", trustLabel: trust });
      expect(r.ok).toBe(false);
      expect(r.blocked).toBe(true);
      expect(r.reason).toBeTruthy();
    }
  });

  test("an invalid spec is refused (no spawn)", async () => {
    const r = await runBuiltAgent({ spec: { ...spec(), nodes: [] } as AgentSpec, prompt: "hi", model: "haiku", workspace: "/tmp" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("invalid spec");
  });

  test("an empty prompt is refused (no spawn)", async () => {
    const r = await runBuiltAgent({ spec: spec(), prompt: "   ", model: "haiku", workspace: "/tmp" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("enter a task");
  });
});
