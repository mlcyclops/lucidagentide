// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-JEV.2 (ADR-0377): the judgment trace contract. Pinned by BEHAVIOR at the two boundaries that matter:
// what the extension captures from a live pi-ai call, and what the desktop accepts off the loopback wire.

import { describe, expect, test } from "bun:test";
import { answerSummary, backendLabel, jevConsulted, judgmentPurpose, STATE_PREVIEW_CHARS } from "./trace.ts";
import { captureJudgment, parseJudgmentReport } from "./trace_schema.ts";

const questions = {
  level: { type: "choice", instructions: "How hard is this request?", criteria: { low: null, high: "needs planning", xhigh: null } },
  stopped: { type: "noul", instructions: "Did the turn promise to act and then stop?" },
  quality: { type: "score", instructions: "Rate it", criteria: ["poor", "fair", "good"] },
} as const;

const answers = {
  level: { type: "choice", choice: "high", probabilities: { low: 0.1, high: 0.7, xhigh: 0.2 }, confidence: 0.62 },
  stopped: { type: "noul", noul: 0.08 },
  quality: { type: "score", score: 1.6, probabilities: { "0": 0.1, "1": 0.2, "2": 0.7 }, confidence: 0.55 },
} as const;

describe("captureJudgment", () => {
  test("a TypeSafe result is captured whole: backend, model, every answer, usage, latency", () => {
    const r = captureJudgment({
      target: "master", backend: "typesafe", label: "typesafe/jev-latest", ms: 41.6,
      request: { state: { request: "refactor the parser" }, questions },
      result: { api: "typesafe", provider: "typesafe", model: "jev-1.13.0", answers, usage: { input: 120, output: 9, cacheRead: 0, cacheWrite: 0 } },
    });
    expect(r.backend).toBe("typesafe");
    expect(r.model).toBe("jev-1.13.0");
    expect(r.ms).toBe(42);
    expect(r.error).toBeUndefined();
    expect(Object.keys(r.questions)).toEqual(["level", "stopped", "quality"]);
    expect(r.answers?.level).toEqual({ type: "choice", choice: "high", probabilities: { low: 0.1, high: 0.7, xhigh: 0.2 }, confidence: 0.62 });
    expect(r.answers?.stopped).toEqual({ type: "noul", noul: 0.08 });
    expect(r.usage).toEqual({ input: 120, output: 9 });
    expect(r.state).toContain("refactor the parser");
    expect(r.stateTruncated).toBe(false);
  });

  test("a thrown call keeps the questions, records the error and carries no answers", () => {
    const r = captureJudgment({
      target: "master", backend: "typesafe", label: "typesafe/jev-latest", ms: 3,
      request: { state: "x", questions }, error: new Error("TypeSafe API error (503): busy"),
    });
    expect(r.error).toBe("TypeSafe API error (503): busy");
    expect(r.answers).toBeUndefined();
    expect(Object.keys(r.questions)).toHaveLength(3);
  });

  test("a question we cannot represent is dropped together with its answer, never one without the other", () => {
    const r = captureJudgment({
      target: "master", backend: "text", label: "anthropic/claude", ms: 1,
      request: { state: "x", questions: { ...questions, weird: { type: "rank", instructions: "?" } } },
      result: { answers: { ...answers, weird: { type: "rank", order: [1] }, quality: { type: "score", score: "high" } } },
    });
    expect(r.questions.weird).toBeUndefined();
    expect(r.answers?.weird).toBeUndefined();
    // a malformed answer to a good question: the question stays (the table shows "no answer")
    expect(r.questions.quality).toBeDefined();
    expect(r.answers?.quality).toBeUndefined();
  });

  test("the state preview is capped and says so; the full length is still reported", () => {
    const big = "y".repeat(STATE_PREVIEW_CHARS + 500);
    const r = captureJudgment({ target: "master", backend: "text", label: "l", ms: 0, request: { state: big, questions: {} } });
    expect(r.state).toHaveLength(STATE_PREVIEW_CHARS);
    expect(r.stateChars).toBe(STATE_PREVIEW_CHARS + 500);
    expect(r.stateTruncated).toBe(true);
  });
});

