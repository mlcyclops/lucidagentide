// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-CHAT.B: the pure inline tool-chip keystone. Over-tests the load-bearing logic the settle-time DOM wiring
// relies on - tool classification, the +/- diffstat + detail truncation, and the fence-aware / block-boundary
// interleave (a chip never splits a paragraph or a code fence; anchors before/after the answer lead/trail).

import { expect, test } from "bun:test";
import { classifyTool, interleaveChips, shouldInterleave, chipsInterleave, toolChip, type ToolMark } from "./answer_chips.ts";

test("classifyTool maps tool names to chip kinds (edit/write win before read/search)", () => {
  expect(classifyTool("edit")).toBe("edit");
  expect(classifyTool("ast_edit")).toBe("edit");
  expect(classifyTool("write")).toBe("write");
  expect(classifyTool("notebook_edit")).toBe("edit"); // has "edit"
  expect(classifyTool("read")).toBe("read");
  expect(classifyTool("search")).toBe("search");
  expect(classifyTool("grep")).toBe("search");
  expect(classifyTool("bash")).toBe("run");
  expect(classifyTool("eval")).toBe("run");
  expect(classifyTool("web_search")).toBe("search"); // "search" wins; still fine as a query chip
  expect(classifyTool("fetch")).toBe("fetch");
  expect(classifyTool("task")).toBe("task");
  expect(classifyTool("mcp__weird__thing")).toBe("other");
});

test("toolChip sizes a diffstat from code and collapses/truncates detail", () => {
  const edit = toolChip("edit", "app.ts", { oldText: "a\nb\nc", newText: "a\nB\nc\nd" });
  expect(edit.kind).toBe("edit");
  expect(edit.k).toBe("edit");
  expect(edit.diffstat).toEqual({ add: 2, del: 1 }); // B replaces b (1 del + 1 add) + d added

  const write = toolChip("write", "new.ts", { content: "l1\nl2\nl3\n" });
  expect(write.diffstat).toEqual({ add: 3, del: 0 }); // trailing newline is not a phantom 4th line

  const patch = toolChip("apply_patch", "x", { patch: "@@\n+added\n-removed\n context" });
  expect(patch.diffstat).toEqual({ add: 1, del: 1 });

  const search = toolChip("search", "  needle   in   haystack  ");
  expect(search.diffstat).toBeNull();
  expect(search.detail).toBe("needle in haystack"); // whitespace collapsed

  const long = toolChip("bash", "x".repeat(200));
  expect(long.detail.length).toBe(64);
  expect(long.detail.endsWith("\u2026")).toBe(true);

  const failed = toolChip("bash", "make", undefined, true);
  expect(failed.failed).toBe(true);
});

test("interleaveChips: no marks -> a single prose part; empty -> nothing", () => {
  expect(interleaveChips("hello world", [])).toEqual([{ kind: "prose", md: "hello world" }]);
  expect(interleaveChips("   \n\n ", [])).toEqual([]);
});

test("interleaveChips: anchors at offset 0 lead the answer; anchors past the end trail it", () => {
  const chip = toolChip("read", "app.ts");
  const md = "first para\n\nsecond para";
  const lead = interleaveChips(md, [{ offset: 0, chip, data: 1 }]);
  expect(lead.map((p) => p.kind)).toEqual(["chip", "prose"]);
  expect(lead[1]).toEqual({ kind: "prose", md });

  const trail = interleaveChips(md, [{ offset: 9999, chip, data: 1 }]);
  expect(trail.map((p) => p.kind)).toEqual(["prose", "chip"]);
  expect(trail[0]).toEqual({ kind: "prose", md });
});

test("interleaveChips: a mid-paragraph anchor snaps to the next block boundary (never splits prose)", () => {
  const chip = toolChip("edit", "x");
  // offset 5 lands inside "alpha"; must snap forward to the blank-line boundary before "bravo".
  const md = "alpha line\n\nbravo line";
  const parts = interleaveChips(md, [{ offset: 5, chip, data: "d" }]);
  expect(parts).toEqual([
    { kind: "prose", md: "alpha line" },
    { kind: "chip", chip, data: "d" },
    { kind: "prose", md: "bravo line" },
  ]);
});

