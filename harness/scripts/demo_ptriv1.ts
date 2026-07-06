// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_ptriv1.ts
//
// P-TRIV.1 (ADR-0174): the Trivia Wire - a word-game ticker in the status bar's idle gap. Proves the
// PURE game core end to end (the DOM layer in app.ts is a thin animation shell over these calls):
//   [1] the SEED BANK is real: 50+ valid questions, no duplicate prompts, correct answers spread
//       across all four positions, a spread of topics;
//   [2] the QUESTION CYCLE never repeats a question until the whole bank has been played;
//   [3] SCORING is base 100 × streak multiplier capped at ×3; a wrong answer gains 0 and resets;
//       a double answer is a no-op (no double score);
//   [4] PERSISTENCE degrades safely: corrupt payloads → zero, a throwing store never breaks play,
//       and a lifetime score survives a fresh game through the same store;
//   [5] the VISIBILITY rule: only while an agent turn has been streaming past the grace delay -
//       never on short turns, gone the moment the turn ends, and OFF wins over everything;
//   [6] the ESCAPING keystone: a hostile question (markup in every field) renders as text, never as
//       markup - the exact shape P-TRIV.2's model-GENERATED packs will flow through.
//
// Run with: bun run harness/scripts/demo_ptriv1.ts

import {
  TRIVIA_BASE_POINTS, TRIVIA_SHOW_AFTER_MS,
  createTriviaGame, isTriviaQuestion, triviaExplainHtml, triviaQuestionHtml, triviaVisible,
  type TriviaQuestion,
} from "../../desktop/renderer/trivia.ts";
import { TRIVIA_BANK } from "../../desktop/renderer/trivia_bank.ts";

function fail(m: string): never { console.error(`FAIL: ${m}`); process.exit(1); }
function ok(m: string): void { console.log(`  PASS  ${m}`); }
const lcg = (seed = 42): (() => number) => {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
};

console.log("P-TRIV.1 demo - the Trivia Wire game core\n");

// [1] the seed bank is real
if (TRIVIA_BANK.length < 50) fail(`seed bank too small: ${TRIVIA_BANK.length}`);
for (const e of TRIVIA_BANK) if (!isTriviaQuestion(e)) fail(`invalid bank entry: ${JSON.stringify(e).slice(0, 80)}`);
if (new Set(TRIVIA_BANK.map((e) => e.q)).size !== TRIVIA_BANK.length) fail("duplicate prompts in the bank");
for (const p of [0, 1, 2, 3]) if (TRIVIA_BANK.filter((e) => e.a === p).length < 5) fail(`answer position ${p} underused - an 'always C' tell`);
const topics = new Set(TRIVIA_BANK.map((e) => e.topic));
if (topics.size < 6) fail(`too few topics: ${topics.size}`);
ok(`seed bank: ${TRIVIA_BANK.length} valid questions, ${topics.size} topics, answers spread across A-D`);

// [2] the cycle never repeats until the bank is exhausted
{
  const g = createTriviaGame(TRIVIA_BANK, undefined, lcg());
  const seen = new Set<string>();
  for (let i = 0; i < TRIVIA_BANK.length; i++) {
    const cur = g.state().question.q;
    if (seen.has(cur)) fail(`question repeated before the bank was exhausted: ${cur}`);
    seen.add(cur);
    g.answer(g.state().question.a); g.advance();
  }
  ok(`cycle: all ${TRIVIA_BANK.length} questions played once before any repeat`);
}

