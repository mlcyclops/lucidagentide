// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/creator/img2threejs/workflow_state.ts - the local checklist that is the authority on progress
// (CREATOR-IMG2THREEJS, ADR-0562). TypeScript port of forge/_shared/workflow_state.py, forge/state.py and
// forge/next.py from github.com/img2threejs/img2threejs (Apache-2.0).
//
// Upstream's rule, kept verbatim in spirit: `.img2threejs/state.json` is the authority on progress, the
// conversation is not. Every mandatory step needs evidence to be marked done, or a stated reason to be
// skipped; steps are marked in order; the correction loop has limits (3 per pass, 6 total by default) and
// reaching one is a HARD STOP the agent may not mark its way out of. The checklist is what stops a model
// from declaring a pass done because it feels done.
//
// The step commands name LUCID's tools (img2threejs_probe, img2threejs_assess, ...) in place of upstream's
// python3 scripts: there is no Python here (CLAUDE.md invariant 2). Domain plugins (upstream's `cs2`) are not
// ported; `profile` accepts only "generic", and anything else is refused BY NAME rather than silently run as
// generic, which is upstream's own rule for a missing plugin.
//
// Pure: every function takes a state and returns a state or a payload. Reading and writing the file is the
// caller's job (harness/omp/img2threejs_extension.ts), so this module is testable without a disk.

import { REFINE_ACTIONS, arrayAt, isInt, isRecord, str, type JsonRecord } from "./contract.ts";

export const STATE_SCHEMA_VERSION = 1;
/** Where the state lives, relative to the workspace. Same path as upstream so a workspace is portable. */
export const STATE_RELATIVE_PATH = ".img2threejs/state.json";
export const DEFAULT_MAX_PER_PASS = 3;
export const DEFAULT_MAX_TOTAL = 6;

export type StepStatus = "pending" | "done" | "skipped";
export type StepScope = "setup" | "pass" | "final";
const STEP_STATUSES: readonly StepStatus[] = ["pending", "done", "skipped"];
const STEP_SCOPES: readonly StepScope[] = ["setup", "pass", "final"];

export interface ChecklistEntry {
  id: string;
  scope: StepScope;
  status: StepStatus;
  evidence: string[];
  reason: string;
  command: string;
}

export interface WorkflowState {
  schemaVersion: number;
  status: "active" | "complete" | "stopped";
  profile: string;
  currentStep: string;
  currentPass: string;
  checklist: ChecklistEntry[];
  loops: { perPass: Record<string, number>; total: number; maxPerPass: number; maxTotal: number };
  artifacts: { reference: string; spec: string };
  passHistory: JsonRecord[];
  reviewCursor: number;
  iterationAction: string;
  stopReason: string;
}

export class WorkflowStateError extends Error {}

/** `{reference}`, `{spec}` and `{pass_id}` are filled by `formatCommand`. */
export const SETUP_STEPS: readonly (readonly [string, string])[] = [
  ["image-analysis", "Read references/image-analysis.md in the img2threejs skill and analyze {reference} with your own vision: subject, silhouette, parts, materials, lighting, hidden sides"],
  ["reference-suitability", "Record a pass, conditional, or reject verdict for {reference} with the reasons (one clear subject, enough resolution, sides that can be inferred)"],
  ["image-probe", "img2threejs_probe {\"image\": {reference}} and save the technical probe beside the spec"],
  ["pre-spec-assessment", "img2threejs_assess {\"targetName\": \"<name>\", \"image\": {reference}, \"complexity\": \"<tier>\"} then fill every unassessed field from what you saw"],
  ["detail-inventory", "Enumerate the identity-defining small details zone by zone (3x3 grid) into preSpecAssessment.detailInventory.details, each mapped to a component localFeature or material localOverride"],
  ["spec-authoring", "Author the ObjectSculptSpec at {spec}: componentTree with levels, parents and attachments, materials, repetitionSystems, buildPasses, sculptPipeline, selfCorrectLoop, qualityTargets"],
  ["strict-validation", "img2threejs_validate {\"spec\": {spec}, \"strict\": true} must report ok before any code is generated"],
];

