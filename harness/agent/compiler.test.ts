// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/agent/compiler.test.ts — P-AGENT.3 (ADR-0133): the Agent Builder compiler (spec -> AgentBundle).

import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAgent, topoOrder, renderAllowlistExtension } from "./compiler.ts";
import { newSpecId, SPEC_VERSION, type AgentSpec } from "./spec.ts";

function spec(over: Partial<AgentSpec> = {}): AgentSpec {
  const now = 1_700_000_000_000;
  return {
    spec_id: newSpecId(),
    spec_version: SPEC_VERSION,
    name: "researcher",
    description: "plan then search",
    mode: "built-agent",
    tools: ["web_search"],
    egress: ["*.example.com"],
    selfEdit: "individual",
    nodes: [
      { id: "a", kind: "prompt", label: "Plan", prompt: "Plan the research" },
      { id: "b", kind: "tool", label: "Search", tool: "web_search" },
      { id: "c", kind: "prompt", label: "Write", prompt: "Summarize" },
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

describe("buildAgent (P-AGENT.3)", () => {
  test("compiles a valid spec into a bundle with the expected files", () => {
    const b = buildAgent(spec());
    expect(b.spec_id).toBe(b.manifest.spec_id);
    const paths = b.files.map((f) => f.path).sort();
    expect(paths).toEqual(["SYSTEM_PROMPT.md", "allowlist.ts", "manifest.json", "spec.json"]);
    expect(b.manifest.bundleVersion).toBe(1);
    expect(b.manifest.stepOrder).toEqual(["a", "b", "c"]); // topological
  });

  test("refuses to compile an invalid spec (fail-closed)", () => {
    expect(() => buildAgent(spec({ nodes: [] }))).toThrow(/refusing to compile/);
    const cyclic = spec({
      edges: [
        { id: "e1", from: "a", to: "b" },
        { id: "e2", from: "b", to: "c" },
        { id: "e3", from: "c", to: "a" },
      ],
    });
    expect(() => buildAgent(cyclic)).toThrow(/refusing to compile/);
  });

  test("the system prompt carries the workflow, the tool allow-list, and LUCID core instructions", () => {
    const p = buildAgent(spec()).systemPrompt;
    expect(p).toContain('You are "researcher"');
    expect(p).toContain("1. [Prompt] Plan");
    expect(p).toContain("call the `web_search` tool");
    expect(p).toContain("You may ONLY use these tools: web_search");
    expect(p).toContain("FAIL-CLOSED security gate"); // LUCID_CORE_INSTRUCTIONS
    expect(p).toContain("preview_open");
  });

  test("a no-tool agent's prompt says it may not call tools", () => {
    const p = buildAgent(spec({ tools: [], nodes: [{ id: "a", kind: "prompt", label: "Think", prompt: "" }], edges: [] })).systemPrompt;
    expect(p).toContain("You may not call any tools");
  });

  test("the generated extension carries the SPDX header, is try/catch-wrapped, and lists the tools", () => {
    const ext = renderAllowlistExtension(spec());
    expect(ext).toContain("SPDX-License-Identifier: BUSL-1.1");
    expect(ext).toContain("export default function agentAllowlist");
    expect(ext).toContain("try {");
    expect(ext).toContain("catch");
    expect(ext).toContain('"web_search"');
    expect(ext).toContain("block: true");
  });

  test("injection-safe: a hostile agent name can't break out of the generated code", () => {
    const ext = renderAllowlistExtension(spec({ name: 'x"; globalThis.pwned=1; //' }));
    // the name is embedded via JSON.stringify, so the payload stays a string literal
    expect(ext).toContain("globalThis.pwned=1");
    expect(ext).toContain("const AGENT_NAME = \"x\\\"; globalThis.pwned=1; //\"");
  });

  test("topoOrder is deterministic and respects edges", () => {
    // reverse the node array but keep the same edges — order must still be a→b→c
    const s = spec();
    s.nodes = [s.nodes[2]!, s.nodes[1]!, s.nodes[0]!];
    expect(topoOrder(s)).toEqual(["a", "b", "c"]);
  });

  // The strongest check: WRITE the generated extension to disk and IMPORT it, then run its default export
  // against a fake `pi` to prove the emitted code actually enforces the allow-list at runtime.
  test("the generated extension, when imported, blocks non-allow-listed tools and allows the rest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-ext-"));
    try {
      const file = join(dir, "allowlist.ts");
      writeFileSync(file, renderAllowlistExtension(spec({ tools: ["web_search", "codegraph_query"] })));
      const mod = await import(file);
      const calls: Array<{ event: string; handler: (e: unknown) => unknown }> = [];
      const pi = { on: (event: string, handler: (e: unknown) => unknown) => calls.push({ event, handler }) };
      mod.default(pi);
      const handler = calls.find((c) => c.event === "tool_call")!.handler;
      expect(handler({ toolName: "web_search" })).toBeUndefined(); // allow-listed → no block
      expect(handler({ toolName: "codegraph_query" })).toBeUndefined();
      const denied = handler({ toolName: "bash" }) as { block?: boolean; reason?: string };
      expect(denied?.block).toBe(true);
      expect(denied?.reason).toContain("not permitted");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
