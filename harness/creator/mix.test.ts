// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/creator/mix.test.ts - CREATOR-5 (ADR-0289) keystone tests.
//
// The claims that must hold or the mixer is lying about what you made:
//   * the same graph renders byte-identical audio twice,
//   * a muted (or unsoloed, or zeroed, or bus-muted) track contributes EXACTLY nothing, byte-wise,
//   * two layered clips sum, they do not replace each other,
//   * a hot mix is REPORTED (true peak + clipped sample count), never silently normalized,
//   * a sample-rate mismatch refuses the render instead of pretending to resample.

import { describe, expect, test } from "bun:test";
import { buildWav, parseWav, type WavFormat } from "../brief/tts_backend.ts";
import { docFromSource, SILENCE_SOURCE, type SourceAudio } from "./timeline.ts";
import {
  emptyMix, envelopeGainAt, clipFadeGain, headroomGain, mixDurationMs, mixSourceIds, mixTrack,
  normalizeEnvelope, panGains, renderMix, soloedTrackIds, trackFromTimeline, trackSilenceReason,
  validateMix, type MixClip, type MixGraph, type MixTrack,
} from "./mix.ts";

const MONO: WavFormat = { channels: 1, sampleRate: 1000, bitsPerSample: 16 }; // 1ms = 1 frame = 2 bytes
const STEREO: WavFormat = { channels: 2, sampleRate: 1000, bitsPerSample: 16 };

/** A constant-valued mono source, so a summed sample is arithmetic the test can predict exactly. */
function flatWav(samples: number, value: number, fmt: WavFormat = MONO): Uint8Array {
  const data = new Uint8Array(samples * 2 * fmt.channels);
  for (let i = 0; i < samples * fmt.channels; i++) {
    const u = value < 0 ? value + 0x10000 : value;
    data[i * 2] = u & 0xff;
    data[i * 2 + 1] = (u >> 8) & 0xff;
  }
  return buildWav(fmt, data);
}

function source(wav: Uint8Array): SourceAudio {
  const { fmt, data } = parseWav(wav);
  return { fmt, data };
}

const clip = (over: Partial<MixClip> & { id: string; sourceId: string; durationMs: number }): MixClip => ({
  startMs: 0, srcStartMs: 0, gain: 1, fadeInMs: 0, fadeOutMs: 0, ...over,
});

/** Read frame `f`, channel `c` out of a rendered WAV's PCM. */
const at = (pcm: Uint8Array, f: number, channels = 1, c = 0): number => {
  const o = (f * channels + c) * 2;
  const raw = pcm[o]! | (pcm[o + 1]! << 8);
  return (raw & 0x8000) ? raw - 0x10000 : raw;
};

const rendered = (graph: MixGraph, sources: ReadonlyMap<string, SourceAudio>): Uint8Array => {
  const r = renderMix(graph, sources);
  if (!r.ok) throw new Error(r.error);
  return parseWav(r.wav).data;
};

const refused = (r: { ok: true } | { ok: false; error: string }): string => {
  if (r.ok) throw new Error("expected a refusal, got a successful render");
  return r.error;
};

/** Two tracks, 100ms each, one at 1000 and one at 2000, over the same span: the layering fixture. */
function twoLayers(): { graph: MixGraph; sources: Map<string, SourceAudio> } {
  const graph: MixGraph = {
    ...emptyMix(1000, 1),
    tracks: [
      mixTrack({ id: "narration", label: "Narration", clips: [clip({ id: "n1", sourceId: "voice", durationMs: 100 })] }),
      mixTrack({ id: "bed", label: "Music bed", clips: [clip({ id: "b1", sourceId: "bed", durationMs: 100 })] }),
    ],
  };
  return { graph, sources: new Map([["voice", source(flatWav(100, 1000))], ["bed", source(flatWav(100, 2000))]]) };
}

