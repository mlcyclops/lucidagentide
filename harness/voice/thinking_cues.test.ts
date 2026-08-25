// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-VOICE.6 (ADR-0249) + P-VOICE.7 (ADR-0257): spoken "still working" cues. What matters is RESTRAINT - the
// failure mode is an agent that chatters over its own answer or narrates every second of a long turn - plus
// the P-VOICE.7 additions: varied openers, active-listening restatement, and thinking snapshots that only
// speak when the reasoning has genuinely moved forward.

import { expect, test } from "bun:test";
import { CUE_GAPS_MS, MAX_CUES, SNAPSHOT_GAP_MS, distillTopic, nextThinkingCue, thinkingSnapshot, type ThinkingCueState } from "./thinking_cues.ts";

const st = (o: Partial<ThinkingCueState> = {}): ThinkingCueState =>
  ({ cuesSpoken: 0, sinceVoiceMs: 0, answerStarted: false, toolActive: false, seed: 0, ...o });

const THINK = "First I checked the config. The timeout only fires on the retry path, not the happy path.";

test("silence shorter than the first gap stays silent", () => {
  expect(nextThinkingCue(st({ sinceVoiceMs: 0 }))).toBeNull();
  expect(nextThinkingCue(st({ sinceVoiceMs: CUE_GAPS_MS[0] - 1 }))).toBeNull();
  expect(nextThinkingCue(st({ sinceVoiceMs: CUE_GAPS_MS[0] }))).not.toBeNull();
});

test("the answer speaking always wins - a cue never talks over it", () => {
  for (const n of [0, 1, 2, 3, 5]) {
    expect(nextThinkingCue(st({ cuesSpoken: n, sinceVoiceMs: 999999, answerStarted: true, thinking: THINK }))).toBeNull();
  }
});

test("gaps escalate, so reassurance never becomes nagging", () => {
  for (let i = 1; i < CUE_GAPS_MS.length; i++) expect(CUE_GAPS_MS[i]!).toBeGreaterThan(CUE_GAPS_MS[i - 1]!);
  // Cue 2 is NOT due at cue 1's gap - the wait genuinely grows.
  expect(nextThinkingCue(st({ cuesSpoken: 1, sinceVoiceMs: CUE_GAPS_MS[0] }))).toBeNull();
  expect(nextThinkingCue(st({ cuesSpoken: 1, sinceVoiceMs: CUE_GAPS_MS[1]! }))).not.toBeNull();
});

test("there is a hard cap per turn, even with fresh thinking", () => {
  expect(nextThinkingCue(st({ cuesSpoken: MAX_CUES, sinceVoiceMs: 999999, thinking: THINK }))).toBeNull();
  expect(nextThinkingCue(st({ cuesSpoken: 99, sinceVoiceMs: 999999, thinking: THINK }))).toBeNull();
});

test("twelve distinct openers - the greeting varies turn to turn", () => {
  const seen = new Set<string>();
  for (let seed = 0; seed < 12; seed++) seen.add(nextThinkingCue(st({ seed, sinceVoiceMs: 999999 }))!.text);
  expect(seen.size).toBe(12);
  // ...and the SAME seed always gives the SAME opener - one turn keeps one voice.
  expect(nextThinkingCue(st({ seed: 7, sinceVoiceMs: 999999 }))!.text)
    .toBe(nextThinkingCue(st({ seed: 7, sinceVoiceMs: 999999 }))!.text);
});

test("active listening: a restatable ask is restated in the opener", () => {
  const topic = distillTopic("Can you fix the login redirect please?");
  expect(topic).toBe("fix the login redirect");
  const cue = nextThinkingCue(st({ sinceVoiceMs: 999999, topic }))!;
  expect(cue.text).toContain("fix the login redirect");
  expect(cue.snapshot).toBeNull();
  // Restatement templates vary too.
  const forms = new Set<string>();
  for (let seed = 0; seed < 6; seed++) forms.add(nextThinkingCue(st({ seed, sinceVoiceMs: 999999, topic }))!.text);
  expect(forms.size).toBe(6);
});

