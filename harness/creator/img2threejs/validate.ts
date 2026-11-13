// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/creator/img2threejs/validate.ts - ObjectSculptSpec validation (CREATOR-IMG2THREEJS, ADR-0562).
// TypeScript port of forge/stage2_spec/validate_sculpt_spec.py from github.com/img2threejs/img2threejs
// (Apache-2.0), reduced to the rules the generator in this repo honors (see ADR-0562 "not ported").
//
// Two kinds of finding, exactly as upstream:
//   errors    - the spec is malformed. Nothing downstream may read it.
//   warnings  - advisory, EXCEPT those prefixed `quality:`. Under `--strict-quality` every quality warning
//               becomes a failure, and the generator refuses (BLOCKED) until the spec is deeper. That is the
//               anti-shallow-spec gate: a spec with one root box and no assessment validates, but it does not
//               generate.
//
// Pure: no I/O, never throws on a bad spec (a non-object spec is reported as an error), deterministic.

import {
  ATTACHMENT_PRIMITIVES, ATTACHMENT_ROLES, DEFAULT_VISUAL_THRESHOLD, DISALLOWED_TOPOLOGY_PRIMITIVE_PAIRS,
  TERMINOLOGY_LIST_FIELDS, TOPOLOGY_ALLOWED_HINT, VALID_COMPLEXITY_TIERS, VALID_COMPONENT_LEVELS,
  VALID_DETAIL_KINDS, VALID_PIPELINE_PASS_IDS, VALID_PRIMITIVES, VALID_REVIEW_ACTIONS, VALID_SUITABILITY,
  VALID_TOPOLOGY_CLASSES, VISUAL_PASS_IDS, arrayAt, isInt, isNonEmptyString, isNumber, isNumberList, isRecord,
  isStringArray, recordAt, str, type JsonRecord,
} from "./contract.ts";

export interface ValidationResult {
  readonly ok: boolean;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  /** Errors plus every `quality:` warning rewritten as a strict failure. Empty means codegen may proceed. */
  readonly strictFailures: readonly string[];
  readonly summary: { readonly targetName: string; readonly suitability: string; readonly components: number; readonly materials: number };
}

const REQUIRED_TOP_LEVEL: Readonly<Record<string, "string" | "object" | "array">> = {
  targetName: "string", suitability: "string", coordinateFrame: "object", silhouette: "object",
  componentTree: "array", materials: "array", proceduralStrategy: "array",
};

const q = (v: unknown): string => JSON.stringify(typeof v === "string" ? v : String(v));

type Sink = { errors: string[]; warnings: string[] };

function stringArray(value: unknown, label: string, s: Sink): void {
  if (value === undefined || value === null) return;
  if (!isStringArray(value)) s.errors.push(`${label} must be an array of strings`);
}
function unitInterval(value: unknown, label: string, s: Sink): void {
  if (!isNumber(value) || value < 0 || value > 1) s.errors.push(`${label} must be a number from 0 to 1`);
}
function nonNegativeInt(value: unknown, label: string, s: Sink): void {
  if (!isInt(value) || value < 0) s.errors.push(`${label} must be a non-negative integer`);
}

// ── assessment, contract, loop ──────────────────────────────────────────────

function validatePreSpecAssessment(spec: JsonRecord, s: Sink): void {
  const assessment = spec.preSpecAssessment;
  if (assessment === undefined || assessment === null) {
    s.warnings.push("quality: missing preSpecAssessment; spec may be shallow because complexity was not assessed first");
    return;
  }
  if (!isRecord(assessment)) { s.errors.push("preSpecAssessment must be an object"); return; }
  const objectClass = assessment.objectClass;
  if (!isRecord(objectClass)) s.errors.push("preSpecAssessment.objectClass must be an object");
  else {
    const primary = objectClass.primaryType;
    if (primary !== undefined && primary !== null && typeof primary !== "string") s.errors.push("preSpecAssessment.objectClass.primaryType must be a string");
    if (primary === undefined || primary === null || primary === "" || primary === "unassessed") s.warnings.push("quality: preSpecAssessment.objectClass.primaryType is unassessed");
    for (const field of ["formLanguage", "structureKind", "motionPotential", "materialFamilies"]) {
      stringArray(objectClass[field], `preSpecAssessment.objectClass.${field}`, s);
      if (Array.isArray(objectClass[field]) && (objectClass[field] as unknown[]).length === 0) s.warnings.push(`quality: preSpecAssessment.objectClass.${field} is empty`);
    }
  }
  const complexity = assessment.complexity;
  if (!isRecord(complexity)) s.errors.push("preSpecAssessment.complexity must be an object");
  else {
    const tier = complexity.tier;
    if (!(VALID_COMPLEXITY_TIERS as readonly unknown[]).includes(tier)) s.errors.push(`preSpecAssessment.complexity.tier must be one of: ${[...VALID_COMPLEXITY_TIERS].sort().join(", ")}`);
    if (tier === "unassessed") s.warnings.push("quality: preSpecAssessment.complexity.tier is unassessed");
    const scores = complexity.scores;
    if (!isRecord(scores)) s.errors.push("preSpecAssessment.complexity.scores must be an object");
    else for (const [key, value] of Object.entries(scores)) if (!isInt(value) || value < 0 || value > 3) s.errors.push(`preSpecAssessment.complexity.scores.${key} must be an integer from 0 to 3`);
    const estimated = complexity.estimatedCounts;
    if (!isRecord(estimated)) s.errors.push("preSpecAssessment.complexity.estimatedCounts must be an object");
    else for (const field of ["macroComponents", "mesoComponents", "microFeatureGroups", "materialLayers", "repetitionSystems"]) if (field in estimated) nonNegativeInt(estimated[field], `preSpecAssessment.complexity.estimatedCounts.${field}`, s);
    stringArray(complexity.reasoning, "preSpecAssessment.complexity.reasoning", s);
  }
  const decision = assessment.specDepthDecision;
  if (!isRecord(decision)) s.errors.push("preSpecAssessment.specDepthDecision must be an object");
  else {
    const depth = decision.requiredDepth;
    if (!(VALID_COMPLEXITY_TIERS as readonly unknown[]).includes(depth)) s.errors.push("preSpecAssessment.specDepthDecision.requiredDepth must be a valid complexity tier");
    if (depth === "unassessed") s.warnings.push("quality: preSpecAssessment.specDepthDecision.requiredDepth is unassessed");
    stringArray(decision.minimumComponentLevels, "preSpecAssessment.specDepthDecision.minimumComponentLevels", s);
    for (const field of ["needsRepetitionSystems", "needsMaterialLocalOverrides", "needsMultipleReviewViews", "needsActionReadyHierarchy"]) {
      if (field in decision && typeof decision[field] !== "boolean") s.errors.push(`preSpecAssessment.specDepthDecision.${field} must be boolean`);
    }
  }
  const unknowns = assessment.unknownsToResolveBeforeImplementation;
  stringArray(unknowns, "preSpecAssessment.unknownsToResolveBeforeImplementation", s);
  if (Array.isArray(unknowns) && unknowns.length > 0) s.warnings.push("quality: preSpecAssessment has unresolved unknowns before implementation");
}

function validateTerminologyProfile(spec: JsonRecord, s: Sink): void {
  const profile = spec.terminologyProfile;
  if (profile === undefined || profile === null) { s.warnings.push("missing terminologyProfile; descriptions may drift into vague non-3D language"); return; }
  if (!isRecord(profile)) { s.errors.push("terminologyProfile must be an object"); return; }
  for (const field of TERMINOLOGY_LIST_FIELDS) {
    const value = profile[field];
    if (value === undefined || value === null) { s.warnings.push(`terminologyProfile.${field} is missing`); continue; }
    if (!Array.isArray(value) || !value.every((item) => isNonEmptyString(item))) s.errors.push(`terminologyProfile.${field} must be an array of non-empty strings`);
  }
  if (profile.descriptionRule !== undefined && typeof profile.descriptionRule !== "string") s.errors.push("terminologyProfile.descriptionRule must be a string");
}

function validateScoreBlock(spec: JsonRecord, s: Sink): void {
  const scores = spec.scores;
  if (scores === undefined || scores === null) { s.warnings.push("missing scores block; image validation evidence will be weaker"); return; }
  if (!isRecord(scores)) { s.errors.push("scores must be an object"); return; }
  for (const [key, value] of Object.entries(scores)) if (!isInt(value) || value < 0 || value > 3) s.errors.push(`score ${q(key)} must be an integer from 0 to 3`);
}

