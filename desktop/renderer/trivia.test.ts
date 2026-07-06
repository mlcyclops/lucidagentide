// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/trivia.test.ts — P-TRIV.1 (ADR-0174): the Trivia Wire game core.
//
// Pins the increment's contracts: bank integrity (the seed pack is valid, varied, duplicate-free),
// the question cycle (no repeats until the bag empties), scoring (base 100 × streak capped at ×3,
// a wrong answer resets), answer idempotence (a double click can never double-score), persistence
// through an injected store (corrupt payloads degrade to zero, a throwing store never breaks play),
// the streaming-only visibility rule, and the escaping keystone (hostile question text renders as
// text, never as markup — the shape P-TRIV.2's model-generated packs will flow through).

import { describe, expect, test } from "bun:test";
import {
  TRIVIA_BASE_POINTS, TRIVIA_IDLE_AFTER_MS, TRIVIA_MAX_MULT, TRIVIA_SHOW_AFTER_MS,
  createTriviaGame, isTriviaQuestion, triviaExplainHtml, triviaQuestionHtml, triviaVisible,
  type TriviaQuestion, type TriviaStore,
} from "./trivia.ts";
import { TRIVIA_BANK } from "./trivia_bank.ts";
import { TRIVIA_EXEC_BANK, TRIVIA_MANAGER_BANK, TRIVIA_SECURITY_BANK, bankForRole } from "./trivia_roles.ts";

// Tiny deterministic LCG so shuffle-order assertions are stable.
const lcg = (seed = 42): (() => number) => {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
};
const memStore = (initial: string | null = null): TriviaStore & { raw: string | null } => {
  const o = { raw: initial, get: () => o.raw, set: (v: string) => { o.raw = v; } };
  return o;
};
const q = (over: Partial<TriviaQuestion> = {}): TriviaQuestion => ({
  topic: "t", q: "Question?", c: ["w", "x", "y", "z"], a: 1, x: "Because.", ...over,
});

describe("seed bank integrity", () => {
  test("every entry passes the shape gate and the bank is big enough", () => {
    expect(TRIVIA_BANK.length).toBeGreaterThanOrEqual(100); // P-TRIV.3 floor
    for (const e of TRIVIA_BANK) expect(isTriviaQuestion(e)).toBe(true);
  });
  test("no duplicate prompts", () => {
    expect(new Set(TRIVIA_BANK.map((e) => e.q)).size).toBe(TRIVIA_BANK.length);
  });
  test("correct answers are spread across all four positions (no 'always C' tell)", () => {
    const byPos = [0, 1, 2, 3].map((p) => TRIVIA_BANK.filter((e) => e.a === p).length);
    for (const n of byPos) expect(n).toBeGreaterThanOrEqual(5);
  });
  test("covers a spread of topics", () => {
    expect(new Set(TRIVIA_BANK.map((e) => e.topic)).size).toBeGreaterThanOrEqual(6);
  });
});

describe("isTriviaQuestion", () => {
  test("accepts a well-formed question", () => expect(isTriviaQuestion(q())).toBe(true));
  test("rejects junk", () => {
    expect(isTriviaQuestion(null)).toBe(false);
    expect(isTriviaQuestion("hi")).toBe(false);
    expect(isTriviaQuestion({ ...q(), c: ["only", "three", "choices"] })).toBe(false);
    expect(isTriviaQuestion({ ...q(), a: 4 })).toBe(false);
    expect(isTriviaQuestion({ ...q(), a: 1.5 })).toBe(false);
    expect(isTriviaQuestion({ ...q(), q: "   " })).toBe(false);
    expect(isTriviaQuestion({ ...q(), x: "" })).toBe(false);
    expect(isTriviaQuestion({ ...q(), c: ["a", "b", "c", 4] })).toBe(false);
  });
});

