// desktop/loop_preflight.ts
//
// P-GOAL.12 (ADR-0057): the "Pre-Flight Audit" — a structured, repeatable readiness pass the user can
// run BEFORE building a /goal loop. It adapts loop-engineering's loop-audit ship-readiness rubric (L0→L3)
// and loop-design-checklist from "is this REPO ready?" to the more actionable "is THIS loop well-formed?",
// then emits a durable Loop Design report (.md) that becomes the loop's starting point — the user adopts
// the matured goal into the Goal field and tweaks it.
//
// PURE module (no I/O, no Date.now()), unit-tested like loop_report / loop_runlog / loop_budget. The
// backend collects the spec (scope + a short prompt-engineering interview), optionally matures it with one
// model call, then calls assessReadiness + renderLoopDesign here. The model step is best-effort: with no
// model, the user's structured answers still produce a complete report + a matured goal (graceful fallback).

import { type LoopRunRecord } from "./loop_runlog.ts";

export interface PreflightSpec {
  goal: string;              // the rough objective the user typed
  command?: string;          // verification command (exit 0 = done) — the strongest "done" signal
  scope?: string;            // "branch: feat/x" | "worktree: ../wt" | "workspace" — where the loop runs
  budgetUsd?: number;        // a $ kill-switch cap (P-GOAL.11)
  maxIters?: number;
  checkerIsCheap?: boolean;  // is the checker a small/cheap model (ADR-0048)?
  // ── the prompt-engineering interview answers ──
  doneDefinition?: string;   // "what does done look like, concretely?"
  nonGoals?: string;         // "what should this loop NOT do?"
  risks?: string;            // risky / off-limits paths (auth, payments, secrets, infra) — the denylist
  feedback?: string;         // USER / product-owner feedback to fold into the loop design
  engineerNotes?: string;    // ENGINEER input — constraints, gotchas, the right approach to take
}

/** The explicit success criteria the (small, deterministic) checker grades against and reports back on —
 *  distilled from the matured design so the checker has the right context, not just a bare stop condition.
 *  Returns "" when nothing beyond the goal was specified (the checker falls back to its condition). */
export function successCriteria(spec: PreflightSpec): string {
  const lines: string[] = [];
  if (nonEmpty(spec.doneDefinition)) lines.push(`Done when: ${spec.doneDefinition!.trim()}`);
  if (nonEmpty(spec.command)) lines.push(`Proven by: \`${spec.command!.trim()}\` exits 0`);
  if (nonEmpty(spec.nonGoals)) lines.push(`Must NOT: ${spec.nonGoals!.trim()}`);
  if (nonEmpty(spec.risks)) lines.push(`Off-limits: ${spec.risks!.trim()}`);
  if (nonEmpty(spec.feedback)) lines.push(`Honor (product-owner): ${spec.feedback!.trim()}`);
  if (nonEmpty(spec.engineerNotes)) lines.push(`Honor (engineer): ${spec.engineerNotes!.trim()}`);
  return lines.join("\n");
}

export type ReadinessLevel = "L0" | "L1" | "L2" | "L3";
export interface ReadinessCheck { key: string; label: string; ok: boolean; weight: number; nudge?: string }
export interface ReadinessReport {
  level: ReadinessLevel;     // L0 intent · L1 report-ready · L2 assisted-fix · L3 unattended-capable
  score: number;             // 0..100 (weighted)
  checks: ReadinessCheck[];
  summary: string;
}

function nonEmpty(s: string | undefined, min = 1): boolean { return !!s && s.trim().length >= min; }

/** Score a loop spec against the ship-readiness rubric. The checks mirror loop-engineering's
 *  loop-design-checklist (purpose, verification, maker/checker, budget, safety) but applied to ONE loop.
 *  Level is gated, not just averaged: L3 (unattended) REQUIRES the load-bearing safety checks, never a
 *  high score alone — a missing verification command can't be out-weighed by a long goal description. */
