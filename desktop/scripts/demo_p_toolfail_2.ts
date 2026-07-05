// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_toolfail_2.ts
//
// Increment P-TOOLFAIL.2 (ADR-0163) — failed tool calls collapse into a small red toolbox badge.
// Proves, against the EXACT three failures from the reporting session (a grep that matched
// nothing, `make` on a box without make twice — one of them the async-manager refusal), that:
//   (1) the extraction layer now yields the COMMAND ATTEMPTED (rawInput first, `$ …` title
//       fallback) and the FULL multi-line error text, not just the 160-char chip line;
//   (2) collapsed = ONE badge with a count — no full-width alarm rows for benign probes;
//   (3) expanded = the "Tool Call Actions" list: per action the tool, reason, command, detail;
//   (4) hostile bytes in any field render inert (escaped);
//   (5) the surface stays NEUTRAL — the tooltip says "not a security block" (ADR-0093 line).

import { toolFailureCommand, toolFailureDetail, toolFailureReason } from "../tool_failure.ts";
import { toolfailGroupHtml, type ToolFailEntry } from "../renderer/toolfail_group.ts";

const fail = (msg: string): never => { console.error(`FAIL: ${msg}`); process.exit(1); };
const ok = (msg: string): void => console.log(`   ${msg} ✓`);

console.log("== P-TOOLFAIL.2 — collapsed toolbox badge + expanded Tool Call Actions ==");

// The three real updates from the session that motivated this increment.
const updates = [
  { status: "failed", kind: "execute", title: '$ grep -n "demo-p-sandbox" Makefile', rawOutput: "(no output)\nWall time: 0.08 seconds\nCommand exited with code 1" },
  { status: "rejected", kind: "execute", rawInput: { command: "make demo-P-SANDBOX.1 && bun test harness" }, message: "Async job manager unavailable for this session." },
  { status: "failed", kind: "execute", rawInput: { command: "make demo-P-SANDBOX.1 && bun test harness" }, rawOutput: "error: command not found: make\nWall time: 0.05 seconds\nCommand exited with code 127" },
];

console.log("\n1) extraction — command attempted + full error, per action");
const entries: ToolFailEntry[] = updates.map((u) => ({
  tool: String(u.kind), reason: toolFailureReason(u).reason,
  command: toolFailureCommand(u) || undefined, detail: toolFailureDetail(u) || undefined,
}));
if (entries[0]!.command !== 'grep -n "demo-p-sandbox" Makefile') fail("title `$ …` should yield the bare command");
if (entries[1]!.command !== "make demo-P-SANDBOX.1 && bun test harness") fail("rawInput.command should win");
if (!entries[2]!.detail?.includes("command not found: make\nWall time")) fail("detail must keep line structure");
ok("commands extracted (rawInput first, `$ …` title fallback); detail keeps its lines");

console.log("\n2) collapsed — one small badge, not a stack of alarm rows");
const collapsed = toolfailGroupHtml(entries, false);
if (!collapsed.includes('class="tf-count">3<')) fail("badge must show the count of collapsed failures");
if (collapsed.includes("tf-body") || collapsed.includes("tf-row")) fail("collapsed must render NO body/rows");
if (!collapsed.includes("not a security block")) fail("the ADR-0093 not-a-denial wording must survive");
ok("3 failures = ONE red toolbox badge (count 3), tooltip keeps the not-a-security-block line");

console.log("\n3) expanded — the Tool Call Actions list");
const open = toolfailGroupHtml(entries, true);
if (!open.includes("Tool Call Actions")) fail("expanded view must be titled Tool Call Actions");
if ((open.match(/tf-row-head/g) ?? []).length !== 3) fail("expanded view must list all 3 failed actions");
if (!open.includes("$ make demo-P-SANDBOX.1 &amp;&amp; bun test harness")) fail("the attempted command must be shown");
if (!open.includes("tool did not run: Async job manager unavailable")) fail("the didn't-run action keeps its honest label");
ok("all 3 actions listed with reason + command attempted + detailed error");

console.log("\n4) hostile output renders inert");
const hostile = toolfailGroupHtml([{ tool: "<script>x</script>", reason: "<img src=x onerror=y>", command: "</code><script>z</script>", detail: "<iframe>" }], true);
if (/<script>|<img |<iframe>/.test(hostile)) fail("unescaped hostile bytes reached the HTML");
ok("tool/reason/command/detail all escaped");

console.log("\n✓ P-TOOLFAIL.2 demo passed — benign probe failures are one quiet toolbox click away, never an alarm wall.");