describe("the graph's invariants", () => {
  test("an empty mix is valid but refuses to render, because there is nothing to render", () => {
    const graph = emptyMix(48000, 2);
    expect(validateMix(graph)).toEqual([]);
    expect(mixDurationMs(graph)).toBe(0);
    expect(refused(renderMix(graph, new Map()))).toMatch(/empty mix/);
  });

  test("validateMix names each structural problem rather than returning a bare false", () => {
    const bad: MixGraph = {
      ...emptyMix(1000, 3),
      bitsPerSample: 24,
      masterGain: -1,
      tracks: [mixTrack({ id: "t", label: "T", pan: 4, clips: [clip({ id: "c", sourceId: "s", durationMs: 10, fadeInMs: 8, fadeOutMs: 8 })] })],
    };
    const problems = validateMix(bad);
    expect(problems).toContain("a mix renders to 1 or 2 channels");
    expect(problems).toContain("only 16-bit PCM is supported");
    expect(problems).toContain("masterGain must be zero or greater");
    expect(problems).toContain("track t has a pan outside -1..1");
    expect(problems.some((p) => p.includes("fades overlap"))).toBe(true);
  });

  test("a track pointing at a bus that does not exist is a named problem", () => {
    const graph: MixGraph = { ...emptyMix(1000, 1), tracks: [mixTrack({ id: "t", label: "T", busId: "ghost" })] };
    expect(validateMix(graph)[0]).toBe("track t names bus ghost, which does not exist");
  });

  test("duration is the furthest clip end, and muting does not shorten it", () => {
    const graph: MixGraph = {
      ...emptyMix(1000, 1),
      tracks: [
        mixTrack({ id: "a", label: "A", clips: [clip({ id: "a1", sourceId: "s", durationMs: 100 })] }),
        mixTrack({ id: "b", label: "B", muted: true, clips: [clip({ id: "b1", sourceId: "s", startMs: 400, durationMs: 100 })] }),
      ],
    };
    expect(mixDurationMs(graph)).toBe(500);
  });

  test("mixSourceIds lists what the render will ask for, and skips silence", () => {
    const graph: MixGraph = {
      ...emptyMix(1000, 1),
      tracks: [mixTrack({ id: "t", label: "T", clips: [
        clip({ id: "c1", sourceId: "a", durationMs: 10 }),
        clip({ id: "c2", sourceId: "a", durationMs: 10, startMs: 10 }),
        clip({ id: "c3", sourceId: SILENCE_SOURCE, durationMs: 10, startMs: 20 }),
      ] })],
    };
    expect(mixSourceIds(graph)).toEqual(["a"]);
  });
});

