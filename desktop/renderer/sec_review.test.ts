// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/sec_review.test.ts — P-SECACK.1 (ADR-0170): the active/reviewed split and the
// fresh-findings counter every Security-panel counter derives from.

import { describe, expect, test } from "bun:test";
import { freshFindings, splitReviewed } from "./sec_review.ts";

describe("splitReviewed", () => {
  const rows = [{ artifact_id: "a" }, { artifact_id: "b" }, { artifact_id: "c" }];

  test("unacked rows stay active; acked rows move to reviewed; order preserved", () => {
    const { active, reviewed } = splitReviewed(rows, { b: { at: "t" } });
    expect(active.map((r) => r.artifact_id)).toEqual(["a", "c"]);
    expect(reviewed.map((r) => r.artifact_id)).toEqual(["b"]);
  });

  test("no acks / null acks → everything active", () => {
    expect(splitReviewed(rows, null).active.length).toBe(3);
    expect(splitReviewed(rows, {}).reviewed.length).toBe(0);
  });

  test("a row with a missing/blank key stays ACTIVE — malformed rows never silently vanish", () => {
    const odd = [{ artifact_id: "" }, { other: 1 }] as Record<string, unknown>[];
    const { active, reviewed } = splitReviewed(odd, { "": { at: "t" }, undefined: { at: "t" } });
    expect(active.length).toBe(2);
    expect(reviewed.length).toBe(0);
  });

  test("null/undefined rows → empty split, never a throw", () => {
    expect(splitReviewed(null, { a: { at: "t" } })).toEqual({ active: [], reviewed: [] });
  });
});

describe("freshFindings", () => {
  test("no watermark → the historic total is all new", () => {
    expect(freshFindings(24, null)).toBe(24);
    expect(freshFindings(24, undefined)).toBe(24);
  });
  test("watermark subtracts; equal → 0; above (impossible but clamped) → 0, never negative", () => {
    expect(freshFindings(30, 24)).toBe(6);
    expect(freshFindings(24, 24)).toBe(0);
    expect(freshFindings(24, 99)).toBe(0);
  });
  test("garbage totals/watermarks degrade to safe numbers", () => {
    expect(freshFindings(NaN, 5)).toBe(0);
    expect(freshFindings(-3, null)).toBe(0);
    expect(freshFindings(24, NaN)).toBe(24);
    expect(freshFindings(24, -7)).toBe(24); // negative watermark treated as 0
  });
});
