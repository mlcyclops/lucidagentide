// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_p_agent_6.ts
//
// P-AGENT.6 (ADR-0129): enterprise EXPORT. The public core packages a compiled agent into a portable,
// tamper-evident bundle for each deploy target (electron / web / cloud); `verifyExport` catches any tampering.
// The actual deploy adapters live in the private add-on.

import { buildAgent } from "../agent/compiler.ts";
import { exportBundle, verifyExport, EXPORT_TARGETS } from "../agent/export.ts";
import { newSpecId, SPEC_VERSION, type AgentSpec } from "../agent/spec.ts";

const fail = (m: string): never => {
  console.error(`FAIL: ${m}`);
  process.exit(1);
};

const spec: AgentSpec = {
  spec_id: newSpecId(),
  spec_version: SPEC_VERSION,
  name: "researcher",
  mode: "built-agent",
  tools: ["web_search"],
  egress: ["*.example.com"],
  selfEdit: "individual",
  nodes: [
    { id: "a", kind: "prompt", label: "Plan", prompt: "Plan the research" },
    { id: "b", kind: "tool", label: "Search", tool: "web_search" },
  ],
  edges: [{ id: "e1", from: "a", to: "b" }],
  created_at: 1,
  updated_at: 1,
};

const bundle = buildAgent(spec);

// ── 1. export for every deploy target ────────────────────────────────────────
for (const target of EXPORT_TARGETS) {
  const pkg = exportBundle(bundle, target);
  const v = verifyExport(pkg);
  console.log(`${target.padEnd(9)} -> ${pkg.files.length} files, digest ${pkg.manifest.digest.slice(0, 22)}…, verify=${v.ok}`);
  if (!v.ok) fail(`export for ${target} did not verify`);
  if (pkg.manifest.entry.runtime !== target) fail("entry runtime mismatch");
}

// ── 2. tamper-evidence: a modified file fails verification ────────────────────
const pkg = exportBundle(bundle, "cloud");
const tampered = {
  ...pkg,
  files: pkg.files.map((f) => (f.path === "allowlist.ts" ? { ...f, content: f.content.replace("block: true", "block: false") } : f)),
};
const v = verifyExport(tampered);
console.log(`\ntampered allowlist.ts -> verify=${v.ok} (${v.reason.slice(0, 60)}…)`);
if (v.ok) fail("a tampered bundle MUST fail verification");

console.log("\ndemo_p_agent_6 OK — agents export portably for electron/web/cloud; tampering is caught");
process.exit(0);
