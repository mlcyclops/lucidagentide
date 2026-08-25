// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/voice/thinking_cues.ts
//
// P-VOICE.6 (ADR-0249) + P-VOICE.7 (ADR-0257): keep a hands-free user company while the agent is thinking.
//
// On screen, a long turn is legible - the thinking block streams, tool chips tick past, the HUD counts. With
// your eyes off it, all of that is DEAD AIR. Thirty seconds of silence after you have spoken is indis-
// tinguishable from a crash, and the natural reaction is to talk again, which in conversation mode starts a
// second turn on top of the first. A short spoken acknowledgement is what a person would give you.
//
// P-VOICE.7 adds three things a person would ALSO give you:
//   · variety - the opener is picked from a bank of twelve by a per-turn seed, so back-to-back turns never
//     greet you with the same canned line;
//   · active listening - when the ask is short enough to restate faithfully, the opener restates it
//     ("Got it: fix the login redirect. On it now.") so you hear that it heard YOU, not just that it woke up;
//   · thinking snapshots - once reasoning text is streaming, later cues lift the newest complete sentence out
//     of it ("Quick update: the timeout only fires on the retry path.") instead of canned filler, and keep
//     going at a slow cadence past the old three-cue cap for as long as the thinking genuinely moves forward.
//
// The restraint rules survive intact:
//   · gaps ESCALATE (a few seconds, then ten-ish, then twenty-ish) - reassurance, not nagging;
//   · after the third cue, ONLY a genuinely new snapshot may speak, and only every half minute;
//   · a hard cap per turn - past eight, more narration would be worse than silence;
//   · nothing once the answer has started speaking - the answer IS the acknowledgement;
//   · the gap is measured from the last thing SPOKEN, not from the turn start, so a long tool run in the
//     middle of a reply is covered the same way the opening think is.
//
// Pure: state in, one cue (or null) out. No timers, no clock, no audio, no randomness - the caller passes a
// per-turn seed, so one turn keeps one voice and tests stay deterministic.

export interface ThinkingCueState {
  /** How many cues have already been spoken THIS turn. */
  cuesSpoken: number;
  /** Milliseconds since the agent last said anything out loud (cue or answer). */
  sinceVoiceMs: number;
  /** The reply has begun speaking - from here the answer speaks for itself. */
  answerStarted: boolean;
  /** A tool call is in flight, which lets the cue say something truer than "thinking". */
  toolActive: boolean;
  /** Per-turn seed for bank picks. Stable within a turn so its cues share one register. */
  seed: number;
  /** Distilled restatement of the user's ask (distillTopic), or null when it cannot be restated faithfully. */
  topic?: string | null;
  /** The reasoning text streamed so far this turn - the raw material for snapshot cues. */
  thinking?: string | null;
  /** The last snapshot already spoken, so a stalled think is never narrated twice. */
  lastSnapshot?: string | null;
}

/** A cue to speak now. `snapshot` echoes the thinking sentence a snapshot cue consumed (the caller stores it
 *  back into `lastSnapshot`), and is null for canned lines. */
export interface ThinkingCue {
  text: string;
  snapshot: string | null;
}

/** Escalating gaps before cue 1, 2 and 3. The first is short (the silence right after you stop talking is
 *  the one that feels broken); the rest back off so a genuinely long turn is not narrated to death. */
export const CUE_GAPS_MS = [2600, 11000, 22000] as const;

/** Past the three canned cues, only fresh thinking snapshots speak, and only this often. */
export const SNAPSHOT_GAP_MS = 30000;

/** Hard per-turn ceiling across ALL cue kinds. */
export const MAX_CUES = 8;

/** Twelve openers, one register: acknowledge, promise work, stop. Every line is plain speech that ends in a
 *  full stop - speakable() leaves it alone and the engine lands the intonation. */
