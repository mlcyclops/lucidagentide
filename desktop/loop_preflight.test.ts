// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/loop_preflight.test.ts - P-GOAL.12 (ADR-0057): the Pre-Flight Audit's pure core.

import { describe, expect, test } from "bun:test";
import { type LoopRunRecord } from "./loop_runlog.ts";
import {
  assessReadiness,
  maturedGoalFrom,
  mergeMatured,
  parsePreflightJson,
  type PreflightSpec,
  preflightUserPrompt,
  relevantPriorRuns,
  renderLoopDesign,
  renderPriorRuns,
  successCriteria,
  summarizePriorRuns,
} from "./loop_preflight.ts";

function run(over: Partial<LoopRunRecord> = {}): LoopRunRecord {
  return {
    ts: 1000, id: "r", goal: "make auth tests pass", outcome: "stopped", outcomeReason: "3 lint errors remain",
    iterations: 5, maxIters: 6, durationMs: 1000, tools: 9, toolsByType: {}, added: 0, removed: 0,
    hasLoc: false, errors: 0, websites: 0, spendUsd: 0.4, hasSpend: true, ...over,
  };
}

function spec(over: Partial<PreflightSpec> = {}): PreflightSpec {
  return { goal: "Make all auth tests pass and fix lint", ...over };
}

describe("assessReadiness - gated levels", () => {
  test("bare objective ⇒ L0", () => {
    expect(assessReadiness(spec({ goal: "speed things up" })).level).toBe("L0"); // too short / vague-ish but present
    expect(assessReadiness({ goal: "" }).level).toBe("L0");
  });
  test("objective + done ⇒ L1", () => {
    expect(assessReadiness(spec({ doneDefinition: "all 42 auth tests green" })).level).toBe("L1");
  });
  test("objective + done + verification ⇒ L2", () => {
    expect(assessReadiness(spec({ doneDefinition: "all 42 auth tests green", command: "npm test" })).level).toBe("L2");
  });
  test("the safety-bearing four lift it to L3 (unattended-capable)", () => {
    const r = assessReadiness(spec({
      doneDefinition: "all 42 auth tests green", command: "npm test && npm run lint",
      budgetUsd: 2, scope: "branch: feat/auth", checkerIsCheap: true,
    }));
    expect(r.level).toBe("L3");
    expect(r.score).toBeGreaterThanOrEqual(90);
  });
  test("a long goal can NOT buy L3 without the verification command (no Verifier Theater)", () => {
    const r = assessReadiness(spec({ doneDefinition: "x".repeat(40), budgetUsd: 5, scope: "branch: x", checkerIsCheap: true }));
    expect(r.level).not.toBe("L3"); // missing command caps it
    expect(r.checks.find((c) => c.key === "verify")!.ok).toBe(false);
  });
  test("each failed check carries an actionable nudge", () => {
    const verify = assessReadiness(spec()).checks.find((c) => c.key === "verify")!;
    expect(verify.ok).toBe(false);
    expect(verify.nudge).toContain("Verifier Theater");
  });
});

describe("maturedGoalFrom", () => {
  test("distills a self-contained goal from the spec", () => {
    const g = maturedGoalFrom(spec({ doneDefinition: "all auth tests green", command: "npm test", nonGoals: "touch payments" }));
    expect(g).toContain("Make all auth tests pass");
    expect(g).toContain("Done when: all auth tests green");
    expect(g).toContain("`npm test`");
    expect(g).toContain("Do NOT: touch payments");
    expect(g.endsWith(".")).toBe(true);
  });
});

describe("renderLoopDesign", () => {
  test("repeatable report carries readiness, matured goal, design table, and gaps", () => {
    const s = spec({ doneDefinition: "tests green", command: "npm test", scope: "branch: feat/auth", budgetUsd: 2, maxIters: 6, checkerIsCheap: true, nonGoals: "do not touch payments or auth secrets" });
    const r = assessReadiness(s);
    const md = renderLoopDesign(s, r, maturedGoalFrom(s));
    expect(md).toContain("# Loop Design - Make all auth tests pass");
    expect(md).toContain("**Readiness: L3");
    expect(md).toContain("## Matured goal");
    expect(md).toContain("| Verification | `npm test` |");
    expect(md).toContain("- [x] Verification command");
    expect(md).toContain("_Nothing outstanding"); // no gaps at L3
  });
  test("an incomplete loop lists its gaps under 'Before you run'", () => {
    const s = spec();
    const md = renderLoopDesign(s, assessReadiness(s), maturedGoalFrom(s));
    expect(md).toContain("## Before you run");
    expect(md).toContain("**Verification command (exit 0 = done)**");
    expect(md).toContain("_none - checker judges self-report_");
  });
  test("escapes backslash-then-pipe and flattens newlines (CodeQL: incomplete escaping)", () => {
    const s = spec({ goal: "a | b\nc", risks: "C:\\tmp | bad" });
    const md = renderLoopDesign(s, assessReadiness(s), "g");
    expect(md).toContain("a \\| b c");           // pipe escaped, newline flattened
    expect(md).toContain("C:\\\\tmp \\| bad");   // backslash → \\ FIRST, then pipe → \|
  });
});

