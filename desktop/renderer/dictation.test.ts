// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// The fluid-dictation state machine (dictation.ts): utterance flushing, hands-free auto-stop, and the
// transcript merge. Pins the timing so live dictation stays responsive without cutting speech short.

import { describe, expect, it } from "bun:test";
import { DICTATION_DEFAULTS, dictationTick, downmixMono, encodeWavPcm16, mergeTranscript, newDictation, pushWave, resampleLinear, sttFailureMessage, waveClock, waveHeight, WHISPER_SAMPLE_RATE, type DictationState } from "./dictation.ts";

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

// P-STT.4: a dead STT engine must be VISIBLE (the old driver swallowed the fail-safe empty transcript,
// so a never-started Whisper server looked like "mic on, nothing happens").
describe("sttFailureMessage", () => {
  it("a failed request (null result) warns generically", () => {
    expect(sttFailureMessage(null)).toContain("Settings \u2192 Voice");
  });
  it("an unreachable server (backend 'unavailable' note) points at Local Whisper", () => {
    const m = sttFailureMessage({ text: "", note: "whisper.cpp STT unavailable (Unable to connect)" });
    expect(m).toContain("Local Whisper");
    expect(sttFailureMessage({ text: "", note: "STT unavailable (fetch failed); no transcript" })).toContain("Whisper URL");
  });
  it("the ElevenLabs no-key note passes through verbatim (it is already guidance)", () => {
    const note = "Add your ElevenLabs API key (Settings \u2192 Voice), or switch STT to offline Whisper.";
    expect(sttFailureMessage({ text: "", note })).toBe(note);
  });
  it("a successful transcript is never a failure", () => {
    expect(sttFailureMessage({ text: "hello world", note: "transcribed 9000 bytes via http://x/inference" })).toBeNull();
  });
  it("genuine silence (server answered, empty text) stays silent - no nagging", () => {
    expect(sttFailureMessage({ text: "", note: "transcribed 2000 bytes via http://x/inference" })).toBeNull();
    expect(sttFailureMessage({ text: "   ", note: "transcribed 2000 bytes via http://x/inference" })).toBeNull();
  });
});

// P-STT.4: the waveform chip's pure bits (ring buffer + level curve + clock).
describe("waveform helpers", () => {
  it("pushWave appends and drops the oldest beyond the cap", () => {
    const h: number[] = [];
    for (let i = 0; i < 7; i++) pushWave(h, i, 5);
    expect(h).toEqual([2, 3, 4, 5, 6]); // capped at 5, oldest gone, order kept
  });
  it("waveHeight is clamped to 0..1 and grows with level", () => {
    expect(waveHeight(0)).toBe(0);
    expect(waveHeight(-1)).toBe(0); // garbage in, floor out
    expect(waveHeight(0.5)).toBe(1); // a shout saturates, never overflows
    expect(waveHeight(0.02)).toBeLessThan(waveHeight(DICTATION_DEFAULTS.voiceLevel)); // monotone through the VAD threshold
    expect(waveHeight(DICTATION_DEFAULTS.voiceLevel)).toBeGreaterThan(0.5); // threshold speech is clearly visible
  });
  it("waveClock formats m:ss and degrades to 0:00 on garbage", () => {
    expect(waveClock(0)).toBe("0:00");
    expect(waveClock(4_300)).toBe("0:04");
    expect(waveClock(65_000)).toBe("1:05");
    expect(waveClock(-50)).toBe("0:00");
    expect(waveClock(Number.NaN)).toBe("0:00");
  });
});

// The mic records WebM/Opus, which whisper.cpp's /inference 400s; these pure helpers transcode a decoded
// clip to the 16 kHz mono 16-bit WAV every self-hosted Whisper accepts. Wrong bytes here = a silent mic.
describe("PCM -> WAV transcode (downmixMono / resampleLinear / encodeWavPcm16)", () => {
  const ascii = (b: Uint8Array, off: number, len: number): string => String.fromCharCode(...b.slice(off, off + len));

  it("downmixMono averages channels, passes a mono clip through untouched, empty -> empty", () => {
    expect(downmixMono([]).length).toBe(0);
    const mono = new Float32Array([0.1, 0.2]);
    expect(downmixMono([mono])).toBe(mono); // single channel returned as-is (no needless copy)
    const left = new Float32Array([1, 0, -1]);
    const right = new Float32Array([0, 0, 1]);
    expect(Array.from(downmixMono([left, right]))).toEqual([0.5, 0, 0]);
  });

  it("resampleLinear is identity at the same rate + empty input, decimates by the ratio, interpolates linearly", () => {
    const s = new Float32Array([0, 0.5, 1, 0.5]);
    expect(resampleLinear(s, 16000, 16000)).toBe(s); // same rate: the exact input, no allocation
    expect(resampleLinear(new Float32Array(0), 48000, 16000).length).toBe(0);
    expect(resampleLinear(new Float32Array(48), 48000, 16000).length).toBe(16); // 3:1 decimation
    const up = resampleLinear(new Float32Array([0, 1]), 1000, 2000); // upsample: midpoint is the average
    expect(up[0]).toBeCloseTo(0, 6);
    expect(up[1]).toBeCloseTo(0.5, 6);
  });

  it("encodeWavPcm16 writes a canonical 16-bit mono PCM header + little-endian, clamped samples", () => {
    const pcm = new Float32Array([0, 1, -1, 2, -2]); // the last two exceed full scale and must clamp
    const wav = encodeWavPcm16(pcm, WHISPER_SAMPLE_RATE);
    expect(wav.length).toBe(44 + pcm.length * 2);
    expect(ascii(wav, 0, 4)).toBe("RIFF");
    expect(ascii(wav, 8, 4)).toBe("WAVE");
    expect(ascii(wav, 12, 4)).toBe("fmt ");
    expect(ascii(wav, 36, 4)).toBe("data");
    const dv = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    expect(dv.getUint32(4, true)).toBe(36 + pcm.length * 2); // RIFF chunk size
    expect(dv.getUint16(20, true)).toBe(1); // audio format = PCM
    expect(dv.getUint16(22, true)).toBe(1); // channels = mono
    expect(dv.getUint32(24, true)).toBe(WHISPER_SAMPLE_RATE);
    expect(dv.getUint32(28, true)).toBe(WHISPER_SAMPLE_RATE * 2); // byte rate = rate * blockAlign
    expect(dv.getUint16(32, true)).toBe(2); // block align
    expect(dv.getUint16(34, true)).toBe(16); // bits per sample
    expect(dv.getUint32(40, true)).toBe(pcm.length * 2); // data chunk size
    expect(dv.getInt16(44, true)).toBe(0);
    expect(dv.getInt16(46, true)).toBe(0x7fff); // +1.0 -> full positive scale
    expect(dv.getInt16(48, true)).toBe(-0x8000); // -1.0 -> full negative scale
    expect(dv.getInt16(50, true)).toBe(0x7fff); // +2.0 clamped
    expect(dv.getInt16(52, true)).toBe(-0x8000); // -2.0 clamped
  });
});