function validateQualityTargets(spec: JsonRecord, s: Sink): void {
  const targets = spec.qualityTargets;
  if (targets === undefined || targets === null) { s.warnings.push("missing qualityTargets; self-correction loop has no explicit fidelity bar"); return; }
  if (!isRecord(targets)) { s.errors.push("qualityTargets must be an object"); return; }
  if (targets.targetFidelity !== undefined && targets.targetFidelity !== null) unitInterval(targets.targetFidelity, "qualityTargets.targetFidelity", s);
  for (const field of ["mustMatch", "niceToHave", "reviewViewpoints"]) stringArray(targets[field], `qualityTargets.${field}`, s);
}

function validateQualityContract(spec: JsonRecord, s: Sink): void {
  const contract = spec.qualityContract;
  if (contract === undefined || contract === null) { s.warnings.push("quality: missing qualityContract; no explicit definition of done prevents shallow specs"); return; }
  if (!isRecord(contract)) { s.errors.push("qualityContract must be an object"); return; }
  const bar = contract.qualityBar;
  if (bar !== undefined && bar !== null && typeof bar !== "string") s.errors.push("qualityContract.qualityBar must be a string");
  if (bar === undefined || bar === null || bar === "" || bar === "unassessed") s.warnings.push("quality: qualityContract.qualityBar is unassessed");
  stringArray(contract.definitionOfDone, "qualityContract.definitionOfDone", s);
  if (Array.isArray(contract.definitionOfDone) && contract.definitionOfDone.length === 0) s.warnings.push("quality: qualityContract.definitionOfDone is empty");
  const minimums = contract.minimumSpecDepth;
  if (!isRecord(minimums)) s.errors.push("qualityContract.minimumSpecDepth must be an object");
  else for (const field of ["macroComponents", "mesoComponents", "microFeatureGroups", "materialLayers", "repetitionSystems", "reviewViewpoints"]) if (field in minimums) nonNegativeInt(minimums[field], `qualityContract.minimumSpecDepth.${field}`, s);
  const groups = contract.featureGroups;
  if (!Array.isArray(groups)) s.errors.push("qualityContract.featureGroups must be an array");
  else {
    if (groups.length < 3) s.warnings.push("quality: qualityContract.featureGroups has fewer than 3 groups; spec may miss important visual layers");
    groups.forEach((group, index) => {
      if (!isRecord(group)) { s.errors.push(`qualityContract.featureGroups[${index}] must be an object`); return; }
      for (const field of ["id", "name"]) if (!isNonEmptyString(group[field])) s.errors.push(`qualityContract.featureGroups[${index}].${field} is required`);
      if ("required" in group && typeof group.required !== "boolean") s.errors.push(`qualityContract.featureGroups[${index}].required must be boolean`);
      for (const field of ["qualityCriteria", "evidenceRefs", "failureModes"]) stringArray(group[field], `qualityContract.featureGroups[${index}].${field}`, s);
      if (group.required === true && !(Array.isArray(group.qualityCriteria) && group.qualityCriteria.length > 0)) s.warnings.push(`quality: required feature group ${q(group.id ?? index)} has no qualityCriteria`);
    });
  }
  for (const field of ["visualDeltaChecks", "antiShallowSpecRules", "mustNotDo"]) {
    stringArray(contract[field], `qualityContract.${field}`, s);
    if (Array.isArray(contract[field]) && (contract[field] as unknown[]).length === 0) s.warnings.push(`quality: qualityContract.${field} is empty`);
  }
}

function validateQualityDepth(spec: JsonRecord, s: Sink): void {
  const contract = spec.qualityContract;
  if (!isRecord(contract) || !isRecord(contract.minimumSpecDepth)) return;
  const minimums = contract.minimumSpecDepth;
  const components = arrayAt(spec, "componentTree").filter(isRecord);
  const targets = spec.qualityTargets;
  const counts: Record<string, number> = {
    macroComponents: components.filter((c) => c.level === "macro").length,
    mesoComponents: components.filter((c) => c.level === "meso").length,
    microFeatureGroups: components.reduce((n, c) => n + (Array.isArray(c.localFeatures) ? c.localFeatures.length : 0), 0),
    materialLayers: arrayAt(spec, "materials").filter(isRecord).length,
    repetitionSystems: arrayAt(spec, "repetitionSystems").filter(isRecord).length,
    reviewViewpoints: isRecord(targets) && Array.isArray(targets.reviewViewpoints) ? targets.reviewViewpoints.length : 0,
  };
  for (const [field, actual] of Object.entries(counts)) {
    const required = minimums[field];
    if (isInt(required) && actual < required) s.warnings.push(`quality: ${field} below qualityContract minimum (${actual} < ${required})`);
  }
}

function validateActionReadiness(spec: JsonRecord, s: Sink): void {
  const readiness = spec.actionReadiness;
  if (readiness === undefined || readiness === null) { s.warnings.push("missing actionReadiness; generated model may not be ready for animation/transformation/destruction"); return; }
  if (!isRecord(readiness)) { s.errors.push("actionReadiness must be an object"); return; }
  for (const field of ["contract", "defaultRigType", "rootMotionNode"]) if (readiness[field] !== undefined && readiness[field] !== null && typeof readiness[field] !== "string") s.errors.push(`actionReadiness.${field} must be a string`);
  for (const field of ["requiredComponentFields", "transformChannels", "authoringRules"]) stringArray(readiness[field], `actionReadiness.${field}`, s);
  if (readiness.destructionPolicy !== undefined && readiness.destructionPolicy !== null && !isRecord(readiness.destructionPolicy)) s.errors.push("actionReadiness.destructionPolicy must be an object");
}

function validateSelfCorrectLoop(spec: JsonRecord, s: Sink): void {
  const loop = spec.selfCorrectLoop;
  if (loop === undefined || loop === null) { s.warnings.push("missing selfCorrectLoop; construction may not review/refine after each pass"); return; }
  if (!isRecord(loop)) { s.errors.push("selfCorrectLoop must be an object"); return; }
  if (loop.enabled !== undefined && typeof loop.enabled !== "boolean") s.errors.push("selfCorrectLoop.enabled must be boolean");
  for (const field of ["reviewAfterPasses", "allowedActions", "specRefineTriggers", "codeRefineTriggers", "stopCriteria"]) stringArray(loop[field], `selfCorrectLoop.${field}`, s);
  if (Array.isArray(loop.allowedActions)) for (const action of loop.allowedActions) if (!(VALID_REVIEW_ACTIONS as readonly unknown[]).includes(action)) s.errors.push(`selfCorrectLoop.allowedActions contains invalid action ${q(action)}`);
  const acceptance = loop.visualAcceptance;
  if (acceptance === undefined || acceptance === null) s.warnings.push("quality: selfCorrectLoop.visualAcceptance is missing; AI vision cannot enforce visual fidelity");
  else if (!isRecord(acceptance)) s.errors.push("selfCorrectLoop.visualAcceptance must be an object");
  else {
    if (acceptance.reviewer !== undefined && typeof acceptance.reviewer !== "string") s.errors.push("selfCorrectLoop.visualAcceptance.reviewer must be a string");
    if (acceptance.threshold === undefined || acceptance.threshold === null) s.warnings.push("quality: selfCorrectLoop.visualAcceptance.threshold is missing");
    else unitInterval(acceptance.threshold, "selfCorrectLoop.visualAcceptance.threshold", s);
    for (const field of ["comparisonArtifactRequired", "layerScoresRequired", "codePixelDiffIsAcceptanceAuthority"]) if (acceptance[field] !== undefined && acceptance[field] !== null && typeof acceptance[field] !== "boolean") s.errors.push(`selfCorrectLoop.visualAcceptance.${field} must be boolean`);
    if (acceptance.scoringRule !== undefined && typeof acceptance.scoringRule !== "string") s.errors.push("selfCorrectLoop.visualAcceptance.scoringRule must be a string");
    stringArray(acceptance.requiredLayerScores, "selfCorrectLoop.visualAcceptance.requiredLayerScores", s);
    const policy = acceptance.featureReviewPolicy;
    if (policy === undefined || policy === null) s.warnings.push("quality: visualAcceptance.featureReviewPolicy is missing");
    else if (!isRecord(policy)) s.errors.push("selfCorrectLoop.visualAcceptance.featureReviewPolicy must be an object");
    else {
      for (const field of ["enabled", "adaptiveEscalation", "singleImagePairOnly"]) if (policy[field] !== undefined && policy[field] !== null && typeof policy[field] !== "boolean") s.errors.push(`selfCorrectLoop.visualAcceptance.featureReviewPolicy.${field} must be boolean`);
      for (const field of ["maxCriticalFeaturesPerPass", "maxImportantFeaturesPerPass"]) if (policy[field] !== undefined && policy[field] !== null) nonNegativeInt(policy[field], `selfCorrectLoop.visualAcceptance.featureReviewPolicy.${field}`, s);
      for (const field of ["criticalDefaultThreshold", "importantAverageThreshold"]) if (policy[field] !== undefined && policy[field] !== null) unitInterval(policy[field], `selfCorrectLoop.visualAcceptance.featureReviewPolicy.${field}`, s);
      for (const field of ["reviewUnit", "selectionRule"]) if (policy[field] !== undefined && policy[field] !== null && typeof policy[field] !== "string") s.errors.push(`selfCorrectLoop.visualAcceptance.featureReviewPolicy.${field} must be a string`);
    }
  }
  const shots = loop.screenshotPolicy;
  if (shots === undefined || shots === null) s.warnings.push("selfCorrectLoop.screenshotPolicy is missing; visual review may drift without screenshots");
  else if (!isRecord(shots)) s.errors.push("selfCorrectLoop.screenshotPolicy must be an object");
  else {
    stringArray(shots.requiredForPasses, "selfCorrectLoop.screenshotPolicy.requiredForPasses", s);
    for (const field of ["preferredCapture", "fallbackCapture", "minimumEvidence", "reviewPairRule", "acceptanceAuthority"]) if (shots[field] !== undefined && shots[field] !== null && typeof shots[field] !== "string") s.errors.push(`selfCorrectLoop.screenshotPolicy.${field} must be a string`);
  }
}

