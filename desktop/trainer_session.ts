// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/trainer_session.ts - P-TRAINER.7b/.8 (ADR-0255): the in-app Trainer, driven by the REAL harness
// core over a persisted store, ROLE-AGNOSTIC BY DEFAULT. Coverage / domains / gap-queue / interview
// questions / games are the pure core (coverage.ts, planner.ts, quizgen.ts) over the ACTIVE pack in
// trainer.duckdb: any role the user builds from a task list / Position Description (rolepack.ts), or the
// shipped WMO pack as an OPTIONAL sample that seeds only on explicit activation (useDemoPack). With no
// active role, getState() returns a minimal needsRole state and stores NOTHING (not even the db file). The answer -> unit leg is the security-load-bearing distiller (PII-redact + fail-closed
// scan + model + re-scan before any storage; ADR-0254): it only mints a unit when a model + the scanner
// sidecar are present; otherwise the interview advances but NOTHING unscanned is ever stored (inv #3/#5).

import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { TrainerStore, type AddUnitInput, type KnowledgeUnitRow } from "../harness/trainer/store.ts";
import { WMO_OBJECTIVES, WMO_PACK_ID } from "../harness/trainer/wmo_pack.ts";
import { coverageScore, domainCoverage, gapQueue } from "../harness/trainer/coverage.ts";
import { startSession as plannerStart, nextQuestion, recordAnswer, withUnits, type PlannerState } from "../harness/trainer/planner.ts";
import { quizFromUnits } from "../harness/trainer/quizgen.ts";
import { buildRolePack, type RolePackInput } from "../harness/trainer/rolepack.ts";
import { personalBaseDir } from "./settings_store.ts";

interface ActiveRole { packId: string; label: string }
// The WMO sample role: activated ONLY by an explicit useDemoPack() call, never as a silent fallback.
const DEMO_ROLE: ActiveRole = { packId: WMO_PACK_ID, label: "Wealth-Management Ops (sample)" };
function activeRole(): ActiveRole | null {
  try { const j = JSON.parse(readFileSync(join(personalBaseDir(), "trainer-active.json"), "utf8")) as Partial<ActiveRole>; if (typeof j.packId === "string" && j.packId) return { packId: j.packId, label: typeof j.label === "string" ? j.label : j.packId }; } catch { /* none yet -> role selection */ }
  return null;
}
function setActiveRole(r: ActiveRole): void { try { writeFileSync(join(personalBaseDir(), "trainer-active.json"), JSON.stringify(r)); } catch { /* best-effort */ } }

interface SeedUnit { objectiveId: string; kind: AddUnitInput["kind"]; title: string; steps?: string[]; trigger?: string; resolution?: string }
// Authored confirmed reference units for the WMO SAMPLE pack only, seeded exclusively by useDemoPack() so
// its coverage + games have real material offline. A user-built role starts empty and fills from the real
// (gated) interview; it never inherits any of this.
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
let plannerPack = "";
let startedAt = 0;

async function ensure(): Promise<TrainerStore> {
  if (store) return store;
  store = await TrainerStore.open(process.env.LUCID_TRAINER_DB_PATH || join(personalBaseDir(), "trainer.duckdb"));
  return store;
}

// Seed the WMO sample pack: objectives + confirmed reference units. Runs ONLY when the user explicitly
// activates the sample (useDemoPack), never on store open and never while an unrelated pack is active.
// Idempotent: re-activation adds nothing (addObjectives has stable ids; units are matched by title).
async function seedDemoPack(s: TrainerStore): Promise<void> {
  await s.addObjectives(WMO_OBJECTIVES);
  for (const u of SEED) {
    const existing = await s.listLiveUnits(u.objectiveId);
    if (existing.some((e) => e.title === u.title)) continue; // idempotent
    const structure = u.steps ? { steps: u.steps } : { trigger: u.trigger, resolution: u.resolution };
    const bodyMd = u.steps ? u.steps.map((x, i) => `${i + 1}. ${x}`).join("\n") : `**When:** ${u.trigger}\n\n**Do:** ${u.resolution}`;
    const id = await s.addUnit({ objectiveId: u.objectiveId, kind: u.kind, title: u.title, bodyMd, structure, trustLabel: "untrusted", completeness: u.steps ? 90 : 80, sourceSessionId: "seed" });
    await s.confirmUnit(id, "seed:reference");
  }
}

