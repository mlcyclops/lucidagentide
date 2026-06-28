// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_goal_13.ts
//
// Increment P-GOAL.13 (ADR-0067) — per-command Speed↔Risk dial for the unattended /goal loop + a Blocks
// section in the After-Action Report. The loop has no human to prompt, so the exec classifier (P-EXEC.1)
// is graded into tiers T0-T4 and a per-command-type dial decides what auto-runs vs blocks. Fail-closed:
// an unconfigured dial is the SAFEST loop, and the T4 catastrophic set ALWAYS blocks.

import { classifyCommand, clampDialRow, loopVerdict } from "../exec_policy.ts";
import { renderBlocks, type LoopBlock } from "../loop_report.ts";

const fail = (m: string): never => { console.error(`FAIL: ${m}`); process.exit(1); };
const ok = (m: string): void => console.log(`   ${m} ✓`);

console.log("== P-GOAL.13 — loop Speed↔Risk dial + AAR blocks ==");

// 1. The graded ladder T0-T4.
const ladder: [string, string][] = [["ls", "T0"], ["mkdir x", "T1"], ["npm install y", "T2"], ["rm z", "T3"], ["rm -rf /", "T4"]];
for (const [cmd, tier] of ladder) if (classifyCommand(cmd).tier !== tier) fail(`${cmd} should be ${tier}, got ${classifyCommand(cmd).tier}`);
ok("classifier grades commands T0 (read-only) → T4 (catastrophic)");

// 2. The dial decides auto vs block; an unset dial is the safest (T0-only) posture.
if (loopVerdict(undefined, "T1") !== "block") fail("an unconfigured dial must block anything past T0");
if (loopVerdict(undefined, "T0") !== "auto") fail("read-only auto-runs even with no dial");
ok("an UNCONFIGURED loop is the SAFEST loop (T0 only; everything riskier blocks)");

if (loopVerdict("T2", "T2") !== "auto" || loopVerdict("T2", "T3") !== "block") fail("dial T2 should auto ≤T2, block T3");
ok("a command auto-runs iff its tier ≤ its type's dial");

if (loopVerdict("T3", "T4") !== "block") fail("T4 must block even under a fully-open dial");
ok("the catastrophic set (T4) ALWAYS blocks, whatever the dial");

// 3. Managed loop ceiling (ADR-0068) tightens the dial, never loosens it.
if (clampDialRow("T3", "T1") !== "T1") fail("managed ceiling must clamp a too-high dial down");
ok("the managed loop ceiling clamps each dial row (tighten-only)");

// 4. The AAR Blocks section tallies risk-dial / catastrophic / security-gate separately + shows posture.
const blocks: LoopBlock[] = [
  { iter: 1, tool: "npm", tier: "T2", reason: "risk-dial" },
  { iter: 2, tool: "rm", tier: "T4", reason: "catastrophic" },
  { iter: 2, tool: "bash", tier: "T4", reason: "security-gate" },
];
const section = renderBlocks(blocks, { shell: "T1", "web-fetch": "T0" });
for (const needle of ["shell=T1", "**3** calls blocked", "Risk dial: **1**", "Catastrophic (T4): **1**", "Security gate (scanner): **1**"]) {
  if (!section.includes(needle)) fail(`Blocks section missing: ${needle}`);
}
ok("the AAR Blocks section records the dial posture + tallies each block layer separately");

console.log("demo-P-GOAL.13 OK");
process.exit(0);
