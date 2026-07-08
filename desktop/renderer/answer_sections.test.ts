// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-CHAT.A: the pure answer sectionizer. Over-tests the split logic the settle-time transform relies on -
// heading + horizontal-rule boundaries, fence-awareness (a `#` inside a code block is NOT a heading),
// intro capture, and the "don't accordion a trivial answer" gate.

import { expect, test } from "bun:test";
import { sectionizeAnswer, shouldSectionize } from "./answer_sections.ts";

test("splits on ATX headings, capturing title + level + body, plus a pre-heading intro", () => {
  const md = "Here is the summary.\n\n## Problem\nIt broke.\n\n## What I changed\nFixed it.\n\n### Detail\nnote";
  const s = sectionizeAnswer(md);
  expect(s.map((x) => x.title)).toEqual([null, "Problem", "What I changed", "Detail"]);
  expect(s.map((x) => x.level)).toEqual([0, 2, 2, 3]);
  expect(s[0]!.body).toBe("Here is the summary.");
  expect(s[1]!.body).toBe("It broke.");
  expect(shouldSectionize(s)).toBe(true);
});

test("splits on horizontal rules (---, box-draw, ***)", () => {
  const md = "alpha\n\n\u2500\u2500\u2500\u2500\u2500\n\nbravo\n\n---\n\ncharlie";
  const s = sectionizeAnswer(md);
  expect(s.map((x) => x.body)).toEqual(["alpha", "bravo", "charlie"]);
  expect(s.every((x) => x.title === null)).toBe(true);
  expect(shouldSectionize(s)).toBe(false); // rules only, no headings -> stays inline
});

test("is fence-aware: a `#` inside a code block is not a heading", () => {
  const md = "## Real\nbefore\n\n```bash\n# not a heading\nmake build\n```\n\n## Also real\nafter";
  const s = sectionizeAnswer(md);
  expect(s.map((x) => x.title)).toEqual(["Real", "Also real"]);
  expect(s[0]!.body).toContain("# not a heading"); // preserved inside the fence
  expect(s[0]!.body).toContain("```bash");
});

test("a heading-less blob is a single section (never accordioned)", () => {
  const s = sectionizeAnswer("just a short answer with `code` and a list:\n- a\n- b");
  expect(s).toHaveLength(1);
  expect(s[0]!.title).toBeNull();
  expect(shouldSectionize(s)).toBe(false);
});

test("empty / whitespace input yields no sections", () => {
  expect(sectionizeAnswer("")).toEqual([]);
  expect(sectionizeAnswer("   \n\n  ")).toEqual([]);
});

test("trailing `#` and extra spaces in a heading are trimmed", () => {
  const s = sectionizeAnswer("##   Verification   ##\nall green");
  expect(s[0]!.title).toBe("Verification");
  expect(s[0]!.level).toBe(2);
});