// ── feature review policy (shared with the pass gate) ───────────────────────

export function featureReviewPolicy(spec: JsonRecord): JsonRecord {
  return recordAt(recordAt(spec.selfCorrectLoop, "visualAcceptance"), "featureReviewPolicy");
}

function featureTargetsForPass(spec: JsonRecord, passId: string): JsonRecord[] {
  return arrayAt(spec, "featureReviewTargets").filter(isRecord).filter((t) => Array.isArray(t.passIds) && t.passIds.includes(passId));
}

/** Why a review entry fails the per-feature gate for a pass. Empty means it passes (or the policy is off). */
export function featureGateFailures(spec: JsonRecord, entry: JsonRecord, passId: string): string[] {
  const policy = featureReviewPolicy(spec);
  if (policy.enabled !== true) return [];
  const targets = featureTargetsForPass(spec, passId);
  const critical = targets.filter((t) => t.tier === "critical" || t.mustPass === true);
  const failures: string[] = [];
  const maxCritical = isNumber(policy.maxCriticalFeaturesPerPass) ? policy.maxCriticalFeaturesPerPass : 5;
  if (critical.length > Math.trunc(maxCritical)) failures.push(`pass ${q(passId)} defines ${critical.length} critical features; group them into at most ${Math.trunc(maxCritical)} semantic systems`);
  const important = targets.filter((t) => t.tier === "important");
  const maxImportant = isNumber(policy.maxImportantFeaturesPerPass) ? policy.maxImportantFeaturesPerPass : 3;
  if (important.length > Math.trunc(maxImportant)) failures.push(`pass ${q(passId)} defines ${important.length} important features; keep only the ${Math.trunc(maxImportant)} most uncertain or high-value systems`);
  const reviews = new Map<string, JsonRecord>();
  for (const r of arrayAt(entry, "featureReviews")) if (isRecord(r) && typeof r.id === "string") reviews.set(r.id, r);
  const defaultThreshold = isNumber(policy.criticalDefaultThreshold) ? policy.criticalDefaultThreshold : 0.8;
  for (const target of critical) {
    const id = target.id;
    if (!isNonEmptyString(id)) continue;
    const review = reviews.get(id);
    if (!review) { failures.push(`critical feature ${q(id)} has no AI vision review`); continue; }
    if (review.visible === false) { failures.push(`critical feature ${q(id)} is not visible in the review view`); continue; }
    const score = review.score;
    const minimum = target.minimumScore ?? defaultThreshold;
    if (!isNumber(score)) failures.push(`critical feature ${q(id)} has no numeric score`);
    else if (!isNumber(minimum) || score < minimum) failures.push(`critical feature ${q(id)} score ${score} is below ${String(minimum)}`);
  }
  const importantIds = new Set(important.map((t) => t.id).filter((id): id is string => typeof id === "string"));
  const importantScores = [...reviews.entries()].filter(([id, r]) => importantIds.has(id) && isNumber(r.score)).map(([, r]) => r.score as number);
  const importantThreshold = isNumber(policy.importantAverageThreshold) ? policy.importantAverageThreshold : 0.65;
  if (importantScores.length) {
    const average = importantScores.reduce((a, b) => a + b, 0) / importantScores.length;
    if (average < importantThreshold) failures.push(`reviewed important features average ${average.toFixed(3)} is below ${importantThreshold.toFixed(3)}`);
  }
  return failures;
}

function validateFeatureReviewTargets(spec: JsonRecord, s: Sink): void {
  const targets = spec.featureReviewTargets;
  if (targets === undefined || targets === null) return;
  if (!Array.isArray(targets)) { s.errors.push("featureReviewTargets must be an array"); return; }
  const seen = new Set<string>();
  targets.forEach((t, index) => {
    if (!isRecord(t)) { s.errors.push(`featureReviewTargets[${index}] must be an object`); return; }
    if (!isNonEmptyString(t.id)) s.errors.push(`featureReviewTargets[${index}].id is required`);
    else if (seen.has(t.id)) s.errors.push(`duplicate featureReviewTargets id ${q(t.id)}`);
    else seen.add(t.id);
    if (t.tier !== undefined && !["critical", "important", "optional"].includes(String(t.tier))) s.errors.push(`featureReviewTargets[${index}].tier must be critical, important, or optional`);
    stringArray(t.passIds, `featureReviewTargets[${index}].passIds`, s);
    if (t.minimumScore !== undefined && t.minimumScore !== null) unitInterval(t.minimumScore, `featureReviewTargets[${index}].minimumScore`, s);
  });
}

// ── review history, passes, pipeline ────────────────────────────────────────

function validateVisualEvidenceItem(item: unknown, label: string, s: Sink): void {
  if (!isRecord(item)) { s.errors.push(`${label} must be an object`); return; }
  for (const field of ["renderScreenshot", "comparisonImage", "referenceImage", "capturedBy", "viewName"]) {
    if (item[field] !== undefined && item[field] !== null && typeof item[field] !== "string") s.errors.push(`${label}.${field} must be a string`);
  }
}

function validateFeatureReviews(entry: JsonRecord, label: string, s: Sink): void {
  const reviews = entry.featureReviews;
  if (reviews === undefined || reviews === null) return;
  if (!Array.isArray(reviews)) { s.errors.push(`${label}.featureReviews must be an array`); return; }
  reviews.forEach((r, i) => {
    if (!isRecord(r)) { s.errors.push(`${label}.featureReviews[${i}] must be an object`); return; }
    if (!isNonEmptyString(r.id)) s.errors.push(`${label}.featureReviews[${i}].id is required`);
    if (r.score !== undefined && r.score !== null) unitInterval(r.score, `${label}.featureReviews[${i}].score`, s);
    if (r.visible !== undefined && typeof r.visible !== "boolean") s.errors.push(`${label}.featureReviews[${i}].visible must be boolean`);
  });
}

