// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/agent/runner.test.ts — P-AGENT.4a (ADR-0133): materialize a bundle + produce omp launch inputs.

import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materializeBundle, composeBuiltAgentArgs } from "./runner.ts";
import { buildAgent } from "./compiler.ts";
import { newSpecId, SPEC_VERSION, type AgentSpec } from "./spec.ts";

function spec(over: Partial<AgentSpec> = {}): AgentSpec {
  const now = 1_700_000_000_000;
  return {
    spec_id: newSpecId(),
    spec_version: SPEC_VERSION,
    name: "researcher",
    mode: "built-agent",
    tools: ["web_search"],
    egress: ["*.example.com"],
    selfEdit: "individual",
    nodes: [
      { id: "a", kind: "prompt", label: "Plan", prompt: "Plan" },
      { id: "b", kind: "tool", label: "Search", tool: "web_search" },
    ],
    edges: [{ id: "e1", from: "a", to: "b" }],
    created_at: now,
    updated_at: now,
    ...over,
  };
}

describe("materializeBundle (P-AGENT.4a)", () => {
  test("writes every bundle file and returns the omp launch inputs", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-run-"));
    try {
      const run = materializeBundle(buildAgent(spec()), join(dir, "run1"));
      for (const f of ["allowlist.ts", "SYSTEM_PROMPT.md", "manifest.json", "spec.json"]) {
        expect(existsSync(join(run.runDir, f))).toBe(true);
      }
      // the -e extension arg points at the written allow-list file
      expect(run.ompExtensionArgs).toEqual(["-e", run.extensionPath]);
      expect(run.extensionPath.endsWith("allowlist.ts")).toBe(true);
      expect(readFileSync(run.extensionPath, "utf8")).toContain("SPDX-License-Identifier: BUSL-1.1");
      // the system prompt is TAIL content to be appended, and egress is surfaced for the caller
      expect(run.systemPrompt).toContain('You are "researcher"');
      expect(run.egress).toEqual(["*.example.com"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the materialized extension is importable and enforces the allow-list at runtime", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-run-"));
    try {
      const run = materializeBundle(buildAgent(spec({ tools: ["web_search"] })), join(dir, "run2"));
      const mod = await import(run.extensionPath);
      const handlers: Array<{ event: string; handler: (e: unknown) => unknown }> = [];
      mod.default({ on: (event: string, handler: (e: unknown) => unknown) => handlers.push({ event, handler }) });
      const onToolCall = handlers.find((h) => h.event === "tool_call")!.handler;
      expect(onToolCall({ toolName: "web_search" })).toBeUndefined();
      expect((onToolCall({ toolName: "bash" }) as { block?: boolean }).block).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("composeBuiltAgentArgs (P-AGENT.4) — gate-first launch", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-launch-"));
  const run = materializeBundle(buildAgent(spec()), join(dir, "runL"));

  test("the security gate is ALWAYS the first -e extension (invariant #4)", () => {
    const { args } = composeBuiltAgentArgs({ gate: "/gate.ts", run, extraExtensions: ["/preview.ts"] });
    expect(args[0]).toBe("acp");
    expect(args[1]).toBe("-e");
    expect(args[2]).toBe("/gate.ts"); // gate first, before preview + the agent's allow-list
    // the agent's own allow-list extension is present, and appears AFTER the gate
    const gateIdx = args.indexOf("/gate.ts");
    const agentIdx = args.indexOf(run.extensionPath);
    expect(agentIdx).toBeGreaterThan(gateIdx);
  });

  test("the agent prompt is appended as TAIL after any base policy, never replacing it", () => {
    const { args, appendSystemPrompt } = composeBuiltAgentArgs({ gate: "/gate.ts", run, basePolicy: "BASE-POLICY" });
    expect(appendSystemPrompt.startsWith("BASE-POLICY")).toBe(true);
    expect(appendSystemPrompt).toContain('You are "researcher"');
    expect(args[args.indexOf("--append-system-prompt") + 1]).toBe(appendSystemPrompt);
  });

  test("without a base policy the appended prompt is exactly the agent's system prompt", () => {
    const { appendSystemPrompt } = composeBuiltAgentArgs({ gate: "/gate.ts", run });
    expect(appendSystemPrompt).toBe(run.systemPrompt);
  });

  test("cleanup", () => {
    rmSync(dir, { recursive: true, force: true });
    expect(true).toBe(true);
  });
});
