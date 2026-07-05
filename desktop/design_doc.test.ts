// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/design_doc.test.ts — P-DESIGN.1 (ADR-0154): DESIGN.md invariants honoring.

import { test, expect, describe } from "bun:test";
import { designInvariantsBlock, designDocPath, isDesignDocPath, DESIGN_DOC_NAME, MAX_DESIGN_CHARS } from "./design_doc.ts";

describe("designInvariantsBlock", () => {
  test("wraps DESIGN.md as a standing <design-invariants> instruction block", () => {
    const b = designInvariantsBlock("# Design\n- 8px grid\n- Brand blue #1e6bff");
    expect(b).toContain("<design-invariants>");
    expect(b).toContain("</design-invariants>");
    expect(b).toContain("Honor them in ALL UI / design");
    expect(b).toContain("8px grid");
    expect(b).toContain("Brand blue #1e6bff");
  });
  test("returns empty for missing/blank content (no block when there is no DESIGN.md)", () => {
    expect(designInvariantsBlock(null)).toBe("");
    expect(designInvariantsBlock(undefined)).toBe("");
    expect(designInvariantsBlock("   \n  ")).toBe("");
  });
  test("clips an oversized doc so it can't dominate the turn", () => {
    const big = "x".repeat(MAX_DESIGN_CHARS + 5000);
    const b = designInvariantsBlock(big);
    expect(b).toContain("truncated");
    expect(b.length).toBeLessThan(MAX_DESIGN_CHARS + 500);
  });
  test("designDocPath joins the workspace + DESIGN.md", () => {
    expect(designDocPath("/work/proj").replace(/\\/g, "/")).toBe("/work/proj/DESIGN.md");
    expect(DESIGN_DOC_NAME).toBe("DESIGN.md");
  });
});

describe("isDesignDocPath (P-FIGMA.2 — detect the agent writing DESIGN.md)", () => {
  test("matches a DESIGN.md write on any separator, case-insensitively", () => {
    expect(isDesignDocPath("DESIGN.md")).toBe(true);
    expect(isDesignDocPath("/work/proj/DESIGN.md")).toBe(true);
    expect(isDesignDocPath("C:\\work\\proj\\DESIGN.md")).toBe(true);
    expect(isDesignDocPath("/work/proj/design.md")).toBe(true);
  });
  test("does not match other files (no false positives)", () => {
    expect(isDesignDocPath("/work/DESIGN.md.bak")).toBe(false);
    expect(isDesignDocPath("/work/MY_DESIGN.md")).toBe(false);
    expect(isDesignDocPath("/work/design/notes.md")).toBe(false);
    expect(isDesignDocPath("")).toBe(false);
    expect(isDesignDocPath(undefined as unknown as string)).toBe(false);
  });
});