describe("question cycle", () => {
  test("an empty bank throws (never a silent broken ticker)", () => {
    expect(() => createTriviaGame([])).toThrow();
    expect(() => createTriviaGame([{ bogus: true } as unknown as TriviaQuestion])).toThrow();
  });
  test("no question repeats until the whole bank has been played", () => {
    const bank = Array.from({ length: 7 }, (_, i) => q({ q: `Q${i}?` }));
    const g = createTriviaGame(bank, undefined, lcg());
    const seen: string[] = [];
    for (let i = 0; i < bank.length; i++) {
      seen.push(g.state().question.q);
      g.answer(g.state().question.a);
      g.advance();
    }
    expect(new Set(seen).size).toBe(bank.length);
  });
  test("no back-to-back repeat across the reshuffle boundary", () => {
    const bank = Array.from({ length: 5 }, (_, i) => q({ q: `Q${i}?` }));
    const g = createTriviaGame(bank, undefined, lcg(7));
    let prev = "";
    for (let i = 0; i < bank.length * 4; i++) {
      const cur = g.state().question.q;
      expect(cur).not.toBe(prev);
      prev = cur;
      g.answer(0); g.advance();
    }
  });
  test("qNum counts up per question", () => {
    const g = createTriviaGame(TRIVIA_BANK, undefined, lcg());
    expect(g.state().qNum).toBe(1);
    g.answer(0); g.advance();
    expect(g.state().qNum).toBe(2);
  });
});

describe("scoring", () => {
  test("base points, streak multiplier, and the ×3 cap", () => {
    const g = createTriviaGame([q()], undefined, lcg());
    expect(g.answer(1)?.gained).toBe(TRIVIA_BASE_POINTS);            // streak 1 → ×1
    g.advance();
    expect(g.answer(1)?.gained).toBe(TRIVIA_BASE_POINTS * 2);        // streak 2 → ×2
    g.advance();
    expect(g.answer(1)?.gained).toBe(TRIVIA_BASE_POINTS * 3);        // streak 3 → ×3
    g.advance();
    expect(g.answer(1)?.gained).toBe(TRIVIA_BASE_POINTS * TRIVIA_MAX_MULT); // capped
    expect(g.state().score).toBe(100 + 200 + 300 + 300);
    expect(g.state().correct).toBe(4);
    expect(g.state().answered).toBe(4);
  });
  test("a wrong answer gains nothing, resets the streak, and reveals the correct index", () => {
    const g = createTriviaGame([q()], undefined, lcg());
    g.answer(1); g.advance();                       // streak 1
    const r = g.answer(0)!;                         // wrong
    expect(r.correct).toBe(false);
    expect(r.gained).toBe(0);
    expect(r.correctIndex).toBe(1);
    expect(g.state().streak).toBe(0);
    g.advance();
    expect(g.answer(1)?.gained).toBe(TRIVIA_BASE_POINTS); // back to ×1
  });
  test("answer is idempotent and rejects junk indexes", () => {
    const g = createTriviaGame([q()], undefined, lcg());
    expect(g.answer(9)).toBeNull();
    expect(g.answer(-1)).toBeNull();
    expect(g.answer(1.5)).toBeNull();
    expect(g.answer(1)).not.toBeNull();
    expect(g.answer(1)).toBeNull();                 // second answer: no-op, no double score
    expect(g.state().score).toBe(TRIVIA_BASE_POINTS);
  });
  test("advance is a no-op in the question phase", () => {
    const g = createTriviaGame([q()], undefined, lcg());
    g.advance();
    expect(g.state().qNum).toBe(1);
    expect(g.state().phase).toBe("question");
  });
  test("skip moves past an unanswered question neutrally; no-op in explain (P-TRIV.3)", () => {
    const bank = Array.from({ length: 3 }, (_, i) => q({ q: `Q${i}?` }));
    const g = createTriviaGame(bank, undefined, lcg());
    const before = g.state().question.q;
    g.skip();
    expect(g.state().qNum).toBe(2);
    expect(g.state().phase).toBe("question");
    expect(g.state().question.q).not.toBe(before);
    expect(g.state().answered).toBe(0); // neutral: no tally, no score
    expect(g.state().score).toBe(0);
    g.answer(g.state().question.a);
    g.skip(); // explain phase → no-op
    expect(g.state().phase).toBe("explain");
  });
});