describe("the gain stages", () => {
  test("an empty envelope is a flat 1, and points are held flat outside their range", () => {
    expect(envelopeGainAt([], 500)).toBe(1);
    const env = normalizeEnvelope([{ atMs: 100, gain: 0.5 }, { atMs: 300, gain: 1 }]);
    expect(envelopeGainAt(env, 0)).toBe(0.5);
    expect(envelopeGainAt(env, 100)).toBe(0.5);
    expect(envelopeGainAt(env, 200)).toBeCloseTo(0.75, 6);
    expect(envelopeGainAt(env, 300)).toBe(1);
    expect(envelopeGainAt(env, 9999)).toBe(1);
  });

  test("normalizeEnvelope sorts, rounds, de-duplicates by time, and drops nonsense", () => {
    const env = normalizeEnvelope([
      { atMs: 300, gain: 1 }, { atMs: 100.4, gain: 0.5 }, { atMs: 100, gain: 0.25 },
      { atMs: Number.NaN, gain: 1 }, { atMs: 50, gain: -3 },
    ]);
    expect(env).toEqual([{ atMs: 50, gain: 0 }, { atMs: 100, gain: 0.25 }, { atMs: 300, gain: 1 }]);
  });

  test("fades ramp linearly in and out and are 1 in the middle", () => {
    const c = clip({ id: "c", sourceId: "s", durationMs: 100, fadeInMs: 20, fadeOutMs: 40 });
    expect(clipFadeGain(c, 0)).toBe(0);
    expect(clipFadeGain(c, 10)).toBeCloseTo(0.5, 6);
    expect(clipFadeGain(c, 20)).toBe(1);
    expect(clipFadeGain(c, 50)).toBe(1);
    expect(clipFadeGain(c, 60)).toBeCloseTo(1, 6);   // the fade out begins here (100 - 40)
    expect(clipFadeGain(c, 80)).toBeCloseTo(0.5, 6); // halfway down it
    expect(clipFadeGain(c, 100)).toBe(0);            // and it reaches zero at the clip's end
    expect(clipFadeGain(c, 101)).toBe(0);            // past the end contributes nothing
  });

  test("pan is equal power: centre is not louder than the edges", () => {
    expect(panGains(0, 1)).toEqual([1]);
    const centre = panGains(0, 2);
    expect(centre[0]).toBeCloseTo(Math.SQRT1_2, 6);
    expect(centre[1]).toBeCloseTo(Math.SQRT1_2, 6);
    const power = (g: number[]): number => g[0]! ** 2 + g[1]! ** 2;
    expect(power(centre)).toBeCloseTo(1, 6);
    expect(power(panGains(-1, 2))).toBeCloseTo(1, 6);
    expect(power(panGains(1, 2))).toBeCloseTo(1, 6);
    expect(panGains(-1, 2)[1]).toBeCloseTo(0, 6);
    expect(panGains(9, 2)[0]).toBeCloseTo(0, 6); // clamped, not wrapped
  });

  test("headroomGain names the number that lands a hot mix at full scale, and never assumes", () => {
    expect(headroomGain(2)).toBe(0.5);
    expect(headroomGain(0)).toBe(1);
    expect(headroomGain(0.5)).toBe(2);
  });

  test("solo is exclusive, and a muted solo does not count as soloing", () => {
    const graph: MixGraph = {
      ...emptyMix(1000, 1),
      tracks: [mixTrack({ id: "a", label: "A", solo: true }), mixTrack({ id: "b", label: "B" })],
    };
    expect([...soloedTrackIds(graph)!]).toEqual(["a"]);
    const mutedSolo: MixGraph = { ...graph, tracks: [mixTrack({ id: "a", label: "A", solo: true, muted: true }), mixTrack({ id: "b", label: "B" })] };
    expect(soloedTrackIds(mutedSolo)).toBeNull();
  });

  test("silence has exactly one reason, in the order a person would check", () => {
    const bus = { id: "bus", label: "Beds", gain: 1, muted: true };
    const graph: MixGraph = { ...emptyMix(1000, 1), buses: [bus] };
    const withClip = [clip({ id: "c", sourceId: "s", durationMs: 10 })];
    expect(trackSilenceReason(graph, mixTrack({ id: "t", label: "T", muted: true, clips: withClip }), null)).toBe("muted");
    expect(trackSilenceReason(graph, mixTrack({ id: "t", label: "T" }), null)).toBe("no clips on the track");
    expect(trackSilenceReason(graph, mixTrack({ id: "t", label: "T", gain: 0, clips: withClip }), null)).toBe("track level is at zero");
    expect(trackSilenceReason(graph, mixTrack({ id: "t", label: "T", clips: withClip }), new Set(["other"]))).toBe("another track is soloed");
    expect(trackSilenceReason(graph, mixTrack({ id: "t", label: "T", clips: withClip, busId: "bus" }), null)).toBe("bus Beds is muted");
    expect(trackSilenceReason(graph, mixTrack({ id: "t", label: "T", clips: withClip }), null)).toBeNull();
  });
});

