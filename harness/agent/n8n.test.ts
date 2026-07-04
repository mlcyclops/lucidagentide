// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/agent/n8n.test.ts — P-AGENT.10 (ADR-0138): the n8n interop translator. Round-trip via the
// embedded portable block, honest lossy mapping on generic imports, DAG preservation, credential NAMES only.

import { test, expect, describe } from "bun:test";
import { specToN8n, n8nToSpec, isN8nWorkflowJson, LUCID_EMBED_FENCE, type N8nWorkflow } from "./n8n.ts";
import { exportPortableAgent, parsePortableAgentJson } from "./portable.ts";
import { validateSpec, newSpecId, SPEC_VERSION, type AgentSpec } from "./spec.ts";

function spec(over: Partial<AgentSpec> = {}): AgentSpec {
  const now = 1_700_000_000_000;
  return {
    spec_id: newSpecId(),
    spec_version: SPEC_VERSION,
    name: "crm-logger",
    mode: "built-agent",
    tools: ["web_search"],
    egress: ["api.crm.example.com"],
    selfEdit: "individual",
    secrets: [{ name: "CRM_TOKEN", kind: "apikey", purpose: "CRM API" }],
    nodes: [
      { id: "a", kind: "prompt", label: "Plan", prompt: "Plan the search" },
      { id: "b", kind: "tool", label: "Search", tool: "web_search" },
      { id: "c", kind: "approval", label: "Review results" },
      { id: "d", kind: "subagent", label: "Log to CRM", subagentSpecId: "agent_child" },
    ],
    edges: [
      { id: "e1", from: "a", to: "b" },
      { id: "e2", from: "b", to: "c" },
      { id: "e3", from: "c", to: "d" },
    ],
    created_at: now,
    updated_at: now,
    ...over,
  };
}

function portableJson(s: AgentSpec): string {
  return JSON.stringify(exportPortableAgent(s, 123), null, 2);
}

describe("specToN8n (P-AGENT.10)", () => {
  test("emits an importable scaffold: trigger + one node per step, wired along the spec edges", () => {
    const s = spec();
    const wf = specToN8n(s, portableJson(s));
    expect(isN8nWorkflowJson(wf)).toBe(true);
    // approval → a REAL n8n wait node; subagent → executeWorkflow; steps keep topo-order names
    const types = wf.nodes.map((n) => n.type);
    expect(types).toContain("n8n-nodes-base.manualTrigger");
    expect(types).toContain("n8n-nodes-base.wait");
    expect(types).toContain("n8n-nodes-base.executeWorkflow");
    // the trigger feeds the single root; each edge became a connection
    expect(wf.connections["Start"]!.main![0]![0]!.node).toBe("1. Plan");
    expect(wf.connections["1. Plan"]!.main![0]![0]!.node).toBe("2. Search");
    expect(wf.connections["3. Review results"]!.main![0]![0]!.node).toBe("4. Log to CRM");
  });

  test("provenance sticky carries setup guidance + the fenced portable agent, never credential values", () => {
    const s = spec();
    const wf = specToN8n(s, portableJson(s));
    const sticky = wf.nodes.find((n) => n.type === "n8n-nodes-base.stickyNote")!;
    const content = String(sticky.parameters.content);
    expect(content).toContain("CRM_TOKEN");
    expect(content).toContain("```" + LUCID_EMBED_FENCE);
    expect(content).toContain("does not contain credential values");
  });

  test("refuses an invalid spec fail-closed", () => {
    const bad = { ...spec(), nodes: [] } as unknown as AgentSpec;
    expect(() => specToN8n(bad, "{}")).toThrow(/invalid spec/);
  });
});

