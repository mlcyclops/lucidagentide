// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_p_agent_8_1.ts
//
// P-AGENT.8.1 (ADR-0130): the SECRET guardrail for the conversational Agent Builder. Proves the user's #1
// rule: an agent may DECLARE which credentials it needs (SecretRef names), but a secret VALUE embedded in a
// spec is REFUSED everywhere it could land — save, compile, run. Secrets live only in the OS-encrypted vault.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAgent } from "../agent/compiler.ts";
import { saveSpecFile } from "../agent/file_store.ts";
import { scanSpecForSecrets } from "../agent/secret_guard.ts";
import { newSpecId, SPEC_VERSION, type AgentSpec } from "../agent/spec.ts";

const fail = (m: string): never => {
  console.error(`FAIL: ${m}`);
  process.exit(1);
};

// The CORRECT pattern: declare credential NAMES (SecretRefs); the value goes in the vault, never the spec.
const good: AgentSpec = {
  spec_id: newSpecId(),
  spec_version: SPEC_VERSION,
  name: "gov-bd",
  description: "Search DoD opportunities; log them to Salesforce.",
  persona: "Read the official docs to help the user generate an API token, then have them store it in the vault.",
  mode: "built-agent",
  tools: ["web_search"],
  egress: ["*.salesforce.com", "*.govwin.com"],
  secrets: [
    { name: "SALESFORCE_API_TOKEN", kind: "apikey", purpose: "Salesforce REST API (Setup → API)" },
    { name: "GOVWIN_PASSWORD", kind: "basic", purpose: "GovWin login" },
  ],
  nodes: [{ id: "a", kind: "prompt", label: "Plan", prompt: "Use SALESFORCE_API_TOKEN from the vault." }],
  edges: [],
  selfEdit: "individual",
  created_at: 1,
  updated_at: 1,
};

// The FORBIDDEN pattern: an actual secret value baked into the spec text.
const leaky: AgentSpec = {
  ...good,
  spec_id: newSpecId(),
  persona: "Use api_key: sk-abcdEFGH1234567890ijklMNOPqrst to call Salesforce.",
};

const dir = mkdtempSync(join(tmpdir(), "demo-p-agent-8-1-"));
try {
  // ── 1. the correctly-declared agent is clean and builds/saves ────────────────
  console.log(`1. declared-refs agent -> leaks=${scanSpecForSecrets(good).length}`);
  if (scanSpecForSecrets(good).length !== 0) fail("a correctly-declared agent must be clean");
  buildAgent(good);
  saveSpecFile(dir, good);
  console.log(`   builds ✓  saves ✓  (secrets declared: ${good.secrets!.map((s) => s.name).join(", ")})`);

  // ── 2. an embedded secret is REFUSED at compile ──────────────────────────────
  const leaks = scanSpecForSecrets(leaky);
  console.log(`\n2. embedded-secret agent -> leaks=${leaks.length} in ${leaks.map((l) => l.where).join(", ")}`);
  let compileRefused = false;
  try { buildAgent(leaky); } catch { compileRefused = true; }
  console.log(`   compile refused: ${compileRefused}`);
  if (!compileRefused) fail("SECURITY: compiling a spec with an embedded secret must be refused");

  // ── 3. …and REFUSED at save (can never be persisted) ─────────────────────────
  let saveRefused = false;
  try { saveSpecFile(dir, leaky); } catch { saveRefused = true; }
  console.log(`   save refused:    ${saveRefused}`);
  if (!saveRefused) fail("SECURITY: saving a spec with an embedded secret must be refused");

  console.log("\ndemo_p_agent_8_1 OK — agents DECLARE credential names; an embedded secret is refused at compile + save (belongs in the vault)");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(0);
