// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/creator/img2threejs/img2threejs.test.ts - the TypeScript port of img2threejs's deterministic
// core (CREATOR-IMG2THREEJS, ADR-0526): the strict gate blocks a shallow spec, the pass gate blocks a deeper
// pass, unsupported geometry blocks by name, the checklist refuses evidence-free and out-of-order marks and
// hard-stops at the loop limit, and the generated factory is TypeScript that Bun can transpile.

import { describe, expect, test } from "bun:test";
import { campLanternSpec } from "./fixtures/camp_lantern.ts";
import {
  completedPasses, filterComponentsForPass, generateFactory, isAssessableTier, makeAssessmentPayload, markSteps,
  newState, passLockReason, passOrder, pipelineStatus, probeImage, statusPayload, statusText, syncFromSpec,
  syncPipeline, unlockedPass, validateSpec, validateState, WorkflowStateError, type JsonRecord,
} from "./index.ts";

const DASH = /[\u2013\u2014]/;

describe("validateSpec", () => {
  test("the lantern fixture passes the strict quality gate", () => {
    const r = validateSpec(campLanternSpec());
    expect(r.errors).toEqual([]);
    expect(r.strictFailures).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.summary).toEqual({ targetName: "Camp Lantern", suitability: "pass", components: 6, materials: 3 });
  });
  test("a non-object spec is one error, never a throw", () => {
    expect(validateSpec("nope").errors).toEqual(["spec must be a JSON object"]);
    expect(validateSpec(null).ok).toBe(false);
  });
  test("a shallow root-box spec validates but fails strict quality on every unassessed field", () => {
    const shallow = {
      targetName: "Thing", suitability: "pass", coordinateFrame: {}, silhouette: {}, proceduralStrategy: [],
      materials: [{ id: "m" }], componentTree: [{ id: "root", primitive: "box", material: "m" }],
      preSpecAssessment: makeAssessmentPayload({ targetName: "Thing" }).preSpecAssessment,
    };
    const r = validateSpec(shallow);
    expect(r.errors).toEqual([]);
    expect(r.strictFailures.length).toBeGreaterThan(3);
    expect(r.strictFailures.some((f) => f.includes("primaryType is unassessed"))).toBe(true);
    expect(r.strictFailures.some((f) => f.includes("missing qualityContract"))).toBe(true);
    expect(r.strictFailures.every((f) => f.startsWith("strict quality failure: "))).toBe(true);
  });
  test("broken references and closed sets are errors", () => {
    const spec = campLanternSpec();
    const tree = spec.componentTree as JsonRecord[];
    tree[1]!.material = "chrome";
    tree[2]!.primitive = "blob";
    tree[3]!.parent = "ghost";
    (spec.reviewHistory as JsonRecord[])[0]!.action = "ship-it";
    const r = validateSpec(spec);
    expect(r.errors).toContain('component "cap" references unknown material "chrome"');
    expect(r.errors.some((e) => e.startsWith('component "glass" primitive must be one of:'))).toBe(true);
    expect(r.errors).toContain('component "handle" references missing parent "ghost"');
    expect(r.errors).toContain("reviewHistory[0].action is invalid");
  });
  test("a child limb without an attachment contract is a quality failure, not an error", () => {
    const spec = campLanternSpec();
    delete (spec.componentTree as JsonRecord[])[3]!.attachment;
    const r = validateSpec(spec);
    expect(r.errors).toEqual([]);
    expect(r.strictFailures).toEqual(['strict quality failure: component "handle" requires attachment.parentSocket, localStart/localEnd, contactType, embedDepth or overlap, and gapTolerance']);
  });
  test("the detail inventory must map to real link keys and meet the tier minimum", () => {
    const spec = campLanternSpec();
    const inv = (spec.preSpecAssessment as JsonRecord).detailInventory as JsonRecord;
    inv.details = [{ id: "x", kind: "gloss", mapsTo: { ref: "nowhere" } }];
    const r = validateSpec(spec);
    expect(r.strictFailures.some((f) => f.includes("has 1 details but targetMinDetails is 6"))).toBe(true);
    expect(r.strictFailures.some((f) => f.includes('detail "x" does not map to'))).toBe(true);
  });
});