describe("persistence", () => {
  test("lifetime score survives a new game through the same store", () => {
    const store = memStore();
    const g1 = createTriviaGame([q()], store, lcg());
    g1.answer(1);
    const g2 = createTriviaGame([q()], store, lcg());
    expect(g2.state().score).toBe(TRIVIA_BASE_POINTS);
    expect(g2.state().answered).toBe(1);
    expect(g2.state().correct).toBe(1);
  });
  test("corrupt or hostile store payloads degrade to zero, never throw", () => {
    for (const raw of ["{nope", "[]", "42", JSON.stringify({ score: -50, answered: "x", correct: 1e99 ** 2 })]) {
      const g = createTriviaGame([q()], memStore(raw), lcg());
      expect(g.state().score).toBe(0);
      expect(g.state().answered).toBe(0);
    }
  });
  test("a throwing store never breaks play", () => {
    const g = createTriviaGame([q()], { get: () => { throw new Error("boom"); }, set: () => { throw new Error("boom"); } }, lcg());
    expect(g.answer(1)?.gained).toBe(TRIVIA_BASE_POINTS);
    expect(g.state().score).toBe(TRIVIA_BASE_POINTS);
  });
});

describe("visibility rule", () => {
  const at = (ms: number) => ({ enabled: true, streaming: true, streamStartedAt: 1000, now: 1000 + ms });
  test("only during a streaming turn, after the grace delay", () => {
    expect(triviaVisible({ enabled: true, streaming: false, streamStartedAt: null, now: 99999 })).toBe(false);
    expect(triviaVisible(at(TRIVIA_SHOW_AFTER_MS - 1))).toBe(false);
    expect(triviaVisible(at(TRIVIA_SHOW_AFTER_MS))).toBe(true);
    expect(triviaVisible({ ...at(99999), streaming: false })).toBe(false);  // turn ended → gone
    expect(triviaVisible({ ...at(99999), enabled: false })).toBe(false);    // user switched it off
    expect(triviaVisible({ ...at(99999), streamStartedAt: null })).toBe(false);
  });
});

describe("role banks (P-TRIV.2)", () => {
  const ROLE_BANKS = { executive: TRIVIA_EXEC_BANK, manager: TRIVIA_MANAGER_BANK, security: TRIVIA_SECURITY_BANK } as const;
  test("every role bank is real: valid shape, big enough, duplicate-free, answers spread", () => {
    // P-TRIV.3 floors: 100 for the specialist working banks, 50 seeded for the executive
    // (whose wire is half news interstitials by design).
    const FLOOR = { executive: 50, manager: 100, security: 100 } as const;
    for (const [role, bank] of Object.entries(ROLE_BANKS)) {
      expect(bank.length).toBeGreaterThanOrEqual(FLOOR[role as keyof typeof FLOOR]);
      for (const e of bank) expect(isTriviaQuestion(e)).toBe(true);
      expect(new Set(bank.map((e) => e.q)).size).toBe(bank.length);
      for (const p of [0, 1, 2, 3]) {
        expect(bank.filter((e) => e.a === p).length, `role ${role} answer position ${p}`).toBeGreaterThanOrEqual(8);
      }
    }
  });
  test("each bank stays in its role's domain (topic whitelists)", () => {
    for (const e of TRIVIA_EXEC_BANK) expect(e.topic.startsWith("govcon")).toBe(true);
    for (const e of TRIVIA_MANAGER_BANK) expect(["cmmi", "pm"]).toContain(e.topic);
    for (const e of TRIVIA_SECURITY_BANK) expect(["cmmc", "rmf"]).toContain(e.topic);
  });
  test("no prompt appears in two banks", () => {
    const all = [...TRIVIA_BANK, ...TRIVIA_EXEC_BANK, ...TRIVIA_MANAGER_BANK, ...TRIVIA_SECURITY_BANK];
    expect(new Set(all.map((e) => e.q)).size).toBe(all.length);
  });
  test("bankForRole: specialists get their domain, developer and no-role keep the general bank", () => {
    expect(bankForRole("executive")).toBe(TRIVIA_EXEC_BANK);
    expect(bankForRole("manager")).toBe(TRIVIA_MANAGER_BANK);
    expect(bankForRole("security")).toBe(TRIVIA_SECURITY_BANK);
    expect(bankForRole("developer")).toBe(TRIVIA_BANK);
    expect(bankForRole(null)).toBe(TRIVIA_BANK);
    expect(bankForRole(undefined)).toBe(TRIVIA_BANK);
  });
  test("a role bank plays through the same game core", () => {
    const g = createTriviaGame(TRIVIA_EXEC_BANK, undefined, lcg());
    expect(g.state().question.topic.startsWith("govcon")).toBe(true);
    expect(g.answer(g.state().question.a)?.gained).toBe(TRIVIA_BASE_POINTS);
  });
});

