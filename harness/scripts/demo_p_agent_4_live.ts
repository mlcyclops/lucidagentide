// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_p_agent_4_live.ts
//
// P-AGENT.4-live (ADR-0133): run a BUILT agent against a REAL Claude model (Haiku — the right size to test
// with). Proves the whole pipeline end-to-end: spec -> compile -> materialize -> spawn omp with the generated
// allow-list extension + the compiled system prompt -> a live model follows the agent's spec.
//
// Requires a reachable Claude model (ANTHROPIC_AUTH_TOKEN / API key in env) + network. Not part of `make test`
// (that stays hermetic). Run: bun run harness/scripts/demo_p_agent_4_live.ts

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAgent } from "../agent/compiler.ts";
import { materializeBundle } from "../agent/runner.ts";
import { newSpecId, SPEC_VERSION, type AgentSpec } from "../agent/spec.ts";

const fail = (m: string): never => {
  console.error(`FAIL: ${m}`);
  process.exit(1);
};

const MARKER = "LUCID-AGENT-DONE";

// A spec with a DISTINCTIVE, checkable behavior: if the live model ends its reply with MARKER, the compiled
// system prompt (persona + workflow) must have reached it.
const spec: AgentSpec = {
  spec_id: newSpecId(),
  spec_version: SPEC_VERSION,
  name: "TerseBot",
  description: "answers tersely",
  persona: `You are TerseBot. Answer in ONE short sentence, then on a new line output the exact marker: ${MARKER}`,
  mode: "built-agent",
  tools: [], // no tools — pure reasoning; the generated allow-list still loads (fail-soft) and blocks everything
  egress: [],
  selfEdit: "individual",
  nodes: [{ id: "a", kind: "prompt", label: "Answer", prompt: "Answer the user's question directly." }],
  edges: [],
  created_at: 1,
  updated_at: 1,
};

const OMP = join(process.env.HOME ?? process.env.USERPROFILE ?? "", ".bun", "bin", "omp");
const dir = mkdtempSync(join(tmpdir(), "agent-live-"));

try {
  const bundle = buildAgent(spec);
  const run = materializeBundle(bundle, join(dir, "run"));
  console.log(`built + materialized "${bundle.name}" -> ${run.extensionPath}`);
  console.log(`system prompt (first 3 lines):\n${bundle.systemPrompt.split("\n").slice(0, 3).join("\n")}\n`);

  const args = [
    "-p", "--model", "haiku", "--no-tools", "--no-lsp", "--no-skills", "--no-session",
    ...run.ompExtensionArgs, // the generated allow-list extension (loads fail-soft even with --no-tools)
    "--append-system-prompt", run.systemPrompt,
    "What is the capital of France?",
  ];
  console.log(`running: omp -p --model haiku -e <allowlist> --append-system-prompt <agent prompt> "What is the capital of France?"\n`);

  const proc = Bun.spawnSync([OMP, ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  const out = new TextDecoder().decode(proc.stdout).trim();
  const err = new TextDecoder().decode(proc.stderr).trim();
  console.log(`--- live model output ---\n${out}\n-------------------------`);
  if (err) console.log(`(stderr: ${err.slice(0, 300)})`);

  if (proc.exitCode !== 0) fail(`omp exited ${proc.exitCode}`);
  if (!/paris/i.test(out)) fail("the model didn't answer the question (no 'Paris') — did the agent run?");
  if (!out.includes(MARKER)) fail(`the compiled persona didn't reach the model (missing marker "${MARKER}")`);

  console.log(`\ndemo_p_agent_4_live OK — the BUILT agent ran on live Haiku, answered correctly, AND followed`);
  console.log(`its compiled spec (persona marker "${MARKER}" present). The generated allow-list extension loaded`);
  console.log(`without breaking the run (fail-soft).`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(0);
