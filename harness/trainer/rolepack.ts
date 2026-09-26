// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/trainer/rolepack.ts - P-TRAINER.8 (ADR-0255): role-agnostic coverage-pack generation.
//
// Turn a role name + a task list and/or a pasted Position Description into a coverage map (objectives +
// scenario-first elicitation) the SAME shape as the shipped WMO pack (wmo_pack.ts), so the trainer can
// extract ANY role's process knowledge - not just wealth-management ops. Pure + deterministic (the
// wmo_pack.ts / gov_onboarding.ts pattern: no model, no IO, no clock). A configured model may ENRICH the
// pack later; this heuristic is the floor that always works, offline and air-gapped.

import type { CoverageObjective } from "./coverage.ts";

const MAX_OBJECTIVES = 14;
const LIST_MARKER = /^([-*\u2022\u00b7]|\d+[.)])\s+/; // -, *, bullet, middot, "1." / "1)"

/** A stable, namespaced pack id for a role name ("Wire Ops Analyst" -> "role-wire-ops-analyst"). */
export function slugRole(role: string): string {
  const s = role.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return s ? `role-${s}` : "role-custom";
}

/** Pull candidate duties from a pasted Position Description: prefer bulleted/numbered lines; else any
 *  sentence-ish line. Strip list markers + trailing punctuation, keep 15..140-char lines, dedupe
 *  case-insensitively, cap. Pure text shaping - never executes or interprets the PD. */
export function extractTasksFromPd(pd: string): string[] {
  const lines = pd.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const bulletish = lines.filter((l) => LIST_MARKER.test(l));
  const src = bulletish.length >= 3 ? bulletish : lines;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of src) {
    const t = raw.replace(LIST_MARKER, "").replace(/[.;,]+$/, "").trim();
    if (t.length < 15 || t.length > 140) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= MAX_OBJECTIVES) break;
  }
  return out;
}

/** A short HUD domain label from a task: the first clause, a few words, ellipsized. */
function domainLabel(task: string): string {
  const head = (task.split(/[,:\u2014]| - /)[0] ?? task).trim();
  const words = head.split(/\s+/).slice(0, 5).join(" ");
  return words.length > 42 ? words.slice(0, 40) + "\u2026" : words || task.slice(0, 40);
}
const lc = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);

export interface RolePackInput { role: string; tasks?: string[]; pdText?: string }

/** Build a coverage pack for ANY role. Each duty becomes one objective with scenario-first / direct / edge
 *  elicitation (ADR-0255 cadence), deterministically templated from the duty text. Tasks come from the
 *  explicit list first, then the PD; duplicates and blanks are dropped. Returns [] when no usable duty is
 *  found (the caller then asks the user to add tasks or paste a fuller PD). */
export function buildRolePack(input: RolePackInput): CoverageObjective[] {
  const packId = slugRole(input.role);
  const merged = [...(input.tasks ?? []), ...(input.pdText ? extractTasksFromPd(input.pdText) : [])]
    .map((t) => t.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  const tasks: string[] = [];
  for (const t of merged) {
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tasks.push(t);
    if (tasks.length >= MAX_OBJECTIVES) break;
  }
  return tasks.map((task, i) => ({
    objectiveId: `${packId}-${i + 1}`,
    packId,
    domain: domainLabel(task),
    title: task.length > 70 ? task.slice(0, 68) + "\u2026" : task,
    description: task,
    weight: i < 3 ? 4 : 3,
    elicitation: {
      scenarios: [`Walk me through exactly how you handle ${lc(task)}, start to finish - use a real recent example.`],
      probes: [`Step by step, what does ${lc(task)} involve, and who is responsible for each step?`],
      edgeProbes: [`Tell me about a time ${lc(task)} went wrong or nearly did. What tipped you off, and what did you do?`],
    },
  }));
}