// [3] scoring: streak, cap, reset, idempotence
{
  const q: TriviaQuestion = { topic: "t", q: "Q?", c: ["w", "x", "y", "z"], a: 2, x: "Because." };
  const g = createTriviaGame([q], undefined, lcg());
  const gains: number[] = [];
  for (let i = 0; i < 4; i++) { gains.push(g.answer(2)!.gained); g.advance(); }
  if (gains.join(",") !== "100,200,300,300") fail(`streak gains wrong: ${gains.join(",")}`);
  const wrong = g.answer(0)!;
  if (wrong.correct || wrong.gained !== 0 || wrong.correctIndex !== 2) fail("wrong answer must gain 0 and reveal the correct index");
  g.advance();
  if (g.answer(2)!.gained !== TRIVIA_BASE_POINTS) fail("streak did not reset after a miss");
  if (g.answer(2) !== null) fail("a second answer must be a no-op");
  const s = g.state();
  if (s.score !== 100 + 200 + 300 + 300 + 100) fail(`lifetime score wrong: ${s.score}`);
  ok(`scoring: 100 -> 200 -> 300 -> 300 (capped), miss resets, double-answer is a no-op (score ${s.score})`);
}

// [4] persistence: corrupt degrades to zero; a real tally survives a new game; a throwing store never breaks play
{
  for (const raw of ["{nope", "[]", "42"]) {
    const g = createTriviaGame(TRIVIA_BANK, { get: () => raw, set: () => { } }, lcg());
    if (g.state().score !== 0) fail(`corrupt store '${raw}' did not degrade to zero`);
  }
  let saved: string | null = null;
  const store = { get: () => saved, set: (v: string) => { saved = v; } };
  const g1 = createTriviaGame(TRIVIA_BANK, store, lcg());
  g1.answer(g1.state().question.a);
  const g2 = createTriviaGame(TRIVIA_BANK, store, lcg(7));
  if (g2.state().score !== TRIVIA_BASE_POINTS || g2.state().answered !== 1) fail("lifetime tally did not survive a new game");
  const g3 = createTriviaGame(TRIVIA_BANK, { get: () => { throw new Error("boom"); }, set: () => { throw new Error("boom"); } }, lcg());
  if (g3.answer(g3.state().question.a) === null) fail("a throwing store broke play");
  ok("persistence: corrupt -> zero, tally survives restarts, a throwing store never breaks play");
}

// [5] the visibility rule
{
  const t0 = 50_000;
  if (triviaVisible({ enabled: true, streaming: false, streamStartedAt: null, now: t0 })) fail("visible while idle");
  if (triviaVisible({ enabled: true, streaming: true, streamStartedAt: t0, now: t0 + TRIVIA_SHOW_AFTER_MS - 1 })) fail("visible before the grace delay");
  if (!triviaVisible({ enabled: true, streaming: true, streamStartedAt: t0, now: t0 + TRIVIA_SHOW_AFTER_MS })) fail("not visible after the grace delay");
  if (triviaVisible({ enabled: true, streaming: false, streamStartedAt: t0, now: t0 + 99_999 })) fail("still visible after the turn ended");
  if (triviaVisible({ enabled: false, streaming: true, streamStartedAt: t0, now: t0 + 99_999 })) fail("visible while disabled - OFF must win");
  ok(`visibility: streaming-only, ${TRIVIA_SHOW_AFTER_MS / 1000}s grace, gone on turn end, OFF wins`);
}

// [6] the escaping keystone - hostile text in every field renders as text, never markup
{
  const hostile: TriviaQuestion = {
    topic: "t",
    q: `<img src=x onerror=alert(1)> & "quotes"`,
    c: [`<script>steal()</script>`, `b`, `c"`, `<b onmouseover=x>`],
    a: 0,
    x: `<svg onload=evil()> explained`,
  };
  const g = createTriviaGame([hostile], undefined, lcg());
  const qh = triviaQuestionHtml(g.state());
  for (const bad of ["<img", "<script", "<b onmouseover"]) if (qh.includes(bad)) fail(`raw markup leaked into the question line: ${bad}`);
  if (!qh.includes("&lt;")) fail("question text was not escaped");
  g.answer(0);
  const xh = triviaExplainHtml(g.state());
  if (xh.includes("<svg")) fail("raw markup leaked into the explanation line");
  ok("escaping: hostile question/choices/explanation render as text, never markup");
}

console.log("\nP-TRIV.1 demo: ALL GREEN - the Trivia Wire core holds its contracts.");