function validateReviewHistory(spec: JsonRecord, s: Sink): void {
  const history = spec.reviewHistory;
  if (history === undefined || history === null) return;
  if (!Array.isArray(history)) { s.errors.push("reviewHistory must be an array"); return; }
  history.forEach((entry, index) => {
    if (!isRecord(entry)) { s.errors.push(`reviewHistory[${index}] must be an object`); return; }
    const action = entry.action;
    if (action !== undefined && action !== null && !(VALID_REVIEW_ACTIONS as readonly unknown[]).includes(action)) s.errors.push(`reviewHistory[${index}].action is invalid`);
    if (entry.estimatedFidelity !== undefined && entry.estimatedFidelity !== null) unitInterval(entry.estimatedFidelity, `reviewHistory[${index}].estimatedFidelity`, s);
    for (const field of ["matched", "mismatches", "specFixes", "codeFixes", "evidence"]) stringArray(entry[field], `reviewHistory[${index}].${field}`, s);
    const visual = entry.visualEvidence;
    if (visual !== undefined && visual !== null) validateVisualEvidenceItem(visual, `reviewHistory[${index}].visualEvidence`, s);
    validateFeatureReviews(entry, `reviewHistory[${index}]`, s);
    const passId = entry.passId;
    if (typeof passId !== "string" || !VISUAL_PASS_IDS.includes(passId) || action !== "continue") return;
    const v = isRecord(visual) ? visual : {};
    if (!v.renderScreenshot) s.warnings.push(`reviewHistory[${index}] continues visual pass ${q(passId)} without a render screenshot`);
    if (!v.comparisonImage) s.warnings.push(`quality: reviewHistory[${index}] continues visual pass ${q(passId)} without an AI vision comparison image`);
    const score = entry.aiVisionScore;
    const threshold = entry.visualAcceptanceThreshold ?? DEFAULT_VISUAL_THRESHOLD;
    if (!isNumber(score)) s.warnings.push(`quality: reviewHistory[${index}] continues visual pass ${q(passId)} without aiVisionScore`);
    else if (isNumber(threshold) && score < threshold) s.warnings.push(`quality: reviewHistory[${index}] aiVisionScore ${score} is below threshold ${threshold}`);
    const acceptance = recordAt(spec.selfCorrectLoop, "visualAcceptance");
    if (acceptance.layerScoresRequired === true) {
      const layerScores = entry.layerScores;
      if (!isRecord(layerScores) || Object.keys(layerScores).length === 0) s.warnings.push(`quality: reviewHistory[${index}] continues visual pass ${q(passId)} without layerScores`);
      else if (Array.isArray(acceptance.requiredLayerScores)) {
        const missing = acceptance.requiredLayerScores.filter((l): l is string => typeof l === "string" && !(l in layerScores));
        if (missing.length) s.warnings.push(`quality: reviewHistory[${index}] layerScores missing: ${missing.join(", ")}`);
      }
    }
    for (const failure of featureGateFailures(spec, entry, passId)) s.warnings.push(`quality: reviewHistory[${index}] feature gate failed: ${failure}`);
  });
}

function validateVisualEvidenceHistory(spec: JsonRecord, s: Sink): void {
  const history = spec.visualEvidence;
  if (history === undefined || history === null) return;
  if (!Array.isArray(history)) { s.errors.push("visualEvidence must be an array"); return; }
  history.forEach((item, index) => validateVisualEvidenceItem(item, `visualEvidence[${index}]`, s));
}

function validateBuildPasses(spec: JsonRecord, s: Sink): string[] {
  const passes = spec.buildPasses;
  if (passes === undefined || passes === null) { s.warnings.push("quality: missing buildPasses; model construction can skip blockout/structural/material gates"); return []; }
  if (!Array.isArray(passes)) { s.errors.push("buildPasses must be an array"); return []; }
  const ids: string[] = [];
  passes.forEach((item, index) => {
    if (!isRecord(item)) { s.errors.push(`buildPasses[${index}] must be an object`); return; }
    const id = item.id;
    if (!isNonEmptyString(id)) { s.errors.push(`buildPasses[${index}].id is required`); return; }
    if (ids.includes(id)) s.errors.push(`duplicate buildPasses id ${q(id)}`);
    if (!VALID_PIPELINE_PASS_IDS.includes(id)) s.errors.push(`buildPasses[${index}].id ${q(id)} must be one of: ${[...VALID_PIPELINE_PASS_IDS].sort().join(", ")}`);
    ids.push(id);
    if (item.goal !== undefined && item.goal !== null && typeof item.goal !== "string") s.errors.push(`buildPasses[${index}].goal must be a string`);
    stringArray(item.componentRefs, `buildPasses[${index}].componentRefs`, s);
    stringArray(item.acceptance, `buildPasses[${index}].acceptance`, s);
  });
  if (ids.length) {
    if (ids[0] !== "blockout") s.warnings.push("quality: first build pass should be blockout");
    if (!ids.includes("structural-pass")) s.warnings.push("quality: missing structural-pass; component hierarchy may be skipped");
    if (!ids.includes("material-pass") && !ids.includes("surface-pass")) s.warnings.push("quality: missing material/surface pass; model may stay as flat geometry");
  }
  return ids;
}

/** Does this review entry complete `passId`? Visual passes need a screenshot, a comparison image, a score
 *  at or above the threshold, and no feature-gate failure. Shared with passes.ts. */
export function reviewCompletesPass(spec: JsonRecord, entry: JsonRecord, passId: string): boolean {
  if (entry.passId !== passId || entry.action !== "continue") return false;
  if (!VISUAL_PASS_IDS.includes(passId)) return true;
  const visual = entry.visualEvidence;
  if (!isRecord(visual) || !visual.renderScreenshot || !visual.comparisonImage) return false;
  const score = entry.aiVisionScore;
  const threshold = entry.visualAcceptanceThreshold ?? DEFAULT_VISUAL_THRESHOLD;
  if (!isNumber(score) || !isNumber(threshold) || score < threshold) return false;
  return featureGateFailures(spec, entry, passId).length === 0;
}

/** The leading run of passes completed in order. Stops at the first pass without a completing review. */
export function completedPassesFromHistory(spec: JsonRecord, passIds: readonly string[]): string[] {
  const history = arrayAt(spec, "reviewHistory").filter(isRecord);
  const completed: string[] = [];
  for (const passId of passIds) {
    if (history.some((entry) => reviewCompletesPass(spec, entry, passId))) completed.push(passId);
    else break;
  }
  return completed;
}

function validateSculptPipeline(spec: JsonRecord, buildPassIds: string[], s: Sink): void {
  const pipeline = spec.sculptPipeline;
  if (pipeline === undefined || pipeline === null) { s.warnings.push("quality: missing sculptPipeline; pass order is not locked and generation can skip build passes"); return; }
  if (!isRecord(pipeline)) { s.errors.push("sculptPipeline must be an object"); return; }
  let orderIds = buildPassIds;
  const order = pipeline.passOrder;
  if (order === undefined || order === null) s.warnings.push("quality: sculptPipeline.passOrder is missing");
  else {
    stringArray(order, "sculptPipeline.passOrder", s);
    if (Array.isArray(order)) {
      orderIds = order.map(String);
      orderIds.forEach((id, index) => { if (!VALID_PIPELINE_PASS_IDS.includes(id)) s.errors.push(`sculptPipeline.passOrder[${index}] ${q(id)} must be one of: ${[...VALID_PIPELINE_PASS_IDS].sort().join(", ")}`); });
    }
  }
  if (buildPassIds.length && orderIds.length && JSON.stringify(orderIds) !== JSON.stringify(buildPassIds)) s.warnings.push("sculptPipeline.passOrder differs from buildPasses order; sync the pipeline before generation");
  const known = orderIds.length ? orderIds : buildPassIds;
  const current = pipeline.currentPass;
  if (current !== undefined && current !== null && current !== "complete" && !known.includes(String(current))) s.errors.push("sculptPipeline.currentPass must be a known build pass or complete");
  const completed = pipeline.completedPasses ?? [];
  stringArray(completed, "sculptPipeline.completedPasses", s);
  if (Array.isArray(completed)) {
    const expected = completedPassesFromHistory(spec, known);
    if (JSON.stringify(completed) !== JSON.stringify(expected)) s.warnings.push("sculptPipeline.completedPasses is out of sync with reviewHistory; run img2threejs_state sync");
    for (const id of completed) if (!known.includes(String(id))) s.errors.push(`sculptPipeline.completedPasses contains unknown pass ${q(id)}`);
  }
  if (pipeline.passGateMode !== "locked-sequential") s.warnings.push("quality: sculptPipeline.passGateMode should be locked-sequential");
  stringArray(pipeline.nextRequiredEvidence, "sculptPipeline.nextRequiredEvidence", s);
}

// ── evidence and materials ──────────────────────────────────────────────────

