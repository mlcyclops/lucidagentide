// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// The fluid-dictation state machine (dictation.ts): utterance flushing, hands-free auto-stop, and the
// transcript merge. Pins the timing so live dictation stays responsive without cutting speech short.

import { describe, expect, it } from "bun:test";
import { DICTATION_DEFAULTS, dictationTick, mergeTranscript, newDictation, type DictationState } from "./dictation.ts";

const LOUD = 0.2; // clearly speech (above voiceLevel)
const QUIET = 0.0; // silence
// Drive a level for `ms` at `step` increments, collecting any actions.
function drive(s: DictationState, level: number, ms: number, step = 100): { state: DictationState; actions: string[] } {
  const actions: string[] = [];
  for (let t = 0; t < ms; t += step) {
    const r = dictationTick(s, level, step);
    s = r.state;
    if (r.action !== "none") actions.push(r.action);
  }
  return { state: s, actions };
}

describe("mergeTranscript", () => {
  it("appends utterances with a single separating space", () => {
    expect(mergeTranscript("Fix the auth guard", "and run the tests.")).toBe("Fix the auth guard and run the tests.");
  });
  it("returns the chunk when the composer is empty", () => {
    expect(mergeTranscript("", "Hello there.")).toBe("Hello there.");
  });
  it("a blank chunk leaves the text unchanged, and trailing space never doubles", () => {
    expect(mergeTranscript("keep me", "   ")).toBe("keep me");
    expect(mergeTranscript("keep me ", "go")).toBe("keep me go");
  });
});

describe("dictationTick", () => {
  it("flushes one utterance after a short pause following enough speech", () => {
    let s = newDictation();
    ({ state: s } = drive(s, LOUD, 1000)); // ~1s of speech
    const r = drive(s, QUIET, DICTATION_DEFAULTS.flushSilenceMs); // then the flush-pause
    expect(r.actions.filter((a) => a === "flush").length).toBe(1); // exactly one flush per utterance
  });

  it("ignores a stray blip below the minimum speech duration (no flush)", () => {
    let s = newDictation();
    ({ state: s } = drive(s, LOUD, 100)); // 100ms < minSpeechMs
    const r = drive(s, QUIET, DICTATION_DEFAULTS.flushSilenceMs);
    expect(r.actions).not.toContain("flush");
  });

  it("auto-stops hands-free after a long trailing silence (only once you've spoken)", () => {
    let s = newDictation();
    ({ state: s } = drive(s, LOUD, 600)); // speak
    const r = drive(s, QUIET, DICTATION_DEFAULTS.autoStopSilenceMs + 200);
    expect(r.actions).toContain("flush"); // the utterance flushed first
    expect(r.actions).toContain("stop"); // then the session auto-stopped
  });

  it("never auto-stops before the first word (a fresh session waits for you)", () => {
    const r = drive(newDictation(), QUIET, DICTATION_DEFAULTS.autoStopSilenceMs * 3);
    expect(r.actions).toEqual([]); // silence with no prior speech -> nothing
  });

  it("flushes mid-stream on a very long continuous utterance (still streams in)", () => {
    const r = drive(newDictation(), LOUD, DICTATION_DEFAULTS.maxSegmentMs + 500);
    expect(r.actions).toContain("flush");
  });
});
