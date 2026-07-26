// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/dictation.ts - P-STT.3: the "fluid dictation" state machine (pure).
//
// The old mic was batch: hold a whole recording, then transcribe the lump at the end. Fluid, native-feeling
// dictation instead transcribes UTTERANCE BY UTTERANCE - you speak, pause, and the words land in the composer
// while you keep going - and stops hands-free after a longer silence. This module owns the timing brain
// (voice-activity detection thresholds, when to flush an utterance, when to auto-stop) and the transcript
// merge. It is PURE (no DOM, no audio, no fetch), so the decisions are unit-tested; app.ts drives the mic
// (AnalyserNode level -> dictationTick), records per-utterance clips, and posts each to the existing
// /api/transcribe. Same trust posture: a transcript is ordinary user input, scanned on send.

export interface DictationTuning {
  /** Normalized RMS level (0..1) at/above which a frame counts as speech. */
  voiceLevel: number;
  /** Pause (ms) after speech that ends an utterance -> flush it for transcription. */
  flushSilenceMs: number;
  /** Longer trailing silence (ms) that ends the whole session hands-free. */
  autoStopSilenceMs: number;
  /** Minimum speech (ms) in a segment before it's worth flushing (ignores a stray click/cough). */
  minSpeechMs: number;
  /** Cap (ms) on one continuous utterance before flushing mid-stream (so a long monologue still streams in). */
  maxSegmentMs: number;
}

export const DICTATION_DEFAULTS: DictationTuning = {
  voiceLevel: 0.045,
  flushSilenceMs: 800,
  autoStopSilenceMs: 3000,
  minSpeechMs: 300,
  maxSegmentMs: 10_000,
};

export interface DictationState {
  /** Speech accumulated in the CURRENT segment (ms). */
  segMs: number;
  /** Continuous silence since the last voice frame (ms). */
  silenceMs: number;
  /** Speech captured since the last flush (there's a pending utterance to transcribe). */
  pendingSpeech: boolean;
  /** Any speech at all this session (gates auto-stop so it never fires before you start). */
  everSpoke: boolean;
}

export type DictationAction = "none" | "flush" | "stop";

export function newDictation(): DictationState {
  // everSpoke=false: a fresh session waits indefinitely for you to START talking; auto-stop only arms once
  // the first speech is heard, so it never cuts off before you've said anything.
  return { segMs: 0, silenceMs: 0, pendingSpeech: false, everSpoke: false };
}

/**
 * Advance the machine by `dtMs` given the current audio `level` (normalized RMS 0..1).
 *   - "flush": an utterance just ended (a short pause after enough speech) or hit the segment cap -> the
 *     driver stops the current clip, transcribes it, appends via mergeTranscript, and starts the next clip.
 *   - "stop": a long trailing silence -> end the session hands-free.
 * Pure: returns the action + the next state; the driver holds no timing logic.
 */
export function dictationTick(s: DictationState, level: number, dtMs: number, tune: DictationTuning = DICTATION_DEFAULTS): { action: DictationAction; state: DictationState } {
  const voice = level >= tune.voiceLevel;
  if (voice) {
    const segMs = s.segMs + dtMs;
    if (segMs >= tune.maxSegmentMs) {
      // Very long continuous speech: flush a chunk mid-stream, keep listening.
      return { action: "flush", state: { segMs: 0, silenceMs: 0, pendingSpeech: false, everSpoke: true } };
    }
    return { action: "none", state: { segMs, silenceMs: 0, pendingSpeech: true, everSpoke: true } };
  }
  const silenceMs = s.silenceMs + dtMs;
  // Hands-free stop after a long pause (only once the user has actually spoken).
  if (s.everSpoke && silenceMs >= tune.autoStopSilenceMs) {
    return { action: "stop", state: { segMs: 0, silenceMs, pendingSpeech: false, everSpoke: s.everSpoke } };
  }
  // A completed utterance: enough speech, then a short pause -> flush it (once per pause).
  if (s.pendingSpeech && s.segMs >= tune.minSpeechMs && silenceMs >= tune.flushSilenceMs) {
    return { action: "flush", state: { segMs: 0, silenceMs, pendingSpeech: false, everSpoke: s.everSpoke } };
  }
  return { action: "none", state: { segMs: s.segMs, silenceMs, pendingSpeech: s.pendingSpeech, everSpoke: s.everSpoke } };
}

/** Append a freshly-transcribed utterance to the running composer text with exactly one separating space
 *  (whisper returns already-punctuated text). Trims the chunk; a blank chunk leaves the text unchanged. */
export function mergeTranscript(current: string, chunk: string): string {
  const c = chunk.trim();
  if (!c) return current;
  const base = current.replace(/\s+$/, "");
  return base ? `${base} ${c}` : c;
}
