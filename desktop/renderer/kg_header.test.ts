// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/kg_header.test.ts — P-KGUI.1 (ADR-0184): the consolidated views dropdown.
// Pins: the button label names the active graph, the active-look predicate, and the menu (all three
// options present with self-describing copy, the active one checked, stable data-kgview handles).

import { describe, expect, test } from "bun:test";
import { kgViewActive, kgViewLabel, kgViewsMenuHtml, type KgViewState } from "./kg_header.ts";

const st = (over: Partial<KgViewState> = {}): KgViewState => ({ relateOn: false, codeMode: false, kbMode: false, ...over });

describe("kgViewLabel", () => {
  test("names the graph on the canvas", () => {
    expect(kgViewLabel(st())).toBe("Personal");
    expect(kgViewLabel(st({ codeMode: true }))).toBe("Code graph");
    expect(kgViewLabel(st({ kbMode: true }))).toBe("Compiled KB");
  });
  test("relate mode is a tool, not a view - the label stays Personal", () => {
    expect(kgViewLabel(st({ relateOn: true }))).toBe("Personal");
  });
});

describe("kgViewActive", () => {
  test("any non-default mode lights the button", () => {
    expect(kgViewActive(st())).toBe(false);
    for (const k of ["relateOn", "codeMode", "kbMode"] as const) expect(kgViewActive(st({ [k]: true }))).toBe(true);
  });
});

describe("kgViewsMenuHtml", () => {
  test("all three options are present, with stable handles and self-describing copy", () => {
    const h = kgViewsMenuHtml(st());
    for (const v of ["relate", "code", "kb"]) expect(h).toContain(`data-kgview="${v}"`);
    expect(h).toContain("Relate nodes");
    expect(h).toContain("Code graph");
    expect(h).toContain("Compiled KB");
    expect(h).toContain("your own relationships"); // each option explains itself in the menu
    expect(h).not.toContain("✓"); // nothing active → nothing checked
  });
  test("the active option carries the check and the .on class", () => {
    const h = kgViewsMenuHtml(st({ codeMode: true }));
    expect(h).toContain("Code graph ✓");
    expect(h.match(/kgv-item on/g)?.length).toBe(1);
    expect(h).not.toContain("Relate nodes ✓");
  });
});