export const PASS_STEPS: readonly (readonly [string, string])[] = [
  ["build-current-pass", "img2threejs_generate {\"spec\": {spec}, \"passId\": {pass_id}, \"out\": \"src/createObjectModel.ts\"}"],
  ["render-capture", "Render {pass_id} in the Preview panel and capture the fixed review view plus two orbit views (preview_screenshot)"],
  ["review-contract-read", "Read references/review-gates.md in the img2threejs skill completely before judging the render"],
  ["pass-gate-check", "img2threejs_state {\"action\": \"sync\", \"spec\": {spec}} and read the unmet evidence it lists for {pass_id}"],
  ["ai-review-recorded", "Compare reference and render side by side with your own vision and append exactly one reviewHistory entry (continue, refine-spec, refine-code, request-input, or stop) with the screenshot paths and the score"],
  ["pipeline-sync", "img2threejs_state {\"action\": \"sync\", \"spec\": {spec}} so the pipeline block and this checklist agree with reviewHistory"],
];

export const FINAL_STEPS: readonly (readonly [string, string])[] = [
  ["part-coverage", "Confirm every visible part of the reference is a named node in root.userData.sculptRuntime.nodes (explodable and clickable), and list any part that is missing"],
  ["action-ready", "Verify the pivots, sockets, colliders and destruction groups in root.userData.sculptRuntime against the spec's actionProfile blocks"],
];

const step = (id: string, command: string, scope: StepScope): ChecklistEntry => ({ id, scope, status: "pending", evidence: [], reason: "", command });

export interface NewStateOptions {
  readonly profile?: string;
  readonly spec?: string;
  readonly maxPerPass?: number;
  readonly maxTotal?: number;
}

export function newState(reference: string, options: NewStateOptions = {}): WorkflowState {
  const profile = options.profile ?? "generic";
  if (profile !== "generic") throw new WorkflowStateError(`unknown domain profile ${JSON.stringify(profile)}: this build ships only "generic" (domain plugins are not ported); it will not fall back silently`);
  if (!reference.trim()) throw new WorkflowStateError("a reference image path is required");
  const maxPerPass = options.maxPerPass ?? DEFAULT_MAX_PER_PASS;
  const maxTotal = options.maxTotal ?? DEFAULT_MAX_TOTAL;
  if (!isInt(maxPerPass) || !isInt(maxTotal) || maxPerPass < 1 || maxTotal < 1 || maxPerPass > maxTotal) throw new WorkflowStateError("loop limits require 1 <= maxPerPass <= maxTotal");
  const state: WorkflowState = {
    schemaVersion: STATE_SCHEMA_VERSION,
    status: "active",
    profile,
    currentStep: SETUP_STEPS[0]![0],
    currentPass: "",
    checklist: [
      ...SETUP_STEPS.map(([id, cmd]) => step(id, cmd, "setup")),
      ...PASS_STEPS.map(([id, cmd]) => step(id, cmd, "pass")),
      ...FINAL_STEPS.map(([id, cmd]) => step(id, cmd, "final")),
    ],
    loops: { perPass: {}, total: 0, maxPerPass, maxTotal },
    artifacts: { reference, spec: options.spec ?? "" },
    passHistory: [],
    reviewCursor: 0,
    iterationAction: "initial",
    stopReason: "",
  };
  recompute(state);
  return state;
}

