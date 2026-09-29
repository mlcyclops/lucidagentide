// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-JEV.5 (ADR-0416): a LOCAL model that failed as a judge more than once is not asked again.

import { describe, expect, test } from "bun:test";
import { bannedJudges, isLocalJudge, JUDGE_BAN_FAILURES, judgeBanEnv, noteJudgeOutcome, parseCommaList } from "./judge_bans.ts";

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
