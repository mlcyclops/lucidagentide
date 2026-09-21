// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/judgment/trace_schema.ts - P-JEV.2 (ADR-0377): the parse-once boundary for JudgmentReport.
//
// Two callers, one schema. The omp extension builds a report from pi-ai's live request/result objects
// (`captureJudgment`), validating each question and answer through the same rules the desktop applies to
// the wire, so a malformed item is dropped at the source instead of failing the whole report later.
// dev.ts re-parses what arrives on the loopback (`parseJudgmentReport`): nothing is trusted because it
// parsed as JSON. Not imported by the renderer (arktype stays out of the browser bundle; trace.ts carries
// the types and the view helpers).

import { type } from "arktype";
import { renderState, STATE_PREVIEW_CHARS, type JudgmentBackend, type JudgmentReport, type TraceAnswer, type TraceQuestion } from "./trace.ts";

/** Instructions and criteria are prompts the caller wrote; cap them so a pathological question cannot
 *  balloon a report either. */
const TEXT_CAP = 2000;

// arktype treats an array as a record with index keys, so both record shapes refuse arrays explicitly.
const Labels = type({ "[string]": "string|null" }).narrow((v, ctx) => !Array.isArray(v) || ctx.mustBe("a plain object"));
const Probabilities = type({ "[string]": "number" }).narrow((v, ctx) => !Array.isArray(v) || ctx.mustBe("a plain object"));

const Question = type({ type: "'choice'", instructions: "string", criteria: Labels })
  .or({ type: "'noul'", instructions: "string", "criteria?": { "true?": "string", "false?": "string" } })
  .or({ type: "'score'", instructions: "string", criteria: "string[]" });

const Answer = type({ type: "'choice'", choice: "string", probabilities: Probabilities, confidence: "number" })
  .or({ type: "'noul'", noul: "number" })
  .or({ type: "'score'", score: "number", probabilities: Probabilities, confidence: "number" });

const Report = type({
  target: "string>0",
  backend: "'typesafe'|'text'",
  label: "string",
  "api?": "string",
  "provider?": "string",
  "model?": "string",
  ms: "number>=0",
  state: "string",
  stateChars: "number>=0",
  stateTruncated: "boolean",
  questions: "object",
  "answers?": "object",
  "error?": "string",
  "usage?": { input: "number", output: "number" },
});

/** Every entry of `raw` that parses as a question, text-capped. Questions we cannot represent are dropped
 *  here and their answers with them below, so the table never shows an answer without its question. */
function parseQuestions(raw: unknown): Record<string, TraceQuestion> {
  const out: Record<string, TraceQuestion> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [id, q] of Object.entries(raw)) {
    const parsed = Question(q);
    if (parsed instanceof type.errors) continue;
    parsed.instructions = cap(parsed.instructions);
    if (parsed.type === "choice") for (const k in parsed.criteria) { const c = parsed.criteria[k]; if (typeof c === "string") parsed.criteria[k] = cap(c); }
    else if (parsed.type === "score") parsed.criteria = parsed.criteria.map(cap);
    else if (parsed.criteria) { if (parsed.criteria.true) parsed.criteria.true = cap(parsed.criteria.true); if (parsed.criteria.false) parsed.criteria.false = cap(parsed.criteria.false); }
    out[id] = parsed;
  }
  return out;
}

function parseAnswers(raw: unknown, questions: Record<string, TraceQuestion>): Record<string, TraceAnswer> {
  const out: Record<string, TraceAnswer> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const id in questions) {
    const parsed = Answer((raw as Record<string, unknown>)[id]);
    if (!(parsed instanceof type.errors)) out[id] = parsed;
  }
  return out;
}

function cap(s: string): string {
  return s.length > TEXT_CAP ? `${s.slice(0, TEXT_CAP)}\u2026` : s;
}

/** What the extension knows at the end of one wrapped `judge()` call. */
export interface CaptureInput {
  target: string;
  backend: JudgmentBackend;
  label: string;
  ms: number;
  request: { state: unknown; questions: unknown };
  result?: { api?: unknown; provider?: unknown; model?: unknown; answers?: unknown; usage?: unknown };
  error?: unknown;
}

/** Build the report the extension posts. The state is rendered and capped here, once. */
export function captureJudgment(input: CaptureInput): JudgmentReport {
  const full = renderState(input.request.state);
  const questions = parseQuestions(input.request.questions);
  const report: JudgmentReport = {
    target: input.target,
    backend: input.backend,
    label: input.label,
    ms: Math.max(0, Math.round(input.ms)),
    state: full.length > STATE_PREVIEW_CHARS ? full.slice(0, STATE_PREVIEW_CHARS) : full,
    stateChars: full.length,
    stateTruncated: full.length > STATE_PREVIEW_CHARS,
    questions,
  };
  const r = input.result;
  if (r) {
    if (typeof r.api === "string") report.api = r.api;
    if (typeof r.provider === "string") report.provider = r.provider;
    if (typeof r.model === "string") report.model = r.model;
    report.answers = parseAnswers(r.answers, questions);
    const usage = type({ input: "number", output: "number" })(r.usage);
    if (!(usage instanceof type.errors)) report.usage = { input: usage.input, output: usage.output };
  }
  if (input.error !== undefined) report.error = cap(input.error instanceof Error ? input.error.message : String(input.error));
  return report;
}

/** Re-validate a report that crossed the loopback wire. Null means "ignore it" (the desktop never throws on
 *  telemetry). */
export function parseJudgmentReport(raw: unknown): JudgmentReport | null {
  const parsed = Report(raw);
  if (parsed instanceof type.errors) return null;
  const questions = parseQuestions(parsed.questions);
  const report: JudgmentReport = {
    target: parsed.target.trim(),
    backend: parsed.backend,
    label: parsed.label,
    ms: Math.round(parsed.ms),
    state: parsed.state.length > STATE_PREVIEW_CHARS ? parsed.state.slice(0, STATE_PREVIEW_CHARS) : parsed.state,
    stateChars: Math.round(parsed.stateChars),
    stateTruncated: parsed.stateTruncated,
    questions,
  };
  if (!report.target) return null;
  if (parsed.api !== undefined) report.api = parsed.api;
  if (parsed.provider !== undefined) report.provider = parsed.provider;
  if (parsed.model !== undefined) report.model = parsed.model;
  if (parsed.answers !== undefined) report.answers = parseAnswers(parsed.answers, questions);
  if (parsed.error !== undefined) report.error = cap(parsed.error);
  if (parsed.usage !== undefined) report.usage = { input: parsed.usage.input, output: parsed.usage.output };
  return report;
}
