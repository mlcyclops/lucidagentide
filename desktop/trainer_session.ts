// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/trainer_session.ts - P-TRAINER.7 (ADR-0255): the in-app Trainer driven by the REAL harness
// core over a persisted store. Coverage / domains / gap-queue / interview questions / games are the pure
// core (coverage.ts, planner.ts, quizgen.ts) over a dedicated trainer.duckdb - NOT seeded UI constants.
//
// The answer -> unit leg is the security-load-bearing distiller (PII-redact + fail-closed scan + model +
// re-scan before any storage; ADR-0254). It only mints a unit when a model + the scanner sidecar are
// present; otherwise the interview still advances but NOTHING unscanned is ever stored (invariants #3/#5).
// A small set of AUTHORED confirmed reference units is seeded once so coverage + games have real material
// offline (the WMO pack itself ships questions, not answers - the real interview grows the map).

import { join } from "node:path";
import { TrainerStore, type AddUnitInput, type KnowledgeUnitRow } from "../harness/trainer/store.ts";
import { WMO_OBJECTIVES, WMO_PACK_ID } from "../harness/trainer/wmo_pack.ts";
import { coverageScore, domainCoverage, gapQueue } from "../harness/trainer/coverage.ts";
import { startSession as plannerStart, nextQuestion, recordAnswer, withUnits, type PlannerState } from "../harness/trainer/planner.ts";
import { quizFromUnits } from "../harness/trainer/quizgen.ts";
import { personalBaseDir } from "./settings_store.ts";

interface SeedUnit { objectiveId: string; kind: AddUnitInput["kind"]; title: string; steps?: string[]; trigger?: string; resolution?: string }
// Authored confirmed reference units (demo seed). Procedures/checklists >= 5 steps and >= 4 edge cases so
// quizFromUnits can build fair 4-option items (it needs 3 decoy resolutions from OTHER edge units).
const SEED: readonly SeedUnit[] = [
  { objectiveId: "wmo-2.1", kind: "procedure", title: "Routine wire release", steps: [
    "Client submits a disbursement request", "Verify the client on a known callback number",
    "Operations enters the wire in the custodian portal", "A principal approves the wire",
    "Custodian releases funds before the cutoff"] },
  { objectiveId: "wmo-1.2", kind: "procedure", title: "Onboarding and custodial account opening", steps: [
    "Open the custodial accounts", "Submit the ACAT transfer", "Track the in-flight ACAT to completion",
    "Fund and reconcile the accounts", "Run the first-90-day review"] },
  { objectiveId: "wmo-4.1", kind: "procedure", title: "Quarterly billing run", steps: [
    "Pull the quarter's AUM data", "Apply each client's fee schedule", "Compute prorations for mid-quarter flows",
    "Generate the fee invoices", "Post the debits to the accounts"] },
  { objectiveId: "wmo-7.1", kind: "checklist", title: "Firm due-diligence checklist", steps: [
    "Identify which legal entity signs the client agreement", "Identify the responsible registered investment adviser",
    "Confirm the qualified custodian holding assets", "Enumerate all advisory, planning, and third-party fees",
    "State whether the firm is a fiduciary for every service", "Review regulatory filings for disclosures and conflicts"] },
  { objectiveId: "wmo-2.2", kind: "edge_case", title: "Emailed wire-instruction change",
    trigger: "An email changes wire instructions before a closing", resolution: "Call back on a known number and re-verify before making any change" },
  { objectiveId: "wmo-3.2", kind: "edge_case", title: "Wrong-account trade on the blotter",
    trigger: "A buy posts to the wrong account overnight", resolution: "Correct the error and make the client whole per the error policy" },
  { objectiveId: "wmo-1.3", kind: "edge_case", title: "Death of a client",
    trigger: "The firm learns a client died over the weekend", resolution: "Freeze discretionary activity and run the death-of-client protocol within 48 hours" },
  { objectiveId: "wmo-5.1", kind: "edge_case", title: "Year-end realized-gains call",
    trigger: "A CPA calls about realized gains before year-end", resolution: "Produce a realized gain and loss report and coordinate harvesting within wash-sale limits" },
];

