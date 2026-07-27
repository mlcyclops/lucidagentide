// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-VOICE.6 (ADR-0249): spoken "still working" cues. What matters is RESTRAINT - the failure mode is an
// agent that chatters over its own answer or narrates every second of a long turn.

import { expect, test } from "bun:test";
import { CUE_GAPS_MS, nextThinkingCue } from "./thinking_cues.ts";

const st = (o: Partial<Parameters<typeof nextThinkingCue>[0]> = {}) =>
  ({ cuesSpoken: 0, sinceVoiceMs: 0, answerStarted: false, toolActive: false, ...o });

test("silence shorter than the first gap stays silent", () => {
  expect(nextThinkingCue(st({ sinceVoiceMs: 0 }))).toBeNull();
  expect(nextThinkingCue(st({ sinceVoiceMs: CUE_GAPS_MS[0] - 1 }))).toBeNull();
  expect(nextThinkingCue(st({ sinceVoiceMs: CUE_GAPS_MS[0] }))).not.toBeNull();
});

test("the answer speaking always wins — a cue never talks over it", () => {
  for (const n of [0, 1, 2]) {
    expect(nextThinkingCue(st({ cuesSpoken: n, sinceVoiceMs: 999999, answerStarted: true }))).toBeNull();
  }
});

test("gaps escalate, so reassurance never becomes nagging", () => {
  for (let i = 1; i < CUE_GAPS_MS.length; i++) expect(CUE_GAPS_MS[i]!).toBeGreaterThan(CUE_GAPS_MS[i - 1]!);
  // Cue 2 is NOT due at cue 1's gap — the wait genuinely grows.
  expect(nextThinkingCue(st({ cuesSpoken: 1, sinceVoiceMs: CUE_GAPS_MS[0] }))).toBeNull();
  expect(nextThinkingCue(st({ cuesSpoken: 1, sinceVoiceMs: CUE_GAPS_MS[1]! }))).not.toBeNull();
});

test("there is a hard cap per turn", () => {
  expect(nextThinkingCue(st({ cuesSpoken: CUE_GAPS_MS.length, sinceVoiceMs: 999999 }))).toBeNull();
  expect(nextThinkingCue(st({ cuesSpoken: 99, sinceVoiceMs: 999999 }))).toBeNull();
});

test("each cue in a turn is different, and a tool run says something truer than 'thinking'", () => {
  const said = [0, 1, 2].map((n) => nextThinkingCue(st({ cuesSpoken: n, sinceVoiceMs: 999999 })));
  expect(said.every((s) => typeof s === "string" && s.length > 0)).toBe(true);
  expect(new Set(said).size).toBe(3); // never the same line twice in one turn
  const tool = nextThinkingCue(st({ sinceVoiceMs: 999999, toolActive: true }));
  expect(tool).not.toBe(said[0]);
  expect(tool).toMatch(/look into|check|digging/i);
});

test("cues are plain speech a TTS engine can read cleanly", () => {
  for (let n = 0; n < CUE_GAPS_MS.length; n++) {
    for (const toolActive of [false, true]) {
      const line = nextThinkingCue(st({ cuesSpoken: n, sinceVoiceMs: 999999, toolActive }))!;
      expect(line).not.toMatch(/[*_`#|<>]/);   // no markdown or markup to narrate
      expect(line).toMatch(/[.!?]$/);          // ends a sentence so the engine lands the intonation
      expect(line.length).toBeLessThan(60);    // short: it is filler, not content
    }
  }
});