describe("the keystone: layering sums, and a silent track contributes nothing", () => {
  test("two tracks over the same span SUM, they do not replace each other", () => {
    const { graph, sources } = twoLayers();
    const out = rendered(graph, sources);
    expect(out.length).toBe(100 * 2);
    expect(at(out, 0)).toBe(3000); // 1000 + 2000, exactly
    expect(at(out, 99)).toBe(3000);
  });

  test("a muted track's samples are never added: the render equals the mix without it", () => {
    const { graph, sources } = twoLayers();
    const soloTrack: MixGraph = { ...graph, tracks: [graph.tracks[0]!] };
    const muted: MixGraph = { ...graph, tracks: [graph.tracks[0]!, { ...graph.tracks[1]!, muted: true }] };
    expect(rendered(muted, sources)).toEqual(rendered(soloTrack, sources));
    const r = renderMix(muted, sources);
    expect(r.ok && r.silentTracks).toEqual([{ id: "bed", reason: "muted" }]);
  });

  test("soloing one track silences the other, byte for byte", () => {
    const { graph, sources } = twoLayers();
    const soloed: MixGraph = { ...graph, tracks: [{ ...graph.tracks[0]!, solo: true }, graph.tracks[1]!] };
    const out = rendered(soloed, sources);
    expect(at(out, 0)).toBe(1000);
    const r = renderMix(soloed, sources);
    expect(r.ok && r.silentTracks[0]?.reason).toBe("another track is soloed");
  });

  test("a muted bus silences every track on it, and says which bus", () => {
    const { graph, sources } = twoLayers();
    const withBus: MixGraph = {
      ...graph,
      buses: [{ id: "beds", label: "Beds", gain: 1, muted: true }],
      tracks: [graph.tracks[0]!, mixTrack({ id: "bed", label: "Music bed", busId: "beds", clips: [clip({ id: "b1", sourceId: "bed", durationMs: 100 })] })],
    };
    const out = rendered(withBus, sources);
    expect(at(out, 0)).toBe(1000);
    const r = renderMix(withBus, sources);
    expect(r.ok && r.silentTracks[0]?.reason).toBe("bus Beds is muted");
  });

  test("the same graph renders byte-identical audio twice", () => {
    const { graph, sources } = twoLayers();
    const a = renderMix(graph, sources);
    const b = renderMix(graph, sources);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.wav).toEqual(b.wav);
      expect(a.peak).toBe(b.peak);
    }
  });
});

describe("levels, position, and honesty about clipping", () => {
  test("track gain, clip gain, bus gain, and master gain all multiply", () => {
    const { sources } = twoLayers();
    const graph: MixGraph = {
      ...emptyMix(1000, 1),
      masterGain: 0.5,
      buses: [{ id: "b", label: "B", gain: 0.5, muted: false }],
      tracks: [mixTrack({ id: "t", label: "T", gain: 0.5, busId: "b", clips: [clip({ id: "c", sourceId: "bed", durationMs: 10, gain: 0.5 })] })],
    };
    // 2000 * 0.5 (clip) * 0.5 (track) * 0.5 (bus) * 0.5 (master) = 125
    expect(at(rendered(graph, sources), 0)).toBe(125);
  });

  test("a clip lands at its own start time and leaves the rest silent", () => {
    const { sources } = twoLayers();
    const graph: MixGraph = {
      ...emptyMix(1000, 1),
      tracks: [mixTrack({ id: "t", label: "T", clips: [clip({ id: "c", sourceId: "voice", startMs: 50, durationMs: 20 })] })],
    };
    const out = rendered(graph, sources);
    expect(out.length).toBe(70 * 2);
    expect(at(out, 49)).toBe(0);
    expect(at(out, 50)).toBe(1000);
    expect(at(out, 69)).toBe(1000);
  });

  test("srcStartMs reads from inside the source, not from its head", () => {
    const ramp = new Uint8Array(100 * 2);
    for (let i = 0; i < 100; i++) { ramp[i * 2] = i & 0xff; ramp[i * 2 + 1] = (i >> 8) & 0xff; }
    const graph: MixGraph = {
      ...emptyMix(1000, 1),
      tracks: [mixTrack({ id: "t", label: "T", clips: [clip({ id: "c", sourceId: "r", durationMs: 10, srcStartMs: 40 })] })],
    };
    const out = rendered(graph, new Map([["r", { fmt: MONO, data: ramp }]]));
    expect(at(out, 0)).toBe(40);
    expect(at(out, 9)).toBe(49);
  });

  test("a hot mix is REPORTED, not normalized: true peak plus a clipped-sample count", () => {
    const sources = new Map([["loud", source(flatWav(10, 30000))]]);
    const graph: MixGraph = {
      ...emptyMix(1000, 1),
      tracks: [
        mixTrack({ id: "a", label: "A", clips: [clip({ id: "a1", sourceId: "loud", durationMs: 10 })] }),
        mixTrack({ id: "b", label: "B", clips: [clip({ id: "b1", sourceId: "loud", durationMs: 10 })] }),
      ],
    };
    const r = renderMix(graph, sources);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.peak).toBeCloseTo(60000 / 32768, 4); // the TRUE peak, measured before the rail
    expect(r.clipped).toBe(10);                    // every sample hit it, and it says so
    expect(at(parseWav(r.wav).data, 0)).toBe(32767); // clamped, never wrapped to a negative
    expect(headroomGain(r.peak)).toBeCloseTo(32768 / 60000, 4);
  });

  test("a mix inside the rails reports zero clipping and its real peak", () => {
    const { graph, sources } = twoLayers();
    const r = renderMix(graph, sources);
    expect(r.ok && r.clipped).toBe(0);
    expect(r.ok && r.peak).toBeCloseTo(3000 / 32768, 5);
  });

  test("an envelope rides the level over time", () => {
    const { sources } = twoLayers();
    const graph: MixGraph = {
      ...emptyMix(1000, 1),
      tracks: [mixTrack({
        id: "t", label: "T",
        envelope: [{ atMs: 0, gain: 0 }, { atMs: 100, gain: 1 }],
        clips: [clip({ id: "c", sourceId: "bed", durationMs: 100 })],
      })],
    };
    const out = rendered(graph, sources);
    expect(at(out, 0)).toBe(0);
    expect(at(out, 50)).toBe(1000); // halfway up a 0..1 ramp over a 2000 source
    expect(at(out, 99)).toBe(1980);
  });

  test("fades apply to the clip's own edges, wherever it sits on the timeline", () => {
    const { sources } = twoLayers();
    const graph: MixGraph = {
      ...emptyMix(1000, 1),
      tracks: [mixTrack({ id: "t", label: "T", clips: [clip({ id: "c", sourceId: "bed", startMs: 20, durationMs: 40, fadeInMs: 10, fadeOutMs: 10 })] })],
    };
    const out = rendered(graph, sources);
    expect(at(out, 20)).toBe(0);      // the fade starts at the CLIP's edge, not at zero on the timeline
    expect(at(out, 25)).toBe(1000);   // halfway through a 10ms fade in
    expect(at(out, 40)).toBe(2000);   // full level in the middle
    expect(at(out, 59)).toBe(200);    // ramping out
  });
});