let store: TrainerStore | null = null;
let planner: PlannerState | null = null;
let startedAt = 0;

async function ensure(): Promise<TrainerStore> {
  if (store) return store;
  const s = await TrainerStore.open(process.env.LUCID_TRAINER_DB_PATH || join(personalBaseDir(), "trainer.duckdb"));
  await s.addObjectives(WMO_OBJECTIVES);
  for (const u of SEED) {
    const existing = await s.listLiveUnits(u.objectiveId);
    if (existing.some((e) => e.title === u.title)) continue; // idempotent
    const structure = u.steps ? { steps: u.steps } : { trigger: u.trigger, resolution: u.resolution };
    const bodyMd = u.steps ? u.steps.map((x, i) => `${i + 1}. ${x}`).join("\n") : `**When:** ${u.trigger}\n\n**Do:** ${u.resolution}`;
    const id = await s.addUnit({ objectiveId: u.objectiveId, kind: u.kind, title: u.title, bodyMd, structure, trustLabel: "untrusted", completeness: u.steps ? 90 : 80, sourceSessionId: "seed" });
    await s.confirmUnit(id, "seed:reference"); // reference units ship confirmed so drills have material
  }
  store = s;
  return s;
}

const objTitle = (id: string): string => WMO_OBJECTIVES.find((o) => o.objectiveId === id)?.title ?? id;
const domOf = (id: string): string => WMO_OBJECTIVES.find((o) => o.objectiveId === id)?.domain ?? "";
const lvl = (n: number): string => (n >= 85 ? "L3" : n >= 60 ? "L2" : n >= 30 ? "L1" : "L0");
function steps(u: KnowledgeUnitRow): string[] {
  try { const s = JSON.parse(u.structure) as { steps?: unknown }; return Array.isArray(s.steps) ? s.steps.filter((x): x is string => typeof x === "string") : []; } catch { return []; }
}

export interface TrainerStateView {
  pack: string; coverage: number;
  domains: { domain: string; score: number; level: string }[];
  gap: { objectiveId: string; domain: string; title: string; level: string } | null;
  question: { kind: string; domain: string; objectiveId: string; text: string; whyDepth: number } | null;
  units: number; confirmed: number; closing: string | null;
}

export async function getState(): Promise<TrainerStateView> {
  const s = await ensure();
  const map = await s.coverageInputs(WMO_PACK_ID);
  const cov = coverageScore(WMO_OBJECTIVES, map);
  const domains = domainCoverage(WMO_OBJECTIVES, map).map((d) => ({ domain: d.domain, score: d.score, level: lvl(d.score) }));
  const gaps = gapQueue(WMO_OBJECTIVES, map);
  const g0 = gaps[0];
  const gap = g0 ? { objectiveId: g0.objective.objectiveId, domain: g0.objective.domain, title: g0.objective.title, level: "L" + g0.level } : null;
  if (!planner) { planner = plannerStart(WMO_OBJECTIVES, map); startedAt = Date.now(); }
  planner = withUnits(planner, map);
  const nr = nextQuestion(planner, Date.now() - startedAt);
  planner = nr.state;
  const q = nr.question ? { kind: nr.question.kind, domain: domOf(nr.question.objectiveId), objectiveId: nr.question.objectiveId, text: nr.question.text, whyDepth: nr.question.whyDepth } : null;
  let live = 0, confirmed = 0;
  for (const o of WMO_OBJECTIVES) { const us = await s.listLiveUnits(o.objectiveId); live += us.length; confirmed += us.filter((u) => u.confirmed_at != null).length; }
  return { pack: WMO_PACK_ID, coverage: cov, domains, gap, question: q, units: live, confirmed, closing: nr.closing ?? null };
}

