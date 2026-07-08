// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_pchatb.ts
//
// P-CHAT.B (ADR-0189): the inline tool-event chips keystone. The DOM wiring (settle-time interleave in
// app.ts - each tool call becomes an expandable chip anchored where it fired, prose parts still sectionize,
// the live thoughts window is dropped once chips represent it) is live-renderer behavior that needs in-app QA;
// this demo proves the PURE logic the wiring depends on - tool classification, the +/- diffstat, and the
// fence-aware / block-boundary interleave that never splits a paragraph or a code fence.
//
// Run with: bun run harness/scripts/demo_pchatb.ts

import { classifyTool, interleaveChips, shouldInterleave, toolChip } from "../../desktop/renderer/answer_chips.ts";

function fail(m: string): never { console.error(`FAIL: ${m}`); process.exit(1); }
function ok(m: string): void { console.log(`  PASS  ${m}`); }

console.log("P-CHAT.B demo - inline tool-event chips (pure keystone)\n");

// [1] classification + diffstat: an edit chip carries a +/- line count; a search chip carries none.
const editChip = toolChip("edit", "desktop/renderer/app.ts", { oldText: "a\nb", newText: "a\nB\nc" });
if (editChip.kind !== "edit" || JSON.stringify(editChip.diffstat) !== JSON.stringify({ add: 2, del: 1 })) fail(`edit chip wrong: ${JSON.stringify(editChip)}`);
const writeChip = toolChip("write", "answer_chips.ts", { content: "l1\nl2\nl3\n" });
if (writeChip.kind !== "write" || writeChip.diffstat?.add !== 3 || writeChip.diffstat?.del !== 0) fail(`write chip wrong: ${JSON.stringify(writeChip)}`);
const searchChip = toolChip("search", "  renderAnswerBody   callers ");
if (classifyTool("search") !== "search" || searchChip.diffstat !== null || searchChip.detail !== "renderAnswerBody callers") fail(`search chip wrong: ${JSON.stringify(searchChip)}`);
ok("edit/write chips carry a +/- diffstat; a search chip has none and its detail is whitespace-collapsed");

// [2] tools that ran BEFORE any answer text lead the reply; tools after the last block trail it.
const md = "Here is the fix.\n\n## What changed\nrewired the render path.";
const lead = interleaveChips(md, [{ offset: 0, chip: searchChip, data: 0 }]);
if (lead.map((p) => p.kind).join("|") !== "chip|prose") fail(`lead order wrong: ${lead.map((p) => p.kind)}`);
const trail = interleaveChips(md, [{ offset: 10_000, chip: editChip, data: 0 }]);
if (trail.map((p) => p.kind).join("|") !== "prose|chip") fail(`trail order wrong: ${trail.map((p) => p.kind)}`);
if (trail[0]!.kind !== "prose" || trail[0]!.md !== md) fail("prose content lost on trail");
ok("anchors at offset 0 lead the answer; anchors past the end trail it (prose preserved for sectionizing)");

// [3] fence-awareness: an anchor inside a ``` block snaps PAST the fence - code is never split.
const fenced = "intro\n\n```ts\nconst x = 1;\n```\n\nafter";
const inFence = interleaveChips(fenced, [{ offset: fenced.indexOf("const x"), chip: editChip, data: 0 }]);
if (inFence.map((p) => p.kind).join("|") !== "prose|chip|prose") fail(`fence split wrong: ${inFence.map((p) => p.kind)}`);
const kept = inFence.find((p) => p.kind === "prose" && p.md.includes("```ts\nconst x = 1;\n```"));
if (!kept) fail("fenced code block was split by a chip");
ok("an anchor inside a code fence snaps past it - the fenced block survives intact in one prose part");

// [4] the gate: a turn with no tool calls never interleaves (renders as a plain / sectioned answer).
if (shouldInterleave(interleaveChips(md, []))) fail("a no-tool answer must not interleave");
if (!shouldInterleave(lead)) fail("a tool-using answer must interleave");
ok("shouldInterleave gates: a no-tool answer stays a plain/sectioned reply; a tool-using answer chips");

console.log("\nP-CHAT.B demo complete - pure interleave verified. DOM wiring (settle interleave + chip drilldowns + thoughts-window drop) is typechecked and awaits in-app QA.");
