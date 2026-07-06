// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/trivia.ts — P-TRIV.1 (ADR-0174): the Trivia Wire game core, PURE.
//
// The skills_dir.ts / steps_restore.ts convention: state in → HTML out, no DOM, no I/O, no timers.
// Everything a test needs to pin — the question cycle (no repeats until the bag empties), scoring
// (base 100 × streak multiplier capped at ×3), lifetime-score persistence through an INJECTED store
// (app.ts hands in localStorage; tests hand in a map), the visibility rule (only while the agent is
// streaming, after a grace delay), and the escaped ticker markup — lives here. app.ts owns only the
// animation loop, the wheel/hover/keyboard wiring, and where the ticker mounts in the status bar.
//
// SECURITY (CLAUDE.md invariant #5): question text is treated as UNTRUSTED DATA even though P-TRIV.1
// ships a static first-party bank — P-TRIV.2 will feed model-GENERATED packs through the same shapes,
// so the escaping discipline is load-bearing from day one. Every string is esc()'d into text-only
// spans; nothing here is ever markdown-rendered, executed, or fed back into any prompt. The game is
// strictly OFF the prompt path: it cannot touch the frozen prefix or the gate (invariants #4, #6).

import { esc } from "./format.ts";

/** One multiple-choice question. `a` indexes the correct choice; `x` is the one-line explanation. */
export interface TriviaQuestion {
  readonly topic: string;
  readonly q: string;
  readonly c: readonly [string, string, string, string];
  readonly a: 0 | 1 | 2 | 3;
  readonly x: string;
}

/** Shape gate for bank entries — P-TRIV.2's generated packs MUST pass this too (bad JSON → dropped,
 *  the game falls back to the seed bank; a malformed generation never breaks the ticker). */
export function isTriviaQuestion(v: unknown): v is TriviaQuestion {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.topic === "string" && o.topic.trim().length > 0
    && typeof o.q === "string" && o.q.trim().length > 0
    && Array.isArray(o.c) && o.c.length === 4 && o.c.every((s) => typeof s === "string" && s.trim().length > 0)
    && typeof o.a === "number" && Number.isInteger(o.a) && o.a >= 0 && o.a <= 3
    && typeof o.x === "string" && o.x.trim().length > 0;
}

export const TRIVIA_BASE_POINTS = 100;
export const TRIVIA_MAX_MULT = 3;
/** The ticker only appears once a turn has been streaming this long — short turns never flash it. */
export const TRIVIA_SHOW_AFTER_MS = 8000;
/** P-TRIV.2 idle engagement: how long the composer must sit empty (no turn running) before the
 *  ticker wakes up to keep a returning user engaged. Longer than the streaming grace on purpose —
 *  idle is a weaker signal of "waiting" than a running turn is. */
export const TRIVIA_IDLE_AFTER_MS = 15000;

export type TriviaPhase = "question" | "explain";

export interface TriviaSnapshot {
  phase: TriviaPhase;
  /** 1-based session question counter (display only; lifetime tallies are score/answered/correct). */
  qNum: number;
  question: TriviaQuestion;
  score: number;
  answered: number;
  correct: number;
  streak: number;
  lastGain: number;
  lastCorrect: boolean | null;
}

/** Injected persistence seam (app.ts → localStorage; tests → a map). Corrupt payloads degrade to zero. */
export interface TriviaStore { get(): string | null; set(v: string): void; }

export interface TriviaAnswerResult { correct: boolean; gained: number; correctIndex: number; }

export interface TriviaGame {
  state(): TriviaSnapshot;
  /** Answer the current question. Returns null when not answerable (wrong phase / bad index) —
   *  a second click or a stray keypress is a no-op, never a double score. */
  answer(k: number): TriviaAnswerResult | null;
  /** explain → next question. No-op in the question phase. */
  advance(): void;
  /** P-TRIV.3: move past an UNANSWERED question (the idle wire's park timeout). No score, no
   *  streak change, no tally - skipping is neutral. No-op in the explain phase. */
  skip(): void;
}

interface PersistedTally { score: number; answered: number; correct: number; }

function loadTally(store: TriviaStore | undefined): PersistedTally {
  if (!store) return { score: 0, answered: 0, correct: 0 };
  try {
    const raw = store.get();
    const o = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
    return { score: num(o.score), answered: num(o.answered), correct: num(o.correct) };
  } catch { return { score: 0, answered: 0, correct: 0 }; }
}

/** Fisher–Yates over index bags so no question repeats until the whole bank has been played. */
function shuffled(n: number, rng: () => number): number[] {
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); const t = a[i]!; a[i] = a[j]!; a[j] = t; }
  return a;
}

