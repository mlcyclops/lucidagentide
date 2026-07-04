// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_p_agent_3.ts
//
// P-AGENT.3 (ADR-0129): the Agent Builder COMPILER. Proves buildAgent(spec) -> AgentBundle:
//   1. a valid spec compiles into a portable bundle (system prompt + generated omp extension + manifest);
//   2. the generated extension actually ENFORCES the allow-list when imported (blocks a non-listed tool);
//   3. an invalid spec is REFUSED fail-closed (no bundle emitted).

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAgent } from "../agent/compiler.ts";
import { newSpecId, SPEC_VERSION, type AgentSpec } from "../agent/spec.ts";

const fail = (m: string): never => {
  console.error(`FAIL: ${m}`);
  process.exit(1);
};

const now = 1_700_000_000_000;
const spec: AgentSpec = {
  spec_id: newSpecId(),
  spec_version: SPEC_VERSION,
  name: "researcher",
  description: "plan -> search -> summarize",
  mode: "built-agent",
  tools: ["web_search"],
  egress: ["*.example.com"],
  selfEdit: "individual",
  nodes: [
    { id: "a", kind: "prompt", label: "Plan", prompt: "Plan the research" },
    { id: "b", kind: "tool", label: "Search", tool: "web_search" },
    { id: "c", kind: "prompt", label: "Summarize", prompt: "Summarize findings" },
  ],
  edges: [
    { id: "e1", from: "a", to: "b" },
    { id: "e2", from: "b", to: "c" },
  ],
  created_at: now,
  updated_at: now,
};

const dir = mkdtempSync(join(tmpdir(), "demo-p-agent-3-"));
try {
  // ── 1. compile ──────────────────────────────────────────────────────────────
  const bundle = buildAgent(spec);
  console.log(`1. compiled "${bundle.name}" -> ${bundle.files.length} files: ${bundle.files.map((f) => f.path).join(", ")}`);
  console.log(`   execution order: ${bundle.manifest.stepOrder.join(" -> ")}`);
  const ext = bundle.files.find((f) => f.path === "allowlist.ts")!;
  if (!ext.content.includes("SPDX-License-Identifier: BUSL-1.1")) fail("generated extension is missing the BUSL header");
  if (!ext.content.includes("try {")) fail("generated extension is not try/catch-wrapped (fail-soft)");
  console.log("   generated extension: BUSL header ✓  try/catch-wrapped ✓");
  console.log(`\n--- system prompt (first 6 lines) ---`);
  console.log(bundle.systemPrompt.split("\n").slice(0, 6).join("\n"));

  // ── 2. the generated extension actually enforces the allow-list ──────────────
  const file = join(dir, "allowlist.ts");
  writeFileSync(file, ext.content);
  const mod = await import(file);
  const handlers: Array<{ event: string; handler: (e: unknown) => unknown }> = [];
  mod.default({ on: (event: string, handler: (e: unknown) => unknown) => handlers.push({ event, handler }) });
  const onToolCall = handlers.find((h) => h.event === "tool_call")!.handler;
  const allowed = onToolCall({ toolName: "web_search" });
  const denied = onToolCall({ toolName: "bash" }) as { block?: boolean; reason?: string };
  console.log(`\n2. allow-list enforcement: web_search -> ${allowed === undefined ? "allowed" : "BLOCKED"}, bash -> ${denied?.block ? "blocked" : "allowed"}`);
  if (allowed !== undefined) fail("an allow-listed tool was blocked");
  if (!denied?.block) fail("a non-allow-listed tool was NOT blocked");
  console.log(`   reason: ${denied.reason}`);

  // ── 3. an invalid spec is refused fail-closed ────────────────────────────────
  let refused = false;
  try {
    buildAgent({ ...spec, edges: [...spec.edges, { id: "e3", from: "c", to: "a" }] }); // cycle
  } catch {
    refused = true;
  }
  console.log(`\n3. cyclic spec -> compiler refused: ${refused}`);
  if (!refused) fail("the compiler must refuse an invalid (cyclic) spec");

  console.log("\ndemo_p_agent_3 OK — valid spec compiles + the generated extension enforces the allow-list; invalid spec refused");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(0);
