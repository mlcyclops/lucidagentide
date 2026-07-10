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
  test("P-KGPACK.2: in kb mode the active KG NAME becomes the label (blank falls back)", () => {
    expect(kgViewLabel(st({ kbMode: true, kbName: "Backend Engineer" }))).toBe("Backend Engineer");
    expect(kgViewLabel(st({ kbMode: true, kbName: "   " }))).toBe("Compiled KB");
    expect(kgViewLabel(st({ codeMode: true, kbName: "Ignored" }))).toBe("Code graph"); // code wins
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

// ───────────── P-KGUI.2 (ADR-0185): the Data dropdown ─────────────

import { kgDataMenuHtml } from "./kg_header.ts";

describe("kgDataMenuHtml", () => {
  test("all three former buttons live in the menu with stable handles and self-describing copy", () => {
    const h = kgDataMenuHtml(false);
    for (const v of ["import", "export", "cui"]) expect(h).toContain(`data-kgdata="${v}"`);
    expect(h).toContain("Import chat history");
    expect(h).toContain("Export Obsidian vault");
    expect(h).toContain("CUI archive");
    expect(h).toContain("scanned by the security gate"); // import explains the gate inline
    expect(h).toContain("CUI excluded by design");       // export explains its boundary inline
  });
  test("the AI-extraction toggle is a row, not an action: no data-kgdata handle, checked follows state", () => {
    const off = kgDataMenuHtml(false);
    expect(off).toContain('id="kgImportAI"');
    expect(off).not.toContain('id="kgImportAI" checked');
    expect(off.match(/data-kgdata=/g)?.length).toBe(3); // the toggle never closes/act as a menu action
    expect(kgDataMenuHtml(true)).toContain('id="kgImportAI" checked');
  });
  test("the CUI row keeps its danger look", () => {
    const h = kgDataMenuHtml(false);
    expect(h).toContain("kgv-danger");
    expect(h.match(/kgv-danger/g)?.length).toBe(1); // only CUI
  });
});

// ───────────── P-KGPACK.2 (ADR-0205): the named-KG picker ─────────────

import { filterKgList, kgPickerHtml, kgPickerRowsHtml, type KgListItem } from "./kg_header.ts";

const kg = (over: Partial<KgListItem> = {}): KgListItem => ({ kg_id: "1", name: "My Knowledge", active: false, read_only: false, source_kind: "manual", ...over });
const sample: KgListItem[] = [
  kg({ kg_id: "1", name: "My Knowledge", active: true }),
  kg({ kg_id: "2", name: "Backend Engineer", source_kind: "chat" }),
  kg({ kg_id: "3", name: "GovCon Contracts Officer", source_kind: "pack", read_only: true }),
];

describe("filterKgList", () => {
  test("case-insensitive substring over name; empty query returns everything", () => {
    expect(filterKgList(sample, "")).toHaveLength(3);
    expect(filterKgList(sample, "  ")).toHaveLength(3);
    expect(filterKgList(sample, "eng").map((k) => k.kg_id)).toEqual(["2"]);
    expect(filterKgList(sample, "OFFICER").map((k) => k.kg_id)).toEqual(["3"]);
    expect(filterKgList(sample, "zzz")).toHaveLength(0);
  });
});

describe("kgPickerRowsHtml", () => {
  test("one selectable + one rename control per KG, the active one checked", () => {
    const h = kgPickerRowsHtml(sample, "");
    for (const id of ["1", "2", "3"]) {
      expect(h).toContain(`data-kgpick="${id}"`);
      expect(h).toContain(`data-kgrename="${id}"`);
    }
    expect(h.match(/✓/g)?.length).toBe(1);            // exactly the active KG is checked
    expect(h).toContain("My Knowledge ✓");
  });
  test("origin badges + read-only marker; pack is read-only", () => {
    const h = kgPickerRowsHtml(sample, "");
    expect(h).toContain(">Chat<");
    expect(h).toContain(">Pack<");
    expect(h).toContain('class="kgp-ro"');             // the read-only pack shows the lock marker
    expect(h.match(/class="kgp-ro"/g)?.length).toBe(1); // only the pack row (not matching the kgp-row class)
  });
  test("filters as you type; empty result shows a message, not blank", () => {
    expect(kgPickerRowsHtml(sample, "backend")).toContain("Backend Engineer");
    expect(kgPickerRowsHtml(sample, "backend")).not.toContain("GovCon");
    expect(kgPickerRowsHtml(sample, "zzz")).toContain("No knowledge graph matches");
  });
  test("a KG name is escaped - it is user data, never markup", () => {
    const h = kgPickerRowsHtml([kg({ kg_id: "9", name: "<img src=x onerror=alert(1)>" })], "");
    expect(h).toContain("&lt;img");
    expect(h).not.toContain("<img src=x");
  });
});

describe("kgPickerHtml", () => {
  test("search box, list, count and the New KG action are all present", () => {
    const h = kgPickerHtml(sample, "");
    expect(h).toContain('id="kgPickSearch"');
    expect(h).toContain('id="kgPickList"');
    expect(h).toContain("data-kgnew");
    expect(h).toContain("New KG");
    expect(h).toContain(">3<"); // the count chip
  });
});
