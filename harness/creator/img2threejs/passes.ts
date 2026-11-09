// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/creator/img2threejs/passes.ts - the locked-sequential pass gate (CREATOR-IMG2THREEJS, ADR-0526).
// TypeScript port of forge/stage3_build/orchestrate_passes.py from github.com/img2threejs/img2threejs
// (Apache-2.0).
//
// A spec's build passes run in order. A pass is COMPLETE only when the review history holds an entry for it
// with `action: "continue"` and, for every visual pass, a render screenshot, a comparison image, and an AI
// vision score at or above the threshold. The generator may build the completed passes and the one
// currently unlocked, never a later one: that is what keeps "blockout" clay-macro and stops a model from
// skipping straight to surface detail that no review has looked at.
//
// Pure. Everything here reads the spec and answers; `syncPipeline` returns a NEW spec object.

import { DEFAULT_PASS_ORDER, PASS_LEVELS, VISUAL_PASS_IDS, arrayAt, isNonEmptyString, isRecord, str, type JsonRecord } from "./contract.ts";
import { completedPassesFromHistory } from "./validate.ts";

/** The pass ids in order: the spec's own `buildPasses` when present, else the default eight. */
export function passOrder(spec: JsonRecord): string[] {
  const ids = arrayAt(spec, "buildPasses").filter(isRecord).map((p) => p.id).filter(isNonEmptyString);
  return ids.length ? ids : [...DEFAULT_PASS_ORDER];
}

export function passAcceptance(spec: JsonRecord, passId: string): string[] {
  for (const item of arrayAt(spec, "buildPasses")) {
    if (isRecord(item) && item.id === passId && Array.isArray(item.acceptance)) return item.acceptance.map(String).filter((v) => v.trim());
  }
  return [];
}

export const completedPasses = (spec: JsonRecord, ids: readonly string[]): string[] => completedPassesFromHistory(spec, ids);

/** The pass that runs next, or "complete" when every pass has a completing review. */
export function currentPass(ids: readonly string[], completed: readonly string[]): string {
  if (completed.length >= ids.length) return "complete";
  return ids[completed.length] ?? "complete";
}

/** The deepest pass the generator may build right now. */
export function unlockedPass(spec: JsonRecord): string {
  const ids = passOrder(spec);
  const completed = completedPasses(spec, ids);
  return completed.length >= ids.length ? ids[ids.length - 1]! : ids[completed.length]!;
}

/** Why `requested` may not be built, or "" when it may (it is completed or the one unlocked). */
export function passLockReason(spec: JsonRecord, requested: string): string {
  const ids = passOrder(spec);
  if (!ids.includes(requested)) return `unknown build pass ${JSON.stringify(requested)}; expected one of: ${ids.join(", ")}`;
  const completed = completedPasses(spec, ids);
  const current = completed.length >= ids.length ? ids[ids.length - 1]! : ids[completed.length]!;
  if (completed.includes(requested) || requested === current) return "";
  const previous = ids[ids.indexOf(requested) - 1] ?? "";
  return `build pass ${JSON.stringify(requested)} is locked; complete ${JSON.stringify(previous)} first with a reviewHistory entry (action=continue, render screenshot, comparison image, aiVisionScore at or above the threshold)`;
}

function componentRefsForPass(spec: JsonRecord, passId: string): Set<string> {
  const ids = passOrder(spec);
  const refs = new Set<string>();
  if (!ids.includes(passId)) return refs;
  const allowed = new Set(ids.slice(0, ids.indexOf(passId) + 1));
  for (const item of arrayAt(spec, "buildPasses")) {
    if (!isRecord(item) || !allowed.has(str(item.id))) continue;
    for (const ref of arrayAt(item, "componentRefs")) if (String(ref).trim()) refs.add(String(ref));
  }
  return refs;
}

/** The components the generator emits for a pass: every component at an allowed level, every component a
 *  pass up to this one names in `componentRefs`, every component whose `fidelityTier` is this pass, plus
 *  each one's parent chain (a child never floats without the node it hangs from). */
export function filterComponentsForPass(spec: JsonRecord, components: readonly JsonRecord[], passId: string): JsonRecord[] {
  const allowedLevels = PASS_LEVELS[passId] ?? ["macro"];
  const explicit = componentRefsForPass(spec, passId);
  const byId = new Map<string, JsonRecord>();
  for (const c of components) if (c.id !== undefined && c.id !== null) byId.set(String(c.id), c);
  const included: JsonRecord[] = [];
  const includedIds = new Set<string>();
  const include = (component: JsonRecord): void => {
    const id = str(component.id);
    if (!id || includedIds.has(id)) return;
    const parent = component.parent;
    if (parent !== undefined && parent !== null && byId.has(String(parent))) include(byId.get(String(parent))!);
    included.push(component);
    includedIds.add(id);
  };
  for (const component of components) {
    const id = str(component.id);
    const level = str(component.level, "macro");
    const tier = str(component.fidelityTier);
    if (explicit.has(id) || allowedLevels.includes(level) || tier === passId) include(component);
  }
  if (!included.length && components.length) included.push(components[0]!);
  return included;
}

/** What the next pass still needs before it counts as done. */
export function nextRequiredEvidence(spec: JsonRecord, passId: string): string[] {
  if (passId === "complete") return [];
  const evidence = passAcceptance(spec, passId);
  if (VISUAL_PASS_IDS.includes(passId)) {
    evidence.push(
      "render screenshot of the generated model from the Preview panel (preview_screenshot)",
      "side-by-side reference/render comparison sheet for AI vision review",
      "AI vision score at or above the visual acceptance threshold",
      "all critical semantic feature scores from the shared image pair at or above their thresholds",
      "self-correction review appended with action=continue before the next pass",
    );
  }
  return evidence;
}

export interface PipelineStatus {
  readonly passOrder: readonly string[];
  readonly completedPasses: readonly string[];
  readonly currentPass: string;
  readonly nextRequiredEvidence: readonly string[];
}

export function pipelineStatus(spec: JsonRecord): PipelineStatus {
  const ids = passOrder(spec);
  const completed = completedPasses(spec, ids);
  const current = currentPass(ids, completed);
  return { passOrder: ids, completedPasses: completed, currentPass: current, nextRequiredEvidence: nextRequiredEvidence(spec, current) };
}

/** A copy of the spec whose `sculptPipeline` block is recomputed from its review history. */
export function syncPipeline(spec: JsonRecord): JsonRecord {
  const status = pipelineStatus(spec);
  const existing = isRecord(spec.sculptPipeline) ? spec.sculptPipeline : {};
  return {
    ...spec,
    sculptPipeline: {
      ...existing,
      passGateMode: "locked-sequential",
      passOrder: [...status.passOrder],
      completedPasses: [...status.completedPasses],
      currentPass: status.currentPass,
      nextRequiredEvidence: [...status.nextRequiredEvidence],
    },
  };
}
