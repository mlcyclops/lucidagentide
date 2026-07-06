// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/skill_studio.test.ts — P-SKILL.5 (ADR-0101): Skill Studio core. Over-tests the defensive
// parse of UNTRUSTED model output (parseCandidates never throws, drops malformed/thin candidates, caps
// count), the DATA-delimited digest, the YAML-safe SKILL.md builder, and analyzeWork threading the
// gathered model into the model call. The scan-gate on codify is proven end-to-end in demo-P-SKILL.5.

import { describe, expect, test } from "bun:test";
import { ANALYSIS_SYSTEM, analyzeWork, buildSkillMd, buildWorkDigest, parseCandidates, type WorkDigestInput } from "./skill_studio.ts";

describe("parseCandidates — defensive parse of untrusted model output", () => {
  test("parses the documented {candidates:[…]} object shape", () => {
    const raw = JSON.stringify({ candidates: [{ name: "auth-triage", description: "Triage auth failures when logins break; not for infra outages.", body: "# steps\n1. check tokens", rationale: "recurring" }] });
    const c = parseCandidates(raw);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ name: "auth-triage", rationale: "recurring" });
  });
  test("parses a bare array and a ```json fenced block", () => {
    expect(parseCandidates('[{"name":"x-y","description":"does a thing when needed","body":"do it"}]')).toHaveLength(1);
    expect(parseCandidates('here you go:\n```json\n{"candidates":[{"name":"x-y","description":"does a thing when needed","body":"do it"}]}\n```\nthanks').length).toBe(1);
  });
  test("slugs a non-kebab name to kebab-case", () => {
    expect(parseCandidates('[{"name":"Auth Triage!","description":"triage when auth breaks","body":"steps"}]')[0].name).toBe("auth-triage");
  });
  test("drops candidates missing a description or body, and unusable names", () => {
    expect(parseCandidates('[{"name":"a","description":"","body":"x"}]')).toHaveLength(0);
    expect(parseCandidates('[{"name":"a","description":"d","body":"   "}]')).toHaveLength(0);
    expect(parseCandidates('[{"name":"!!!","description":"d","body":"x"}]')).toHaveLength(0);
  });
  test("caps the candidate count", () => {
    const many = JSON.stringify({ candidates: Array.from({ length: 12 }, (_, i) => ({ name: `skill-${i}`, description: "a valid description here", body: "body" })) });
    expect(parseCandidates(many, 6)).toHaveLength(6);
  });
  test("garbage / empty / non-JSON never throws → []", () => {
    expect(parseCandidates("not json at all")).toEqual([]);
    expect(parseCandidates("")).toEqual([]);
    expect(parseCandidates('{"candidates":"nope"}')).toEqual([]);
    expect(parseCandidates("{oops")).toEqual([]);
  });
});

describe("buildWorkDigest — delimited DATA", () => {
  const base: WorkDigestInput = { window: "week", model: "gpt-x", sessions: [{ title: "Auth work", when: "2026-07-06", userExcerpts: ["fix the login bug"] }], aiLoc: [{ repo: "app", loc: 120, edits: 4 }], loops: [{ goal: "green tests", iters: 3, done: true }] };
  test("wraps everything in the trust-boundary markers and lists each section", () => {
    const d = buildWorkDigest(base);
    expect(d.startsWith("UNTRUSTED_CONTENT_START")).toBe(true);
    expect(d.trimEnd().endsWith("UNTRUSTED_CONTENT_END")).toBe(true);
    expect(d).toContain("Primary model: gpt-x");
    expect(d).toContain("Auth work");
    expect(d).toContain("fix the login bug");
    expect(d).toContain("app: +120 LOC over 4 edit(s)");
    expect(d).toContain("met in 3 iter(s): green tests");
  });
  test("an empty window still produces a valid delimited digest", () => {
    const d = buildWorkDigest({ window: "today", model: "", sessions: [], aiLoc: [], loops: [] });
    expect(d).toContain("UNTRUSTED_CONTENT_START");
    expect(d).toContain("No significant recent work");
  });
});

describe("buildSkillMd — valid, YAML-safe frontmatter", () => {
  test("emits frontmatter + body and strips any model-supplied frontmatter", () => {
    const md = buildSkillMd({ name: "my-skill", description: "does X when Y, not when Z", body: "---\nname: bogus\ndescription: bogus\n---\n\n# real body\nstep 1" });
    expect(md).toContain("name: my-skill");
    expect(md).toContain('description: "does X when Y, not when Z"');
    expect(md).toContain("# real body");
    expect(md).not.toContain("name: bogus");
  });
  test("collapses a multi-line description to one line and escapes quotes", () => {
    const md = buildSkillMd({ name: "x", description: 'line one\nline "two"', body: "b" });
    expect(md).toContain('description: "line one line \\"two\\""');
    expect(md.split("\n").filter((l) => l.startsWith("description:"))).toHaveLength(1);
  });
});

describe("analyzeWork — gather → digest → model → parse", () => {
  test("threads the gathered model into the model call and returns parsed candidates", async () => {
    let sawModel = "";
    let sawSystem = "";
    const gather = async (window: "today" | "week"): Promise<WorkDigestInput> => ({ window, model: "primary-model", sessions: [], aiLoc: [], loops: [] });
    const complete = async (system: string, _user: string, model?: string): Promise<string> => {
      sawModel = model ?? ""; sawSystem = system;
      return JSON.stringify({ candidates: [{ name: "loop-triage", description: "triage a failing loop when it stalls", body: "steps" }] });
    };
    const res = await analyzeWork("week", { gather, complete });
    expect(sawModel).toBe("primary-model"); // the digest's model is passed to complete
    expect(sawSystem).toBe(ANALYSIS_SYSTEM);
    expect(res.model).toBe("primary-model");
    expect(res.candidates).toHaveLength(1);
    expect(res.candidates[0].name).toBe("loop-triage");
  });
  test("a model that returns nothing usable yields zero candidates (never throws)", async () => {
    const res = await analyzeWork("today", { gather: async (w) => ({ window: w, model: "m", sessions: [], aiLoc: [], loops: [] }), complete: async () => "sorry, I can't help with that" });
    expect(res.candidates).toEqual([]);
  });
});