function validateEvidence(spec: JsonRecord, s: Sink): Set<string> {
  const refs = new Set<string>();
  const evidence = spec.viewEvidence;
  if (evidence === undefined || evidence === null) return refs;
  if (!Array.isArray(evidence)) { s.errors.push("viewEvidence must be an array when present"); return refs; }
  evidence.forEach((item, index) => {
    if (!isRecord(item)) { s.errors.push(`viewEvidence[${index}] must be an object`); return; }
    const id = item.id;
    if (!isNonEmptyString(id)) { s.errors.push(`viewEvidence[${index}].id is required`); return; }
    if (refs.has(id)) s.errors.push(`duplicate viewEvidence id ${q(id)}`);
    refs.add(id);
    if (item.confidence !== undefined && item.confidence !== null) unitInterval(item.confidence, `viewEvidence ${q(id)} confidence`, s);
    const region = item.imageRegion;
    if (region !== undefined && region !== null) {
      if (!isRecord(region)) s.errors.push(`viewEvidence ${q(id)} imageRegion must be an object`);
      else for (const key of ["x", "y", "width", "height"]) if (key in region && !isNumber(region[key])) s.errors.push(`viewEvidence ${q(id)} imageRegion.${key} must be numeric`);
    }
  });
  if (refs.size === 0) s.warnings.push("missing viewEvidence; local visual claims cannot be traced back to image regions");
  return refs;
}

function scalarOrLayer(value: unknown, label: string, s: Sink): void {
  if (value === undefined || value === null) return;
  if (isNumber(value)) { if (value < 0 || value > 1) s.errors.push(`${label} must be from 0 to 1`); return; }
  if (!isRecord(value)) { s.errors.push(`${label} must be a number or an object`); return; }
  for (const key of ["base", "variation", "min", "max"]) if (key in value && !isNumber(value[key])) s.errors.push(`${label}.${key} must be numeric`);
}

const isHexColor = (v: unknown): boolean => typeof v === "string" && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v);

function validateMaterials(spec: JsonRecord, s: Sink): Set<string> {
  const ids = new Set<string>();
  arrayAt(spec, "materials").forEach((material, index) => {
    if (!isRecord(material)) { s.errors.push(`materials[${index}] must be an object`); return; }
    const id = material.id;
    if (!isNonEmptyString(id)) { s.errors.push(`materials[${index}].id is required`); return; }
    if (ids.has(id)) s.errors.push(`duplicate material id ${q(id)}`);
    ids.add(id);
    const color = material.baseColor ?? material.color;
    if (color !== undefined && color !== null && !isHexColor(color)) s.errors.push(`material ${q(id)} baseColor/color should be #RGB or #RRGGBB`);
    for (const field of ["shaderModel", "type"]) if (material[field] !== undefined && material[field] !== null && typeof material[field] !== "string") s.errors.push(`material ${q(id)} ${field} must be a string`);
    if (material.doubleSided !== undefined && material.doubleSided !== null && typeof material.doubleSided !== "boolean") s.errors.push(`material ${q(id)} doubleSided must be boolean`);
    for (const field of ["albedo", "ambientOcclusion", "normal", "bump", "displacement", "wear", "dirt"]) if (material[field] !== undefined && material[field] !== null && !isRecord(material[field])) s.errors.push(`material ${q(id)} ${field} must be an object`);
    scalarOrLayer(material.roughness, `material ${q(id)} roughness`, s);
    scalarOrLayer(material.metalness, `material ${q(id)} metalness`, s);
    for (const field of ["clearcoat", "clearcoatRoughness", "transmission", "sheen", "opacity"]) scalarOrLayer(material[field], `material ${q(id)} ${field}`, s);
    const res = material.textureResolution;
    if (res !== undefined && res !== null && (!isInt(res) || res < 64 || res > 4096)) s.errors.push(`material ${q(id)} textureResolution must be an integer from 64 to 4096`);
    const overrides = material.localOverrides;
    if (overrides !== undefined && overrides !== null) {
      if (!Array.isArray(overrides)) s.errors.push(`material ${q(id)} localOverrides must be an array`);
      else overrides.forEach((o, i) => { if (!isRecord(o) || !isNonEmptyString(o.id)) s.errors.push(`material ${q(id)} localOverrides[${i}] must be an object with an id`); });
    }
    stringArray(material.shaderNotes, `material ${q(id)} shaderNotes`, s);
    if (material.emissive !== undefined && material.emissive !== null && !isHexColor(material.emissive)) s.errors.push(`material ${q(id)} emissive should be #RGB or #RRGGBB`);
  });
  if (ids.size === 0) s.errors.push("at least one material is required");
  return ids;
}

// ── components ──────────────────────────────────────────────────────────────

function validateDimensions(id: string, dimensions: unknown, s: Sink): void {
  if (dimensions === undefined || dimensions === null) return;
  if (!isRecord(dimensions)) { s.errors.push(`component ${q(id)} dimensions must be an object`); return; }
  for (const field of ["width", "height", "depth", "radius", "length"]) if (field in dimensions && !isNumber(dimensions[field])) s.errors.push(`component ${q(id)} dimensions.${field} must be numeric`);
  if (dimensions.confidence !== undefined && dimensions.confidence !== null) unitInterval(dimensions.confidence, `component ${q(id)} dimensions.confidence`, s);
}

const point2List = (v: unknown): boolean => Array.isArray(v) && v.length >= 3 && v.every((p) => isNumberList(p, 2));
const point3List = (v: unknown, min: number): boolean => Array.isArray(v) && v.length >= min && v.every((p) => isNumberList(p, 3));

function validateGeometryDescriptor(id: string, descriptor: unknown, s: Sink): void {
  if (descriptor === undefined || descriptor === null) return;
  if (!isRecord(descriptor)) { s.errors.push(`component ${q(id)} geometryDescriptor must be an object`); return; }
  for (const field of ["topologyIntent", "uvStrategy", "normalStrategy"]) if (descriptor[field] !== undefined && descriptor[field] !== null && typeof descriptor[field] !== "string") s.errors.push(`component ${q(id)} geometryDescriptor.${field} must be a string`);
  const edge = descriptor.edgeTreatment;
  if (edge !== undefined && edge !== null) {
    if (!isRecord(edge)) s.errors.push(`component ${q(id)} geometryDescriptor.edgeTreatment must be an object`);
    else {
      if ("bevelRadius" in edge && !isNumber(edge.bevelRadius)) s.errors.push(`component ${q(id)} edgeTreatment.bevelRadius must be numeric`);
      if ("segments" in edge && !isInt(edge.segments)) s.errors.push(`component ${q(id)} edgeTreatment.segments must be an integer`);
    }
  }
  if (descriptor.deformationStack !== undefined && descriptor.deformationStack !== null && !Array.isArray(descriptor.deformationStack)) s.errors.push(`component ${q(id)} geometryDescriptor.deformationStack must be an array`);
  if (descriptor.torusTubeRatio !== undefined && (!isNumber(descriptor.torusTubeRatio) || descriptor.torusTubeRatio <= 0 || descriptor.torusTubeRatio >= 1)) s.errors.push(`component ${q(id)} geometryDescriptor.torusTubeRatio must be a number between 0 and 1`);
  const profile = descriptor.profile2D;
  if (profile !== undefined && profile !== null && (!isRecord(profile) || !point2List(profile.points) || (profile.depth !== undefined && (!isNumber(profile.depth) || profile.depth <= 0)))) s.errors.push(`component ${q(id)} geometryDescriptor.profile2D needs points [[x,y],...] (3 or more) and a positive depth`);
  const lathe = descriptor.latheProfile;
  if (lathe !== undefined && lathe !== null && (!isRecord(lathe) || !point2List(lathe.points) || (lathe.segments !== undefined && (!isInt(lathe.segments) || lathe.segments < 3)))) s.errors.push(`component ${q(id)} geometryDescriptor.latheProfile needs points [[radius,y],...] (3 or more) and segments >= 3`);
  const tube = descriptor.tubePath;
  if (tube !== undefined && tube !== null && (!isRecord(tube) || !point3List(tube.points, 2) || (tube.radius !== undefined && (!isNumber(tube.radius) || tube.radius <= 0)))) s.errors.push(`component ${q(id)} geometryDescriptor.tubePath needs points [[x,y,z],...] (2 or more) and a positive radius`);
  for (const key of ["curveSweep", "taperedSweep"]) {
    const sweep = descriptor[key];
    if (sweep === undefined || sweep === null) continue;
    if (!isRecord(sweep) || !point3List(sweep.path, 2)) { s.errors.push(`component ${q(id)} geometryDescriptor.${key} needs path [[x,y,z],...] (2 or more)`); continue; }
    for (const r of ["radius", "baseRadius", "endRadius"]) if (sweep[r] !== undefined && (!isNumber(sweep[r]) || (sweep[r] as number) < 0)) s.errors.push(`component ${q(id)} geometryDescriptor.${key}.${r} must be a non-negative number`);
  }
  const blade = descriptor.bladeSpec;
  if (blade !== undefined && blade !== null && (!isRecord(blade) || !point2List(blade.profile) || (blade.thickness !== undefined && (!isNumber(blade.thickness) || blade.thickness <= 0)))) s.errors.push(`component ${q(id)} geometryDescriptor.bladeSpec needs profile [[x,y],...] (3 or more) and a positive thickness`);
  const base = descriptor.basePrimitive;
  if (base !== undefined && base !== null && (!(VALID_PRIMITIVES as readonly unknown[]).includes(base) || base === "instanced-cluster")) s.errors.push(`component ${q(id)} geometryDescriptor.basePrimitive must be a non-cluster primitive`);
  if ("sdf" in descriptor && "visualHull" in descriptor) s.errors.push(`component ${q(id)} geometryDescriptor cannot combine sdf and visualHull`);
}

