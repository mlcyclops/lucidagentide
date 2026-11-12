// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/creator/img2threejs/fixtures/camp_lantern.ts - a small ObjectSculptSpec that passes the strict
// quality gate (CREATOR-IMG2THREEJS, ADR-0562). Shared by the unit tests and `make demo-CREATOR-IMG2THREEJS`.
// It is first-party and invented: a generic camp lantern, no reference image, no brand.

import { makePreSpecAssessment, makeQualityContract } from "../assessment.ts";
import type { JsonRecord } from "../contract.ts";
import { syncPipeline } from "../passes.ts";

const attach = (parentSocket: string, start: [number, number, number], end: [number, number, number], baseRadius: number, endRadius = baseRadius): JsonRecord => ({
  parentId: "body", parentSocket, localStart: start, localEnd: end, contactType: "seated", embedDepth: 0.03, gapTolerance: 0.005, baseRadius, endRadius,
});

const profile = (role: string, collider: string): JsonRecord => ({
  animationRole: role,
  pivot: { mode: "component-origin", localPosition: [0, 0, 0], axis: [0, 1, 0], confidence: 0.8 },
  transformChannels: { position: true, rotation: true, scale: false },
  collider: { type: collider, offset: [0, 0, 0], scale: [1, 1, 1], isTrigger: false },
  destruction: { breakable: false, fractureGroup: "shell" },
});

