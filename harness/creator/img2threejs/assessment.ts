// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/creator/img2threejs/assessment.ts - the pre-spec assessment and quality contract skeletons
// (CREATOR-IMG2THREEJS, ADR-0562). TypeScript port of forge/stage2_spec/new_pre_spec_assessment.py and the
// `make_pre_spec_assessment` / `make_quality_contract` builders of forge/stage2_spec/new_sculpt_spec.py from
// github.com/img2threejs/img2threejs (Apache-2.0).
//
// The skeleton is deliberately full of "unassessed" placeholders: every one of them is a `quality:` warning
// under validation, so the strict gate refuses codegen until the agent has LOOKED at the image and filled
// them from what it saw. Nothing here infers anything about the picture; it only fixes the shape and the
// minimum depth the chosen complexity tier demands.
//
// Not ported from upstream: the CS2 skin domain plugin, the local BM25 spec search (needs a corpus this
// repo does not ship), and the pipeline-routing block.

import { ASSESSABLE_TIERS, COMPLEXITY_MINIMUMS, DETAIL_MINIMUMS, type AssessableTier, type JsonRecord } from "./contract.ts";

export type SubjectDomain = "object" | "character" | "hybrid";

export interface AssessmentRequest {
  readonly targetName: string;
  /** Reference image path or URL as the agent will cite it. Stored verbatim as data. */
  readonly image?: string;
  /** Initial estimate; upstream defaults to moderate and refines after visual inspection. */
  readonly complexity?: AssessableTier;
  readonly domain?: SubjectDomain;
}

export function isAssessableTier(v: unknown): v is AssessableTier {
  return typeof v === "string" && (ASSESSABLE_TIERS as readonly string[]).includes(v);
}

export function makePreSpecAssessment(targetName: string): JsonRecord {
  return {
    objectClass: {
      primaryType: "unassessed",
      primaryDomain: "unassessed",
      formLanguage: [],
      structureKind: [],
      motionPotential: [],
      materialFamilies: [],
      notes: "Fill from direct visual inspection before writing the final spec. Do not use fixed domain profiles. Set primaryDomain to object, character, or hybrid.",
    },
    complexity: {
      tier: "unassessed",
      scores: {
        silhouetteComplexity: 0, componentCount: 0, hierarchyDepth: 0, repetitionDensity: 0,
        materialLayerCount: 0, localDetailDensity: 0, occlusionRisk: 0, actionReadinessNeed: 0,
      },
      estimatedCounts: { macroComponents: 1, mesoComponents: 0, microFeatureGroups: 0, materialLayers: 1, repetitionSystems: 0 },
      reasoning: [`Assess ${JSON.stringify(targetName)} from the image before finalizing componentTree/materials.`],
    },
    specDepthDecision: {
      requiredDepth: "unassessed",
      minimumComponentLevels: ["macro"],
      needsRepetitionSystems: false,
      needsMaterialLocalOverrides: false,
      needsMultipleReviewViews: true,
      needsActionReadyHierarchy: true,
      rationale: "Choose simple/moderate/complex/ultra-complex from observed structure, not from a hardcoded domain.",
    },
    unknownsToResolveBeforeImplementation: [],
    detailInventory: {
      scanMethod: "component-zones",
      targetMinDetails: 0,
      note: "Enumerate every identity-defining small detail before authoring the spec. Each detail must map to a component.localFeatures entry or material.localOverrides entry, never prose only. Scan the image zone by zone (a 3x3 grid) with your own vision.",
      details: [],
    },
    anatomy: {
      applies: false,
      styleHeads: 0,
      proportions: { headUnit: 0, torso: 0, legs: 0, shoulderWidth: 0, hipWidth: 0 },
      pose: { type: "unassessed", jointAngles: {} },
      faceLandmarks: { eyeLine: 0, eyeSpacing: 0, noseBase: 0, mouthLine: 0, hairline: 0 },
      features: [],
      confidence: 0,
      note: "Only meaningful when objectClass.primaryDomain is character or hybrid. Set applies=true and fill from your own landmark reading of the image.",
    },
  };
}