export function createTriviaGame(bank: readonly TriviaQuestion[], store?: TriviaStore, rng: () => number = Math.random): TriviaGame {
  const qs = bank.filter(isTriviaQuestion);
  if (qs.length === 0) throw new Error("trivia: empty question bank");
  const tally = loadTally(store);
  let bag = shuffled(qs.length, rng);
  let cur = bag.pop()!;
  let phase: TriviaPhase = "question";
  let qNum = 1, streak = 0, lastGain = 0;
  let lastCorrect: boolean | null = null;

  const persist = (): void => {
    try { store?.set(JSON.stringify(tally)); } catch { /* a full/blocked store never breaks play */ }
  };
  const next = (): number => {
    if (bag.length === 0) {
      bag = shuffled(qs.length, rng);
      // Avoid the same question back-to-back across a reshuffle boundary.
      if (qs.length > 1 && bag[bag.length - 1] === cur) { const t = bag[0]!; bag[0] = bag[bag.length - 1]!; bag[bag.length - 1] = t; }
    }
    return bag.pop()!;
  };

  return {
    state: () => ({ phase, qNum, question: qs[cur]!, score: tally.score, answered: tally.answered, correct: tally.correct, streak, lastGain, lastCorrect }),
    answer(k: number): TriviaAnswerResult | null {
      if (phase !== "question" || !Number.isInteger(k) || k < 0 || k > 3) return null;
      const ok = k === qs[cur]!.a;
      if (ok) { streak += 1; lastGain = TRIVIA_BASE_POINTS * Math.min(streak, TRIVIA_MAX_MULT); tally.score += lastGain; tally.correct += 1; }
      else { streak = 0; lastGain = 0; }
      tally.answered += 1;
      lastCorrect = ok;
      phase = "explain";
      persist();
      return { correct: ok, gained: lastGain, correctIndex: qs[cur]!.a };
    },
    advance(): void {
      if (phase !== "explain") return;
      cur = next();
      phase = "question";
      qNum += 1;
    },
    skip(): void {
      if (phase !== "question") return;
      cur = next();
      qNum += 1;
    },
  };
}

/** The visibility rule, pure so every branch is testable.
 *  Branch 1 (P-TRIV.1): an agent turn is streaming and has streamed past the grace — the boredom
 *  window. Branch 2 (P-TRIV.2 idle engagement): no turn is running, the composer sits EMPTY past
 *  the idle grace, and there is something to come back to — past sessions or an unlocked Knowledge
 *  Graph. A brand-new empty install (no history, locked/absent KG) never shows the game uninvited,
 *  and one keystroke in the composer hides it instantly (composerEmpty flips false). */
export function triviaVisible(o: {
  enabled: boolean; streaming: boolean; streamStartedAt: number | null; now: number;
  composerEmpty?: boolean; hasHistory?: boolean; kgUnlocked?: boolean; idleSince?: number | null;
}): boolean {
  if (!o.enabled) return false;
  if (o.streaming) return o.streamStartedAt !== null && o.now - o.streamStartedAt >= TRIVIA_SHOW_AFTER_MS;
  return o.composerEmpty === true
    && (o.hasHistory === true || o.kgUnlocked === true)
    && o.idleSince !== null && o.idleSince !== undefined
    && o.now - o.idleSince >= TRIVIA_IDLE_AFTER_MS;
}

// ───────── ticker markup (pure; every data string escaped) ─────────

/** Per-character spans so app.ts can hue-cycle the letters as they travel. esc() per char keeps a
 *  hostile question ("<img onerror=…>") inert — it renders as visible text, never as markup.
 *  Exported for trivia_news.ts (P-TRIV.3), which builds news lines through the same keystone. */
export function letterSpans(text: string): string {
  let out = "";
  for (const ch of text) out += `<span class="tl">${esc(ch)}</span>`;
  return out;
}

export const TRIVIA_CHOICE_LABELS = ["A", "B", "C", "D"] as const;

/** The question phase: Qn · scrolling letters · four clickable A–D pills. */
export function triviaQuestionHtml(s: TriviaSnapshot): string {
  const pills = s.question.c.map((c, k) =>
    `<span class="tch" role="button" tabindex="-1" data-tch="${k}"><b>${TRIVIA_CHOICE_LABELS[k]}</b>${esc(c)}</span>`).join("");
  return `<span class="tqn">Q${s.qNum}</span>${letterSpans(s.question.q)}${pills}<span class="tpad"></span>`;
}

/** The explain phase: a ✓ +gain / correct-letter prefix, then the one-line explanation. */
export function triviaExplainHtml(s: TriviaSnapshot): string {
  const head = s.lastCorrect
    ? `<span class="tvx ok">+${s.lastGain}</span>`
    : `<span class="tvx bad">${TRIVIA_CHOICE_LABELS[s.question.a]}:</span>`;
  return `${head}${letterSpans(s.question.x)}<span class="tpad"></span>`;
}
