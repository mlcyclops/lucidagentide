// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/dictation.ts - P-STT.3: the "fluid dictation" state machine (pure).
//
// The old mic was batch: hold a whole recording, then transcribe the lump at the end. Fluid, native-feeling
// dictation instead transcribes UTTERANCE BY UTTERANCE - you speak, pause, and the words land in the composer
// while you keep going - and stops hands-free after a longer silence. This module owns the timing brain
// (voice-activity detection thresholds, when to flush an utterance, when to auto-stop), the transcript
// merge, and the PCM -> WAV encode that makes a clip transcribable. It is PURE (no DOM, no audio capture,
// no fetch), so the decisions are unit-tested; app.ts drives the mic (AnalyserNode level -> dictationTick),
// records per-utterance clips, transcodes them to WAV with the helpers below, and posts each to the existing
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

// ── P-STT.4: make dictation failures VISIBLE ────────────────────────────────
// The STT backends are fail-safe by design (empty text + a note, never a throw), which the old driver
// silently discarded: a Whisper server that was never started produced a pulsing mic and NOTHING in the
// composer, with zero feedback. This pure classifier decides, from one transcribe result, whether the
// engine itself failed (worth a warning with a fix) or the utterance was just silence (never nag).

/** A transcribe result as the renderer sees it (null = the request itself failed). */
export interface SttResultLike { text: string; note?: string }

/**
 * The user-facing message to show for a FAILED utterance, or null when nothing is wrong (text landed,
 * or the clip was genuine silence). Detection leans on the stable backend contract: every failure note
 * contains "unavailable"; the no-key ElevenLabs note is already user-facing guidance and passes through.
 */
export function sttFailureMessage(r: SttResultLike | null | undefined): string | null {
  if (!r) return "The transcription request failed. Check Settings \u2192 Voice.";
  if (r.text.trim()) return null;
  const note = r.note ?? "";
  if (note.startsWith("Add your ElevenLabs")) return note;
  if (/unavailable/i.test(note)) {
    return "No speech-to-text server answered. Start Local Whisper in Settings \u2192 Voice (Install & start), or point the Whisper URL at a running server.";
  }
  return null; // transcribed fine but heard nothing: silence, not an error
}

// ── P-STT.4: mini waveform next to the mic ──────────────────────────────────
// While dictation is live, the composer shows a small scrolling level history (newest at the right,
// seconds sliding left) so the user SEES the mic hearing them. These are the pure bits: the ring buffer
// and the level -> bar-height curve; app.ts owns the canvas.

/** Append a level sample in place, keeping at most `cap` samples (oldest dropped). Returns `hist`. */
export function pushWave(hist: number[], level: number, cap: number): number[] {
  hist.push(level);
  if (hist.length > cap) hist.splice(0, hist.length - cap);
  return hist;
}

/** Map a normalized RMS level (0..~0.5 for speech) to a bar height fraction (0..1). A sqrt-ish curve so
 *  quiet speech is still visible; clamped so a shout can't overflow the strip. */
export function waveHeight(level: number): number {
  return Math.min(1, Math.sqrt(Math.max(0, level) * 14));
}

/** Elapsed-session clock for the waveform chip: "m:ss". Negative/NaN degrade to 0:00. */
export function waveClock(ms: number): string {
  const s = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// ── PCM -> WAV: make a recorded clip transcribable ──────────────────────────
// The mic records WebM/Opus (MediaRecorder), but whisper.cpp's /inference and OpenAI-compatible STT servers
// decode WAV/PCM, NOT the WebM container - so a raw upload 400s and the mic looks "heard you, but nothing
// transcribed". app.ts decodes the clip with the Web Audio API (Chromium decodes its own WebM/Opus) and
// feeds the resulting PCM through these PURE helpers to build a 16 kHz mono 16-bit WAV before uploading.
// 16 kHz mono is whisper's native input; a smaller, universally-decodable payload.

/** whisper's native input sample rate. Encode clips at this rate so no server-side resample is needed. */
export const WHISPER_SAMPLE_RATE = 16000;

/** Downmix N channels of Float32 PCM to one by averaging. 0 channels -> empty; 1 channel returns as-is. */
export function downmixMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0);
  if (channels.length === 1) return channels[0];
  const n = channels[0].length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let c = 0; c < channels.length; c++) sum += channels[c][i] ?? 0;
    out[i] = sum / channels.length;
  }
  return out;
}

/** Resample mono Float32 PCM from `fromRate` to `toRate` with linear interpolation. Same rate (or empty
 *  input) returns the input unchanged. Pure: no Web Audio. Linear is ample for speech STT. */
export function resampleLinear(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || samples.length === 0 || fromRate <= 0 || toRate <= 0) return samples;
  const ratio = toRate / fromRate;
  const outLen = Math.max(1, Math.round(samples.length * ratio));
  const out = new Float32Array(outLen);
  const last = samples.length - 1;
  for (let i = 0; i < outLen; i++) {
    const srcPos = i / ratio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(i0 + 1, last);
    const frac = srcPos - i0;
    out[i] = samples[i0] * (1 - frac) + samples[i1] * frac;
  }
  return out;
}

/** Encode mono Float32 PCM (range [-1, 1]) as a 16-bit little-endian PCM WAV and return the file bytes.
 *  Pure: no Web Audio / DOM. Out-of-range samples are clamped. This is the container whisper.cpp and any
 *  OpenAI-compatible STT reliably decode. */
export function encodeWavPcm16(samples: Float32Array, sampleRate: number): Uint8Array<ArrayBuffer> {
  const n = samples.length;
  const blockAlign = 2; // mono, 16-bit
  const dataBytes = n * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const dv = new DataView(buf);
  const writeStr = (off: number, s: string) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
  writeStr(0, "RIFF");
  dv.setUint32(4, 36 + dataBytes, true); // RIFF chunk size
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  dv.setUint32(16, 16, true); // fmt chunk size (PCM)
  dv.setUint16(20, 1, true); // audio format = PCM
  dv.setUint16(22, 1, true); // channels = mono
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * blockAlign, true); // byte rate
  dv.setUint16(32, blockAlign, true);
  dv.setUint16(34, 16, true); // bits per sample
  writeStr(36, "data");
  dv.setUint32(40, dataBytes, true);
  let off = 44;
  for (let i = 0; i < n; i++) {
    const s = samples[i] < -1 ? -1 : samples[i] > 1 ? 1 : samples[i];
    dv.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return new Uint8Array(buf);
}