describe("channels", () => {
  test("a mono source panned hard left in a stereo mix lands only on the left", () => {
    const sources = new Map([["voice", source(flatWav(10, 1000))]]);
    const graph: MixGraph = {
      ...emptyMix(1000, 2),
      tracks: [mixTrack({ id: "t", label: "T", pan: -1, clips: [clip({ id: "c", sourceId: "voice", durationMs: 10 })] })],
    };
    const out = rendered(graph, sources);
    expect(out.length).toBe(10 * 2 * 2);
    expect(at(out, 0, 2, 0)).toBe(1000);
    expect(at(out, 0, 2, 1)).toBe(0);
  });

  test("a stereo source folds to mono by averaging its channels", () => {
    const data = new Uint8Array(4 * 2 * 2);
    for (let f = 0; f < 4; f++) {
      data[f * 4] = 0xe8; data[f * 4 + 1] = 0x03;      // left  = 1000
      data[f * 4 + 2] = 0xd0; data[f * 4 + 3] = 0x07;  // right = 2000
    }
    const graph: MixGraph = {
      ...emptyMix(1000, 1),
      tracks: [mixTrack({ id: "t", label: "T", clips: [clip({ id: "c", sourceId: "st", durationMs: 4 })] })],
    };
    expect(at(rendered(graph, new Map([["st", { fmt: STEREO, data }]])), 0)).toBe(1500);
  });

  test("a mono render says when it had to ignore a pan, instead of silently dropping it", () => {
    const { sources } = twoLayers();
    const graph: MixGraph = {
      ...emptyMix(1000, 1),
      tracks: [mixTrack({ id: "t", label: "T", pan: -1, clips: [clip({ id: "c", sourceId: "voice", durationMs: 10 })] })],
    };
    const r = renderMix(graph, sources);
    expect(r.ok && r.panIgnored).toBe(true);
    const stereo = renderMix({ ...graph, channels: 2 }, sources);
    expect(stereo.ok && stereo.panIgnored).toBe(false);
  });
});