describe("idle engagement visibility (P-TRIV.2)", () => {
  const idleBase = {
    enabled: true, streaming: false, streamStartedAt: null as number | null,
    composerEmpty: true, hasHistory: true, kgUnlocked: false, idleSince: 1000,
  };
  test("empty composer + past sessions → visible after the idle grace, not before", () => {
    expect(triviaVisible({ ...idleBase, now: 1000 + TRIVIA_IDLE_AFTER_MS - 1 })).toBe(false);
    expect(triviaVisible({ ...idleBase, now: 1000 + TRIVIA_IDLE_AFTER_MS })).toBe(true);
  });
  test("an unlocked Knowledge Graph alone is enough history", () => {
    expect(triviaVisible({ ...idleBase, hasHistory: false, kgUnlocked: true, now: 999_999 })).toBe(true);
  });
  test("a brand-new empty install never shows the game uninvited", () => {
    expect(triviaVisible({ ...idleBase, hasHistory: false, kgUnlocked: false, now: 999_999 })).toBe(false);
  });
  test("one keystroke in the composer hides it (composerEmpty false)", () => {
    expect(triviaVisible({ ...idleBase, composerEmpty: false, now: 999_999 })).toBe(false);
  });
  test("no idle anchor or disabled → hidden", () => {
    expect(triviaVisible({ ...idleBase, idleSince: null, now: 999_999 })).toBe(false);
    expect(triviaVisible({ ...idleBase, enabled: false, now: 999_999 })).toBe(false);
  });
  test("the streaming branch takes precedence and ignores idle inputs", () => {
    // Mid-turn the ticker shows by the P-TRIV.1 rule even while the composer holds a queued prompt.
    expect(triviaVisible({ ...idleBase, streaming: true, streamStartedAt: 1000, composerEmpty: false, now: 1000 + TRIVIA_SHOW_AFTER_MS })).toBe(true);
    expect(triviaVisible({ ...idleBase, streaming: true, streamStartedAt: null, now: 999_999 })).toBe(false);
  });
  test("P-TRIV.1 callers (no idle fields) behave exactly as before", () => {
    expect(triviaVisible({ enabled: true, streaming: false, streamStartedAt: null, now: 999_999 })).toBe(false);
    expect(triviaVisible({ enabled: true, streaming: true, streamStartedAt: 1000, now: 1000 + TRIVIA_SHOW_AFTER_MS })).toBe(true);
  });
});

describe("ticker markup (escaping keystone)", () => {
  const hostile = q({
    q: `<img src=x onerror=alert(1)> & "quotes"`,
    c: [`<script>1</script>`, `b`, `c`, `d"`],
    x: `<svg onload=evil()> explained`,
  });
  test("hostile question text renders as text, never markup", () => {
    const g = createTriviaGame([hostile], undefined, lcg());
    const html = triviaQuestionHtml(g.state());
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;");
    // The four choice pills exist and carry their answer indexes.
    for (const k of [0, 1, 2, 3]) expect(html).toContain(`data-tch="${k}"`);
  });
  test("explain markup carries the gain when correct, the answer letter when wrong", () => {
    const g = createTriviaGame([hostile], undefined, lcg());
    g.answer(1);
    const okHtml = triviaExplainHtml(g.state());
    expect(okHtml).toContain(`+${TRIVIA_BASE_POINTS}`);
    expect(okHtml).not.toContain("<svg");

    const g2 = createTriviaGame([hostile], undefined, lcg());
    g2.answer(0);
    const badHtml = triviaExplainHtml(g2.state());
    expect(badHtml).toContain(">B:</span>");
    expect(badHtml).not.toContain("<svg");
  });
});