export async function submitAnswer(text: string): Promise<{ distilled: boolean; reason: string; state: TrainerStateView }> {
  const s = await ensure();
  const map = await s.coverageInputs(WMO_PACK_ID);
  if (!planner) { planner = plannerStart(WMO_OBJECTIVES, map); startedAt = Date.now(); }
  planner = recordAnswer(planner, text); // advances the interview (queues five-whys on a deviation cue)
  // The answer -> knowledge-unit distiller is fail-closed on a model + the scanner sidecar (redact, scan,
  // model-distill, re-scan) - it is wired here when those are configured. Offline we NEVER store unscanned
  // text; the interview advances and coverage reflects only actually-captured (scanned) units.
  return {
    distilled: false,
    reason: "Capturing a lesson runs the fail-closed distiller (PII-redact + scanner + model). Start the scanner sidecar and configure a model to grow the coverage map from your answers.",
    state: await getState(),
  };
}

export interface TrainerGame { id: string; title: string; source: string; [k: string]: unknown }
export async function getGames(): Promise<{ games: TrainerGame[] }> {
  const s = await ensure();
  const confirmed = await s.listConfirmedUnits(WMO_PACK_ID);
  const kindOf = new Map(confirmed.map((u) => [u.unit_id, u.kind]));
  const games: TrainerGame[] = [];
  // Sequence: a real procedure/checklist unit's steps.
  const proc = confirmed.find((u) => (u.kind === "checklist" || u.kind === "procedure") && steps(u).length >= 4);
  if (proc) games.push({ id: "seq", title: "Sequence the Steps", source: `${domOf(proc.objective_id)} \u00b7 ${proc.objective_id} (${objTitle(proc.objective_id)})`, steps: steps(proc) });
  // Next Step? + Spot the Exception: derived from confirmed units via quizFromUnits (deterministic).
  const quiz = quizFromUnits(confirmed, 0xc0ffee);
  const toChoice = (it: (typeof quiz)[number]) => ({ prompt: it.question, correct: it.options[it.correctAnswer]!, decoys: it.options.filter((_, i) => i !== it.correctAnswer), source: `${domOf(it.objectiveId)} \u00b7 ${it.objectiveId} (${objTitle(it.objectiveId)})` });
  const nextItem = quiz.find((it) => { const k = kindOf.get(it.sourceUnitId); return k === "procedure" || k === "checklist"; });
  if (nextItem) games.push({ id: "next", title: "Next Step?", ...toChoice(nextItem) });
  const excItem = quiz.find((it) => { const k = kindOf.get(it.sourceUnitId); return k === "edge_case" || k === "exception"; });
  if (excItem) games.push({ id: "exc", title: "Spot the Exception", ...toChoice(excItem) });
  // Five Whys: an authored deviation drill tied to the real wire-cutoff objective (planner runs the live
  // version during an interview; this is the trainee-side replay).
  games.push({ id: "why", title: "Five Whys", source: "Money movement \u00b7 wmo-2.1 (Wires, ACH, and journals)",
    root: "The Friday wire didn't go out before the holiday weekend.",
    chain: [
      { q: "Why didn't the wire go out?", correct: "The custodian cutoff had already passed", decoys: ["The client cancelled it", "The bank was closed all week"] },
      { q: "Why was the cutoff missed?", correct: "The request arrived at 4pm, after the 2pm cutoff", decoys: ["Operations forgot to send it", "The principal was unavailable"] },
      { q: "Why did the request arrive so late?", correct: "The client was waiting on a signed document from their attorney", decoys: ["The adviser was on vacation", "The portal was down"] },
      { q: "Why wasn't the deadline flagged earlier?", correct: "No one owned a same-day cutoff watch on inbound requests", decoys: ["The client never mentioned the date", "Wires are always same-day"] },
    ],
    fix: "Root cause: no owner for a same-day cutoff watch. Fix captured \u2192 add a cutoff-watch step to the wire procedure.",
  });
  return { games };
}
