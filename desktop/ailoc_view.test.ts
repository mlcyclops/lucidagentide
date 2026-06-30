// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/ailoc_view.test.ts — P-LOC.3 (ADR-0095): the "never silently vanish" rule for the
// AI-authored code section.

import { describe, expect, test } from "bun:test";
import { aiLocHasData } from "./ailoc_view.ts";
import type { AiLocSummary } from "./renderer/bridge.ts";

const summary = (edits: number): AiLocSummary => ({
  totals: { added: edits * 10, removed: edits, edits, models: edits ? 1 : 0, repos: edits ? 1 : 0 },
  byModel: [], rows: [], identities: [], generatedAt: "2026-06-29T00:00:00Z",
});

describe("aiLocHasData", () => {
  test("null / undefined ⇒ no data (renderer shows the empty state, not nothing)", () => {
    expect(aiLocHasData(null)).toBe(false);
    expect(aiLocHasData(undefined)).toBe(false);
  });
  test("a roll-up with zero edits ⇒ no data (empty ledger still shows the empty state)", () => {
    expect(aiLocHasData(summary(0))).toBe(false);
  });
  test("a roll-up with ≥1 edit ⇒ data", () => {
    expect(aiLocHasData(summary(1))).toBe(true);
    expect(aiLocHasData(summary(42))).toBe(true);
  });
});