function validateActionProfile(id: string, profile: unknown, s: Sink): void {
  if (profile === undefined || profile === null) { s.warnings.push(`component ${q(id)} is missing actionProfile; future animation/destruction may require refactor`); return; }
  if (!isRecord(profile)) { s.errors.push(`component ${q(id)} actionProfile must be an object`); return; }
  if (profile.animationRole !== undefined && profile.animationRole !== null && typeof profile.animationRole !== "string") s.errors.push(`component ${q(id)} actionProfile.animationRole must be a string`);
  const pivot = profile.pivot;
  if (pivot !== undefined && pivot !== null) {
    if (!isRecord(pivot)) s.errors.push(`component ${q(id)} actionProfile.pivot must be an object`);
    else {
      if (pivot.mode !== undefined && pivot.mode !== null && typeof pivot.mode !== "string") s.errors.push(`component ${q(id)} actionProfile.pivot.mode must be a string`);
      for (const field of ["localPosition", "axis"]) if (field in pivot && !isNumberList(pivot[field], 3)) s.errors.push(`component ${q(id)} actionProfile.pivot.${field} must be [number, number, number]`);
      if (pivot.confidence !== undefined && pivot.confidence !== null) unitInterval(pivot.confidence, `component ${q(id)} actionProfile.pivot.confidence`, s);
    }
  }
  const channels = profile.transformChannels;
  if (channels !== undefined && channels !== null) {
    if (!isRecord(channels)) s.errors.push(`component ${q(id)} actionProfile.transformChannels must be an object`);
    else for (const [k, v] of Object.entries(channels)) if (typeof v !== "boolean") s.errors.push(`component ${q(id)} actionProfile.transformChannels.${k} must be boolean`);
  }
  const sockets = profile.sockets;
  if (sockets !== undefined && sockets !== null) {
    if (!Array.isArray(sockets)) s.errors.push(`component ${q(id)} actionProfile.sockets must be an array`);
    else sockets.forEach((socket, i) => {
      if (!isRecord(socket)) { s.errors.push(`component ${q(id)} actionProfile.sockets[${i}] must be an object`); return; }
      if (socket.id !== undefined && socket.id !== null && typeof socket.id !== "string") s.errors.push(`component ${q(id)} actionProfile.sockets[${i}].id must be a string`);
      for (const field of ["localPosition", "position", "localRotation", "rotation"]) if (field in socket && !isNumberList(socket[field], 3)) s.errors.push(`component ${q(id)} actionProfile.sockets[${i}].${field} must be [number, number, number]`);
    });
  }
  const collider = profile.collider;
  if (collider !== undefined && collider !== null) {
    if (!isRecord(collider)) s.errors.push(`component ${q(id)} actionProfile.collider must be an object`);
    else {
      if (collider.type !== undefined && collider.type !== null && typeof collider.type !== "string") s.errors.push(`component ${q(id)} actionProfile.collider.type must be a string`);
      for (const field of ["offset", "scale"]) if (field in collider && !isNumberList(collider[field], 3)) s.errors.push(`component ${q(id)} actionProfile.collider.${field} must be [number, number, number]`);
      if ("isTrigger" in collider && typeof collider.isTrigger !== "boolean") s.errors.push(`component ${q(id)} actionProfile.collider.isTrigger must be boolean`);
    }
  }
  if (profile.constraints !== undefined && profile.constraints !== null && !Array.isArray(profile.constraints)) s.errors.push(`component ${q(id)} actionProfile.constraints must be an array`);
  const destruction = profile.destruction;
  if (destruction !== undefined && destruction !== null) {
    if (!isRecord(destruction)) s.errors.push(`component ${q(id)} actionProfile.destruction must be an object`);
    else {
      if ("breakable" in destruction && typeof destruction.breakable !== "boolean") s.errors.push(`component ${q(id)} actionProfile.destruction.breakable must be boolean`);
      if ("breakImpulse" in destruction && !isNumber(destruction.breakImpulse)) s.errors.push(`component ${q(id)} actionProfile.destruction.breakImpulse must be numeric`);
      for (const field of ["fractureGroup", "debrisMaterial"]) if (destruction[field] !== undefined && destruction[field] !== null && typeof destruction[field] !== "string") s.errors.push(`component ${q(id)} actionProfile.destruction.${field} must be a string`);
      for (const field of ["seamRefs", "detachableFragments"]) stringArray(destruction[field], `component ${q(id)} actionProfile.destruction.${field}`, s);
    }
  }
}

/** A child whose role, animation role, name token or primitive says "I hang off my parent" must say where. */
export function componentRequiresAttachment(component: JsonRecord): boolean {
  if (!component.parent) return false;
  const role = str(component.role).toLowerCase();
  const name = str(component.name, str(component.id)).toLowerCase();
  const primitive = str(component.primitive).toLowerCase();
  const animationRole = str(recordAt(component, "actionProfile").animationRole).toLowerCase();
  const tokens = new Set<string>([role, animationRole, ...(name.match(/[a-z0-9]+/g) ?? [])]);
  return ATTACHMENT_ROLES.some((r) => tokens.has(r)) || ATTACHMENT_PRIMITIVES.includes(primitive);
}

function attachmentIsComplete(a: JsonRecord): boolean {
  const hasEndpoint = isNumberList(a.localStart, 3) && isNumberList(a.localEnd, 3);
  const hasSocket = isNonEmptyString(a.parentSocket) || isNonEmptyString(a.parentId);
  const hasContact = isNonEmptyString(a.contactType);
  const hasOverlap = (isNumber(a.embedDepth) && a.embedDepth > 0) || (isNumber(a.overlap) && a.overlap > 0);
  const hasTolerance = isNumber(a.gapTolerance);
  return hasEndpoint && hasSocket && hasContact && hasOverlap && hasTolerance;
}

function validateAttachment(id: string, parent: string | null, attachment: unknown, required: boolean, s: Sink): void {
  const requirement = `quality: component ${q(id)} requires attachment.parentSocket, localStart/localEnd, contactType, embedDepth or overlap, and gapTolerance`;
  if (attachment === undefined || attachment === null) { if (required) s.warnings.push(requirement); return; }
  if (!isRecord(attachment)) { s.errors.push(`component ${q(id)} attachment must be an object`); return; }
  for (const field of ["parentId", "parentSocket", "contactType"]) if (attachment[field] !== undefined && attachment[field] !== null && typeof attachment[field] !== "string") s.errors.push(`component ${q(id)} attachment.${field} must be a string`);
  if (parent && typeof attachment.parentId === "string" && attachment.parentId !== parent) s.warnings.push(`quality: component ${q(id)} attachment.parentId ${q(attachment.parentId)} does not match parent ${q(parent)}`);
  for (const field of ["localStart", "localEnd", "contactNormal"]) if (attachment[field] !== undefined && attachment[field] !== null && !isNumberList(attachment[field], 3)) s.errors.push(`component ${q(id)} attachment.${field} must be [number, number, number]`);
  for (const field of ["embedDepth", "overlap", "gapTolerance", "baseRadius", "endRadius"]) {
    const v = attachment[field];
    if (v !== undefined && v !== null && (!isNumber(v) || v < 0)) s.errors.push(`component ${q(id)} attachment.${field} must be a non-negative number`);
  }
  stringArray(attachment.evidenceRefs, `component ${q(id)} attachment.evidenceRefs`, s);
  if (required && !attachmentIsComplete(attachment)) s.warnings.push(requirement);
}