const lvl = (n: number): string => (n >= 85 ? "L3" : n >= 60 ? "L2" : n >= 30 ? "L1" : "L0");
function steps(u: KnowledgeUnitRow): string[] {
  try { const s = JSON.parse(u.structure) as { steps?: unknown }; return Array.isArray(s.steps) ? s.steps.filter((x): x is string => typeof x === "string") : []; } catch { return []; }
}

export interface TrainerStateView {
  pack: string; role: { id: string; label: string }; needsRole: boolean; needsSetup: boolean; coverage: number;
  domains: { domain: string; score: number; level: string }[];
  gap: { objectiveId: string; domain: string; title: string; level: string } | null;
  question: { kind: string; domain: string; objectiveId: string; text: string; whyDepth: number } | null;
  units: number; confirmed: number; closing: string | null;
}

export async function getState(): Promise<TrainerStateView> {
  const active = activeRole();
  if (!active) {
    // No role chosen yet: a minimal "pick a role" state. Nothing is opened or seeded; trainer.duckdb is
    // not even created until a role (user-built or the WMO sample) is explicitly activated.
    return { pack: "", role: { id: "", label: "Choose a role" }, needsRole: true, needsSetup: true, coverage: 0, domains: [], gap: null, question: null, units: 0, confirmed: 0, closing: null };
  }
  const s = await ensure();
  const { packId, label } = active;
  const objs = await s.listObjectives(packId);
  const map = await s.coverageInputs(packId);
  const byId = new Map(objs.map((o) => [o.objectiveId, o]));
  const domains = domainCoverage(objs, map).map((d) => ({ domain: d.domain, score: d.score, level: lvl(d.score) }));
  const g0 = gapQueue(objs, map)[0];
  const gap = g0 ? { objectiveId: g0.objective.objectiveId, domain: g0.objective.domain, title: g0.objective.title, level: "L" + g0.level } : null;
  if (!planner || plannerPack !== packId) { planner = plannerStart(objs, map); plannerPack = packId; startedAt = Date.now(); }
  planner = withUnits(planner, map);
  const nr = nextQuestion(planner, Date.now() - startedAt);
  planner = nr.state;
  const q = nr.question ? { kind: nr.question.kind, domain: byId.get(nr.question.objectiveId)?.domain ?? "", objectiveId: nr.question.objectiveId, text: nr.question.text, whyDepth: nr.question.whyDepth } : null;
  let live = 0, confirmed = 0;
  for (const o of objs) { const us = await s.listLiveUnits(o.objectiveId); live += us.length; confirmed += us.filter((u) => u.confirmed_at != null).length; }
  return { pack: packId, role: { id: packId, label }, needsRole: false, needsSetup: objs.length === 0, coverage: coverageScore(objs, map), domains, gap, question: q, units: live, confirmed, closing: nr.closing ?? null };
}

/** Build + activate a coverage pack for ANY role from a name + tasks and/or a pasted Position Description
 *  (rolepack.ts). Resets the interview onto the new pack. The PD is the user's own first-party text; it is
 *  parsed as data (heuristic, never executed) and only reaches a model later through the fail-closed
 *  distiller. Returns ok:false with a hint when no usable duty is found. */