const OPENERS = [
  "Got it. Thinking this through.",
  "On it. Give me a moment.",
  "Okay, working on that now.",
  "Heard you. Let me think this over.",
  "Alright, let me reason through this.",
  "Copy that. Thinking it over now.",
  "One sec, lining up an answer.",
  "Okay, give me a beat to think.",
  "Understood. Working through it now.",
  "Let me chew on that for a second.",
  "Right, thinking through the details.",
  "Good question. Working it out now.",
] as const;

/** Active-listening openers: restate the requirement, then promise work. The colon/comma frames treat the
 *  topic as a quoted restatement, so any distilled fragment reads naturally regardless of its grammar. */
const RESTATE_TEMPLATES = [
  "Got it: {topic}. On it now.",
  "Okay, {topic}. Working on it.",
  "Understood: {topic}. Give me a moment.",
  "So, {topic}. Let me work through that.",
  "Right, {topic}. Thinking it through now.",
  "Heard you: {topic}. Let me dig in.",
] as const;

/** Cue 2 fallbacks (no snapshot yet). Two banks, because "let me check that" is a lie when nothing is
 *  running and "still thinking" undersells a tool sweep. */
const STILL_LINES = [
  "Still working on it. Give me a few seconds.",
  "Still on it. This needs a little thought.",
  "Working through it. Hang tight.",
  "Still thinking. Almost have a direction.",
] as const;

const TOOL_STILL_LINES = [
  "Still digging through this. One moment.",
  "Checking a few things. Hang tight.",
  "Running that down now. One moment.",
  "Gathering what I need. Almost there.",
] as const;

/** Cue 3 fallbacks (no snapshot yet). */
const ALMOST_LINES = [
  "Almost there. This one is taking a moment.",
  "Nearly done thinking. Thanks for waiting.",
  "Close now. Pulling the answer together.",
  "Wrapping up my thinking now.",
] as const;

const TOOL_ALMOST_LINES = [
  "Nearly done. Just checking a few more things.",
  "Almost there. Verifying a couple of details.",
  "Close now. Finishing the last checks.",
  "Wrapping up. One more thing to confirm.",
] as const;

/** Frames for a lifted thinking sentence. The sentence brings its own full stop. */
const SNAPSHOT_FRAMES = [
  "Quick update: {snap}",
  "Here is where I am: {snap}",
  "Status check: {snap}",
  "My thinking so far: {snap}",
] as const;

/** Seeded bank pick. Same seed, same pick - a turn keeps one voice; the next turn (new seed) gets another. */
function pick<T>(bank: readonly T[], seed: number, salt = 0): T {
  const i = Math.abs((seed | 0) + salt) % bank.length;
  return bank[i] as T;
}

function framedSnapshot(snap: string, seed: number, salt: number): string {
  return pick(SNAPSHOT_FRAMES, seed, salt).replace("{snap}", snap);
}

/** Distill the user's prompt into a short restatement for the active-listening opener, or null when it
 *  cannot be restated FAITHFULLY - a clipped or garbled echo is worse than a plain acknowledgement. Pure. */