describe("pass gate", () => {
  test("one completing blockout review unlocks structural-pass and locks the rest", () => {
    const spec = campLanternSpec();
    expect(completedPasses(spec, passOrder(spec))).toEqual(["blockout"]);
    expect(unlockedPass(spec)).toBe("structural-pass");
    expect(passLockReason(spec, "blockout")).toBe("");
    expect(passLockReason(spec, "structural-pass")).toBe("");
    expect(passLockReason(spec, "form-refinement")).toContain('build pass "form-refinement" is locked; complete "structural-pass" first');
    expect(passLockReason(spec, "polish")).toContain("unknown build pass");
  });
  test("a review below threshold or without a comparison image does not complete a visual pass", () => {
    const spec = campLanternSpec();
    const entry = (spec.reviewHistory as JsonRecord[])[0]!;
    entry.aiVisionScore = 0.5;
    expect(completedPasses(spec, passOrder(spec))).toEqual([]);
    entry.aiVisionScore = 0.9;
    delete (entry.visualEvidence as JsonRecord).comparisonImage;
    expect(completedPasses(spec, passOrder(spec))).toEqual([]);
  });
  test("a failed critical feature review blocks the pass even with a passing overall score", () => {
    const spec = campLanternSpec();
    const entry = (spec.reviewHistory as JsonRecord[])[0]!;
    (entry.featureReviews as JsonRecord[])[0]!.score = 0.4;
    expect(completedPasses(spec, passOrder(spec))).toEqual([]);
    const r = validateSpec(spec);
    expect(r.warnings.some((w) => w.includes('critical feature "silhouette" score 0.4 is below 0.75'))).toBe(true);
  });
  test("blockout builds macro components only, with parents pulled in", () => {
    const spec = campLanternSpec();
    const tree = spec.componentTree as JsonRecord[];
    expect(filterComponentsForPass(spec, tree, "blockout").map((c) => c.id)).toEqual(["body", "cap"]);
    expect(filterComponentsForPass(spec, tree, "structural-pass").map((c) => c.id)).toEqual(["body", "cap", "glass", "handle", "vent-ring"]);
    expect(filterComponentsForPass(spec, tree, "form-refinement").map((c) => c.id)).toEqual(["body", "cap", "glass", "handle", "vent-ring", "knob"]);
  });
  test("syncPipeline rewrites the pipeline block from the review history", () => {
    const spec = campLanternSpec();
    const synced = syncPipeline({ ...spec, sculptPipeline: undefined });
    const p = synced.sculptPipeline as JsonRecord;
    expect(p.passGateMode).toBe("locked-sequential");
    expect(p.completedPasses).toEqual(["blockout"]);
    expect(p.currentPass).toBe("structural-pass");
    expect((p.nextRequiredEvidence as string[]).length).toBeGreaterThan(3);
    expect(pipelineStatus(spec).currentPass).toBe("structural-pass");
  });
});

