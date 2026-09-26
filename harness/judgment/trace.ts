// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/judgment/trace.ts - P-JEV.2 (ADR-0377): the one shape a traced judgment travels in.
//
// omp answers its typed judgments (auto-thinking effort, the smart unexpected-stop check, git AI staging,
// the eval `judge()` helper) through pi-ai's `Judge` classes: `TypeSafeJudge` (Jev, api.typesafe.ai) and
// `TextJudge` (a chat or local model answering by keyword). omp records NONE of the answers anywhere and
// exposes no hook for them, so the only place the full request + result exist is inside those two calls.
// `harness/omp/judgment_extension.ts` wraps them in-process and posts one of these per call; the desktop
// validates it here and the renderer draws it. Three consumers, one contract.
//
// The types and the view helpers are dependency-free so the renderer bundle can import them; the arktype
// schema that parses the wire lives in trace_schema.ts (dev.ts and the extension only). The shapes mirror
// pi-ai's `judgment/types.ts` structurally rather than importing them, because the renderer bundle must not
// depend on pi-ai and because a future omp that renames a field must degrade to "unparsed", never crash.

/** Which pi-ai judge class answered. `typesafe` is Jev; `text` is the keyword bridge (chat or local model). */
export type JudgmentBackend = "typesafe" | "text";

export interface TraceChoiceQuestion { type: "choice"; instructions: string; criteria: Record<string, string | null> }
export interface TraceNoulQuestion { type: "noul"; instructions: string; criteria?: { true?: string; false?: string } }
export interface TraceScoreQuestion { type: "score"; instructions: string; criteria: readonly string[] }
export type TraceQuestion = TraceChoiceQuestion | TraceNoulQuestion | TraceScoreQuestion;

export interface TraceChoiceAnswer { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
export interface TraceNoulAnswer { type: "noul"; noul: number }
export interface TraceScoreAnswer { type: "score"; score: number; probabilities: Record<string, number>; confidence: number }
export type TraceAnswer = TraceChoiceAnswer | TraceNoulAnswer | TraceScoreAnswer;

/** One judgment call, as the extension observed it. `answers` is absent when the call threw (`error` set);
 *  a TypeSafe failure is followed by a second report from the `text` fallback omp routes to. */
export interface JudgmentReport {
  /** Which omp child: "master" or a fleet lane id (LUCID_INTERJECT_TARGET). */
  target: string;
  backend: JudgmentBackend;
  /** The judge's own label (`typesafe/jev-latest`, `anthropic/claude-...`), present even when the call threw. */
  label: string;
  api?: string;
  provider?: string;
  model?: string;
  ms: number;
  /** The judged state, rendered to text and capped at STATE_PREVIEW_CHARS. */
  state: string;
  stateChars: number;
  stateTruncated: boolean;
  questions: Record<string, TraceQuestion>;
  answers?: Record<string, TraceAnswer>;
  error?: string;
  usage?: { input: number; output: number };
}

/** Enough of the state to see WHAT was judged; never a second copy of a whole transcript on the wire. */
export const STATE_PREVIEW_CHARS = 4000;

/** Render a judgment state the way a reader wants to see it: a string as-is, anything else as JSON. */
export function renderState(state: unknown): string {
  if (typeof state === "string") return state;
  try { return JSON.stringify(state, null, 2) ?? String(state); } catch { return String(state); }
}

/** Which omp feature asked. Inferred from the question ids each caller uses (pinned omp 18.2.6:
 *  auto-thinking/classifier.ts asks `bucket` or `level` over `{request}`; unexpected-stop-classifier.ts asks
 *  `stopped` over `{message}`; git-tui/ai-stage.ts asks `file<N>` / `matches`). Anything else came through
 *  the eval `judge()` helper, i.e. the agent asked on purpose. */
export function judgmentPurpose(report: Pick<JudgmentReport, "questions">): string {
  const ids = Object.keys(report.questions);
  if (ids.length === 1 && (ids[0] === "bucket" || ids[0] === "level")) return "Auto-thinking effort";
  if (ids.length === 1 && ids[0] === "stopped") return "Unexpected-stop check";
  if (ids.length && ids.every((id) => id === "matches" || /^file\d+$/.test(id))) return "Git AI staging";
  return "Agent judge() call";
}

/** True when at least one report in the turn was ANSWERED by Jev (a TypeSafe call that threw and fell back
 *  does not count as consulted: the answer the agent used came from the fallback). */
export function jevConsulted(reports: readonly Pick<JudgmentReport, "backend" | "error">[]): boolean {
  return reports.some((r) => r.backend === "typesafe" && !r.error);
}

/** Headline + probability bars for one answer, ready to draw. `bars` is empty for a noul answer, whose
 *  single probability IS the headline. */
export interface AnswerSummary { headline: string; bars: { label: string; p: number }[]; confidence?: number }

export function answerSummary(q: TraceQuestion, a: TraceAnswer | undefined): AnswerSummary {
  if (!a) return { headline: "no answer", bars: [] };
  if (a.type === "choice") {
    const labels = q.type === "choice" ? Object.keys(q.criteria) : Object.keys(a.probabilities);
    return { headline: a.choice, confidence: a.confidence, bars: labels.map((label) => ({ label, p: a.probabilities[label] ?? 0 })) };
  }
  if (a.type === "noul") return { headline: `${Math.round(a.noul * 100)}% yes`, bars: [] };
  const levels = q.type === "score" ? q.criteria : [];
  const nearest = levels[Math.round(a.score)];
  const headline = nearest === undefined ? a.score.toFixed(2) : `${a.score.toFixed(2)} \u00b7 ${nearest}`;
  return { headline, confidence: a.confidence, bars: Object.entries(a.probabilities).map(([k, p]) => ({ label: levels[Number(k)] ?? k, p })) };
}

/** The label for a report's backend: Jev by model when TypeSafe answered, else the chat/local model. */
export function backendLabel(r: Pick<JudgmentReport, "backend" | "model" | "provider" | "label">): string {
  if (r.backend === "typesafe") return `Jev (${r.model ?? r.label})`;
  return r.provider && r.model ? `${r.provider}/${r.model}` : r.label;
}

/** Why a configured Jev may legitimately sit idle for a whole turn. Shown on the idle note. */
export const JEV_IDLE_REASON = "Nothing asked for a judgment: no auto-thinking effort rating, no unexpected-stop check, and no judge() call from the agent this turn.";
