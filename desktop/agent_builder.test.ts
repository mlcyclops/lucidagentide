// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/agent_builder.test.ts — P-AGENT.2 (ADR-0133): the Agent Builder canvas pure builders + adapters.

import { test, expect, describe } from "bun:test";
import {
  agentBuilderPanelHtml,
  nodeEditorHtml,
  runPanelHtml,
  secretsPanelHtml,
  agentInterviewPrompt,
  specToGraphData,
  saveErrors,
  newCanvasSpec,
  kindLabel,
} from "./renderer/agent_builder.ts";
import { newSpecId, SPEC_VERSION, type AgentSpec } from "../harness/agent/spec.ts";

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
      { id: "a", kind: "prompt", label: "Plan", prompt: "Plan it" },
      { id: "b", kind: "tool", label: "Search", tool: "web_search" },
      { id: "c", kind: "prompt", label: "Write", prompt: "Write it" },
    ],
    edges: [
      { id: "e1", from: "a", to: "b" },
      { id: "e2", from: "b", to: "c" },
    ],
    created_at: now,
    updated_at: now,
    ...over,
  };
}

describe("agent builder panel (P-AGENT.2)", () => {
  test("panel html has the surface id, an add-node button per kind, and Save/Validate", () => {
    const h = agentBuilderPanelHtml();
    expect(h).toContain('id="agentBuilder"');
    expect(h).toContain('id="abCanvas"'); // the mountGraph host
    expect(h).toContain('id="abSave"');
    expect(h).toContain('id="abValidate"');
    expect(h).toContain('id="abConnect"');
    expect(h).toContain('id="abExport"');
    expect(h).toContain('id="abRun"');
    for (const kind of ["prompt", "tool", "subagent", "approval"]) {
      expect(h).toContain(`data-ab-add="${kind}"`);
    }
  });

  test("run panel has a task box, run button, output area, and shows the model", () => {
    const h = runPanelHtml("claude-haiku-4-5");
    expect(h).toContain('id="abRunPrompt"');
    expect(h).toContain('id="abRunGo"');
    expect(h).toContain('id="abRunOut"');
    expect(h).toContain("claude-haiku-4-5");
  });

  test("secrets & connections panel lists egress connections + credential refs with vault status", () => {
    const s = spec({
      egress: ["*.salesforce.com", "*.govwin.com"],
      secrets: [
        { name: "SALESFORCE_API_TOKEN", kind: "apikey", purpose: "Salesforce REST API" },
        { name: "GOVWIN_PASSWORD", kind: "basic", purpose: "GovWin login" },
      ],
    });
    // GOVWIN_PASSWORD already in the vault; SALESFORCE_API_TOKEN not yet
    const h = secretsPanelHtml(s, new Set(["GOVWIN_PASSWORD"]), true);
    expect(h).toContain("*.salesforce.com");
    expect(h).toContain("SALESFORCE_API_TOKEN");
    expect(h).toContain("in vault"); // GOVWIN_PASSWORD status
    expect(h).toContain("needs a value"); // SALESFORCE_API_TOKEN status
    expect(h).toContain("ab-cred-save"); // an "Add to vault" affordance for the missing one
    expect(h).toContain("ab-cred-help"); // a "How do I get this?" doc-assist link for the missing one
    // the panel never renders a secret VALUE — only names/kinds/purposes
    expect(h).not.toContain("password value");
  });

  test("connections show Approve until whitelisted, then approved (P-AGENT.8.5)", () => {
    const s = spec({ egress: ["*.salesforce.com", "*.govwin.com"], secrets: [] });
    // *.salesforce.com already approved; *.govwin.com not yet
    const h = secretsPanelHtml(s, new Set(), true, new Set(["*.salesforce.com"]));
    expect(h).toContain("✓ approved"); // salesforce
    expect(h).toContain("ab-conn-approve"); // an Approve button for govwin
    expect(h).toContain('data-conn="*.govwin.com"');
  });

  test("secrets panel warns when the vault is unavailable (non-Electron)", () => {
    const h = secretsPanelHtml(spec({ secrets: [{ name: "X", kind: "apikey" }] }), new Set(), false);
    expect(h).toContain("desktop app only");
  });

  test("/agent interview prompt steers the guardrailed interview + the handoff (P-AGENT.8)", () => {
    const p = agentInterviewPrompt("");
    expect(p).toContain("agent_builder_open"); // ends by opening the builder
    expect(p).toContain("NAME only"); // declare secrets by name
    expect(p).toContain("NEVER ask me for a password"); // the guardrail
    expect(p).toContain("what should this agent do"); // asks the first question when no description
    // with a description, it weaves it in + confirms first
    const withDesc = agentInterviewPrompt("search for DoD grants and log to Salesforce");
    expect(withDesc).toContain("search for DoD grants and log to Salesforce");
    expect(withDesc).toContain("confirming my idea");
  });

  test("node editor shows kind-specific fields", () => {
    const promptEd = nodeEditorHtml({ id: "a", kind: "prompt", label: "Plan", prompt: "hi" }, []);
    expect(promptEd).toContain('id="abPrompt"');
    const toolEd = nodeEditorHtml({ id: "b", kind: "tool", label: "Search", tool: "web_search" }, ["web_search"]);
    expect(toolEd).toContain('id="abTool"');
    expect(toolEd).toContain("web_search");
  });

  test("kindLabel is sentence case for each kind", () => {
    expect(kindLabel("prompt")).toBe("Prompt");
    expect(kindLabel("subagent")).toBe("Sub-agent");
  });

  test("node editor escapes interpolated values (no raw injection)", () => {
    const ed = nodeEditorHtml({ id: "x", kind: "prompt", label: '"><img src=x>', prompt: "" }, []);
    expect(ed).not.toContain("<img src=x>");
    expect(ed).toContain("&lt;img");
  });
});

describe("spec ↔ canvas adapters (P-AGENT.2)", () => {
  test("specToGraphData maps nodes/edges into the graph engine shape with degree counts", () => {
    const g = specToGraphData(spec());
    expect(g.nodes.map((n) => n.id).sort()).toEqual(["a", "b", "c"]);
    expect(g.facts).toEqual([]);
    // node b is on two edges → degree 2
    expect(g.nodes.find((n) => n.id === "b")!.count).toBe(2);
    expect(g.edges).toContainEqual({ from: "a", to: "b", relation: "then" });
    // kind is preserved so the engine's kind-lens colours nodes by step type
    expect(g.nodes.find((n) => n.id === "b")!.kind).toBe("tool");
  });

  test("saveErrors is empty for a valid spec and surfaces a cycle for an invalid one", () => {
    expect(saveErrors(spec())).toEqual([]);
    const cyclic = spec({
      edges: [
        { id: "e1", from: "a", to: "b" },
        { id: "e2", from: "b", to: "c" },
        { id: "e3", from: "c", to: "a" },
      ],
    });
    expect(saveErrors(cyclic).join()).toContain("acyclic");
  });

  test("newCanvasSpec yields a valid starting spec", () => {
    expect(saveErrors(newCanvasSpec("blank", 1))).toEqual([]);
  });
});