/** Parse and check a state object read from disk. Throws WorkflowStateError with the first defect. */
export function validateState(input: unknown): WorkflowState {
  if (!isRecord(input)) throw new WorkflowStateError("state must be a JSON object");
  if (input.schemaVersion !== STATE_SCHEMA_VERSION) throw new WorkflowStateError(`unsupported state schemaVersion: ${JSON.stringify(input.schemaVersion)}`);
  if (input.profile !== "generic") throw new WorkflowStateError(`unknown domain profile ${JSON.stringify(input.profile)}: this build ships only "generic"; it will not fall back silently`);
  const checklist = input.checklist;
  if (!Array.isArray(checklist) || !checklist.length) throw new WorkflowStateError("state checklist must be a non-empty list");
  const seen = new Set<string>();
  for (const entry of checklist) {
    if (!isRecord(entry) || typeof entry.id !== "string") throw new WorkflowStateError("every checklist entry needs a string id");
    if (seen.has(entry.id)) throw new WorkflowStateError(`duplicate checklist step: ${entry.id}`);
    seen.add(entry.id);
    if (!(STEP_SCOPES as readonly unknown[]).includes(entry.scope)) throw new WorkflowStateError(`invalid checklist scope for ${entry.id}`);
    if (!(STEP_STATUSES as readonly unknown[]).includes(entry.status)) throw new WorkflowStateError(`invalid checklist status for ${entry.id}`);
    if (!Array.isArray(entry.evidence) || !entry.evidence.every((e) => typeof e === "string")) throw new WorkflowStateError(`checklist step ${entry.id} evidence must be a list of strings`);
    if (typeof entry.reason !== "string" || typeof entry.command !== "string") throw new WorkflowStateError(`checklist step ${entry.id} needs string reason and command`);
  }
  const loops = input.loops;
  if (!isRecord(loops)) throw new WorkflowStateError("state loops must be an object");
  if (!isInt(loops.maxPerPass) || !isInt(loops.maxTotal)) throw new WorkflowStateError("loop limits must be integers");
  if (loops.maxPerPass < 1 || loops.maxTotal < 1 || loops.maxPerPass > loops.maxTotal) throw new WorkflowStateError("loop limits require 1 <= maxPerPass <= maxTotal");
  if (!isRecord(loops.perPass) || !Object.values(loops.perPass).every((v) => isInt(v) && v >= 0)) throw new WorkflowStateError("state loops.perPass must map pass ids to counts");
  if (!isInt(loops.total) || loops.total < 0) throw new WorkflowStateError("state loops.total must be a non-negative integer");
  const artifacts = input.artifacts;
  if (!isRecord(artifacts) || !artifacts.reference) throw new WorkflowStateError("state artifacts.reference is required");
  const cursor = input.reviewCursor ?? 0;
  if (!isInt(cursor) || cursor < 0) throw new WorkflowStateError("state reviewCursor must be a non-negative integer");
  if (!["active", "complete", "stopped"].includes(String(input.status))) throw new WorkflowStateError("state status must be active, complete, or stopped");
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    status: input.status as WorkflowState["status"],
    profile: "generic",
    currentStep: str(input.currentStep),
    currentPass: str(input.currentPass),
    checklist: checklist.map((e) => ({ id: str((e as JsonRecord).id), scope: (e as JsonRecord).scope as StepScope, status: (e as JsonRecord).status as StepStatus, evidence: [...((e as JsonRecord).evidence as string[])], reason: str((e as JsonRecord).reason), command: str((e as JsonRecord).command) })),
    loops: { perPass: { ...(loops.perPass as Record<string, number>) }, total: loops.total, maxPerPass: loops.maxPerPass, maxTotal: loops.maxTotal },
    artifacts: { reference: str(artifacts.reference), spec: str(artifacts.spec) },
    passHistory: arrayAt(input, "passHistory").filter(isRecord),
    reviewCursor: cursor,
    iterationAction: str(input.iterationAction, "initial"),
    stopReason: str(input.stopReason),
  };
}

const entries = (state: WorkflowState, scope: StepScope): ChecklistEntry[] => state.checklist.filter((e) => e.scope === scope);
const pending = (list: ChecklistEntry[]): ChecklistEntry[] => list.filter((e) => e.status === "pending");

/** The step the agent must do next, or null when everything is done. */
export function nextEntry(state: WorkflowState): ChecklistEntry | null {
  const setup = pending(entries(state, "setup"));
  if (setup.length) return setup[0]!;
  if (state.currentPass !== "complete") {
    const pass = pending(entries(state, "pass"));
    if (pass.length) return pass[0]!;
    return step("await-pass-transition", "img2threejs_state {\"action\": \"sync\", \"spec\": {spec}} to move to the next pass once the review says continue", "pass");
  }
  const final = pending(entries(state, "final"));
  return final.length ? final[0]! : null;
}

