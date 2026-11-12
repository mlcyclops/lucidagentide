// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/creator/img2threejs/contract.ts - the closed vocabularies of the img2threejs pipeline
// (CREATOR-IMG2THREEJS, ADR-0562), ported to TypeScript from github.com/img2threejs/img2threejs
// (Apache-2.0; forge/stage2_spec/validate_sculpt_spec.py, forge/stage3_build/orchestrate_passes.py).
//
// Upstream ships this pipeline as Python scripts. CLAUDE.md invariant 2 fixes the language boundary of
// this repo (the ONLY Python is scanner-sidecar/), so the deterministic core is re-expressed here as pure
// TypeScript with no file, process or network access. The agent's judgment (reading the reference image,
// scoring a render) stays with the model; these modules enforce the gates the model must not skip.
//
// Every set here is CLOSED. A value outside it is an error, never a silent default: upstream had a bug
// where a primitive known to the validator but not to the generator was rewritten to "box" and the wrong
// shape shipped, which is why the generator imports these sets instead of keeping its own.

/** The geometry primitives a component may declare. */
export const VALID_PRIMITIVES = [
  "box", "sphere", "ellipsoid", "cylinder", "cone", "capsule", "torus", "tube", "lathe", "extrude",
  "ground-blade", "curve-sweep", "tapered-sweep", "plane-card", "instanced-cluster",
] as const;
export type Primitive = (typeof VALID_PRIMITIVES)[number];

/** Component detail levels. Blockout builds macro only; deeper passes unlock meso, then micro. */
export const VALID_COMPONENT_LEVELS = ["macro", "meso", "micro"] as const;
export type ComponentLevel = (typeof VALID_COMPONENT_LEVELS)[number];

export const VALID_SUITABILITY = ["pass", "conditional", "reject"] as const;
export const VALID_COMPLEXITY_TIERS = ["unassessed", "simple", "moderate", "complex", "ultra-complex"] as const;
export type ComplexityTier = (typeof VALID_COMPLEXITY_TIERS)[number];
/** The tiers an assessment may be asked for (unassessed is the skeleton's placeholder, never a request). */
export const ASSESSABLE_TIERS = ["simple", "moderate", "complex", "ultra-complex"] as const;
export type AssessableTier = (typeof ASSESSABLE_TIERS)[number];

/** Every review ends in exactly one of these. */
export const VALID_REVIEW_ACTIONS = ["continue", "refine-spec", "refine-code", "request-input", "stop"] as const;
export type ReviewAction = (typeof VALID_REVIEW_ACTIONS)[number];
export const REFINE_ACTIONS: readonly ReviewAction[] = ["refine-spec", "refine-code"];

export const VALID_TOPOLOGY_CLASSES = [
  "continuous-sculpt", "assembled-solid", "conforming-shell", "surface-relief", "fiber-strand",
  "material-only", "implicit", "open-shell",
] as const;

/** Primitives that are structurally wrong for a topology class (prevents a box-stack faking an organic bulge). */
export const DISALLOWED_TOPOLOGY_PRIMITIVE_PAIRS: Readonly<Record<string, readonly string[]>> = {
  "continuous-sculpt": ["box", "cylinder", "cone"],
  "fiber-strand": ["box", "plane-card"],
};
export const TOPOLOGY_ALLOWED_HINT: Readonly<Record<string, string>> = {
  "continuous-sculpt": "lathe, extrude, or curve-sweep",
  "fiber-strand": "tube or instanced-cluster",
};

/** The build passes, in the only order they may run. */
export const DEFAULT_PASS_ORDER = [
  "blockout", "structural-pass", "form-refinement", "material-pass", "surface-pass", "lighting-pass",
  "interaction-pass", "optimization-pass",
] as const;
export type PassId = (typeof DEFAULT_PASS_ORDER)[number];
/** Passes that need a render screenshot and a vision comparison before they count as complete. */
export const VISUAL_PASS_IDS: readonly string[] = DEFAULT_PASS_ORDER.filter((p) => p !== "optimization-pass");
export const VALID_PIPELINE_PASS_IDS: readonly string[] = [...DEFAULT_PASS_ORDER, "proportion-lock", "feature-placement"];
/** Which component levels each pass may build. */
export const PASS_LEVELS: Readonly<Record<string, readonly string[]>> = {
  blockout: ["macro"],
  "structural-pass": ["macro", "meso"],
  "form-refinement": ["macro", "meso", "micro"],
  "material-pass": ["macro", "meso", "micro"],
  "surface-pass": ["macro", "meso", "micro"],
  "lighting-pass": ["macro", "meso", "micro"],
  "interaction-pass": ["macro", "meso", "micro"],
  "optimization-pass": ["macro", "meso", "micro"],
};

