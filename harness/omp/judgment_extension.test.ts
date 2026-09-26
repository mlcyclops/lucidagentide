// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-JEV.2 (ADR-0377): the prototype wrapper that makes judgments visible. Driven through a fake judge class
// so the contract is pinned without the network: what omp gets back must be byte-for-byte what the judge
// returned (or threw), and the desktop must have the report BEFORE omp gets it.

import { describe, expect, test } from "bun:test";
import { TextJudge, TypeSafeJudge } from "@oh-my-pi/pi-ai/judgment";
import type { JudgmentReport } from "../judgment/trace.ts";
import { traceJudgePrototype, type JudgeLike } from "./judgment_extension.ts";

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
