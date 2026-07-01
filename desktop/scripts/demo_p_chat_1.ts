// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_chat_1.ts — P-CHAT.1 (ADR-0104): the pure line diff behind the chat's inline,
// expandable code preview. A tool step now carries the authored code (a write's content → syntax-highlighted
// via Monaco; an edit's oldText/newText → this diff). The Monaco highlighting + expandable DOM are verified
// live (they need a browser); the diff — the load-bearing pure logic — is proven here.

import { lineDiff, diffStat } from "../renderer/linediff.ts";

const fail = (msg: string): never => { console.error(`FAIL: ${msg}`); process.exit(1); };
const ok = (msg: string): void => console.log(`   ${msg} ✓`);
const kinds = (rows: { type: string; text: string }[]) => rows.map((r) => `${r.type[0]}:${r.text}`).join("|");

console.log("== P-CHAT.1 — inline edit diff (writes are highlighted; edits diff old→new) ==");

console.log("\n1) a changed line → context kept, old removed (red), new added (green)");
const rows = lineDiff("let hp = 3;\nfunction tick(){\n  speed = 1;\n}", "let hp = 3;\nfunction tick(){\n  speed = 2;\n  flash();\n}");
if (kinds(rows) !== "c:let hp = 3;|c:function tick(){|d:  speed = 1;|a:  speed = 2;|a:  flash();|c:}") fail(`unexpected diff: ${kinds(rows)}`);
const s = diffStat(rows);
if (s.add !== 2 || s.del !== 1) fail(`stat should be +2 −1, got +${s.add} −${s.del}`);
ok(`edit → +${s.add} −${s.del}, context preserved`);

console.log("\n2) brand-new file (empty old) → all additions; deletion-only edit → all removals");
if (diffStat(lineDiff("", "a\nb\nc")).add !== 3) fail("new content should be all additions");
if (diffStat(lineDiff("a\nb\nc", "a")).del !== 2) fail("removed lines should be deletions");
ok("empty-old → all add; shrink → all del");

console.log("\n3) identical text → no changes; a trailing newline is not a phantom row");
if (diffStat(lineDiff("x\ny", "x\ny")).add + diffStat(lineDiff("x\ny", "x\ny")).del !== 0) fail("identical should have no changes");
if (lineDiff("a\n", "a\n").length !== 1) fail("trailing newline must not add a blank row");
ok("no-op edit → 0 changes; trailing newline handled");

console.log("\nPASS — the diff is correct, minimal, and stable; the chat renders it as green/red rows inline.");