describe("generateFactory", () => {
  test("blockout emits the macro parts, the material map and the runtime, as transpilable TypeScript", () => {
    const r = generateFactory(campLanternSpec(), "blockout");
    if (!r.ok) throw new Error(JSON.stringify(r.report));
    expect(r.functionName).toBe("createCampLanternModel");
    expect(r.components).toEqual(["body", "cap"]);
    expect(r.source).toContain("export function createCampLanternModel(options: ProceduralModelOptions = {}): THREE.Group");
    expect(r.source).toContain('materialMap["glass"] = createSculptMaterial(');
    expect(r.source).toContain("root.userData.sculptRuntime = { nodes, meshes, sockets, colliders, destructionGroups }");
    expect(r.source).toContain('sockets["body:cap-seat"]');
    expect(r.source).toContain('destructionGroups["shell"]');
    expect(r.source).not.toContain('nodes["handle"]');
    expect(r.source).not.toContain("InstancedMesh(");
    expect(r.source).not.toContain("buildTubeGeometry");
    expect(DASH.test(r.source)).toBe(false);
    const js = new Bun.Transpiler({ loader: "ts" }).transformSync(r.source);
    expect(js).toContain("createCampLanternModel");
  });
  test("structural-pass adds the meso parts: an attachment-sized tube, a torus, and the vent slots as one InstancedMesh", () => {
    const r = generateFactory(campLanternSpec(), "structural-pass");
    if (!r.ok) throw new Error(JSON.stringify(r.report));
    expect(r.components).toEqual(["body", "cap", "glass", "handle", "vent-ring"]);
    expect(r.source).toContain("function buildTubeGeometry(");
    expect(r.source).toContain("new THREE.TorusGeometry(0.45, 0.054,");
    expect(r.source).toContain("new THREE.InstancedMesh(geo, mat, 8)");
    expect(r.source).toContain('nodes["repetition:vent-slots"] = cluster;');
    expect(r.source).toMatch(/const endpoint_handle_3 = makeAttachmentEndpoint\(\{"parentId":"body"/);
    expect(r.source).toContain("new THREE.CylinderGeometry(endpoint_glass_2.endRadius, endpoint_glass_2.baseRadius, endpoint_glass_2.length,");
    expect(() => new Bun.Transpiler({ loader: "ts" }).transformSync(r.source)).not.toThrow();
  });
  test("a locked pass is BLOCKED and no source exists", () => {
    const r = generateFactory(campLanternSpec(), "material-pass");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.report.gate).toBe("pass-lock");
    expect(r.report.status).toBe("BLOCKED");
    expect(r.report.cause[0]).toContain('"material-pass" is locked');
    expect("source" in r).toBe(false);
  });
  test("a shallow spec is BLOCKED by strict quality", () => {
    const spec = campLanternSpec();
    (spec.qualityContract as JsonRecord).qualityBar = "unassessed";
    const r = generateFactory(spec, "blockout");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.report.gate).toBe("strict-quality");
    expect(r.report.cause).toContain("strict quality failure: qualityContract.qualityBar is unassessed");
  });
  test("geometry this port cannot build is BLOCKED by component name, never substituted with a box", () => {
    const spec = campLanternSpec();
    (spec.componentTree as JsonRecord[])[0]!.geometryDescriptor = { subdivide: { iterations: 2 } };
    const r = generateFactory(spec, "blockout");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.report.gate).toBe("geometry");
    expect(r.report.cause[0]).toContain('component "body": subdivision cages are not ported');
  });
  test("a spec string that looks like code is emitted as a JSON literal", () => {
    const spec = campLanternSpec();
    (spec.componentTree as JsonRecord[])[0]!.name = "Body\"; process.exit(1); //";
    const r = generateFactory(spec, "blockout");
    if (!r.ok) throw new Error(JSON.stringify(r.report));
    expect(r.source).toContain('.name = "Body\\"; process.exit(1); //__pivot";');
    expect(r.source).not.toContain("\n process.exit");
    expect(() => new Bun.Transpiler({ loader: "ts" }).transformSync(r.source)).not.toThrow();
  });
});