test("interleaveChips: an anchor inside a fenced code block snaps past the fence (never splits code)", () => {
  const chip = toolChip("bash", "run");
  const md = "intro\n\n```ts\nconst a = 1;\nconst b = 2;\n```\n\nafter";
  const fenceStart = md.indexOf("const a"); // an offset squarely inside the fence
  const parts = interleaveChips(md, [{ offset: fenceStart, chip, data: 0 }]);
  // the fence must survive intact in a single prose part; the chip lands between the fence block and "after".
  const prose = parts.filter((p) => p.kind === "prose").map((p) => (p.kind === "prose" ? p.md : ""));
  expect(prose.some((m) => m.includes("```ts\nconst a = 1;\nconst b = 2;\n```"))).toBe(true);
  expect(parts.map((p) => p.kind)).toEqual(["prose", "chip", "prose"]);
  expect(parts[2]).toEqual({ kind: "prose", md: "after" });
});

test("interleaveChips: multiple anchors keep order and group at a shared boundary", () => {
  const c1 = toolChip("read", "a"), c2 = toolChip("search", "b"), c3 = toolChip("edit", "c");
  const md = "para one\n\npara two";
  const marks: ToolMark<number>[] = [
    { offset: 0, chip: c1, data: 1 },
    { offset: 0, chip: c2, data: 2 }, // same boundary as c1 -> keeps input order
    { offset: 9999, chip: c3, data: 3 },
  ];
  const parts = interleaveChips(md, marks);
  expect(parts.map((p) => p.kind)).toEqual(["chip", "chip", "prose", "chip"]);
  expect(parts.filter((p) => p.kind === "chip").map((p) => (p.kind === "chip" ? p.data : 0))).toEqual([1, 2, 3]);
});

test("interleaveChips: prose parts keep their markdown so P-CHAT.A can still sectionize them", () => {
  const chip = toolChip("read", "x");
  const md = "## Problem\nit broke\n\n## Fix\ndone";
  const parts = interleaveChips(md, [{ offset: 9999, chip, data: 0 }]);
  expect(parts[0]).toEqual({ kind: "prose", md: "## Problem\nit broke\n\n## Fix\ndone" });
});

test("shouldInterleave is true only when a chip is present", () => {
  const chip = toolChip("read", "x");
  expect(shouldInterleave(interleaveChips("just prose", []))).toBe(false);
  expect(shouldInterleave(interleaveChips("prose", [{ offset: 0, chip, data: 0 }]))).toBe(true);
});

test("chipsInterleave: true only when a chip is SANDWICHED between prose (not a lead/trailing edge pile)", () => {
  const chip = toolChip("read", "x");
  // short/flat answer, chip snaps to the end -> trailing edge, NOT a genuine interleave (keep the window)
  expect(chipsInterleave(interleaveChips("one short line", [{ offset: 9999, chip, data: 0 }]))).toBe(false);
  // two blocks with a chip anchored at the SECOND block's boundary -> prose|chip|prose -> genuine interleave
  const md = "para one\n\npara two";
  expect(chipsInterleave(interleaveChips(md, [{ offset: md.indexOf("para two"), chip, data: 0 }]))).toBe(true);
  // a LEAD chip before the only prose block is not an interleave
  expect(chipsInterleave(interleaveChips("solo", [{ offset: 0, chip, data: 0 }]))).toBe(false);
  // no chips at all
  expect(chipsInterleave(interleaveChips("just prose", []))).toBe(false);
  // an answer that is ALL chips / no prose keeps the window too
  expect(chipsInterleave([{ kind: "chip", chip, data: 0 }] as any)).toBe(false);
});