describe("fail-closed", () => {
  test("a missing source refuses the render and names the clip, track, and source", () => {
    const { graph } = twoLayers();
    const err = refused(renderMix(graph, new Map([["voice", source(flatWav(100, 1000))]])));
    expect(err).toContain('needs source "bed"');
    expect(err).toContain("track bed");
  });

  test("a sample-rate mismatch refuses with both rates and admits there is no resampler", () => {
    const { graph } = twoLayers();
    const wrong = new Map([
      ["voice", source(flatWav(100, 1000))],
      ["bed", source(buildWav({ channels: 1, sampleRate: 48000, bitsPerSample: 16 }, new Uint8Array(200)))],
    ]);
    const err = refused(renderMix(graph, wrong));
    expect(err).toContain("48000Hz");
    expect(err).toContain("1000Hz");
    expect(err).toMatch(/no resampler/);
  });

  test("a non-16-bit or many-channel source refuses by name", () => {
    const { graph } = twoLayers();
    const eight = new Map([
      ["voice", source(flatWav(100, 1000))],
      ["bed", { fmt: { channels: 1, sampleRate: 1000, bitsPerSample: 8 }, data: new Uint8Array(100) }],
    ]);
    expect(refused(renderMix(graph, eight))).toContain("8-bit");
    const many = new Map([
      ["voice", source(flatWav(100, 1000))],
      ["bed", { fmt: { channels: 6, sampleRate: 1000, bitsPerSample: 16 }, data: new Uint8Array(1200) }],
    ]);
    expect(refused(renderMix(graph, many))).toContain("6 channels");
  });

  test("a structurally broken graph refuses with the structural reason", () => {
    const { graph, sources } = twoLayers();
    expect(refused(renderMix({ ...graph, bitsPerSample: 32 }, sources))).toMatch(/only 16-bit PCM/);
  });

  test("a source shorter than its clip pads with silence rather than reading past its end", () => {
    const sources = new Map([["short", source(flatWav(10, 1000))]]);
    const graph: MixGraph = {
      ...emptyMix(1000, 1),
      tracks: [mixTrack({ id: "t", label: "T", clips: [clip({ id: "c", sourceId: "short", durationMs: 40 })] })],
    };
    const out = rendered(graph, sources);
    expect(out.length).toBe(40 * 2);
    expect(at(out, 9)).toBe(1000);
    expect(at(out, 10)).toBe(0);
    expect(at(out, 39)).toBe(0);
  });

  test("a silence clip occupies its span and adds nothing", () => {
    const { sources } = twoLayers();
    const graph: MixGraph = {
      ...emptyMix(1000, 1),
      tracks: [mixTrack({ id: "t", label: "T", clips: [
        clip({ id: "c1", sourceId: SILENCE_SOURCE, durationMs: 10 }),
        clip({ id: "c2", sourceId: "voice", startMs: 10, durationMs: 10 }),
      ] })],
    };
    const out = rendered(graph, sources);
    expect(at(out, 0)).toBe(0);
    expect(at(out, 10)).toBe(1000);
  });
});

describe("CREATOR-2 interop", () => {
  test("an edited timeline lifts onto one mix track, keeping every clip's position and source region", () => {
    const doc = docFromSource({ sourceId: "take-1", fmt: MONO, durationMs: 100, items: [] });
    const track: MixTrack = trackFromTimeline(doc, { id: "vox", label: "Vox", gain: 0.5, pan: -0.5 });
    expect(track.clips).toHaveLength(1);
    expect(track.clips[0]).toMatchObject({ id: "vox-c1", sourceId: "take-1", startMs: 0, durationMs: 100, srcStartMs: 0, gain: 1 });
    expect(track.gain).toBe(0.5);
    expect(track.pan).toBe(-0.5);
  });

  test("the lifted track renders the same audio the timeline would, layered under a bed", () => {
    const doc = docFromSource({ sourceId: "voice", fmt: MONO, durationMs: 100, items: [] });
    const { sources } = twoLayers();
    const graph: MixGraph = {
      ...emptyMix(1000, 1),
      tracks: [
        trackFromTimeline(doc, { id: "vox", label: "Vox" }),
        mixTrack({ id: "bed", label: "Bed", gain: 0.25, clips: [clip({ id: "b1", sourceId: "bed", durationMs: 100 })] }),
      ],
    };
    expect(at(rendered(graph, sources), 0)).toBe(1000 + 500); // voice at unity, bed at a quarter
    expect(validateMix(graph)).toEqual([]);
  });
});
