// desktop/goal_verdict.ts
//
// P-GOAL.1 (ADR-0046): parse a /goal checker's reply into a {done, reason} verdict. Pure + unit-tested.
// Conservative and FAIL-CLOSED: anything unparseable or empty is NOT-done, so a broken or hijacked
// checker can never *falsely* stop the loop on a "done" it didn't actually verify.

export interface GoalVerdict { done: boolean; reason: string }

export function parseGoalVerdict(out: string): GoalVerdict {
  const m = /\{[^{}]*"done"[\s\S]*?\}/.exec(out ?? "");
  if (m) {
    try { const o = JSON.parse(m[0]) as { done?: unknown; reason?: unknown }; return { done: o.done === true, reason: String(o.reason ?? "").slice(0, 240) }; }
    catch { /* fall through to heuristic */ }
  }
  const t = (out ?? "").toLowerCase();
  if (!t.trim()) return { done: false, reason: "checker returned nothing (treated as not done)" };
  // NOTE: a bare "done" is deliberately NOT a positive keyword — it appears in the JSON key itself
  // (e.g. a truncated `{"done": tru`), which would falsely read as success. Require explicit pass words.
  const positive = /\b(passed|success|succeeded|exit code 0|all tests pass)\b/.test(t);
  const negative = /\b(not done|fail|failed|error|exit code [1-9]|still)\b/.test(t);
  return positive && !negative
    ? { done: true, reason: (out ?? "").trim().slice(0, 240) }
    : { done: false, reason: (out ?? "").trim().slice(0, 240) };
}