export function assessReadiness(spec: PreflightSpec): ReadinessReport {
  const goalOk = nonEmpty(spec.goal, 12);
  const doneOk = nonEmpty(spec.doneDefinition, 6);
  const verifyOk = nonEmpty(spec.command, 2);
  const scopeOk = nonEmpty(spec.scope) && spec.scope!.toLowerCase() !== "workspace" ? true : nonEmpty(spec.scope);
  const budgetOk = (spec.budgetUsd ?? 0) > 0;
  const checkerOk = spec.checkerIsCheap === true;
  const denylistOk = nonEmpty(spec.risks, 3) || nonEmpty(spec.nonGoals, 3);

  const checks: ReadinessCheck[] = [
    { key: "objective", label: "Clear objective (one concrete end-state)", ok: goalOk, weight: 18, nudge: goalOk ? undefined : "Describe the finished result in one concrete sentence." },
    { key: "done", label: "Definition of done", ok: doneOk, weight: 14, nudge: doneOk ? undefined : "Say exactly what 'done' looks like so the checker can judge it." },
    { key: "verify", label: "Verification command (exit 0 = done)", ok: verifyOk, weight: 22, nudge: verifyOk ? undefined : "Add a shell command that proves done by exit code — without it the checker only judges the agent's self-report (Verifier Theater)." },
    { key: "scope", label: "Explicit scope (branch / worktree)", ok: scopeOk, weight: 12, nudge: scopeOk ? undefined : "Pick the branch or worktree the loop runs in, so it can't wander." },
    { key: "budget", label: "Budget cap (kill switch)", ok: budgetOk, weight: 14, nudge: budgetOk ? undefined : "Set a $ ceiling so an unattended run can't burn the budget." },
    { key: "checker", label: "Cheap, separate checker model", ok: checkerOk, weight: 10, nudge: checkerOk ? undefined : "Grade with a small fast model — it's cheaper to run every round." },
    { key: "denylist", label: "Non-goals / risky paths noted", ok: denylistOk, weight: 10, nudge: denylistOk ? undefined : "List off-limits areas (auth, payments, secrets, infra) and what the loop must NOT do." },
  ];

  const score = Math.round(checks.reduce((a, c) => a + (c.ok ? c.weight : 0), 0));
  // Gated levels (loop-engineering L0→L3). L3 = "unattended-capable": needs the verification command,
  // a budget kill switch, an explicit scope, and a cheap checker — the safety-bearing four.
  let level: ReadinessLevel;
  if (goalOk && doneOk && verifyOk && budgetOk && scopeOk && checkerOk) level = "L3";
  else if (goalOk && doneOk && verifyOk) level = "L2";
  else if (goalOk && doneOk) level = "L1";
  else level = "L0";

  const LEVEL_BLURB: Record<ReadinessLevel, string> = {
    L0: "intent only — sharpen the objective before running",
    L1: "report-ready — fine to run and watch, but add a verification command to trust 'done'",
    L2: "assisted — verifiable; add a budget cap + explicit scope before running it unattended",
    L3: "unattended-capable — verifiable, budgeted, scoped, and cheaply graded",
  };
  return { level, score, checks, summary: `${level} (${score}/100) — ${LEVEL_BLURB[level]}` };
}

/** A crisp, self-contained goal string distilled from the spec — what gets adopted into the Goal field.
 *  Deterministic fallback used when no model maturation is available. */
export function maturedGoalFrom(spec: PreflightSpec): string {
  const parts = [spec.goal.trim().replace(/\.+$/, "")];
  if (nonEmpty(spec.doneDefinition)) parts.push(`Done when: ${spec.doneDefinition!.trim().replace(/\.+$/, "")}`);
  if (nonEmpty(spec.command)) parts.push(`Verify by running \`${spec.command!.trim()}\` (exit 0 = done)`);
  if (nonEmpty(spec.nonGoals)) parts.push(`Do NOT: ${spec.nonGoals!.trim().replace(/\.+$/, "")}`);
  if (nonEmpty(spec.risks)) parts.push(`Stay clear of: ${spec.risks!.trim().replace(/\.+$/, "")}`);
  if (nonEmpty(spec.feedback)) parts.push(`Per product-owner feedback: ${spec.feedback!.trim().replace(/\.+$/, "")}`);
  if (nonEmpty(spec.engineerNotes)) parts.push(`Per engineering guidance: ${spec.engineerNotes!.trim().replace(/\.+$/, "")}`);
  return parts.join(". ") + ".";
}

// ── history awareness: don't lose context of past runs ────────────────────────

const STOPWORDS = new Set(["the", "and", "for", "with", "all", "any", "make", "fix", "add", "run", "loop", "this", "that", "into", "from", "are", "was"]);
function sigTokens(s: string): Set<string> {
  return new Set((s || "").toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !STOPWORDS.has(t)));
}

/** Pick prior runs RELATED to this goal (most-relevant first), so the Pre-Flight Audit carries forward
 *  what past runs of a similar loop did. Relevance = shared significant tokens; ties broken by recency.
 *  Returns [] when nothing overlaps (the caller still reports the total count, so "history exists" shows). */