function recompute(state: WorkflowState): void {
  const entry = nextEntry(state);
  if (state.status === "stopped") state.currentStep = "stopped";
  else if (entry === null) { state.status = "complete"; state.currentStep = "complete"; state.stopReason = ""; }
  else { state.status = "active"; state.currentStep = entry.id; state.stopReason = ""; }
}

/** The step's command with the workspace's own paths filled in (JSON-quoted, so they are data). */
export function formatCommand(state: WorkflowState, entry: ChecklistEntry): string {
  let command = entry.command;
  if (entry.id === "build-current-pass") {
    if (state.iterationAction === "refine-code") return "Refine the existing src/createObjectModel.ts from the latest review; do not regenerate it";
    if (state.iterationAction === "new-pass" || state.iterationAction === "refine-spec") command = command.replace("\"out\": \"src/createObjectModel.ts\"", "\"out\": \"src/createObjectModel.ts\", \"force\": true");
  }
  return command
    .replaceAll("{reference}", JSON.stringify(state.artifacts.reference || "<reference>"))
    .replaceAll("{spec}", JSON.stringify(state.artifacts.spec || "<spec>"))
    .replaceAll("{pass_id}", JSON.stringify(state.currentPass || "<pass>"));
}

export interface MarkOptions { readonly status: StepStatus; readonly evidence?: readonly string[]; readonly reason?: string }

/** Mark steps. Returns a NEW state. Refuses out-of-order completion, completion without evidence, a skip
 *  without a reason, an unknown step, and ANY change to a hard-stopped state. */
export function markSteps(input: WorkflowState, stepIds: readonly string[], options: MarkOptions): WorkflowState {
  const state = structuredClone(input);
  if (state.status === "stopped") throw new WorkflowStateError("state is hard-stopped; do not mark more work complete");
  if (!STEP_STATUSES.includes(options.status)) throw new WorkflowStateError("mark status must be done, skipped, or pending");
  const evidence = (options.evidence ?? []).map((e) => e.trim()).filter(Boolean);
  const reason = (options.reason ?? "").trim();
  if (options.status === "done" && !evidence.length) throw new WorkflowStateError("completing a mandatory step requires at least one evidence value");
  if (options.status === "skipped" && !reason) throw new WorkflowStateError("skipping a mandatory step requires a reason");
  if (!stepIds.length) throw new WorkflowStateError("at least one step id is required");
  const byId = new Map(state.checklist.map((e) => [e.id, e]));
  const missing = stepIds.filter((id) => !byId.has(id));
  if (missing.length) throw new WorkflowStateError(`unknown checklist step(s): ${missing.join(", ")}`);
  if (options.status === "pending") {
    for (const id of stepIds) { const e = byId.get(id)!; e.status = "pending"; e.evidence = []; e.reason = reason; }
    recompute(state);
    return state;
  }
  for (const id of stepIds) {
    const expected = nextEntry(state);
    if (expected === null || expected.id !== id) throw new WorkflowStateError(`out-of-order checklist update: expected ${expected ? expected.id : "complete"}, received ${id}`);
    const e = byId.get(id)!;
    e.status = options.status;
    e.evidence = [...evidence];
    e.reason = reason;
    recompute(state);
  }
  return state;
}

function setCurrentPass(state: WorkflowState, passId: string): void {
  const normalized = passId.trim();
  if (!normalized) throw new WorkflowStateError("current pass cannot be empty");
  const previous = state.currentPass;
  if (previous && previous !== normalized) state.passHistory.push({ passId: previous, checklist: structuredClone(entries(state, "pass")) });
  if (previous !== normalized) {
    for (const e of entries(state, "pass")) { e.status = "pending"; e.evidence = []; e.reason = ""; }
    state.iterationAction = previous ? "new-pass" : "initial";
  }
  state.currentPass = normalized;
  recompute(state);
}

