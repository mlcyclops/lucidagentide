// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/titlebar_fit.test.ts - P-TITLEBAR.1 (ADR-0603): the fold order gives up the model name last.

import { describe, expect, test } from "bun:test";
import { nextFoldLevel, type FoldLevel } from "./titlebar_fit.ts";

const walk = (has: { foldable: number; zoom: boolean }): FoldLevel[] => {
  const out: FoldLevel[] = [];
  for (let l = nextFoldLevel(0, has); l !== null; l = nextFoldLevel(l, has)) out.push(l);
  return out;
};

describe("nextFoldLevel", () => {
  test("chips fold first, then the zoom group, and the model name is cut last", () => {
    expect(walk({ foldable: 2, zoom: true })).toEqual([1, 2, 3]);
  });

  test("a level that would change nothing is skipped, but cutting the name is always the last step", () => {
    expect(walk({ foldable: 0, zoom: true })).toEqual([2, 3]);
    expect(walk({ foldable: 1, zoom: false })).toEqual([1, 3]);
    expect(walk({ foldable: 0, zoom: false })).toEqual([3]);
  });
});