describe("model maturation (interview)", () => {
  test("parsePreflightJson extracts fields, fails soft on junk", () => {
    const ok = parsePreflightJson('noise {"maturedGoal":"do X","suggestedCommand":"make test"} trailing');
    expect(ok.maturedGoal).toBe("do X");
    expect(ok.suggestedCommand).toBe("make test");
    expect(parsePreflightJson("not json at all")).toEqual({});
  });
  test("mergeMatured fills gaps but never overrides what the user provided", () => {
    const merged = mergeMatured(spec({ command: "npm test" }), { suggestedCommand: "make", definitionOfDone: "green", risks: "infra" });
    expect(merged.command).toBe("npm test");      // user value wins
    expect(merged.doneDefinition).toBe("green");  // model fills the blank
    expect(merged.risks).toBe("infra");
  });
  test("preflightUserPrompt includes the answers that were given, omits the blanks", () => {
    const p = preflightUserPrompt(spec({ command: "npm test", scope: "branch: x" }));
    expect(p).toContain("Verification command (user): npm test");
    expect(p).toContain("Scope: branch: x");
    expect(p).not.toContain("Non-goals (user):");
  });
  test("preflightUserPrompt folds in stakeholder feedback + prior-run digest", () => {
    const p = preflightUserPrompt(spec({ feedback: "PO wants zero flaky tests" }), "Prior runs of similar loops:\n- ...");
    expect(p).toContain("product-owner feedback to honor: PO wants zero flaky tests");
    expect(p).toContain("don't repeat what already failed");
  });
});

describe("history awareness (don't lose context of past runs)", () => {
  test("relevantPriorRuns ranks by shared significant tokens, drops unrelated", () => {
    const records = [
      run({ id: "a", goal: "make auth tests pass", ts: 1 }),
      run({ id: "b", goal: "update the changelog", ts: 2 }),
      run({ id: "c", goal: "fix auth tests and lint", ts: 3 }),
    ];
    const rel = relevantPriorRuns(records, "make all auth tests pass", 3);
    expect(rel.map((r) => r.id)).toEqual(["a", "c"]); // both share "auth"/"tests"; changelog dropped
  });
  test("feedback flows into the matured goal", () => {
    expect(maturedGoalFrom(spec({ feedback: "ship by Friday" }))).toContain("Per product-owner feedback: ship by Friday");
  });
  test("summarizePriorRuns + renderPriorRuns state whether history exists", () => {
    expect(renderPriorRuns(0, [])).toContain("No prior loop runs on record");
    const rel = [run({ goal: "fix auth tests", outcome: "stopped", outcomeReason: "lint errors", iterations: 6 })];
    const md = renderPriorRuns(4, rel);
    expect(md).toContain("4 prior loop runs on record");
    expect(md).toContain(".omp/loops/");
    expect(md).toContain("⏹️ stopped in 6 iter");
    expect(summarizePriorRuns(rel)).toContain("fix auth tests");
  });
  test("renderLoopDesign surfaces a Prior runs section when history is passed", () => {
    const s = spec();
    const md = renderLoopDesign(s, assessReadiness(s), "g", { total: 2, relevant: [run({ goal: "auth tests" })] });
    expect(md).toContain("## Prior runs");
    expect(md).toContain("2 prior loop runs on record");
    expect(md).toContain("| User / PO feedback |");
  });
});

describe("successCriteria (checker context) + engineer input", () => {
  test("distills the checker's grading rubric from the matured design", () => {
    const c = successCriteria(spec({
      doneDefinition: "42 tests pass", command: "npm test", nonGoals: "edit payments",
      feedback: "no flaky tests", engineerNotes: "use the existing fixture loader",
    }));
    expect(c).toContain("Done when: 42 tests pass");
    expect(c).toContain("Proven by: `npm test` exits 0");
    expect(c).toContain("Must NOT: edit payments");
    expect(c).toContain("Honor (product-owner): no flaky tests");
    expect(c).toContain("Honor (engineer): use the existing fixture loader");
  });
  test("empty when nothing beyond the goal was specified", () => {
    expect(successCriteria(spec())).toBe("");
  });
  test("engineer notes flow into the matured goal and the design report", () => {
    expect(maturedGoalFrom(spec({ engineerNotes: "keep diffs small" }))).toContain("Per engineering guidance: keep diffs small");
    const s = spec({ engineerNotes: "keep diffs small" });
    expect(renderLoopDesign(s, assessReadiness(s), "g")).toContain("| Engineer notes | keep diffs small |");
  });
});