/** Fold the spec's review history into the checklist: the current pass, refine iterations (which reopen the
 *  pass steps), the correction-loop counts, and the hard stop when a limit is reached. Returns a NEW state. */
export function syncFromSpec(input: WorkflowState, spec: JsonRecord, current: string): WorkflowState {
  const state = structuredClone(input);
  setCurrentPass(state, current);
  const history = arrayAt(spec, "reviewHistory").filter(isRecord);
  const cursor = Math.min(state.reviewCursor, history.length);
  const refinements = history.slice(cursor).filter((e) => e.passId === current && REFINE_ACTIONS.includes(e.action as never));
  if (current !== "complete" && refinements.length) {
    state.passHistory.push({ passId: current, iteration: "refine", checklist: structuredClone(entries(state, "pass")) });
    for (const e of entries(state, "pass")) { e.status = "pending"; e.evidence = []; e.reason = ""; }
    state.iterationAction = str(refinements[refinements.length - 1]!.action);
  }
  state.reviewCursor = history.length;
  const perPass: Record<string, number> = {};
  let total = 0;
  for (const entry of history) {
    if (!REFINE_ACTIONS.includes(entry.action as never)) continue;
    const passId = str(entry.passId, "unknown") || "unknown";
    perPass[passId] = (perPass[passId] ?? 0) + 1;
    total += 1;
  }
  state.loops.perPass = perPass;
  state.loops.total = total;
  const passCount = perPass[current] ?? 0;
  if (passCount >= state.loops.maxPerPass) {
    state.status = "stopped";
    state.currentStep = "stopped";
    state.stopReason = `max-correction-loops-reached:${current}:${passCount}/${state.loops.maxPerPass}`;
  } else if (total >= state.loops.maxTotal) {
    state.status = "stopped";
    state.currentStep = "stopped";
    state.stopReason = `max-total-correction-loops-reached:${total}/${state.loops.maxTotal}`;
  } else {
    recompute(state);
  }
  return state;
}

export interface StatusPayload {
  readonly status: WorkflowState["status"];
  readonly currentStep: string;
  readonly currentPass: string;
  readonly loop: { readonly passCount: number; readonly maxPerPass: number; readonly totalCount: number; readonly maxTotal: number };
  readonly nextCommand: string | null;
  readonly stopReason: string | null;
  readonly pending: readonly string[];
}

export function statusPayload(state: WorkflowState): StatusPayload {
  const entry = nextEntry(state);
  const current = state.currentPass;
  const visible = new Set<StepScope>(["setup", "final"]);
  if (current !== "complete") visible.add("pass");
  return {
    status: state.status,
    currentStep: state.currentStep,
    currentPass: current,
    loop: { passCount: state.loops.perPass[current] ?? 0, maxPerPass: state.loops.maxPerPass, totalCount: state.loops.total, maxTotal: state.loops.maxTotal },
    nextCommand: state.status !== "active" || entry === null ? null : formatCommand(state, entry),
    stopReason: state.stopReason || null,
    pending: state.checklist.filter((e) => visible.has(e.scope) && e.status === "pending").map((e) => e.id),
  };
}

/** The one-screen status line the agent reads, same shape as upstream's `LOCAL_STATE` banner. */
export function statusText(payload: StatusPayload): string {
  const lines = [
    `LOCAL_STATE status=${payload.status} step=${payload.currentStep} pass=${payload.currentPass || "none"} loop=${payload.loop.passCount}/${payload.loop.maxPerPass} total=${payload.loop.totalCount}/${payload.loop.maxTotal}`,
  ];
  if (payload.stopReason) lines.push(`STOP: ${payload.stopReason}`);
  else if (payload.nextCommand) lines.push(`next command: ${payload.nextCommand}`);
  lines.push("pending mandatory steps:");
  for (const id of payload.pending) lines.push(`- ${id}`);
  return lines.join("\n");
}
