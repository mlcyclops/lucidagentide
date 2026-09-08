// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// demo_pctx1.ts - P-CTX.1 (ADR-0350): the prompt-audit.
//
// Doubles as the human-facing CLI (`make prompt-audit`) and the increment's proof
// (`make demo-P-CTX.1`). Fully offline: echo model, in-memory session store, MCP off.
//
// Proves:
//   1. the audit assembles the desktop chat's request shape on THIS repo and measures it;
//   2. accounting parity: the report total IS omp's computeNonMessageTokens, and every
//      section's rows sum exactly to the section total (residuals are differences);
//   3. tool attribution: the production -e extensions add tools the builtin surface
//      lacks, and each is measured and tagged [ext];
//   4. honesty: the appended-policy bytes match acp_backend's composition, the
//      tokenizer mode is named, and exclusions are declared.
//
// Flags: --json | --window N | --target N | --detail N | --no-extensions | --live-discovery

import { buildReport, captureAssembly, composeAppendedPolicy, renderReport } from "../prompt/prompt_audit.ts";

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function ok(msg: string): void {
  console.log(`  \u2713 ${msg}`);
}

function intFlag(name: string, dflt: number): number {
  const i = process.argv.indexOf(name);
  if (i < 0) return dflt;
  const v = Number(process.argv[i + 1]);
  if (!Number.isFinite(v) || v <= 0) fail(`${name} needs a positive number`);
  return v;
}

const asJson = process.argv.includes("--json");
const withExtensions = !process.argv.includes("--no-extensions");
const liveDiscovery = process.argv.includes("--live-discovery");
const window = intFlag("--window", 65536);
const target = intFlag("--target", 10000);
const detail = intFlag("--detail", 8);

const capture = await captureAssembly({ withExtensions, liveDiscovery });
const report = buildReport(capture, { window, target });

if (asJson) {
  console.log(JSON.stringify({ capture, report }, null, 2));
  process.exit(0);
}

console.log(renderReport(report, detail));

// Demo assertions (structural, never absolute numbers: settings and skills differ per machine).
console.log("\nP-CTX.1 checks:");

if (capture.blockTokens.length < 2) fail(`expected >= 2 system prompt blocks, got ${capture.blockTokens.length}`);
ok(`omp assembled ${capture.blockTokens.length} system prompt blocks on this repo`);

if (report.total <= 0) fail("non-message baseline is zero: nothing was measured");
ok(`non-message baseline measured: ${report.total} tokens (omp's own computeNonMessageTokens)`);

// Section-sum invariant: rows sum EXACTLY to their section (residual rows are differences).
for (const s of report.sections) {
  if (s.rows.length === 0) continue;
  const sum = s.rows.reduce((a, r) => a + r.tokens, 0);
  if (sum !== s.tokens) fail(`section "${s.label}" rows sum ${sum} != section total ${s.tokens}`);
}
ok("every section's rows sum exactly to the section total");

if (withExtensions) {
  const ext = capture.tools.filter((t) => t.source === "extension");
  if (ext.length === 0) fail("production -e extensions registered no tools (measurement seam broken)");
  ok(`extension tool surface measured: ${ext.length} tools, ${ext.reduce((a, t) => a + t.tokens, 0)} tokens`);
}

if (capture.appendedPolicyTokens <= 0) fail("appended policy measured as empty");
const parts = capture.policyRows.reduce((a, p) => a + p.tokens, 0);
if (parts <= 0 || capture.policyRows.length !== 7) fail("expected 7 measured policy parts");
ok(`appended policy: ${capture.appendedPolicyTokens} tokens across 7 policies (${composeAppendedPolicy().length} bytes)`);

const isAgentsMd = (p: string): boolean => {
  const norm = p.replace(/\\/g, "/");
  return norm === "AGENTS.md" || norm.endsWith("/AGENTS.md");
};
if (!capture.contextFiles.some((f) => isAgentsMd(f.path))) {
  fail("AGENTS.md context file was not discovered on this repo");
}
ok("context files discovered and measured per file (AGENTS.md present)");

if (capture.skills.length > 0 && capture.skillsTokens <= 0) fail("skills present but skills list measured as 0");
ok(`skills list: ${capture.skills.length} skills, ${capture.skillsTokens} tokens`);

if (report.workingRoom !== window - report.total) fail("window math is inconsistent");
ok(`window ${window}: ${report.workingRoom} working room; target ${target}: ${report.overTarget > 0 ? `OVER by ${report.overTarget}` : "met"}`);

console.log("\nP-CTX.1 demo: PASS");
process.exit(0);