function validateComponents(spec: JsonRecord, materialIds: Set<string>, evidenceIds: Set<string>, s: Sink): void {
  const ids = new Set<string>();
  const parentRefs: [string, string][] = [];
  arrayAt(spec, "componentTree").forEach((component, index) => {
    if (!isRecord(component)) { s.errors.push(`componentTree[${index}] must be an object`); return; }
    const id = component.id;
    if (!isNonEmptyString(id)) { s.errors.push(`componentTree[${index}].id is required`); return; }
    if (ids.has(id)) s.errors.push(`duplicate component id ${q(id)}`);
    ids.add(id);
    const primitive = component.primitive;
    if (!(VALID_PRIMITIVES as readonly unknown[]).includes(primitive)) s.errors.push(`component ${q(id)} primitive must be one of: ${[...VALID_PRIMITIVES].sort().join(", ")}`);
    const topology = component.topologyClass;
    if (topology !== undefined && topology !== null) {
      if (!(VALID_TOPOLOGY_CLASSES as readonly unknown[]).includes(topology)) s.warnings.push(`quality: component ${q(id)} missing or invalid topologyClass (must be one of: ${[...VALID_TOPOLOGY_CLASSES].sort().join(", ")})`);
      else {
        const rationale = component.topologyRationale;
        if (!isNonEmptyString(rationale)) s.warnings.push(`quality: component ${q(id)} topologyRationale is required alongside topologyClass`);
        else if (rationale.trim().toLowerCase().replace(/[\s_-]+/g, "") === String(topology).toLowerCase().replace(/[\s_-]+/g, "")) s.warnings.push(`quality: component ${q(id)} topologyRationale restates the enum value instead of citing visible evidence`);
        const disallowed = DISALLOWED_TOPOLOGY_PRIMITIVE_PAIRS[String(topology)] ?? [];
        if (typeof primitive === "string" && disallowed.includes(primitive)) s.warnings.push(`quality: component ${q(id)} pairs topologyClass=${q(topology)} with disallowed primitive ${q(primitive)} (use ${TOPOLOGY_ALLOWED_HINT[String(topology)] ?? "an allowed primitive"} instead)`);
        if (topology === "implicit" && !("sdf" in recordAt(component, "geometryDescriptor"))) s.errors.push(`component ${q(id)} topologyClass 'implicit' requires geometryDescriptor.sdf`);
      }
    }
    const level = component.level;
    if (level !== undefined && level !== null && !(VALID_COMPONENT_LEVELS as readonly unknown[]).includes(level)) s.errors.push(`component ${q(id)} level must be macro, meso, or micro`);
    for (const field of ["importance", "confidence"]) if (component[field] !== undefined && component[field] !== null) unitInterval(component[field], `component ${q(id)} ${field}`, s);
    const parent = component.parent;
    if (parent) {
      if (typeof parent !== "string") s.errors.push(`component ${q(id)} parent must be a string or null`);
      else parentRefs.push([id, parent]);
    }
    const material = component.material;
    if (material && !materialIds.has(String(material))) s.errors.push(`component ${q(id)} references unknown material ${q(material)}`);
    validateGeometryDescriptor(id, component.geometryDescriptor, s);
    const layers = component.materialLayers;
    if (layers !== undefined && layers !== null) {
      stringArray(layers, `component ${q(id)} materialLayers`, s);
      if (isStringArray(layers)) for (const l of layers) if (!materialIds.has(l)) s.errors.push(`component ${q(id)} materialLayers references unknown material ${q(l)}`);
    }
    validateDimensions(id, component.dimensions, s);
    const transform = component.transform;
    if (transform !== undefined && transform !== null) {
      if (!isRecord(transform)) s.errors.push(`component ${q(id)} transform must be an object`);
      else for (const field of ["position", "rotation", "scale"]) if (field in transform && !isNumberList(transform[field], 3)) s.errors.push(`component ${q(id)} transform.${field} must be [number, number, number]`);
    }
    validateActionProfile(id, component.actionProfile, s);
    validateAttachment(id, typeof parent === "string" ? parent : null, component.attachment, componentRequiresAttachment(component), s);
    for (const field of ["deformations", "joints", "seams", "localFeatures"]) if (component[field] !== undefined && component[field] !== null && !Array.isArray(component[field])) s.errors.push(`component ${q(id)} ${field} must be an array`);
    const surface = component.surfaceDetail;
    if (surface !== undefined && surface !== null) {
      if (!isRecord(surface)) s.errors.push(`component ${q(id)} surfaceDetail must be an object`);
      else for (const field of ["macroRoughness", "microRoughness", "bumpAmplitude"]) if (field in surface && !isNumber(surface[field])) s.errors.push(`component ${q(id)} surfaceDetail.${field} must be numeric`);
    }
    const refs = component.evidenceRefs;
    if (refs !== undefined && refs !== null) {
      stringArray(refs, `component ${q(id)} evidenceRefs`, s);
      if (isStringArray(refs) && evidenceIds.size) for (const r of refs) if (!evidenceIds.has(r)) s.errors.push(`component ${q(id)} references missing evidence ${q(r)}`);
    }
  });
  for (const [id, parent] of parentRefs) if (!ids.has(parent)) s.errors.push(`component ${q(id)} references missing parent ${q(parent)}`);
  // A parent chain that loops has no root to hang from. Each loop is reported once, by its members.
  const parentOf = new Map(parentRefs);
  const looped = new Set<string>();
  for (const [start] of parentRefs) {
    const chain: string[] = [];
    let at: string | undefined = start;
    while (at !== undefined && !chain.includes(at) && !looped.has(at)) { chain.push(at); at = parentOf.get(at); }
    if (at === undefined || looped.has(at)) continue;
    const loop = chain.slice(chain.indexOf(at));
    for (const member of loop) looped.add(member);
    s.errors.push(`component parent chain loops: ${[...loop, at].map(q).join(" -> ")}`);
  }
  if (ids.size === 0) s.errors.push("at least one component is required");
  if (ids.size === 1) s.warnings.push("only one component found; this is likely still blockout quality");
}

function validateRepetitionSystems(spec: JsonRecord, materialIds: Set<string>, componentIds: Set<string>, s: Sink): void {
  const systems = spec.repetitionSystems;
  if (systems === undefined || systems === null) return;
  if (!Array.isArray(systems)) { s.errors.push("repetitionSystems must be an array"); return; }
  const seen = new Set<string>();
  systems.forEach((system, index) => {
    if (!isRecord(system)) { s.errors.push(`repetitionSystems[${index}] must be an object`); return; }
    const id = system.id;
    if (!isNonEmptyString(id)) s.errors.push(`repetitionSystems[${index}].id is required`);
    else if (seen.has(id)) s.errors.push(`duplicate repetitionSystems id ${q(id)}`);
    else seen.add(id);
    const label = `repetitionSystems[${index}]`;
    if (system.count !== undefined && (!isInt(system.count) || system.count < 0)) s.errors.push(`${label}.count must be a non-negative integer`);
    if (system.primitive !== undefined && (!(VALID_PRIMITIVES as readonly unknown[]).includes(system.primitive) || system.primitive === "instanced-cluster")) s.errors.push(`${label}.primitive must be a non-cluster primitive`);
    if (system.level !== undefined && !(VALID_COMPONENT_LEVELS as readonly unknown[]).includes(system.level)) s.errors.push(`${label}.level must be macro, meso, or micro`);
    if (system.material !== undefined && system.material !== null && !materialIds.has(String(system.material))) s.errors.push(`${label} references unknown material ${q(system.material)}`);
    if (system.parent !== undefined && system.parent !== null && system.parent !== "root" && !componentIds.has(String(system.parent))) s.errors.push(`${label} references unknown parent ${q(system.parent)}`);
    if (system.instanceScale !== undefined && !isNumberList(system.instanceScale, 3)) s.errors.push(`${label}.instanceScale must be [number, number, number]`);
    const placement = system.placement;
    if (placement !== undefined && placement !== null) {
      if (!isRecord(placement)) s.errors.push(`${label}.placement must be an object`);
      else {
        if (placement.mode !== undefined && !["radial", "linear", "grid"].includes(String(placement.mode))) s.errors.push(`${label}.placement.mode must be radial, linear, or grid`);
        for (const field of ["axis", "start", "step", "origin"]) if (field in placement && !isNumberList(placement[field], 3)) s.errors.push(`${label}.placement.${field} must be [number, number, number]`);
        for (const field of ["radius", "startAngleDeg", "spacing"]) if (field in placement && !isNumber(placement[field])) s.errors.push(`${label}.placement.${field} must be numeric`);
        if ("columns" in placement && (!isInt(placement.columns) || placement.columns < 1)) s.errors.push(`${label}.placement.columns must be a positive integer`);
      }
    }
  });
}