describe("workflow state", () => {
  test("a new state starts at image analysis and only generic is a known profile", () => {
    const state = newState("reference/lantern.png", { spec: "object-sculpt-spec.json" });
    expect(state.currentStep).toBe("image-analysis");
    expect(statusPayload(state).pending[0]).toBe("image-analysis");
    expect(statusPayload(state).nextCommand).toContain('"reference/lantern.png"');
    expect(() => newState("x.png", { profile: "cs2" })).toThrow(/unknown domain profile "cs2"/);
    expect(() => newState("x.png", { maxPerPass: 4, maxTotal: 2 })).toThrow(WorkflowStateError);
  });
  test("done needs evidence, skipped needs a reason, and steps go in order", () => {
    const state = newState("ref.png");
    expect(() => markSteps(state, ["image-analysis"], { status: "done" })).toThrow(/requires at least one evidence/);
    expect(() => markSteps(state, ["image-analysis"], { status: "skipped" })).toThrow(/requires a reason/);
    expect(() => markSteps(state, ["image-probe"], { status: "done", evidence: ["probe.json"] })).toThrow(/out-of-order checklist update: expected image-analysis, received image-probe/);
    expect(() => markSteps(state, ["nope"], { status: "done", evidence: ["x"] })).toThrow(/unknown checklist step/);
    const next = markSteps(state, ["image-analysis", "reference-suitability"], { status: "done", evidence: ["notes.md"] });
    expect(next.currentStep).toBe("image-probe");
    expect(state.currentStep).toBe("image-analysis"); // the input was not mutated
  });
  test("sync adopts the spec's current pass, counts refinements, and hard-stops at the limit", () => {
    let state = newState("ref.png", { spec: "spec.json" });
    for (const id of ["image-analysis", "reference-suitability", "image-probe", "pre-spec-assessment", "detail-inventory", "spec-authoring", "strict-validation"]) state = markSteps(state, [id], { status: "done", evidence: ["e"] });
    const spec = campLanternSpec();
    state = syncFromSpec(state, spec, pipelineStatus(spec).currentPass);
    expect(state.currentPass).toBe("structural-pass");
    expect(state.currentStep).toBe("build-current-pass");
    expect(statusPayload(state).nextCommand).toContain('"passId": "structural-pass"');
    const refine = (n: number): JsonRecord[] => Array.from({ length: n }, () => ({ passId: "structural-pass", action: "refine-code", mismatches: ["handle too thick"] }));
    const once = syncFromSpec(state, { ...spec, reviewHistory: [...(spec.reviewHistory as JsonRecord[]), ...refine(1)] }, "structural-pass");
    expect(once.status).toBe("active");
    expect(once.iterationAction).toBe("refine-code");
    expect(statusPayload(once).nextCommand).toBe("Refine the existing src/createObjectModel.ts from the latest review; do not regenerate it");
    expect(once.loops.perPass["structural-pass"]).toBe(1);
    const stopped = syncFromSpec(state, { ...spec, reviewHistory: [...(spec.reviewHistory as JsonRecord[]), ...refine(3)] }, "structural-pass");
    expect(stopped.status).toBe("stopped");
    expect(stopped.stopReason).toBe("max-correction-loops-reached:structural-pass:3/3");
    expect(statusText(statusPayload(stopped))).toContain("STOP: max-correction-loops-reached");
    expect(() => markSteps(stopped, ["build-current-pass"], { status: "done", evidence: ["e"] })).toThrow(/hard-stopped/);
  });
  test("a state survives a JSON round trip and a tampered one is refused by name", () => {
    const state = newState("ref.png");
    const back = validateState(JSON.parse(JSON.stringify(state)));
    expect(back).toEqual(state);
    expect(() => validateState({ ...state, schemaVersion: 2 })).toThrow(/unsupported state schemaVersion/);
    expect(() => validateState({ ...state, profile: "cs2" })).toThrow(/unknown domain profile/);
    expect(() => validateState({ ...state, loops: { ...state.loops, maxPerPass: 9 } })).toThrow(/1 <= maxPerPass <= maxTotal/);
  });
});

describe("probeImage and assessment", () => {
  const png = (w: number, h: number): Uint8Array => {
    const b = new Uint8Array(64);
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);
    new DataView(b.buffer).setUint32(16, w);
    new DataView(b.buffer).setUint32(20, h);
    return b;
  };
  test("a PNG header gives type, size and a verdict", () => {
    const ok = probeImage(png(1024, 768), 500_000);
    expect(ok).toMatchObject({ type: "png", width: 1024, height: 768, bytes: 500_000, technicalSuitability: "pass", warnings: [] });
    const small = probeImage(png(300, 2000));
    expect(small.technicalSuitability).toBe("conditional");
    expect(small.warnings).toEqual(["low resolution; small geometry/material details may be unreliable", "extreme aspect ratio; object may be cropped or surrounded by empty space"]);
  });
  test("a JPEG SOF0 segment gives the size; garbage gives warnings, not a throw", () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x02, 0x58, 0x03, 0x20, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9]);
    expect(probeImage(jpeg)).toMatchObject({ type: "jpeg", width: 800, height: 600 });
    expect(probeImage(new Uint8Array([1, 2, 3]))).toMatchObject({ type: null, width: null, technicalSuitability: "conditional", warnings: ["unknown image type", "could not read image dimensions"] });
  });
  test("the assessment payload carries the tier's minimums and stays unassessed where the agent must look", () => {
    const p = makeAssessmentPayload({ targetName: "Old Boot", image: "boot.png", complexity: "complex", domain: "object" });
    const a = p.preSpecAssessment as JsonRecord;
    expect((a.complexity as JsonRecord).tier).toBe("complex");
    expect((a.detailInventory as JsonRecord).targetMinDetails).toBe(10);
    expect((a.specDepthDecision as JsonRecord).needsRepetitionSystems).toBe(true);
    expect((a.objectClass as JsonRecord).primaryType).toBe("unassessed");
    expect((p.qualityContract as JsonRecord).minimumSpecDepth).toEqual({ macroComponents: 3, mesoComponents: 8, microFeatureGroups: 5, materialLayers: 3, repetitionSystems: 1, reviewViewpoints: 4 });
    expect(isAssessableTier("moderate")).toBe(true);
    expect(isAssessableTier("unassessed")).toBe(false);
  });
});
