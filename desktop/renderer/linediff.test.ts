// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/linediff.test.ts — P-CHAT.1 (ADR-0104): the pure line diff behind the chat's inline
// edit preview (an omp `edit` carries oldText/newText → colored +/− rows).

import { describe, expect, test } from "bun:test";
import { lineDiff, diffStat, patchLineType, patchStat } from "./linediff.ts";

const kinds = (rows: { type: string; text: string }[]) => rows.map((r) => `${r.type[0]}:${r.text}`).join("|");

describe("lineDiff (P-CHAT.1)", () => {
  test("a changed middle line → context kept, old removed, new added", () => {
    const rows = lineDiff("a\nb\nc", "a\nB\nc");
    expect(kinds(rows)).toBe("c:a|d:b|a:B|c:c");
    expect(diffStat(rows)).toEqual({ add: 1, del: 1 });
  });
  test("pure additions", () => {
    const rows = lineDiff("a\nb", "a\nb\nc\nd");
    expect(diffStat(rows)).toEqual({ add: 2, del: 0 });
    expect(rows.filter((r) => r.type === "add").map((r) => r.text)).toEqual(["c", "d"]);
  });
  test("pure deletions", () => {
    const rows = lineDiff("a\nb\nc", "a");
    expect(diffStat(rows)).toEqual({ add: 0, del: 2 });
  });
  test("identical text → all context, no changes", () => {
    const rows = lineDiff("x\ny", "x\ny");
    expect(diffStat(rows)).toEqual({ add: 0, del: 0 });
    expect(rows.every((r) => r.type === "ctx")).toBe(true);
  });
  test("a trailing newline doesn't create a phantom blank row", () => {
    expect(diffStat(lineDiff("a\n", "a\n"))).toEqual({ add: 0, del: 0 });
    expect(lineDiff("a\n", "a\n").length).toBe(1);
  });
  test("empty old (brand-new content) → all additions; empty new → all deletions", () => {
    expect(diffStat(lineDiff("", "a\nb"))).toEqual({ add: 2, del: 0 });
    expect(diffStat(lineDiff("a\nb", ""))).toEqual({ add: 0, del: 2 });
  });
  test("insertion in the middle keeps surrounding context", () => {
    const rows = lineDiff("a\nc", "a\nb\nc");
    expect(kinds(rows)).toBe("c:a|a:b|c:c");
  });
});

describe("patchLineType / patchStat (P-CHAT.1): omp hashline edit patches", () => {
  test("classifies +/− content, header, and anchor directives", () => {
    expect(patchLineType("+<h1>Hi</h1>")).toBe("add");
    expect(patchLineType("-<h1>Old</h1>")).toBe("del");
    expect(patchLineType("−removed")).toBe("del");                 // unicode minus
    expect(patchLineType("[C:/x.html#1B0F]")).toBe("meta");
    expect(patchLineType("SWAP 5.=5:")).toBe("meta");
    expect(patchLineType("  unchanged")).toBe("ctx");
  });
  test("patchStat counts added / removed content lines only", () => {
    const patch = "[file#ab]\nSWAP 5.=5:\n-old line\n+new line\n+extra";
    expect(patchStat(patch)).toEqual({ add: 2, del: 1 });
  });
});
