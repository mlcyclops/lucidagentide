// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/agent/handoff.test.ts — P-AGENT.8.2 (ADR-0130): the chat -> Agent-Builder handoff gate.

import { test, expect, describe } from "bun:test";
import { parseDraftedSpec, agentBuilderOpenSpec } from "./handoff.ts";
import { newSpecId, SPEC_VERSION, type AgentSpec } from "./spec.ts";

function draft(over: Partial<AgentSpec> = {}): AgentSpec {
  return {
    spec_id: newSpecId(),
    spec_version: SPEC_VERSION,
    name: "gov-bd",
    description: "Search DoD opportunities; log to Salesforce.",
    mode: "built-agent",
    tools: ["web_search"],
    egress: ["*.salesforce.com"],
    secrets: [{ name: "SALESFORCE_API_TOKEN", kind: "apikey", purpose: "Salesforce REST API" }],
    nodes: [{ id: "a", kind: "prompt", label: "Plan", prompt: "Plan the search." }],
    edges: [],
    selfEdit: "individual",
    created_at: 1,
    updated_at: 1,
    ...over,
  };
}

describe("parseDraftedSpec (P-AGENT.8.2)", () => {
  test("accepts a valid, secret-free draft", () => {
    const r = parseDraftedSpec(JSON.stringify(draft()));
    expect(r.ok).toBe(true);
    expect(r.spec?.name).toBe("gov-bd");
  });
  test("rejects non-JSON", () => {
    expect(parseDraftedSpec("{not json").ok).toBe(false);
  });
  test("rejects an invalid spec (not a DAG)", () => {
    const bad = draft({ nodes: [{ id: "a", kind: "prompt", label: "x", prompt: "" }], edges: [{ id: "e", from: "a", to: "a" }] });
    expect(parseDraftedSpec(JSON.stringify(bad)).ok).toBe(false);
  });
  test("rejects a draft that embeds a secret, steering the agent to the vault", () => {
    const leaky = draft({ persona: "use api_key: sk-abcdEFGH1234567890ijklMNOP" });
    const r = parseDraftedSpec(JSON.stringify(leaky));
    expect(r.ok).toBe(false);
    expect(r.message).toContain("vault");
  });
});

describe("agentBuilderOpenSpec detector (P-AGENT.8.2)", () => {
  test("returns the spec for an agent_builder_open call with a valid specJson", () => {
    const spec = agentBuilderOpenSpec("agent_builder_open", { specJson: JSON.stringify(draft()) });
    expect(spec?.name).toBe("gov-bd");
  });
  test("returns null for a call without specJson (a different tool)", () => {
    // specJson is unique to agent_builder_open, so a call that lacks it is not our tool.
    expect(agentBuilderOpenSpec("preview_open", { path: "/tmp/x.html" })).toBeNull();
    expect(agentBuilderOpenSpec("agent_builder_open", {})).toBeNull();
  });
  test("returns null (never opens) for a leaky draft", () => {
    const leaky = draft({ persona: "token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345" });
    expect(agentBuilderOpenSpec("agent_builder_open", { specJson: JSON.stringify(leaky) })).toBeNull();
  });
});