export function makeQualityContract(): JsonRecord {
  return {
    qualityBar: "unassessed",
    definitionOfDone: [
      "The rendered model matches the reference silhouette, primary proportions, visible component hierarchy, material response, and most recognizable local features for the selected fidelity tier.",
    ],
    minimumSpecDepth: { macroComponents: 1, mesoComponents: 0, microFeatureGroups: 0, materialLayers: 1, repetitionSystems: 0, reviewViewpoints: 3 },
    featureGroups: [
      {
        id: "overall-silhouette", name: "Overall silhouette and proportions", required: true,
        qualityCriteria: ["Bounding shape, dominant curves, negative spaces, and scale relationships are explicitly described."],
        evidenceRefs: ["full-object"],
        failureModes: ["model reads as a generic placeholder instead of the reference object", "major proportions are guessed without evidence"],
      },
      {
        id: "primary-structure", name: "Primary structure and hierarchy", required: true,
        qualityCriteria: ["Major parts, joints, seams, contact points, and parent-child relationships are named before code generation."],
        evidenceRefs: ["full-object"],
        failureModes: ["large visible parts are merged into one mesh", "component hierarchy is too shallow for the observed complexity"],
      },
      {
        id: "attachment-joint-correctness", name: "Attachment and joint correctness", required: true,
        qualityCriteria: ["Every visible child appendage, branch, limb, handle, connector, tube, cable, horn, wing, leg, or hinged part has an attachment contract with parent socket, localStart/localEnd, contact type, embed/overlap, and gap tolerance."],
        evidenceRefs: ["full-object"],
        failureModes: ["child part root floats away from the parent", "branch/limb/tube is centered in space instead of pivoting from its root", "parent-child transform mixes world and local coordinates"],
      },
      {
        id: "surface-material-response", name: "Surface material response", required: true,
        qualityCriteria: [
          "Albedo zones, roughness, normal/bump/displacement intent, cavity dirt, edge wear, and local overrides are specified where visible.",
          "Important materials define independent albedo, roughness, height/normal, and AO responses instead of reusing one texture for unrelated PBR channels.",
        ],
        evidenceRefs: ["full-object"],
        failureModes: ["surface looks like flat plastic", "local material variation is missing or not tied to image evidence"],
      },
      {
        id: "reference-lookdev", name: "Reference color, material, and lighting response", required: true,
        qualityCriteria: [
          "Material-pass names the reference-derived albedo palette, roughness variation, tactile normal/bump response, and local masks.",
          "Lighting-pass names key/fill/rim or environment light, exposure, tone mapping, background, and contact shadow behavior.",
        ],
        evidenceRefs: ["full-object"],
        failureModes: ["model has acceptable shape but reads as flat shaded or plastic", "colors are a generic average instead of reference-observed local color zones", "lighting is evenly ambient and cannot reproduce the source value range"],
      },
    ],
    visualDeltaChecks: [
      "silhouette and negative-space delta",
      "component hierarchy depth delta",
      "repetition density and distribution delta",
      "material albedo/roughness/normal response delta",
      "local feature placement and scale delta",
    ],
    antiShallowSpecRules: [
      "Do not proceed to code if qualityContract.qualityBar is unassessed.",
      "Do not proceed to code if the spec only contains a root component for a moderate or complex object.",
      "Do not proceed to code if required featureGroups are not represented by componentTree, materials, or repetitionSystems.",
      "Do not proceed to code if visible local features are described only in prose and not attached to components/materials/evidenceRefs.",
      "Do not proceed past structural-pass if attached child parts lack attachment.parentSocket, localStart, localEnd, embedDepth/overlap, and gapTolerance.",
      "Do not place adjacent separate-geometry parts below 0.02 world-unit seam overlap.",
      "Do not satisfy raised or recessed relief, fasteners, or grip structure with a map alone when the feature affects form; use geometry.",
    ],
  };
}

/** The assessment payload the agent fills in, with the depth minimums the tier demands already applied. */
export function makeAssessmentPayload(request: AssessmentRequest): JsonRecord {
  const complexity: AssessableTier = request.complexity ?? "moderate";
  const assessment = makePreSpecAssessment(request.targetName);
  const contract = makeQualityContract();
  (assessment.complexity as JsonRecord).tier = complexity;
  const decision = assessment.specDepthDecision as JsonRecord;
  decision.requiredDepth = complexity;
  if (complexity === "complex" || complexity === "ultra-complex") {
    decision.needsRepetitionSystems = true;
    decision.needsMaterialLocalOverrides = true;
    decision.minimumComponentLevels = ["macro", "meso", "micro"];
  } else if (complexity === "moderate") {
    decision.minimumComponentLevels = ["macro", "meso"];
  }
  (assessment.detailInventory as JsonRecord).targetMinDetails = DETAIL_MINIMUMS[complexity];
  if (request.domain) (assessment.objectClass as JsonRecord).primaryDomain = request.domain;
  if (request.domain === "character" || request.domain === "hybrid") (assessment.anatomy as JsonRecord).applies = true;
  contract.qualityBar = complexity;
  contract.minimumSpecDepth = { ...COMPLEXITY_MINIMUMS[complexity] };
  return {
    targetName: request.targetName,
    sourceImage: request.image ?? "",
    preSpecAssessment: assessment,
    qualityContract: contract,
    authoringInstruction: "Fill observed object class, complexity reasoning, featureGroups, visualDeltaChecks, and unknowns before generating or implementing ObjectSculptSpec.",
  };
}