export async function setRole(input: RolePackInput): Promise<{ ok: boolean; error?: string; state?: TrainerStateView }> {
  const s = await ensure();
  const pack = buildRolePack(input);
  if (!pack.length) return { ok: false, error: "Add at least one task, or paste a Position Description whose duties are on their own lines (bulleted lines work best)." };
  await s.addObjectives(pack);
  setActiveRole({ packId: pack[0]!.packId, label: input.role.trim() || pack[0]!.packId });
  planner = null; startedAt = 0; // fresh interview for the new role
  return { ok: true, state: await getState() };
}

/** Explicitly activate the shipped WMO pack as a SAMPLE role: seed its objectives + reference units
 *  (idempotent), mark it active, and reset the interview onto it. This is the ONLY path that seeds WMO
 *  content; a fresh install or a user-built role never touches it. */
export async function useDemoPack(): Promise<TrainerStateView> {
  const s = await ensure();
  await seedDemoPack(s);
  setActiveRole(DEMO_ROLE);
  planner = null; startedAt = 0; // fresh interview on the sample
  return getState();
}

export async function submitAnswer(text: string): Promise<{ distilled: boolean; reason: string; state: TrainerStateView }> {
  const active = activeRole();
  if (!active) return { distilled: false, reason: "Choose a role first: build one from your tasks or a Position Description, or try the sample role.", state: await getState() };
  const s = await ensure();
  const { packId } = active;
  const map = await s.coverageInputs(packId);
  if (!planner || plannerPack !== packId) { planner = plannerStart(await s.listObjectives(packId), map); plannerPack = packId; startedAt = Date.now(); }
  planner = recordAnswer(planner, text); // advances the interview (queues five-whys on a deviation cue)
  return {
    distilled: false,
    reason: "Capturing a lesson runs the fail-closed distiller (PII-redact + scanner + model). Start the scanner sidecar and configure a model to grow the coverage map from your answers.",
    state: await getState(),
  };
}

export interface TrainerGame { id: string; title: string; source: string; [k: string]: unknown }
export async function getGames(): Promise<{ games: TrainerGame[] }> {
  const active = activeRole();
  if (!active) return { games: [] }; // no role -> no lessons -> no drills
  const s = await ensure();
  const { packId } = active;
  const objs = await s.listObjectives(packId);
  const byId = new Map(objs.map((o) => [o.objectiveId, o]));
  const src = (objectiveId: string): string => { const o = byId.get(objectiveId); return o ? `${o.domain} \u00b7 ${o.objectiveId} (${o.title})` : objectiveId; };
  const confirmed = await s.listConfirmedUnits(packId);
  const kindOf = new Map(confirmed.map((u) => [u.unit_id, u.kind]));
  const games: TrainerGame[] = [];
  const proc = confirmed.find((u) => (u.kind === "checklist" || u.kind === "procedure") && steps(u).length >= 4);
  if (proc) games.push({ id: "seq", title: "Sequence the Steps", source: src(proc.objective_id), steps: steps(proc) });
  const quiz = quizFromUnits(confirmed, 0xc0ffee);
  const toChoice = (it: (typeof quiz)[number]) => ({ prompt: it.question, correct: it.options[it.correctAnswer]!, decoys: it.options.filter((_, i) => i !== it.correctAnswer), source: src(it.objectiveId) });
  const nextItem = quiz.find((it) => { const k = kindOf.get(it.sourceUnitId); return k === "procedure" || k === "checklist"; });
  if (nextItem) games.push({ id: "next", title: "Next Step?", ...toChoice(nextItem) });
  const excItem = quiz.find((it) => { const k = kindOf.get(it.sourceUnitId); return k === "edge_case" || k === "exception"; });
  if (excItem) games.push({ id: "exc", title: "Spot the Exception", ...toChoice(excItem) });
  // Five Whys: the authored wire-cutoff deviation drill applies to the WMO demo only.
  if (packId === WMO_PACK_ID) games.push({ id: "why", title: "Five Whys", source: "Money movement \u00b7 wmo-2.1 (Wires, ACH, and journals)",
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