describe("parseJudgmentReport", () => {
  test("a captured report survives the wire (JSON) unchanged", () => {
    const sent = captureJudgment({
      target: "lane-3", backend: "text", label: "openai/gpt", ms: 7,
      request: { state: ["a", "b"], questions }, result: { api: "openai-responses", provider: "openai", model: "gpt-5", answers },
    });
    expect(parseJudgmentReport(JSON.parse(JSON.stringify(sent)))).toEqual(sent);
  });

  test("garbage is ignored, not thrown: wrong backend, empty target, non-object, missing questions", () => {
    expect(parseJudgmentReport(null)).toBeNull();
    expect(parseJudgmentReport("report")).toBeNull();
    expect(parseJudgmentReport({ target: "", backend: "typesafe", label: "", ms: 1, state: "", stateChars: 0, stateTruncated: false, questions: {} })).toBeNull();
    expect(parseJudgmentReport({ target: "master", backend: "jev", label: "", ms: 1, state: "", stateChars: 0, stateTruncated: false, questions: {} })).toBeNull();
    expect(parseJudgmentReport({ target: "master", backend: "typesafe", label: "", ms: 1, state: "", stateChars: 0, stateTruncated: false })).toBeNull();
  });

  test("a criteria map that is really an array is refused as a question (arktype would index it)", () => {
    const r = parseJudgmentReport({
      target: "master", backend: "typesafe", label: "l", ms: 1, state: "", stateChars: 0, stateTruncated: false,
      questions: { q: { type: "choice", instructions: "i", criteria: ["a", "b"] } },
    });
    expect(r?.questions.q).toBeUndefined();
  });
});

describe("view helpers", () => {
  test("purpose is inferred from the ids omp's callers use; anything else is the agent asking", () => {
    expect(judgmentPurpose({ questions: { level: questions.level } })).toBe("Auto-thinking effort");
    expect(judgmentPurpose({ questions: { bucket: questions.level } })).toBe("Auto-thinking effort");
    expect(judgmentPurpose({ questions: { stopped: questions.stopped } })).toBe("Unexpected-stop check");
    expect(judgmentPurpose({ questions: { file0: questions.stopped, file1: questions.stopped } })).toBe("Git AI staging");
    expect(judgmentPurpose({ questions })).toBe("Agent judge() call");
    expect(judgmentPurpose({ questions: {} })).toBe("Agent judge() call");
  });

  test("Jev counts as consulted only when a TypeSafe call ANSWERED; a failed call that fell back does not", () => {
    expect(jevConsulted([{ backend: "typesafe", error: "503" }, { backend: "text" }])).toBe(false);
    expect(jevConsulted([{ backend: "text" }])).toBe(false);
    expect(jevConsulted([{ backend: "typesafe", error: "503" }, { backend: "typesafe" }])).toBe(true);
  });

  test("answer summaries name the level a score landed on and keep the choice's option order", () => {
    const score = answerSummary(questions.quality, answers.quality);
    expect(score.headline).toBe("1.60 \u00b7 good");
    expect(score.bars.map((b) => b.label)).toEqual(["poor", "fair", "good"]);
    const choice = answerSummary(questions.level, answers.level);
    expect(choice.headline).toBe("high");
    expect(choice.bars.map((b) => b.label)).toEqual(["low", "high", "xhigh"]);
    expect(answerSummary(questions.stopped, answers.stopped).headline).toBe("8% yes");
    expect(answerSummary(questions.stopped, undefined).headline).toBe("no answer");
  });

  test("the backend label says Jev by model, else the provider/model that answered", () => {
    expect(backendLabel({ backend: "typesafe", model: "jev-1.13.0", label: "typesafe/jev-latest" })).toBe("Jev (jev-1.13.0)");
    expect(backendLabel({ backend: "typesafe", label: "typesafe/jev-latest" })).toBe("Jev (typesafe/jev-latest)");
    expect(backendLabel({ backend: "text", provider: "anthropic", model: "claude-fable-5-1", label: "x" })).toBe("anthropic/claude-fable-5-1");
    expect(backendLabel({ backend: "text", label: "local/tiny" })).toBe("local/tiny");
  });
});
