// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, test } from "bun:test";
import { cadRunBlock, creatorCadHtml, isCadInspect, isCadModelResult, sortedCounts, type CadDxfInspect, type CreatorCadView } from "./creator_cad.ts";

const dxf: CadDxfInspect = {
  kind: "dxf", version: "AC1027", units: "mm",
  layers: [{ name: "WALLS", color: 7, entityCount: 12 }, { name: "DIMS", color: 1, entityCount: 40 }],
  entityCounts: { LINE: 30, ARC: 4, TEXT: 18 }, extents: { min: [0, 0], max: [1200, 800] }, svg: "<svg></svg>",
};

const view = (over: Partial<CreatorCadView> = {}): CreatorCadView => ({
  endpoints: [{ id: "nick-dgx-cad", label: "CAD (Nick DGX)", cui: { posture: "enclave", allowed: true, reason: "enclave endpoint" } }],
  endpointId: "nick-dgx-cad", fileName: "", busy: "", status: "", statusTone: "", inspect: null,
  script: "result = 1", outputs: ["step"], modelBusy: "", modelStatus: "", modelTone: "", model: null, ...over,
});

describe("inspect shape gate", () => {
  test("accepts each documented kind", () => {
    expect(isCadInspect(dxf)).toBe(true);
    expect(isCadInspect({ ...dxf, extents: null })).toBe(true);
    expect(isCadInspect({ kind: "ifc", schema: "IFC4", projectName: "Clinic", counts: { IfcWall: 3 }, storeys: [{ name: "L1", elevation: 0 }] })).toBe(true);
    expect(isCadInspect({ kind: "step", solids: 2, bbox: { min: [0, 0, 0], max: [1, 2, 3] }, svg: "" })).toBe(true);
  });

  test("refuses half a payload rather than painting it", () => {
    expect(isCadInspect({ ...dxf, layers: [{ name: "A" }] })).toBe(false);
    expect(isCadInspect({ ...dxf, entityCounts: { LINE: "30" } })).toBe(false);
    expect(isCadInspect({ kind: "step", solids: 1, bbox: { min: [0, 0], max: [1, 1] }, svg: "" })).toBe(false);
    expect(isCadInspect({ kind: "dwg" })).toBe(false);
    expect(isCadModelResult({ ok: true, artifacts: [{ id: "a" }], log: "" })).toBe(false);
  });
});

describe("tables", () => {
  test("counts sort largest first, ties by name", () => {
    expect(sortedCounts({ TEXT: 4, ARC: 4, LINE: 30 })).toEqual([["LINE", 30], ["ARC", 4], ["TEXT", 4]]);
  });

  test("the SVG is never interpolated into the pane markup, only a slot for the sanitized image", () => {
    const html = creatorCadHtml(view({ inspect: { ...dxf, svg: "<svg><script>alert(1)</script></svg>" } }));
    expect(html).not.toContain("<script>");
    expect(html).toContain('data-ccad-svg="inspect"');
  });
});

describe("run gate", () => {
  test("a refused endpoint blocks before anything else", () => {
    const refused = view({ endpoints: [{ id: "x", label: "X", cui: { posture: "cloud", allowed: false, reason: "not an enclave" } }], endpointId: "x", script: "" });
    expect(cadRunBlock(refused)).toBe("Refused under CUI lockdown: not an enclave");
  });

  test("script and outputs are required; a ready pane has no block", () => {
    expect(cadRunBlock(view({ script: "  " }))).toContain("assigns result");
    expect(cadRunBlock(view({ outputs: [] }))).toContain("at least one output");
    expect(cadRunBlock(view())).toBe("");
  });
});