export function relevantPriorRuns(records: LoopRunRecord[], goal: string, limit = 3): LoopRunRecord[] {
  const want = sigTokens(goal);
  if (!want.size) return [];
  const scored = records
    .map((r) => { const t = sigTokens(r.goal); let overlap = 0; for (const w of want) if (t.has(w)) overlap++; return { r, overlap }; })
    .filter((x) => x.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap || b.r.ts - a.r.ts);
  return scored.slice(0, limit).map((x) => x.r);
}

const OUTCOME_WORD: Record<string, string> = { met: "✅ met", stopped: "⏹️ stopped", cancelled: "🛑 cancelled", error: "❗ error" };
function priorLine(r: LoopRunRecord): string {
  const spend = r.hasSpend ? ` · $${r.spendUsd.toFixed(2)}` : "";
  return `${OUTCOME_WORD[r.outcome] ?? r.outcome} in ${r.iterations} iter${spend} — ${(r.outcomeReason || "").slice(0, 90)}`;
}

/** Plain-text history digest for the model interview, so maturation accounts for what failed before. */
export function summarizePriorRuns(runs: LoopRunRecord[]): string {
  if (!runs.length) return "";
  return "Prior runs of similar loops:\n" + runs.map((r) => `- "${r.goal.slice(0, 60)}": ${priorLine(r)}`).join("\n");
}

// Escape for a Markdown table cell: backslash FIRST (else a trailing "\" escapes the cell's closing
// pipe), then pipe, then flatten newlines. Same rule as loop_report.mdCell (CodeQL: incomplete escaping).
const esc = (s: string | undefined): string => (s ?? "").replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ").trim();

/** The "## Prior runs" report section — states whether history exists and surfaces the relevant runs so
 *  the new loop design carries their context forward (their After-Action Reports live in `.omp/loops/`). */
export function renderPriorRuns(totalRuns: number, relevant: LoopRunRecord[]): string {
  const out: string[] = ["## Prior runs", ""];
  if (totalRuns === 0) { out.push("_No prior loop runs on record — this is a first run._", ""); return out.join("\n"); }
  out.push(`${totalRuns} prior loop run${totalRuns === 1 ? "" : "s"} on record (full After-Action Reports in \`.omp/loops/\`).`);
  out.push("");
  if (relevant.length) {
    out.push("Most relevant to this goal:");
    out.push("");
    out.push("| Goal | Outcome |");
    out.push("|---|---|");
    for (const r of relevant) out.push(`| ${esc(r.goal).slice(0, 50)} | ${esc(priorLine(r))} |`);
  } else {
    out.push("_None match this goal closely — review the reports if this overlaps past work._");
  }
  out.push("");
  return out.join("\n");
}

/** Render the repeatable Loop Design report (markdown) — the durable artifact the Pre-Flight Audit
 *  produces. Same template every time so it's comparable run-to-run (loop-engineering's design doc). */
export function renderLoopDesign(spec: PreflightSpec, report: ReadinessReport, maturedGoal: string, history?: { total: number; relevant: LoopRunRecord[] }): string {
  const out: string[] = [];
  out.push(`# Loop Design — ${esc(spec.goal).slice(0, 80) || "(untitled loop)"}`);
  out.push("");
  out.push(`**Readiness: ${report.summary}**`);
  out.push("");
  out.push("## Matured goal");
  out.push("");
  out.push("> " + maturedGoal.replace(/\n/g, "\n> "));
  out.push("");
  if (history) out.push(renderPriorRuns(history.total, history.relevant));
  out.push("## Design");
  out.push("");
  out.push("| | |");
  out.push("|---|---|");
  out.push(`| Objective | ${esc(spec.goal) || "—"} |`);
  out.push(`| Definition of done | ${esc(spec.doneDefinition) || "_unset_"} |`);
  out.push(`| Verification | ${spec.command ? "`" + esc(spec.command) + "`" : "_none — checker judges self-report_"} |`);
  out.push(`| Scope | ${esc(spec.scope) || "workspace"} |`);
  out.push(`| Budget cap | ${spec.budgetUsd && spec.budgetUsd > 0 ? "$" + spec.budgetUsd.toFixed(2) : "_none_"} |`);
  out.push(`| Max iterations | ${spec.maxIters ?? "—"} |`);
  out.push(`| Checker | ${spec.checkerIsCheap ? "cheap/separate ✓" : "_review — flagship is wasteful_"} |`);
  out.push(`| Non-goals | ${esc(spec.nonGoals) || "_unset_"} |`);
  out.push(`| Risky / off-limits | ${esc(spec.risks) || "_unset_"} |`);
  out.push(`| User / PO feedback | ${esc(spec.feedback) || "_none provided_"} |`);
  out.push(`| Engineer notes | ${esc(spec.engineerNotes) || "_none provided_"} |`);
  out.push("");
  out.push("## Readiness checklist");
  out.push("");
  for (const c of report.checks) out.push(`- [${c.ok ? "x" : " "}] ${c.label}${c.ok ? "" : ` — _${c.nudge}_`}`);
  out.push("");
  const gaps = report.checks.filter((c) => !c.ok);
  out.push("## Before you run");
  out.push("");
  if (!gaps.length) out.push("_Nothing outstanding — this loop is unattended-capable._");
  else for (const c of gaps) out.push(`- **${c.label}** — ${c.nudge}`);
  out.push("");
  return out.join("\n");
}

