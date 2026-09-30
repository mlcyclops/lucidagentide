// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-JEV.2 (ADR-0377): the prototype wrapper that makes judgments visible. Driven through a fake judge class
// so the contract is pinned without the network: what omp gets back must be byte-for-byte what the judge
// returned (or threw), and the desktop must have the report BEFORE omp gets it.

import { describe, expect, test } from "bun:test";
import { TextJudge, TypeSafeJudge } from "@oh-my-pi/pi-ai/judgment";
import type { JudgmentReport } from "../judgment/trace.ts";
import { JudgeBreaker, traceJudgePrototype, type JudgeLike } from "./judgment_extension.ts";

const questions = { stopped: { type: "noul", instructions: "Did it stop early?" } };
const answers = { stopped: { type: "noul", noul: 0.9 } };

class FakeJudge implements JudgeLike {
  label = "fake/model";
  calls = 0;
  constructor(private readonly fail?: Error) {}
  async judge(_request: { state: unknown; questions: unknown }): Promise<unknown> {
    this.calls++;
    if (this.fail) throw this.fail;
    return { api: "fake", provider: "fake", model: "m1", answers, usage: { input: 1, output: 1 } };
  }
}

function collector() {
  const reports: JudgmentReport[] = [];
  const order: string[] = [];
  const post = async (r: JudgmentReport) => { order.push("posted"); reports.push(r); };
  return { reports, order, post };
}

describe("traceJudgePrototype", () => {
  test("the result reaches omp unchanged and the desktop has the report first", async () => {
    class J extends FakeJudge {}
    const c = collector();
    expect(traceJudgePrototype(J.prototype, "text", "master", c.post)).toBe(true);
    const j = new J();
    const result = await j.judge({ state: { message: "I will do that next." }, questions });
    c.order.push("returned");
    expect(result).toEqual({ api: "fake", provider: "fake", model: "m1", answers, usage: { input: 1, output: 1 } });
    expect(c.order).toEqual(["posted", "returned"]);
    expect(c.reports).toHaveLength(1);
    const r = c.reports[0]!;
    expect(r).toMatchObject({ target: "master", backend: "text", label: "fake/model", model: "m1", answers });
    expect(r.state).toContain("I will do that next.");
    expect(r.ms).toBeGreaterThanOrEqual(0);
  });

  test("a throwing judge is reported with its error and STILL throws to omp (the fallback chain stays intact)", async () => {
    class J extends FakeJudge {}
    const c = collector();
    traceJudgePrototype(J.prototype, "typesafe", "master", c.post);
    const boom = new Error("TypeSafe API error (503): busy");
    await expect(new J(boom).judge({ state: "s", questions })).rejects.toBe(boom);
    expect(c.reports[0]).toMatchObject({ backend: "typesafe", error: "TypeSafe API error (503): busy" });
    expect(c.reports[0]!.answers).toBeUndefined();
  });

  test("a failing post never changes what omp sees", async () => {
    class J extends FakeJudge {}
    traceJudgePrototype(J.prototype, "text", "master", async () => { throw new Error("desktop gone"); });
    const result = await new J().judge({ state: "s", questions });
    expect(result).toMatchObject({ model: "m1" });
  });

  test("wrapping twice traces once", async () => {
    class J extends FakeJudge {}
    const c = collector();
    traceJudgePrototype(J.prototype, "text", "master", c.post);
    traceJudgePrototype(J.prototype, "text", "master", c.post);
    await new J().judge({ state: "s", questions });
    expect(c.reports).toHaveLength(1);
  });

  test("the fleet lane's target rides on every report", async () => {
    class J extends FakeJudge {}
    const c = collector();
    traceJudgePrototype(J.prototype, "text", "lane-7", c.post);
    await new J().judge({ state: "s", questions });
    expect(c.reports[0]!.target).toBe("lane-7");
  });

  test("the real pi-ai classes expose the method the wrapper needs (the seam this increment rests on)", () => {
    expect(typeof TypeSafeJudge.prototype.judge).toBe("function");
    expect(typeof TextJudge.prototype.judge).toBe("function");
  });
});

// P-JEV.5 (ADR-0416): the in-process circuit breaker for local judges.
describe("JudgeBreaker", () => {
  const locals = ["dgx-spark"];
  test("a local judge is asked twice, then refused BEFORE the call with a plain error (omp moves to the next candidate)", async () => {
    class J extends FakeJudge { label = "dgx-spark/glm-5.3-flash"; }
    const c = collector();
    const breaker = new JudgeBreaker(locals, []);
    traceJudgePrototype(J.prototype, "text", "master", c.post, breaker);
    const dead = new J(new Error("The operation was aborted."));
    await expect(dead.judge({ state: "s", questions })).rejects.toThrow("aborted");
    await expect(dead.judge({ state: "s", questions })).rejects.toThrow("aborted");
    expect(dead.calls).toBe(2);
    const err = await dead.judge({ state: "s", questions }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe("Error"); // never an AbortError: omp rethrows those and ends the judgment
    expect((err as Error).message).toContain("dgx-spark/glm-5.3-flash is not asked after 2 failed judgments");
    expect(dead.calls).toBe(2); // the model was not called
    expect(c.reports).toHaveLength(2); // a skip is not a judgment: no trace row for it
  });
  test("a cloud judge's TRANSIENT failures never refuse it, however many", async () => {
    class J extends FakeJudge { label = "anthropic/claude-haiku-4-5"; }
    const breaker = new JudgeBreaker(locals, []);
    traceJudgePrototype(J.prototype, "text", "master", async () => {}, breaker);
    const flaky = new J(new Error("overloaded"));
    for (let i = 0; i < 4; i++) await expect(flaky.judge({ state: "s", questions })).rejects.toThrow("overloaded");
    expect(flaky.calls).toBe(4);
  });
  // P-JEV.6 (ADR-0421): omp cools down only 401/402/403; a 404 for the model was re-paid on every judgment.
  test("a CLOUD judge whose account says the model does not exist is refused from the next call on", async () => {
    class J extends FakeJudge { label = "openai/gpt-5.3-codex-spark"; }
    const breaker = new JudgeBreaker(locals, []);
    traceJudgePrototype(J.prototype, "text", "master", async () => {}, breaker);
    const missing = new J(new Error("404 The model `gpt-5.3-codex-spark` does not exist or you do not have access to it. (type=invalid_request_error param=model_not_found)"));
    await expect(missing.judge({ state: "s", questions })).rejects.toThrow("does not exist");
    await expect(missing.judge({ state: "s", questions })).rejects.toThrow("this account has no such model");
    expect(missing.calls).toBe(1);
  });
  test("a ban from the desktop's ledger (LUCID_JUDGE_BANS) applies from the first call", async () => {
    class J extends FakeJudge { label = "dgx-spark/glm-5.3-flash"; }
    const breaker = new JudgeBreaker(locals, ["dgx-spark/glm-5.3-flash"]);
    traceJudgePrototype(J.prototype, "text", "master", async () => {}, breaker);
    const j = new J();
    await expect(j.judge({ state: "s", questions })).rejects.toThrow("not asked");
    expect(j.calls).toBe(0);
  });
});