// ── detail inventory ────────────────────────────────────────────────────────

function detailLinkKeys(spec: JsonRecord): Set<string> {
  const keys = new Set<string>();
  for (const comp of arrayAt(spec, "componentTree").filter(isRecord)) {
    const cid = comp.id;
    if (typeof cid === "string") keys.add(cid);
    for (const feat of arrayAt(comp, "localFeatures")) {
      const fid = typeof feat === "string" ? feat : isRecord(feat) && typeof feat.id === "string" ? feat.id : null;
      if (fid === null) continue;
      keys.add(fid);
      if (typeof cid === "string") keys.add(`${cid}/${fid}`);
    }
  }
  for (const mat of arrayAt(spec, "materials").filter(isRecord)) {
    const mid = mat.id;
    if (typeof mid === "string") keys.add(mid);
    for (const over of arrayAt(mat, "localOverrides")) {
      if (!isRecord(over) || typeof over.id !== "string") continue;
      keys.add(over.id);
      if (typeof mid === "string") keys.add(`${mid}/${over.id}`);
    }
  }
  return keys;
}

const layerBase = (v: unknown): number | null => (isNumber(v) ? v : isRecord(v) && isNumber(v.base) ? v.base : null);

function hasGlossResponse(spec: JsonRecord): boolean {
  for (const mat of arrayAt(spec, "materials").filter(isRecord)) {
    const rough = layerBase(mat.roughness);
    if (rough !== null && rough < 0.35) return true;
    if (isNumber(mat.clearcoat) || isRecord(mat.clearcoat)) return true;
    for (const over of arrayAt(mat, "localOverrides")) if (isRecord(over) && isNumber(over.roughness) && over.roughness < 0.3) return true;
  }
  return false;
}

function hasRepetitionOrSmallParts(spec: JsonRecord): boolean {
  for (const rep of arrayAt(spec, "repetitionSystems").filter(isRecord)) {
    if (rep.realization === "map-only" || rep.buildsGeometry === false) continue;
    if (rep.geometry !== undefined || rep.instances !== undefined || rep.buildsGeometry === true || isInt(rep.count)) return true;
  }
  return arrayAt(spec, "componentTree").some((c) => isRecord(c) && c.level === "micro");
}

function validateDetailInventory(spec: JsonRecord, s: Sink): void {
  const assessment = spec.preSpecAssessment;
  if (!isRecord(assessment)) return;
  const inv = assessment.detailInventory;
  if (!isRecord(inv)) return;
  const details = inv.details ?? [];
  if (!Array.isArray(details)) { s.errors.push("preSpecAssessment.detailInventory.details must be an array"); return; }
  const target = inv.targetMinDetails ?? 0;
  if (!isInt(target) || target <= 0) return;
  if (details.length < target) s.warnings.push(`quality: detailInventory has ${details.length} details but targetMinDetails is ${target}; enumerate identity-defining details (gloss, bevel, fasteners, linework, stains) before code generation`);
  const links = detailLinkKeys(spec);
  let hasGloss = false;
  let hasFastener = false;
  details.forEach((detail, index) => {
    if (!isRecord(detail)) { s.errors.push(`detailInventory.details[${index}] must be an object`); return; }
    const did = detail.id ?? index;
    const kind = detail.kind;
    if (typeof kind !== "string" || !VALID_DETAIL_KINDS.includes(kind)) s.warnings.push(`quality: detailInventory detail ${q(did)} has unknown kind ${q(kind)}`);
    const ref = recordAt(detail, "mapsTo").ref;
    if (!(typeof ref === "string" && links.has(ref))) s.warnings.push(`quality: detailInventory detail ${q(did)} does not map to a component.localFeatures or material.localOverrides entry (no prose-only details)`);
    if (kind === "gloss") hasGloss = true;
    else if (kind === "fastener") hasFastener = true;
  });
  if (hasGloss && !hasGlossResponse(spec)) s.warnings.push("quality: detailInventory lists a gloss detail but no material provides low roughness or clearcoat response");
  if (hasFastener && !hasRepetitionOrSmallParts(spec)) s.warnings.push("quality: detailInventory lists fastener details but no repetitionSystem/instancing or micro parts represent them");
}

// ── entry point ─────────────────────────────────────────────────────────────

/** Rewrite the `quality:` warnings as strict failures and prepend the errors. */
export function strictFailures(errors: readonly string[], warnings: readonly string[]): string[] {
  return [...errors, ...warnings.filter((w) => w.startsWith("quality:")).map((w) => `strict quality failure: ${w.slice("quality:".length).trim()}`)];
}

/** Validate an ObjectSculptSpec. Never throws: a non-object is one error. */
export function validateSpec(input: unknown): ValidationResult {
  const s: Sink = { errors: [], warnings: [] };
  if (!isRecord(input)) {
    s.errors.push("spec must be a JSON object");
    return { ok: false, errors: s.errors, warnings: s.warnings, strictFailures: strictFailures(s.errors, s.warnings), summary: { targetName: "", suitability: "", components: 0, materials: 0 } };
  }
  const spec = input;
  for (const [key, kind] of Object.entries(REQUIRED_TOP_LEVEL)) {
    if (!(key in spec)) { s.errors.push(`missing top-level field ${q(key)}`); continue; }
    const v = spec[key];
    const okType = kind === "string" ? typeof v === "string" : kind === "array" ? Array.isArray(v) : isRecord(v);
    if (!okType) s.errors.push(`field ${q(key)} must be ${kind === "object" ? "dict" : kind === "array" ? "list" : "str"}`);
  }
  if (!(VALID_SUITABILITY as readonly unknown[]).includes(spec.suitability)) s.errors.push("suitability must be pass, conditional, or reject");
  validatePreSpecAssessment(spec, s);
  validateTerminologyProfile(spec, s);
  validateScoreBlock(spec, s);
  validateQualityTargets(spec, s);
  validateQualityContract(spec, s);
  validateActionReadiness(spec, s);
  validateSelfCorrectLoop(spec, s);
  validateFeatureReviewTargets(spec, s);
  validateReviewHistory(spec, s);
  validateVisualEvidenceHistory(spec, s);
  const buildPassIds = validateBuildPasses(spec, s);
  validateSculptPipeline(spec, buildPassIds, s);
  const evidenceIds = validateEvidence(spec, s);
  const materialIds = validateMaterials(spec, s);
  validateComponents(spec, materialIds, evidenceIds, s);
  const componentIds = new Set(arrayAt(spec, "componentTree").filter(isRecord).map((c) => str(c.id)).filter(Boolean));
  validateRepetitionSystems(spec, materialIds, componentIds, s);
  if (spec.lodPlan !== undefined && spec.lodPlan !== null && !Array.isArray(spec.lodPlan)) s.errors.push("lodPlan must be an array");
  if (spec.performanceBudget !== undefined && spec.performanceBudget !== null && !isRecord(spec.performanceBudget)) s.errors.push("performanceBudget must be an object");
  validateQualityDepth(spec, s);
  validateDetailInventory(spec, s);
  if (spec.suitability === "pass" && Array.isArray(spec.risks) && spec.risks.length > 0) s.warnings.push("suitability is pass but risks are present; confirm they are acceptable");
  return {
    ok: s.errors.length === 0,
    errors: s.errors,
    warnings: s.warnings,
    strictFailures: strictFailures(s.errors, s.warnings),
    summary: {
      targetName: str(spec.targetName),
      suitability: str(spec.suitability),
      components: arrayAt(spec, "componentTree").length,
      materials: arrayAt(spec, "materials").length,
    },
  };
}