test("distillTopic refuses what it cannot restate faithfully", () => {
  expect(distillTopic("hi")).toBeNull(); // too thin
  expect(distillTopic("Refactor the entire authentication and session management subsystem across the desktop and web clients")).toBeNull(); // too long to echo without mangling
  expect(distillTopic("run `make test` for me")).toBe("run make test for me"); // inline code reads fine without backticks
  expect(distillTopic("check {weird} markup")).toBeNull(); // reads badly aloud
  expect(distillTopic("")).toBeNull();
});

test("each cue in a turn is different, and a tool run says something truer than 'thinking'", () => {
  const said = [0, 1, 2].map((n) => nextThinkingCue(st({ cuesSpoken: n, sinceVoiceMs: 999999 }))!.text);
  expect(said.every((s) => typeof s === "string" && s.length > 0)).toBe(true);
  expect(new Set(said).size).toBe(3); // never the same line twice in one turn
  const tool = nextThinkingCue(st({ cuesSpoken: 1, sinceVoiceMs: 999999, toolActive: true }))!.text;
  expect(tool).not.toBe(said[1]);
  expect(tool).toMatch(/digging|check|running|gathering/i);
});

test("a fresh thinking snapshot beats canned filler on later cues", () => {
  const cue = nextThinkingCue(st({ cuesSpoken: 1, sinceVoiceMs: 999999, thinking: THINK }))!;
  expect(cue.snapshot).toBe("The timeout only fires on the retry path, not the happy path.");
  expect(cue.text).toContain(cue.snapshot!);
});

test("a stalled think is never narrated twice - and past cue 3 silence returns", () => {
  const snap = thinkingSnapshot(THINK, null)!;
  // Same thinking, snapshot already spoken: cue 2 falls back to canned filler...
  const fallback = nextThinkingCue(st({ cuesSpoken: 1, sinceVoiceMs: 999999, thinking: THINK, lastSnapshot: snap }))!;
  expect(fallback.snapshot).toBeNull();
  // ...and past the third cue, no fresh snapshot means NO cue at all.
  expect(nextThinkingCue(st({ cuesSpoken: 3, sinceVoiceMs: 999999, thinking: THINK, lastSnapshot: snap }))).toBeNull();
  expect(nextThinkingCue(st({ cuesSpoken: 3, sinceVoiceMs: 999999 }))).toBeNull(); // no thinking at all
});

test("snapshot cues past the cap-of-three wait for the slow cadence", () => {
  expect(nextThinkingCue(st({ cuesSpoken: 3, sinceVoiceMs: SNAPSHOT_GAP_MS - 1, thinking: THINK }))).toBeNull();
  const cue = nextThinkingCue(st({ cuesSpoken: 3, sinceVoiceMs: SNAPSHOT_GAP_MS, thinking: THINK }));
  expect(cue).not.toBeNull();
  expect(cue!.snapshot).not.toBeNull();
});

test("thinkingSnapshot lifts speech, not code, URLs or fragments", () => {
  expect(thinkingSnapshot("const x = { a: 1 }; retry();", null)).toBeNull();
  expect(thinkingSnapshot("See https://example.com/docs for the details on this failing path.", null)).toBeNull();
  expect(thinkingSnapshot("Hmm. Ok. Short.", null)).toBeNull();
  expect(thinkingSnapshot("**The retry loop** never resets its _backoff_ counter after a success.", null))
    .toBe("The retry loop never resets its backoff counter after a success.");
  expect(thinkingSnapshot(null, null)).toBeNull();
});

test("cues are plain speech a TTS engine can read cleanly", () => {
  const topic = distillTopic("fix the login redirect on the settings page");
  for (let seed = 0; seed < 12; seed++) {
    for (let n = 0; n < 4; n++) {
      for (const toolActive of [false, true]) {
        for (const thinking of [null, THINK]) {
          const cue = nextThinkingCue(st({ seed, cuesSpoken: n, sinceVoiceMs: 999999, toolActive, thinking, topic: n === 0 ? topic : null }));
          if (!cue) continue; // cue 4+ with no fresh snapshot is legitimately silent
          expect(cue.text).not.toMatch(/[*_`#|<>]/); // no markdown or markup to narrate
          expect(cue.text).toMatch(/[.!?]$/);        // ends a sentence so the engine lands the intonation
          expect(cue.text.length).toBeLessThan(200); // snapshots carry content; filler stays much shorter
        }
      }
    }
  }
});
