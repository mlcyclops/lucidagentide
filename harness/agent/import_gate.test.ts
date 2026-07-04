// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/agent/import_gate.test.ts — P-AGENT.5 (ADR-0133): the untrusted-spec quarantine gate (pure logic).
// The scanner-integrated end-to-end path is proven in demo_p_agent_5.ts (it starts the real sidecar).

import { test, expect, describe } from "bun:test";
import { collectSpecText, importDecision, canAutoRun } from "./import_gate.ts";
import { newSpecId, SPEC_VERSION, type AgentSpec } from "./spec.ts";
import type { Finding } from "../contracts.ts";
import type { GateDecision } from "../security/gate.ts";

function spec(over: Partial<AgentSpec> = {}): AgentSpec {
  return {
    spec_id: newSpecId(),
    spec_version: SPEC_VERSION,
    name: "researcher",
    description: "plan then search",
    persona: "You are careful.",
    mode: "built-agent",
    tools: ["web_search"],
    egress: [],
    selfEdit: "individual",
    nodes: [{ id: "a", kind: "prompt", label: "Plan", prompt: "Plan the task" }],
    edges: [],
    created_at: 1,
    updated_at: 1,
    ...over,
  };
}

const clean: GateDecision = { block: false, reason: "clean", trustLabel: "trusted", findings: [], failClosed: false };
const finding: Finding = { type: "zero-width", codepoint: "U+200B", index: 3, severity: "high" };
const blocked: GateDecision = { block: true, reason: "quarantined: 1 finding", trustLabel: "quarantined", findings: [finding], failClosed: false };
const subThreshold: GateDecision = { block: false, reason: "suspicious", trustLabel: "suspicious", findings: [{ ...finding, severity: "low" }], failClosed: false };
const failClosed: GateDecision = { block: true, reason: "fail-closed: scan unavailable", trustLabel: "quarantined", findings: [], failClosed: true };

describe("collectSpecText (P-AGENT.5)", () => {
  test("gathers name/description/persona + node labels + prompts (the injection surface)", () => {
    const t = collectSpecText(spec());
    expect(t).toContain("researcher");
    expect(t).toContain("plan then search");
    expect(t).toContain("You are careful.");
    expect(t).toContain("Plan the task");
    // tool identifiers are NOT free text and are excluded
    expect(t).not.toContain("web_search");
  });
});

describe("importDecision (P-AGENT.5) — provenance + findings -> trust label", () => {
  test("locally authored + clean -> trusted", () => {
    expect(importDecision("local", clean).trustLabel).toBe("trusted");
  });
  test("imported + clean -> untrusted (external provenance is never auto-trusted)", () => {
    expect(importDecision("import", clean).trustLabel).toBe("untrusted");
  });
  test("blocking findings -> quarantined regardless of source", () => {
    expect(importDecision("local", blocked).trustLabel).toBe("quarantined");
    expect(importDecision("import", blocked).trustLabel).toBe("quarantined");
  });
  test("sub-threshold findings -> suspicious", () => {
    expect(importDecision("local", subThreshold).trustLabel).toBe("suspicious");
  });
  test("fail-closed (scan unavailable) -> quarantined even for a local spec", () => {
    expect(importDecision("local", failClosed).trustLabel).toBe("quarantined");
  });
});

describe("canAutoRun (P-AGENT.5) — only trusted auto-runs", () => {
  test("trusted may auto-run", () => {
    expect(canAutoRun("trusted").allowed).toBe(true);
  });
  test("untrusted / suspicious / quarantined may NOT auto-run", () => {
    expect(canAutoRun("untrusted").allowed).toBe(false);
    expect(canAutoRun("suspicious").allowed).toBe(false);
    expect(canAutoRun("quarantined").allowed).toBe(false);
  });
  test("every non-trusted label carries a human-readable reason", () => {
    for (const l of ["untrusted", "suspicious", "quarantined"] as const) {
      expect(canAutoRun(l).reason.length).toBeGreaterThan(0);
    }
  });
});
