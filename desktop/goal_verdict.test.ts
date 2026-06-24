// desktop/goal_verdict.test.ts
//
// P-GOAL.1 (ADR-0046): the /goal checker parser. Over-tested on the ONE property that makes an
// unattended loop safe — it is FAIL-CLOSED: a broken, empty, or garbled checker reply is NOT-done, so
// the loop never falsely declares success on a "done" it didn't verify.

import { describe, expect, test } from "bun:test";
import { parseGoalVerdict } from "./goal_verdict.ts";

describe("parseGoalVerdict", () => {
  test("strict JSON done=true", () => {
    expect(parseGoalVerdict('{"done": true, "reason": "all tests pass"}')).toEqual({ done: true, reason: "all tests pass" });
  });
  test("strict JSON done=false (embedded in prose)", () => {
    expect(parseGoalVerdict('Result: {"done": false, "reason": "2 tests failing"} ok').done).toBe(false);
  });
  test("only literal true counts as done (truthy strings do not)", () => {
    expect(parseGoalVerdict('{"done": "yes", "reason": "x"}').done).toBe(false);
    expect(parseGoalVerdict('{"done": 1, "reason": "x"}').done).toBe(false);
  });

  // Fail-closed cases — the safety property.
  test("empty reply ⇒ not done", () => { expect(parseGoalVerdict("").done).toBe(false); });
  test("whitespace reply ⇒ not done", () => { expect(parseGoalVerdict("   \n ").done).toBe(false); });
  test("malformed JSON never throws ⇒ not done", () => { expect(parseGoalVerdict('{"done": tru').done).toBe(false); });
  test("rambling with no verdict ⇒ not done", () => { expect(parseGoalVerdict("I think it might be okay maybe?").done).toBe(false); });

  // Heuristic fallback (no JSON).
  test("clear pass language ⇒ done", () => { expect(parseGoalVerdict("The command passed with exit code 0.").done).toBe(true); });
  test("pass AND fail mentioned ⇒ not done (conservative)", () => { expect(parseGoalVerdict("Tests passed but lint failed.").done).toBe(false); });
  test("non-zero exit ⇒ not done", () => { expect(parseGoalVerdict("It finished with exit code 1.").done).toBe(false); });
});