describe("n8nToSpec (P-AGENT.10)", () => {
  test("round-trip: an exported workflow imports back to the EXACT original spec via the embedded block", () => {
    const s = spec();
    const wf = specToN8n(s, portableJson(s));
    const r = n8nToSpec(wf);
    expect(r.embeddedPortableJson).toBeTruthy();
    const restored = parsePortableAgentJson(r.embeddedPortableJson!);
    expect(restored.ok).toBe(true);
    expect(restored.spec).toEqual(s);
  });

  test("generic n8n workflow maps to a valid spec: wait→approval, httpRequest→read tool + egress, creds→refs", () => {
    const wf: N8nWorkflow = {
      name: "Lead sync",
      nodes: [
        { parameters: {}, name: "When clicking Test", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, position: [0, 0] },
        {
          parameters: { url: "https://api.hubspot.com/crm/v3/objects/contacts" },
          name: "Fetch contacts",
          type: "n8n-nodes-base.httpRequest",
          typeVersion: 4.1,
          position: [200, 0],
          credentials: { httpBasicAuth: { id: "1", name: "hubspot login" } },
        },
        { parameters: { jsCode: "return items;" }, name: "Reshape", type: "n8n-nodes-base.code", typeVersion: 2, position: [400, 0] },
        { parameters: {}, name: "Manager sign-off", type: "n8n-nodes-base.wait", typeVersion: 1.1, position: [600, 0] },
      ],
      connections: {
        "When clicking Test": { main: [[{ node: "Fetch contacts", type: "main", index: 0 }]] },
        "Fetch contacts": { main: [[{ node: "Reshape", type: "main", index: 0 }]] },
        Reshape: { main: [[{ node: "Manager sign-off", type: "main", index: 0 }]] },
      },
      settings: {},
    };
    const r = n8nToSpec(wf, 42);
    expect(r.embeddedPortableJson).toBeUndefined();
    const v = validateSpec(r.spec);
    expect(v.ok).toBe(true);
    const s = v.spec!;
    expect(s.nodes.map((n) => n.kind)).toEqual(["tool", "prompt", "approval"]); // trigger dropped, noted
    expect(s.tools).toEqual(["read"]);
    expect(s.egress).toEqual(["api.hubspot.com"]);
    expect(s.secrets![0]!.name).toBe("HUBSPOT_LOGIN");
    expect(s.secrets![0]!.kind).toBe("basic");
    expect(s.secrets![0]!.provisioning?.method).toBe("user-input");
    expect(s.edges).toHaveLength(2); // fetch→reshape→sign-off
    expect(r.notes.join()).toContain("trigger");
  });

  test("n8n IF nodes become branch nodes with true/false edge labels; underconnected ones demote (P-AGENT.11c)", () => {
    const wf: N8nWorkflow = {
      name: "Triage",
      nodes: [
        { parameters: {}, name: "Check", type: "n8n-nodes-base.if", typeVersion: 2, position: [0, 0] },
        { parameters: {}, name: "High", type: "n8n-nodes-base.code", typeVersion: 2, position: [200, 0] },
        { parameters: {}, name: "Low", type: "n8n-nodes-base.code", typeVersion: 2, position: [200, 200] },
        { parameters: {}, name: "Lonely", type: "n8n-nodes-base.if", typeVersion: 2, position: [400, 0] },
      ],
      connections: {
        Check: { main: [[{ node: "High", type: "main", index: 0 }], [{ node: "Low", type: "main", index: 0 }]] },
        High: { main: [[{ node: "Lonely", type: "main", index: 0 }]] },
      },
      settings: {},
    };
    const r = n8nToSpec(wf, 42);
    const v = validateSpec(r.spec);
    expect(v.ok).toBe(true);
    const s = v.spec!;
    const check = s.nodes.find((n) => n.label === "Check")!;
    expect(check.kind).toBe("branch");
    const labels = s.edges.filter((e) => e.from === check.id).map((e) => e.label).sort();
    expect(labels).toEqual(["false", "true"]); // IF lane 0 = true, lane 1 = false
    // the IF with a single connected output is demoted, not refused
    expect(s.nodes.find((n) => n.label === "Lonely")!.kind).toBe("prompt");
    expect(r.notes.join()).toContain("demoted");
  });

  test("loop-back connections are dropped so the result stays a DAG", () => {
    const wf: N8nWorkflow = {
      name: "Loopy",
      nodes: [
        { parameters: {}, name: "A", type: "n8n-nodes-base.code", typeVersion: 2, position: [0, 0] },
        { parameters: {}, name: "B", type: "n8n-nodes-base.code", typeVersion: 2, position: [200, 0] },
      ],
      connections: {
        A: { main: [[{ node: "B", type: "main", index: 0 }]] },
        B: { main: [[{ node: "A", type: "main", index: 0 }]] }, // the loop back
      },
      settings: {},
    };
    const r = n8nToSpec(wf, 42);
    expect(validateSpec(r.spec).ok).toBe(true);
    expect(r.spec!.edges).toHaveLength(1);
    expect(r.notes.join()).toContain("loop-back");
  });

  test("detection: n8n JSON vs anything else", () => {
    expect(isN8nWorkflowJson({ nodes: [], connections: {} })).toBe(true);
    expect(isN8nWorkflowJson({ format: "lucid-agent" })).toBe(false);
    expect(isN8nWorkflowJson([])).toBe(false);
    expect(isN8nWorkflowJson("x")).toBe(false);
  });
});
