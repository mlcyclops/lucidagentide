// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/voice/thinking_cues.ts
//
// P-VOICE.6 (ADR-0249): keep a hands-free user company while the agent is thinking.
//
// On screen, a long turn is legible - the thinking block streams, tool chips tick past, the HUD counts. With
// your eyes off it, all of that is DEAD AIR. Thirty seconds of silence after you have spoken is indis-
// tinguishable from a crash, and the natural reaction is to talk again, which in conversation mode starts a
// second turn on top of the first. A short spoken acknowledgement is what a person would give you.
//
// The hard part is restraint. A cue every few seconds is worse than silence, and a cue that lands on top of
// the answer is worse still, so:
//   · gaps ESCALATE (a few seconds, then ten-ish, then twenty-ish) - reassurance, not nagging;
//   · a hard cap per turn - after three the user knows it is working;
//   · nothing once the answer has started speaking - the answer IS the acknowledgement;
//   · the gap is measured from the last thing SPOKEN, not from the turn start, so a long tool run in the
//     middle of a reply is covered the same way the opening think is.
//
// Pure: state in, one line of speech or null out. No timers, no clock, no audio.

export interface ThinkingCueState {
  /** How many cues have already been spoken THIS turn. */
  cuesSpoken: number;
  /** Milliseconds since the agent last said anything out loud (cue or answer). */
  sinceVoiceMs: number;
  /** The reply has begun speaking - from here the answer speaks for itself. */
  answerStarted: boolean;
  /** A tool call is in flight, which lets the cue say something truer than "thinking". */
  toolActive: boolean;
}

/** Escalating gaps before cue 1, 2 and 3. The first is short (the silence right after you stop talking is
 *  the one that feels broken); the rest back off so a genuinely long turn is not narrated to death. */
export const CUE_GAPS_MS = [2600, 11000, 22000] as const;

/** What to say, indexed by how many cues have already gone out. Two banks, because "let me check that" is a
 *  lie when nothing is running and "still thinking" undersells a tool sweep. Every line is plain speech that
 *  ends in a full stop - speakable() leaves it alone and the engine lands the intonation. */
const IDLE_LINES = [
  "Got it. Thinking this through.",
  "Still working on it. Give me a few seconds.",
  "Almost there. This one is taking a moment.",
] as const;

const TOOL_LINES = [
  "Got it. Let me look into that.",
  "Still digging through this. One moment.",
  "Nearly done. Just checking a few more things.",
] as const;

/** The cue to speak right now, or null when the right thing to do is stay quiet. */
export function nextThinkingCue(s: ThinkingCueState): string | null {
  if (s.answerStarted) return null;                       // the answer is already talking
  if (s.cuesSpoken >= CUE_GAPS_MS.length) return null;    // said enough; more would be nagging
  const gap = CUE_GAPS_MS[s.cuesSpoken];
  if (gap === undefined || s.sinceVoiceMs < gap) return null;
  const bank = s.toolActive ? TOOL_LINES : IDLE_LINES;
  return bank[s.cuesSpoken] ?? null;
}