/** Roles whose child component must carry an attachment contract (root at the parent, not floating). */
export const ATTACHMENT_ROLES: readonly string[] = [
  "appendage", "branch", "limb", "arm", "leg", "handle", "connector", "tube", "cable", "horn", "wing", "tail",
  "root", "fork", "rib", "support", "hinge", "socket", "pipe",
];
/** Primitives whose geometry is derived from the attachment endpoints when one is present. */
export const ATTACHMENT_PRIMITIVES: readonly string[] = ["cylinder", "cone", "capsule", "tube", "curve-sweep"];

export const VALID_DETAIL_KINDS: readonly string[] = [
  "gloss", "bevel", "fastener", "linework", "contour", "seam", "stitch", "stain", "scratch", "chip", "decal",
  "emissive", "hole", "groove", "ridge",
];

export const TERMINOLOGY_LIST_FIELDS = ["geometryTerms", "materialTerms", "lightingTerms"] as const;

/** Minimum spec depth per complexity tier (the quality contract's `minimumSpecDepth`). */
export const COMPLEXITY_MINIMUMS: Readonly<Record<AssessableTier, Readonly<Record<string, number>>>> = {
  simple: { macroComponents: 1, mesoComponents: 0, microFeatureGroups: 0, materialLayers: 1, repetitionSystems: 0, reviewViewpoints: 2 },
  moderate: { macroComponents: 2, mesoComponents: 3, microFeatureGroups: 2, materialLayers: 2, repetitionSystems: 0, reviewViewpoints: 3 },
  complex: { macroComponents: 3, mesoComponents: 8, microFeatureGroups: 5, materialLayers: 3, repetitionSystems: 1, reviewViewpoints: 4 },
  "ultra-complex": { macroComponents: 5, mesoComponents: 16, microFeatureGroups: 8, materialLayers: 4, repetitionSystems: 2, reviewViewpoints: 5 },
};
/** Identity-defining details that must be enumerated before code, per tier. */
export const DETAIL_MINIMUMS: Readonly<Record<AssessableTier, number>> = { simple: 3, moderate: 6, complex: 10, "ultra-complex": 16 };

/** The default visual acceptance threshold when a review entry names none. */
export const DEFAULT_VISUAL_THRESHOLD = 0.7;

// ── JSON helpers shared by every module ─────────────────────────────────────

export type JsonRecord = Record<string, unknown>;

export const isRecord = (v: unknown): v is JsonRecord => typeof v === "object" && v !== null && !Array.isArray(v);
export const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
export const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
export const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
export const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
export const isNumberList = (v: unknown, length: number): v is number[] =>
  Array.isArray(v) && v.length === length && v.every((x) => isNumber(x));
/** `obj[key]` as a record, or an empty one. */
export const recordAt = (obj: unknown, key: string): JsonRecord => (isRecord(obj) && isRecord(obj[key]) ? obj[key] : {});
/** `obj[key]` as an array, or an empty one. */
export const arrayAt = (obj: unknown, key: string): unknown[] => (isRecord(obj) && Array.isArray(obj[key]) ? (obj[key] as unknown[]) : []);
export const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);

/** A plain ASCII slug for ids and file names. */
export function slugify(value: string): string {
  const slug = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "object";
}

/** `PascalCase` of a free-text target name, for the generated factory's identifiers. */
export function pascalCase(value: string): string {
  const parts = value.replace(/[^A-Za-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
  const joined = parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("");
  const safe = joined.replace(/^[0-9]+/, "");
  return safe || "ProceduralObject";
}
