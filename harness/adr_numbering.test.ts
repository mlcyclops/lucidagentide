// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/adr_numbering.test.ts - ADR numbers must be unique, because a merge will never tell you.
//
// Two branches can each allocate the same ADR number. When both land in a 20,000-line append-only
// document they occupy DIFFERENT regions of it, so git merges them cleanly and the duplicate ships
// in silence. There is no conflict to resolve and no reviewer prompt. That has already happened four
// times on master (pinned below), and it nearly happened a fifth time: the Creator release-channel
// ADR and the PWA branch's phone auto-expand ADR were both allocated 0302, caught only because two
// branches were compared by hand while planning a merge (see ADR-0304).
//
// This test is the mechanical version of that hand comparison. It cannot see other branches, so it
// does not prevent the allocation. What it guarantees is that a duplicate cannot SURVIVE a merge
// into this file, which is the step where the silence used to happen.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Duplicates inherited from master, each one a real pair of unrelated decisions sharing a number:
 *  0054 (thinking-item governance / the `/goal` after-action report), 0055 (subagent edit gating /
 *  cross-run evaluation), 0174 (the trivia wire / the AppContainer loopback posture), 0246 (macOS
 *  auto-update being inert / the GPU-sandbox self-heal).
 *
 *  This is documented debt, not an allowance. Renumbering them now would invalidate every existing
 *  citation, and a citation to either one is already ambiguous. Nothing may be ADDED to this set:
 *  a new collision is a bug to fix before merge, not a pin to extend. */
const KNOWN_DUPLICATES = ["0054", "0055", "0174", "0246"];

test("every ADR number in DECISIONS.md is unique, apart from the pinned inherited duplicates", () => {
  const text = readFileSync(join(import.meta.dir, "..", "DECISIONS.md"), "utf8");

  // Headings use both `--` and an em dash as the separator, and some carry a trailing `(SCOPE/PLAN)`
  // or a date, so only the number is matched. `A0..` exists too (the managed-config series).
  const byNumber = new Map<string, string[]>();
  for (const line of text.split("\n")) {
    const m = /^## ADR-(A?\d{3,4})\b/.exec(line);
    if (!m) continue;
    const number = m[1]!;
    const heading = line.trim();
    const seen = byNumber.get(number);
    if (seen) seen.push(heading);
    else byNumber.set(number, [heading]);
  }

  // Guard against the regex silently matching nothing (a heading-format drift would otherwise make
  // this whole test vacuous and green).
  expect(byNumber.size).toBeGreaterThan(250);

  const duplicated = [...byNumber.entries()].filter(([, headings]) => headings.length > 1);

  // Diagnostic first: name BOTH sides of any unexpected collision, so whoever trips this sees which
  // two decisions are involved rather than just a count.
  const unexpected = duplicated
    .filter(([number]) => !KNOWN_DUPLICATES.includes(number))
    .map(([number, headings]) => `ADR-${number} used ${headings.length}x:\n    ${headings.join("\n    ")}`)
    .join("\n");
  expect(unexpected).toBe("");

  // Then exactness, which also catches the good direction: if an inherited duplicate ever gets
  // resolved, this fails until it is removed from the pin, so the list cannot rot into a lie.
  expect(duplicated.map(([number]) => number).toSorted()).toEqual([...KNOWN_DUPLICATES].toSorted());
});
