// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-JEV.5 (ADR-0416): a LOCAL model that failed as a judge more than once is not asked again.
// P-JEV.6 (ADR-0421): a judge whose account says the model does not exist is not asked again, cloud or local.

import { describe, expect, test } from "bun:test";
import { bannedJudges, isLocalJudge, isMissingModelError, JUDGE_BAN_FAILURES, judgeBanEnv, noteJudgeOutcome, parseCommaList } from "./judge_bans.ts";

const LOCALS = ["dgx-spark", "ollama"];

describe("isLocalJudge", () => {
  test("a LUCID local provider slug or omp's on-device runner is local; a cloud provider is not", () => {
    expect(isLocalJudge("dgx-spark/glm-5.3-flash", LOCALS)).toBe(true);
    expect(isLocalJudge("local/qwen3-0.6b", LOCALS)).toBe(true);
    expect(isLocalJudge("anthropic/claude-haiku-4-5", LOCALS)).toBe(false);
    expect(isLocalJudge("typesafe/jev-latest", LOCALS)).toBe(false);
    expect(isLocalJudge("glm-5.3-flash", LOCALS)).toBe(false); // unqualified: no provider to match
  });
});

describe("noteJudgeOutcome + bannedJudges", () => {
  test("banned from the second failure on ('more than once'), never from one", () => {
    let l = noteJudgeOutcome({}, { label: "dgx-spark/glm-5.3-flash", error: "The operation was aborted." }, LOCALS, 1);
    expect(bannedJudges(l)).toEqual([]);
    l = noteJudgeOutcome(l, { label: "dgx-spark/glm-5.3-flash", error: "The operation was aborted." }, LOCALS, 2);
    expect(bannedJudges(l)).toEqual(["dgx-spark/glm-5.3-flash"]);
    expect(l["dgx-spark/glm-5.3-flash"]).toEqual({ failures: JUDGE_BAN_FAILURES, lastAt: 2, lastError: "The operation was aborted." });
  });
  test("a success, and a failure of a cloud judge, leave the ledger untouched (same object)", () => {
    const l = { "dgx-spark/glm-5.3-flash": { failures: 1, lastAt: 1, lastError: "x" } };
    expect(noteJudgeOutcome(l, { label: "dgx-spark/glm-5.3-flash" }, LOCALS, 2)).toBe(l);
    expect(noteJudgeOutcome(l, { label: "anthropic/claude-haiku-4-5", error: "overloaded" }, LOCALS, 2)).toBe(l);
  });
  // P-JEV.6 (ADR-0421): the operator's screenshot, verbatim: omp's smol pattern picked openai/gpt-5.3-codex-spark
  // under an API-key account that has no such model, and every judgment paid that 404 first.
  const MISSING = "404 The model `gpt-5.3-codex-spark` does not exist or you do not have access to it. (type=invalid_request_error param=model_not_found)";
  test("a judge whose account says the model does not exist is banned from ONE answer, cloud or local", () => {
    const cloud = noteJudgeOutcome({}, { label: "openai/gpt-5.3-codex-spark", error: MISSING }, LOCALS, 7);
    expect(bannedJudges(cloud)).toEqual(["openai/gpt-5.3-codex-spark"]);
    expect(cloud["openai/gpt-5.3-codex-spark"]!.failures).toBe(JUDGE_BAN_FAILURES);
    const local = noteJudgeOutcome({}, { label: "ollama/qwen3", error: 'model "qwen3" not found, try pulling it first' }, LOCALS, 8);
    expect(bannedJudges(local)).toEqual(["ollama/qwen3"]);
  });
  test("isMissingModelError: provider wording for a missing model, never a transient", () => {
    for (const e of [MISSING, '{"type":"error","error":{"type":"not_found_error","message":"model: claude-x"}}', "unknown model: foo", "No such model: bar", "The model `x` is not available"]) {
      expect(isMissingModelError(e)).toBe(true);
    }
    for (const e of ["overloaded", "429 rate limit exceeded", "502 Bad Gateway", "The operation was aborted.", "401 invalid api key", "", undefined]) {
      expect(isMissingModelError(e)).toBe(false);
    }
  });
  test("bans list oldest first and the env carries both lists", () => {
    let l = noteJudgeOutcome({}, { label: "ollama/qwen3", error: "e" }, LOCALS, 5);
    l = noteJudgeOutcome(l, { label: "ollama/qwen3", error: "e" }, LOCALS, 6);
    l = noteJudgeOutcome(l, { label: "dgx-spark/glm-5.3-flash", error: "e" }, LOCALS, 1);
    l = noteJudgeOutcome(l, { label: "dgx-spark/glm-5.3-flash", error: "e" }, LOCALS, 2);
    const banned = bannedJudges(l);
    expect(banned).toEqual(["dgx-spark/glm-5.3-flash", "ollama/qwen3"]);
    const env = judgeBanEnv(LOCALS, banned);
    expect(parseCommaList(env.LUCID_JUDGE_LOCAL_PROVIDERS)).toEqual(LOCALS);
    expect(parseCommaList(env.LUCID_JUDGE_BANS)).toEqual(banned);
    expect(parseCommaList(undefined)).toEqual([]);
  });
});