/** A moderate-tier lantern: 2 macro, 3 meso, 1 micro component, 3 materials, one radial repetition system. */
export function campLanternSpec(): JsonRecord {
  const assessment = makePreSpecAssessment("Camp Lantern");
  const objectClass = assessment.objectClass as JsonRecord;
  objectClass.primaryType = "lantern";
  objectClass.primaryDomain = "object";
  objectClass.formLanguage = ["cylindrical body", "conical cap", "wire bail handle"];
  objectClass.structureKind = ["stacked solids", "attached handle"];
  objectClass.motionPotential = ["handle swings", "knob turns"];
  objectClass.materialFamilies = ["painted steel", "glass", "brass"];
  const complexity = assessment.complexity as JsonRecord;
  complexity.tier = "moderate";
  complexity.scores = { silhouetteComplexity: 1, componentCount: 2, hierarchyDepth: 1, repetitionDensity: 1, materialLayerCount: 2, localDetailDensity: 1, occlusionRisk: 1, actionReadinessNeed: 1 };
  complexity.estimatedCounts = { macroComponents: 2, mesoComponents: 3, microFeatureGroups: 2, materialLayers: 3, repetitionSystems: 1 };
  complexity.reasoning = ["one tall cylinder dominates the silhouette", "a conical cap, a glass chimney and a bail handle are the visible meso parts"];
  const decision = assessment.specDepthDecision as JsonRecord;
  decision.requiredDepth = "moderate";
  decision.minimumComponentLevels = ["macro", "meso"];
  const inventory = assessment.detailInventory as JsonRecord;
  inventory.targetMinDetails = 6;
  inventory.details = [
    { id: "d1", kind: "gloss", mapsTo: { ref: "glass" } },
    { id: "d2", kind: "fastener", mapsTo: { ref: "knob" } },
    { id: "d3", kind: "seam", mapsTo: { ref: "body/seam-line" } },
    { id: "d4", kind: "emissive", mapsTo: { ref: "brass/wick-glow" } },
    { id: "d5", kind: "groove", mapsTo: { ref: "body/embossed-logo" } },
    { id: "d6", kind: "ridge", mapsTo: { ref: "knob/knurl" } },
  ];
  const contract = makeQualityContract();
  contract.qualityBar = "moderate";
  contract.minimumSpecDepth = { macroComponents: 2, mesoComponents: 3, microFeatureGroups: 2, materialLayers: 2, repetitionSystems: 0, reviewViewpoints: 3 };

  const spec: JsonRecord = {
    targetName: "Camp Lantern",
    sourceImage: "reference/lantern.png",
    suitability: "pass",
    coordinateFrame: { up: "+y", forward: "-z", units: "meters" },
    silhouette: { primary: "tall cylinder with a conical cap", aspect: 0.45 },
    proceduralStrategy: ["stacked primitives", "attachment endpoints for the handle", "instanced vent slots"],
    scores: { subjectClarity: 3, resolution: 2, occlusion: 2 },
    terminologyProfile: { geometryTerms: ["cylinder", "cone", "torus", "tube"], materialTerms: ["albedo", "roughness", "metalness", "transmission"], lightingTerms: ["key", "fill", "rim"], descriptionRule: "name the 3D form, never the vibe" },
    qualityTargets: { targetFidelity: 0.8, mustMatch: ["silhouette", "cap proportion", "handle arc"], niceToHave: ["knurl on the knob"], reviewViewpoints: ["front", "three-quarter", "top"] },
    actionReadiness: { contract: "sculpt-runtime-v1", defaultRigType: "pivot", rootMotionNode: "root", requiredComponentFields: ["actionProfile"], transformChannels: ["position", "rotation"], authoringRules: ["pivot at the joint"], destructionPolicy: { mode: "groups" } },
    selfCorrectLoop: {
      enabled: true,
      reviewAfterPasses: ["blockout", "structural-pass", "form-refinement", "material-pass", "surface-pass", "lighting-pass", "interaction-pass"],
      allowedActions: ["continue", "refine-spec", "refine-code", "request-input", "stop"],
      visualAcceptance: { reviewer: "agent-vision", threshold: 0.7, comparisonArtifactRequired: true, featureReviewPolicy: { enabled: true, maxCriticalFeaturesPerPass: 5, maxImportantFeaturesPerPass: 3, criticalDefaultThreshold: 0.8, importantAverageThreshold: 0.65 } },
      screenshotPolicy: { requiredForPasses: ["blockout", "structural-pass", "form-refinement", "material-pass", "surface-pass", "lighting-pass", "interaction-pass"], preferredCapture: "preview_screenshot", minimumEvidence: "one fixed view plus two orbit views" },
    },
    featureReviewTargets: [
      { id: "silhouette", tier: "critical", passIds: ["blockout", "structural-pass"], minimumScore: 0.75 },
    ],
    preSpecAssessment: assessment,
    qualityContract: contract,
    viewEvidence: [{ id: "full-object", confidence: 0.9, imageRegion: { x: 0, y: 0, width: 1, height: 1 } }],
    materials: [
      { id: "painted-steel", baseColor: "#2f5d3a", roughness: { base: 0.55, variation: 0.1 }, metalness: 0.0 },
      { id: "glass", baseColor: "#dfe9ec", roughness: 0.08, metalness: 0.0, transmission: 0.85, ior: 1.5, doubleSided: true },
      { id: "brass", baseColor: "#b08d57", roughness: 0.35, metalness: 1.0, emissive: "#000000", localOverrides: [{ id: "wick-glow", emissive: "#ffb347" }] },
    ],
    componentTree: [
      { id: "body", name: "Fuel body", primitive: "cylinder", level: "macro", material: "painted-steel", dimensions: { radius: 0.09, height: 0.22 }, transform: { position: [0, 0.11, 0] }, localFeatures: ["embossed-logo", "seam-line"], actionProfile: { ...profile("static", "cylinder"), sockets: [{ id: "cap-seat", localPosition: [0, 0.11, 0] }, { id: "bail-left", localPosition: [-0.09, 0.08, 0] }] }, evidenceRefs: ["full-object"] },
      { id: "cap", name: "Vent cap", primitive: "cone", level: "macro", parent: "body", material: "painted-steel", attachment: attach("cap-seat", [0, 0.11, 0], [0, 0.19, 0], 0.07, 0.02), actionProfile: profile("static", "cone"), evidenceRefs: ["full-object"] },
      { id: "glass", name: "Glass chimney", primitive: "cylinder", level: "meso", parent: "body", material: "glass", role: "chimney", attachment: attach("cap-seat", [0, 0.11, 0], [0, 0.17, 0], 0.06, 0.06), actionProfile: profile("static", "cylinder"), evidenceRefs: ["full-object"] },
      { id: "handle", name: "Bail handle", primitive: "tube", level: "meso", parent: "body", material: "brass", role: "handle", attachment: attach("bail-left", [-0.09, 0.08, 0], [0.09, 0.08, 0], 0.006), geometryDescriptor: { tubePath: { points: [[-0.09, 0.08, 0], [-0.06, 0.26, 0], [0.06, 0.26, 0], [0.09, 0.08, 0]], radius: 0.006 } }, actionProfile: { ...profile("hinge", "capsule"), pivot: { mode: "socket", localPosition: [-0.09, 0.08, 0], axis: [1, 0, 0], confidence: 0.7 } }, evidenceRefs: ["full-object"] },
      { id: "vent-ring", name: "Vent ring", primitive: "torus", level: "meso", parent: "body", material: "painted-steel", role: "trim", dimensions: { radius: 0.095, height: 0.02 }, transform: { position: [0, 0.2, 0], rotation: [1.5707963, 0, 0] }, geometryDescriptor: { torusTubeRatio: 0.12 }, actionProfile: profile("static", "torus"), evidenceRefs: ["full-object"] },
      { id: "knob", name: "Wick knob", primitive: "box", level: "micro", parent: "body", material: "brass", role: "control", dimensions: { width: 0.02, height: 0.02, depth: 0.02 }, transform: { position: [0.1, 0.05, 0] }, localFeatures: ["knurl"], actionProfile: profile("rotor", "box"), evidenceRefs: ["full-object"] },
    ],
    repetitionSystems: [
      { id: "vent-slots", level: "meso", parent: "cap", count: 8, primitive: "box", material: "painted-steel", instanceScale: [0.012, 0.004, 0.02], placement: { mode: "radial", axis: [0, 1, 0], radius: 0.05, startAngleDeg: 0 } },
    ],
    buildPasses: [
      { id: "blockout", goal: "mass and proportion", componentRefs: ["body", "cap"], acceptance: ["silhouette reads as a lantern"] },
      { id: "structural-pass", goal: "every visible part present", componentRefs: ["glass", "handle", "vent-ring"], acceptance: ["handle roots at the body sockets"] },
      { id: "form-refinement", goal: "curves and small parts", componentRefs: ["knob"], acceptance: ["knob and vent slots present"] },
      { id: "material-pass", goal: "paint, brass, glass", acceptance: ["glass transmits"] },
      { id: "surface-pass", goal: "wear and seams", acceptance: ["seam line visible"] },
      { id: "lighting-pass", goal: "look-dev lights", acceptance: ["three review modes render"] },
      { id: "interaction-pass", goal: "pivots and sockets", acceptance: ["handle swings about its sockets"] },
      { id: "optimization-pass", goal: "draw calls", acceptance: ["under 20 draw calls"] },
    ],
    reviewHistory: [
      {
        passId: "blockout", action: "continue", aiVisionScore: 0.82, estimatedFidelity: 0.6,
        visualEvidence: { renderScreenshot: "shots/blockout-front.png", comparisonImage: "shots/blockout-compare.png", capturedBy: "preview_screenshot" },
        featureReviews: [{ id: "silhouette", score: 0.8, visible: true }],
        matched: ["tall body", "cap proportion"], mismatches: [], evidence: ["shots/blockout-front.png"],
      },
    ],
    lookDevTargets: { qualityPriority: "balanced" },
  };
  return syncPipeline(spec);
}
