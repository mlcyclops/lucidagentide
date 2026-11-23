// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-FLEET.READ1 (ADR-0646): which table columns hold compact data and so must never wrap in a Fleet card.
import { describe, expect, test } from "bun:test";
import { compactColumns, isCompactValue } from "./md_table_fit.ts";

describe("isCompactValue", () => {
  test("numbers, times, dates, durations, sizes and versions are compact", () => {
    for (const v of ["0:00", "3:11", "12:04:59", "9:30 AM", "42", "-3.5", "1,234,567", "$19.99", "87%", "4.2k", "120 ms", "3m 2s", "2026-11-21", "11/21/2026", "v2.5.4", "2.5.4-beta.8", "1.5 GB"]) {
      expect(isCompactValue(v)).toBe(true);
    }
  });
  test("prose, names and long values are text", () => {
    for (const v of ["Office, Monday 9 A.M.", "Finale", "Close on the stapler", "anthropic/claude-opus-5-5", "12345678901234567890123456789", "3 agents"]) {
      expect(isCompactValue(v)).toBe(false);
    }
  });
});

describe("compactColumns", () => {
  test("the reported table: the Time column is compact, the Section and What happens columns are text", () => {
    const rows = [
      ["0:00", "Office, Monday 9 A.M.", "Close on Milton's stapler and the TPS reports"],
      ["0:43", "The boss gets an order", "Debate the meaning of life"],
      ["3:11", "Finale", "Another live commit and bolt"],
    ];
    expect(compactColumns(rows)).toEqual([true, false, false]);
  });
  test("placeholders do not make a numeric column text, but a column of placeholders only is text", () => {
    expect(compactColumns([["12", "-"], ["n/a", ""], ["7", "--"]])).toEqual([true, false]);
  });
  test("one prose cell makes the column text", () => {
    expect(compactColumns([["12"], ["about a dozen"]])).toEqual([false]);
  });
  test("ragged rows and an empty body", () => {
    expect(compactColumns([["1", "a"], ["2"]])).toEqual([true, false]);
    expect(compactColumns([])).toEqual([]);
  });
});