export function distillTopic(prompt: string): string | null {
  const t = (prompt || "")
    .replace(/```[\s\S]*?```/g, " ")           // never restate a code block
    .replace(/`([^`]*)`/g, "$1")               // inline code: keep the word, drop the backticks
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")     // images have no speakable restatement
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")   // links: keep the label
    .replace(/https?:\/\/\S+/g, " ")           // a raw URL is not speech
    .replace(/\s+/g, " ")
    .trim();
  let s = (t.match(/^[^.!?\n]*/)?.[0] ?? "").trim(); // the first sentence carries the requirement
  // Peel conversational wrappers so the restatement is the REQUIREMENT, not the greeting around it.
  for (let prev = ""; prev !== s; ) {
    prev = s;
    s = s.replace(/^(hey|hi|hello|ok|okay|so|please|lucid|um|uh|also|and)[,!.\s]+/i, "");
    s = s.replace(/^(can|could|would|will) you\s+(please\s+)?/i, "");
    s = s.replace(/^(i('d| would) like( you)? to|i want( you)? to|i need( you)? to|help me( to)?)\s+/i, "");
  }
  s = s.replace(/[\s,;:]+$/, "").replace(/\s+please$/i, "");
  if (s.length < 8 || s.length > 72) return null;  // too thin, or too long to restate without mangling it
  if (/[{}<>|*_#\\]/.test(s)) return null;         // reads badly aloud; the plain opener is the honest choice
  if (/^[A-Z][a-z]/.test(s) && !/^I\b/.test(s)) s = s[0]!.toLowerCase() + s.slice(1); // mid-sentence casing
  return s;
}

/** Lift the newest complete, speakable sentence out of the reasoning stream, or null when there is nothing
 *  new worth saying. Returns null (not an older sentence) when the newest candidate was already spoken -
 *  a stalled think stays quiet rather than narrating backwards. Pure. */
export function thinkingSnapshot(thinking: string | null | undefined, lastSnapshot?: string | null): string | null {
  // Neutralize URLs BEFORE sentence-splitting: a URL's internal dots would sever the sentence and let its
  // tail slip past the filter. The pipe lands in the reject class below, disqualifying the whole sentence.
  const raw = (thinking ?? "").slice(-800).replace(/https?:\/\/\S+/g, "|"); // a snapshot is about NOW
  if (!raw.trim()) return null;
  const sentences = raw.match(/[^.!?\n]+[.!?]/g) ?? [];
  for (let i = sentences.length - 1; i >= 0; i--) {
    const s = (sentences[i] ?? "").replace(/[*_#]+/g, "").replace(/\s+/g, " ").trim();
    if (s.length < 24 || s.length > 160) continue;      // a fragment or a wall of text is not a summary
    if (/[{}<>|`;=\\]/.test(s)) continue; // code and URLs (now pipes) are not speech
    if (s.split(" ").length < 5) continue;
    if (lastSnapshot && s === lastSnapshot) return null; // the thinking has not moved on - stay quiet
    return s;
  }
  return null;
}

/** The cue to speak right now, or null when the right thing to do is stay quiet. */
export function nextThinkingCue(s: ThinkingCueState): ThinkingCue | null {
  if (s.answerStarted) return null;                    // the answer is already talking
  if (s.cuesSpoken >= MAX_CUES) return null;           // said enough; more would be nagging
  if (s.cuesSpoken < CUE_GAPS_MS.length) {
    const gap = CUE_GAPS_MS[s.cuesSpoken];
    if (gap === undefined || s.sinceVoiceMs < gap) return null;
    if (s.cuesSpoken === 0) {
      // The opener: restate the ask when it can be restated faithfully, otherwise a varied acknowledgement.
      const topic = (s.topic ?? "").trim();
      const text = topic ? pick(RESTATE_TEMPLATES, s.seed).replace("{topic}", topic) : pick(OPENERS, s.seed);
      return { text, snapshot: null };
    }
    // Cues 2 and 3: a REAL snapshot of the live thinking beats canned filler.
    const snap = thinkingSnapshot(s.thinking, s.lastSnapshot);
    if (snap) return { text: framedSnapshot(snap, s.seed, s.cuesSpoken), snapshot: snap };
    const bank = s.cuesSpoken === 1
      ? (s.toolActive ? TOOL_STILL_LINES : STILL_LINES)
      : (s.toolActive ? TOOL_ALMOST_LINES : ALMOST_LINES);
    return { text: pick(bank, s.seed), snapshot: null };
  }
  // Past the three canned cues: keep the user company ONLY while the thinking genuinely moves forward.
  if (s.sinceVoiceMs < SNAPSHOT_GAP_MS) return null;
  const snap = thinkingSnapshot(s.thinking, s.lastSnapshot);
  if (!snap) return null;
  return { text: framedSnapshot(snap, s.seed, s.cuesSpoken), snapshot: snap };
}