// ── model-assisted maturation (prompt-engineering interview) ───────────────────

/** The interviewer system prompt: a prompt-engineering coach that hardens a loose goal into a crisp,
 *  verifiable loop design and returns STRICT JSON (so the result is parseable, never free prose). */
export function preflightSystemPrompt(): string {
  return [
    "You are a LOOP-DESIGN interviewer. Turn a loose automation goal into a crisp, verifiable, safely-scoped",
    "loop the agent can run to a stop condition. Be concrete and conservative. Prefer a shell command that",
    "exits 0 as the proof of 'done'. Do not invent facts about the repo. Output ONLY strict JSON on one line:",
    `{"maturedGoal": "<one concrete sentence>", "definitionOfDone": "<observable end-state>", "suggestedCommand": "<shell verify cmd or empty>", "nonGoals": "<what it must NOT do>", "risks": "<off-limits paths>"}`,
  ].join(" ");
}

/** The interview user turn: the user's draft + their answers + the chosen scope + any stakeholder
 *  feedback + a digest of prior runs (so maturation carries history forward, not re-solving old blockers). */
export function preflightUserPrompt(spec: PreflightSpec, priorRunsDigest = ""): string {
  return [
    `Goal draft: ${spec.goal}`,
    spec.doneDefinition ? `Definition of done (user): ${spec.doneDefinition}` : "",
    spec.command ? `Verification command (user): ${spec.command}` : "",
    spec.scope ? `Scope: ${spec.scope}` : "",
    spec.nonGoals ? `Non-goals (user): ${spec.nonGoals}` : "",
    spec.risks ? `Risky areas (user): ${spec.risks}` : "",
    spec.feedback ? `User / product-owner feedback to honor: ${spec.feedback}` : "",
    spec.engineerNotes ? `Engineer guidance to honor: ${spec.engineerNotes}` : "",
    priorRunsDigest ? `\n${priorRunsDigest}\n(Account for these — don't repeat what already failed.)` : "",
    "Harden this into a verifiable loop and return the JSON.",
  ].filter(Boolean).join("\n");
}

export interface MaturedFields { maturedGoal?: string; definitionOfDone?: string; suggestedCommand?: string; nonGoals?: string; risks?: string }

/** Parse the interviewer's JSON reply. Fail-soft: returns {} on anything unparseable, so the backend
 *  falls back to the user's own structured answers (the report is produced either way). */
export function parsePreflightJson(out: string): MaturedFields {
  const m = /\{[\s\S]*\}/.exec(out ?? "");
  if (!m) return {};
  try {
    const o = JSON.parse(m[0]) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" ? v.trim().slice(0, 600) : undefined);
    return { maturedGoal: str(o.maturedGoal), definitionOfDone: str(o.definitionOfDone), suggestedCommand: str(o.suggestedCommand), nonGoals: str(o.nonGoals), risks: str(o.risks) };
  } catch { return {}; }
}

/** Merge model-matured fields over the user's spec (user-provided values win when the model left a gap
 *  empty; the model fills the blanks). Pure — used by the backend after the model call. */
export function mergeMatured(spec: PreflightSpec, m: MaturedFields): PreflightSpec {
  return {
    ...spec,
    doneDefinition: spec.doneDefinition || m.definitionOfDone,
    command: spec.command || m.suggestedCommand || undefined,
    nonGoals: spec.nonGoals || m.nonGoals,
    risks: spec.risks || m.risks,
  };
}
