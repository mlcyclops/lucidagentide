// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/creator_mixer.test.ts - CREATOR-5 (ADR-0289).
//
// DOM-free, like every other renderer test here. What is worth testing in a mixer is not that a slider
// fires, it is what a control move MEANS: that every edit hands back a NEW graph and leaves the one it was
// given byte-identical (the undo contract), that a refusal keeps the core's own words, and - the
// load-bearing ones - that a peak of zero never prints as "-Infinity dBFS", that a clean render says
// "nothing clipped" instead of showing a zero next to the word, and that a format the server never
// reported is never guessed.

import { describe, expect, test } from "bun:test";
import {
  MAX_MIX_GAIN, addLibraryTrack, creatorMixerHtml, envelopeWords, formatClipping, formatGain, formatPeak,
  formatWords, headroomOffer, isMixerTracksPayload, isRenderMixReport, mixFormatLabel, mixerDurationLabel,
  panWords, patchTrack, primarySourceId, removeTrack, reportLines, rowState, setMasterGain,
  setTwoPointEnvelope, trackAddability,
  type CreatorMixerView, type MixerTrackView, type RenderMixResult,
} from "./creator_mixer.ts";
import {
  MAX_MIX_TRACKS, emptyMix, mixTrack, soloedTrackIds, validateMix,
  type MixClip, type MixGraph, type MixTrack, type NewTrackInput,
} from "../../harness/creator/mix.ts";

const clip = (over: Partial<MixClip> = {}): MixClip =>
  ({ id: "c1", sourceId: "trk1", startMs: 0, durationMs: 2000, srcStartMs: 0, gain: 1, fadeInMs: 0, fadeOutMs: 0, ...over });

// Built through the core's own builder, so a fixture can never drift from the defaults the render assumes.
const track = (over: Partial<NewTrackInput> = {}): MixTrack =>
  mixTrack({ id: "t1", label: "narration", clips: [clip()], ...over });

const graph = (tracks: MixTrack[] = [track()], over: Partial<MixGraph> = {}): MixGraph =>
  ({ ...emptyMix(44100, 2), tracks, ...over });

const lib = (over: Partial<MixerTrackView> = {}): MixerTrackView =>
  ({ id: "trk1", title: "narration", mime: "audio/wav", durationMs: 2000, sampleRate: 44100, channels: 2, ...over });

const view = (over: Partial<CreatorMixerView> = {}): CreatorMixerView => ({
  library: [lib()], sampleRate: 44100, channels: 2, graph: graph(), addId: "trk1", title: "the mix",
  applyHeadroom: false, report: null, status: "", statusTone: "", busy: "",
  ...over,
});

const ok = (over: Partial<RenderMixResult> = {}): RenderMixResult => ({
  ok: true, trackId: "mix1", bytes: 352844, durationMs: 2000, peak: 0.5, clipped: 0,
  silentTracks: [], panIgnored: false,
  ...over,
});

describe("patchTrack: a control move is a NEW graph", () => {
  test("level, pan, mute and solo land, and the graph handed in is left byte-identical", () => {
    const before = graph();
    const json = JSON.stringify(before);
    const after = patchTrack(before, "t1", { gain: 0.5, pan: -0.4, muted: true, solo: true });
    expect(after).not.toBe(before);
    expect(after.tracks[0]!.gain).toBe(0.5);
    expect(after.tracks[0]!.pan).toBe(-0.4);
    expect(after.tracks[0]!.muted).toBe(true);
    expect(after.tracks[0]!.solo).toBe(true);
    expect(JSON.stringify(before)).toBe(json); // the undo contract, asserted rather than assumed
  });

  test("fades land on the track's clip, and another track's clip is untouched", () => {
    const before = graph([track(), track({ id: "t2", label: "bed", clips: [clip({ id: "c2", sourceId: "trk2" })] })]);
    const after = patchTrack(before, "t1", { fadeInMs: 250, fadeOutMs: 400 });
    expect(after.tracks[0]!.clips[0]!.fadeInMs).toBe(250);
    expect(after.tracks[0]!.clips[0]!.fadeOutMs).toBe(400);
    expect(after.tracks[1]!.clips[0]).toBe(before.tracks[1]!.clips[0]);
    expect(before.tracks[0]!.clips[0]!.fadeInMs).toBe(0);
  });

  test("a non-finite reading is IGNORED, not written: a half-typed field cannot zero a level", () => {
    const before = patchTrack(graph(), "t1", { gain: 0.8 });
    const after = patchTrack(before, "t1", { gain: Number.NaN, pan: Number.POSITIVE_INFINITY });
    expect(after.tracks[0]!.gain).toBe(0.8);
    expect(after.tracks[0]!.pan).toBe(0);
  });

  test("readings past the control's own range are clamped to it", () => {
    const after = patchTrack(graph(), "t1", { gain: 99, pan: -8 });
    expect(after.tracks[0]!.gain).toBe(MAX_MIX_GAIN);
    expect(after.tracks[0]!.pan).toBe(-1);
    expect(patchTrack(graph(), "t1", { gain: -3, pan: 8 }).tracks[0]!.gain).toBe(0);
  });

  test("an unmentioned field keeps its value, and an unknown id changes nothing but still copies", () => {
    const before = patchTrack(graph(), "t1", { gain: 0.25, muted: true });
    const after = patchTrack(before, "nobody", { gain: 1 });
    expect(after).not.toBe(before);
    expect(after.tracks[0]!.gain).toBe(0.25);
    expect(after.tracks[0]!.muted).toBe(true);
  });

  test("overlapping fades are NOT silently clamped: validateMix names them in the user's own numbers", () => {
    const after = patchTrack(graph(), "t1", { fadeInMs: 1500, fadeOutMs: 1500 });
    expect(after.tracks[0]!.clips[0]!.fadeInMs).toBe(1500);
    const problems = validateMix(after);
    expect(problems.some((p) => p.includes("1500ms in + 1500ms out exceeds 2000ms"))).toBe(true);
  });
});

describe("addLibraryTrack: what may join THIS mix", () => {
  test("an addable track becomes one clip carrying the whole file, and the input graph is untouched", () => {
    const before = graph([]);
    const json = JSON.stringify(before);
    const r = addLibraryTrack(before, lib({ id: "trk9", title: "bed", durationMs: 6000 }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.graph).not.toBe(before);
    expect(JSON.stringify(before)).toBe(json);
    expect(r.graph.tracks).toHaveLength(1);
    const added = r.graph.tracks[0]!;
    expect(added.id).toBe(r.trackId);
    expect(added.label).toBe("bed");
    expect(added.gain).toBe(1);
    expect(added.pan).toBe(0);
    expect(added.muted).toBe(false);
    expect(added.clips[0]).toEqual({ id: `${r.trackId}-c1`, sourceId: "trk9", startMs: 0, durationMs: 6000, srcStartMs: 0, gain: 1, fadeInMs: 0, fadeOutMs: 0 });
  });

  test("layering the same source twice is legitimate, so the second copy gets a fresh id", () => {
    const first = addLibraryTrack(graph([]), lib({ id: "bed" }));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = addLibraryTrack(first.graph, lib({ id: "bed" }));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.trackId).not.toBe(first.trackId);
    expect(second.graph.tracks.map((t) => t.id)).toEqual([first.trackId, second.trackId]);
    expect(validateMix(second.graph)).toEqual([]);
  });

  test("a sample-rate mismatch is refused, naming BOTH rates and the resampler this build does not ship", () => {
    const r = addLibraryTrack(graph([]), lib({ sampleRate: 48000 }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("48000Hz");
    expect(r.error).toContain("44100Hz");
    expect(r.error).toContain("no resampler");
  });

  test("an unmeasured length is refused, and null is called unknown, never zero", () => {
    const r = addLibraryTrack(graph([]), lib({ durationMs: null }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("never measured");
    expect(r.error).toContain("Null is unknown, never zero.");
  });

  test("a full mix refuses the next track instead of dropping one silently", () => {
    const many = Array.from({ length: MAX_MIX_TRACKS }, (_, i) => track({ id: `t${i}`, label: `t${i}` }));
    const r = addLibraryTrack(graph(many), lib());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain(`at most ${MAX_MIX_TRACKS} tracks`);
  });
});

describe("trackAddability: a false refusal is the same lie as a silent fix", () => {
  test("a format-mismatched track is NOT addable, in words built from its real numbers", () => {
    const v = trackAddability(lib({ sampleRate: 22050 }), { sampleRate: 44100, channels: 2 });
    expect(v.addable).toBe(false);
    expect(v.reason).toBe("This track is 22050Hz and the mix runs at 44100Hz. This build ships no resampler, so it cannot be mixed in.");
  });

  test("a CHANNEL difference is addable, with a note saying what the render really does", () => {
    const toMono = trackAddability(lib({ channels: 2 }), { sampleRate: 44100, channels: 1 });
    expect(toMono.addable).toBe(true);
    expect(toMono.reason).toContain("stereo");
    expect(toMono.reason).toContain("folds its channels down to one");
    expect(toMono.reason).toContain("not a refusal");
    const toStereo = trackAddability(lib({ channels: 1 }), { sampleRate: 44100, channels: 2 });
    expect(toStereo.addable).toBe(true);
    expect(toStereo.reason).toContain("same signal on both sides");
  });

  test("a perfect match carries no caveat at all, and an unreported mix format blocks everything", () => {
    expect(trackAddability(lib(), { sampleRate: 44100, channels: 2 })).toEqual({ addable: true, reason: "" });
    const noFmt = trackAddability(lib(), { sampleRate: null, channels: null });
    expect(noFmt.addable).toBe(false);
    expect(noFmt.reason).toContain("has not reported the format");
  });

  test("an unmeasured format is unknown, and unknown is not a match", () => {
    const v = trackAddability(lib({ sampleRate: null, channels: null }), { sampleRate: 44100, channels: 2 });
    expect(v.addable).toBe(false);
    expect(v.reason).toContain("an unmeasured sample rate, an unmeasured channel count");
    expect(v.reason).toContain("unknown is not a match");
    expect(formatWords(lib({ channels: null }))).toBe("44100Hz, an unmeasured channel count");
  });
});

describe("removeTrack and setMasterGain", () => {
  test("removeTrack drops exactly one and leaves the input graph untouched", () => {
    const before = graph([track(), track({ id: "t2", label: "bed" })]);
    const json = JSON.stringify(before);
    const after = removeTrack(before, "t1");
    expect(after).not.toBe(before);
    expect(after.tracks.map((t) => t.id)).toEqual(["t2"]);
    expect(JSON.stringify(before)).toBe(json);
    expect(removeTrack(before, "nobody").tracks).toHaveLength(2);
  });

  test("setMasterGain clamps, ignores a broken reading, and never mutates in place", () => {
    const before = graph();
    const json = JSON.stringify(before);
    expect(setMasterGain(before, 0.5).masterGain).toBe(0.5);
    expect(setMasterGain(before, 40).masterGain).toBe(MAX_MIX_GAIN);
    expect(setMasterGain(before, -1).masterGain).toBe(0);
    expect(setMasterGain(before, Number.NaN).masterGain).toBe(1);
    expect(setMasterGain(before, 0.5)).not.toBe(before);
    expect(JSON.stringify(before)).toBe(json);
  });
});

describe("setTwoPointEnvelope: a ramp across the track's OWN span", () => {
  test("two points at the track's first clip start and last clip end, sorted, input untouched", () => {
    const before = graph([track({ clips: [clip({ id: "c1", startMs: 500, durationMs: 1000 }), clip({ id: "c2", startMs: 2000, durationMs: 500 })] })]);
    const json = JSON.stringify(before);
    const after = setTwoPointEnvelope(before, "t1", 0.2, 1);
    expect(after).not.toBe(before);
    expect(after.tracks[0]!.envelope).toEqual([{ atMs: 500, gain: 0.2 }, { atMs: 2500, gain: 1 }]);
    expect(JSON.stringify(before)).toBe(json);
    expect(validateMix(after)).toEqual([]);
    expect(envelopeWords(after.tracks[0]!)).toContain("x0.20 (-14.0 dB) at 0:00, then x1.00 (0.0 dB) at 0:02");
  });

  test("a track with no clips gets an EMPTY envelope, not two points stacked at zero", () => {
    const after = setTwoPointEnvelope(graph([track({ clips: [] })]), "t1", 0, 1);
    expect(after.tracks[0]!.envelope).toEqual([]);
    expect(envelopeWords(after.tracks[0]!)).toBe("No automation: one flat level for the whole track.");
  });
});

describe("formatPeak: the log of nothing is not a reading", () => {
  test("a peak of zero prints as SILENCE and never as -Infinity dBFS", () => {
    const s = formatPeak(0);
    expect(s).toContain("silence");
    expect(s).toContain("0% of full scale");
    expect(s).not.toContain("Infinity");
    expect(s).not.toContain("NaN");
  });

  test("full scale is exactly 0.0 dBFS, half is -6.0, and an over-unity peak is signed", () => {
    expect(formatPeak(1)).toBe("Peak 100.0% of full scale, 0.0 dBFS.");
    expect(formatPeak(0.5)).toBe("Peak 50.0% of full scale, -6.0 dBFS.");
    expect(formatPeak(1.2)).toContain("+1.6 dBFS");
    expect(formatPeak(0.999)).toContain("0.0 dBFS"); // a hair under unity never prints "-0.0"
    expect(formatPeak(0.999)).not.toContain("-0.0");
  });

  test("an absent peak is UNKNOWN, not zero", () => {
    expect(formatPeak(undefined)).toContain("Unknown is not zero");
    expect(formatPeak(Number.NaN)).toContain("Unknown is not zero");
  });
});

describe("formatClipping: never print a scary number that is not there", () => {
  test("nothing clipped says so, and the count zero never appears beside the word", () => {
    expect(formatClipping(0)).toBe("Nothing clipped: not one sample hit the rail.");
    expect(formatClipping(0)).not.toContain("0 sample");
  });

  test("some clipped names the count, singular or plural, and what to do about it", () => {
    expect(formatClipping(1)).toContain("1 sample clipped");
    expect(formatClipping(4128)).toContain("4128 samples clipped");
    expect(formatClipping(4128)).toContain("apply headroom");
  });

  test("an unreported count is unknown, not a clean bill of health", () => {
    expect(formatClipping(undefined)).toContain("not reported");
    expect(formatClipping(undefined)).not.toContain("Nothing clipped");
  });
});

describe("the mix-format indicator reflects what the SERVER reported", () => {
  test("mono and stereo are named from the reported numbers", () => {
    expect(mixFormatLabel({ sampleRate: 44100, channels: 2 })).toBe("This mix renders at 44100Hz, stereo, 16-bit PCM.");
    expect(mixFormatLabel({ sampleRate: 24000, channels: 1 })).toBe("This mix renders at 24000Hz, mono, 16-bit PCM.");
  });

  test("an unreported format claims nothing at all, rather than guessing a default", () => {
    const s = mixFormatLabel({ sampleRate: null, channels: null });
    expect(s).toContain("not claiming one");
    expect(s).not.toContain("Hz");
    expect(mixFormatLabel({ sampleRate: 44100, channels: null })).toContain("not claiming one");
  });

  test("pan words say plainly that a mono mix has nowhere to place a pan", () => {
    expect(panWords(0, 2)).toBe("centre");
    expect(panWords(-0.5, 2)).toBe("50% left");
    expect(panWords(1, 2)).toBe("100% right");
    expect(panWords(-1, 1)).toBe("centre (a mono mix has nowhere to place a pan)");
  });

  test("a level is the number actually applied, and zero is silent rather than -Infinity dB", () => {
    expect(formatGain(1)).toBe("x1.00 (0.0 dB)");
    expect(formatGain(2)).toBe("x2.00 (+6.0 dB)");
    expect(formatGain(0)).toBe("x0.00 (silent)");
    expect(formatGain(0)).not.toContain("Infinity");
  });
});

describe("rowState: the row and the render can never disagree about a quiet track", () => {
  test("a muted track carries the core's own one-word reason and is not audible", () => {
    const g = graph([track({ muted: true })]);
    const st = rowState(g, g.tracks[0]!, soloedTrackIds(g));
    expect(st.muted).toBe(true);
    expect(st.audible).toBe(false);
    expect(st.silence).toBe("muted");
    expect(st.clip).toBe(g.tracks[0]!.clips[0]!);
  });

  test("a soloed track stays audible while every other track says WHY it went quiet", () => {
    const g = graph([track({ solo: true }), track({ id: "t2", label: "bed", clips: [clip({ id: "c2", sourceId: "trk2" })] })]);
    const soloed = soloedTrackIds(g);
    const lead = rowState(g, g.tracks[0]!, soloed);
    const bed = rowState(g, g.tracks[1]!, soloed);
    expect(lead.solo).toBe(true);
    expect(lead.silence).toBe("");
    expect(lead.audible).toBe(true);
    expect(bed.silence).toBe("another track is soloed");
    expect(bed.audible).toBe(false);
  });

  test("a track silenced by its BUS carries the bus's own sentence, naming the bus", () => {
    const g = graph([track({ busId: "b1" })], { buses: [{ id: "b1", label: "Beds", gain: 1, muted: true }] });
    expect(rowState(g, g.tracks[0]!, soloedTrackIds(g)).silence).toBe("bus Beds is muted");
    const atZero = graph([track({ busId: "b1" })], { buses: [{ id: "b1", label: "Beds", gain: 0, muted: false }] });
    expect(rowState(atZero, atZero.tracks[0]!, soloedTrackIds(atZero)).silence).toBe("bus Beds is at zero");
  });

  test("a clipless track has no clip to fade, and says so rather than offering dead fields", () => {
    const g = graph([track({ clips: [] })]);
    const st = rowState(g, g.tracks[0]!, soloedTrackIds(g));
    expect(st.clip).toBeNull();
    expect(st.silence).toBe("no clips on the track");
  });
});

describe("the render report, in the user's numbers", () => {
  test("a clean render prints every measurement and NO headroom line", () => {
    const lines = reportLines(ok());
    expect(lines).toEqual([
      "Saved as library track mix1.",
      "0:02 of audio, 352844 bytes on disk.",
      "Peak 50.0% of full scale, -6.0 dBFS.",
      "Nothing clipped: not one sample hit the rail.",
    ]);
    expect(lines.join(" ")).not.toContain("Headroom applied");
  });

  test("panIgnored, every silent track, and the exact headroom applied all print when present", () => {
    const lines = reportLines(ok({
      peak: 1.4, clipped: 91, panIgnored: true,
      silentTracks: [{ id: "t2", reason: "another track is soloed" }, { id: "t3", reason: "bus Beds is muted" }],
      headroomApplied: 0.714286,
    }));
    const text = lines.join("\n");
    expect(text).toContain("+2.9 dBFS");
    expect(text).toContain("91 samples clipped");
    expect(text).toContain("mono render has nowhere to place a pan");
    expect(text).toContain("Track t2 contributed nothing: another track is soloed.");
    expect(text).toContain("Track t3 contributed nothing: bus Beds is muted.");
    expect(text).toContain("scaled by x0.7143, because you asked for it");
  });

  test("a refusal is the server's error string VERBATIM, never a generic message", () => {
    const err = 'source "trk4" is 48000Hz and the mix is 44100Hz; this build has no resampler';
    expect(reportLines({ ok: false, error: err })).toEqual([err]);
  });

  test("headroomOffer measures rather than promises: nothing before a render, the exact factor after", () => {
    expect(headroomOffer(null)).toBeNull();
    expect(headroomOffer(0)).toBeNull();
    expect(headroomOffer(undefined)).toBeNull();
    expect(headroomOffer(0.5)).toContain("up by x2.0000");
    expect(headroomOffer(1.25)).toContain("down by x0.8000");
    expect(headroomOffer(1)).toContain("nothing to recover");
  });
});

describe("primarySourceId: a mix has many inputs, the ledger has one parent slot", () => {
  test("the FIRST AUDIBLE track's source is named, skipping a muted one", () => {
    const g = graph([
      track({ muted: true }),
      track({ id: "t2", label: "bed", clips: [clip({ id: "c2", sourceId: "trk2" })] }),
    ]);
    expect(primarySourceId(g, soloedTrackIds(g))).toBe("trk2");
  });

  test("with nothing audible it still names a source rather than inventing one, and null when empty", () => {
    const allMuted = graph([track({ muted: true })]);
    expect(primarySourceId(allMuted, soloedTrackIds(allMuted))).toBe("trk1");
    expect(primarySourceId(graph([]), null)).toBeNull();
  });
});

describe("the shape gates fail closed", () => {
  test("a tracks payload missing or lying about its format is rejected", () => {
    expect(isMixerTracksPayload({ tracks: [], sampleRate: 44100, channels: 2 })).toBe(true);
    expect(isMixerTracksPayload({ tracks: [lib()], sampleRate: 44100, channels: 1 })).toBe(true);
    expect(isMixerTracksPayload(null)).toBe(false);
    expect(isMixerTracksPayload({ tracks: [], sampleRate: 0, channels: 2 })).toBe(false);
    expect(isMixerTracksPayload({ tracks: [], sampleRate: 44100, channels: 6 })).toBe(false);
    expect(isMixerTracksPayload({ tracks: {}, sampleRate: 44100, channels: 2 })).toBe(false);
    expect(isMixerTracksPayload({ tracks: [{ id: "a" }], sampleRate: 44100, channels: 2 })).toBe(false);
    // null is a legal answer for a measurement; a string is not
    expect(isMixerTracksPayload({ tracks: [lib({ durationMs: null, sampleRate: null, channels: null })], sampleRate: 44100, channels: 2 })).toBe(true);
  });

  test("an ABSENT format is a real answer (nothing decodable), but HALF a format is not", () => {
    expect(isMixerTracksPayload({ tracks: [] })).toBe(true);
    expect(isMixerTracksPayload({ tracks: [lib()] })).toBe(true);
    expect(isMixerTracksPayload({ tracks: [], sampleRate: 44100 })).toBe(false);
    expect(isMixerTracksPayload({ tracks: [], channels: 2 })).toBe(false);
  });

  test("a report without its measurements is not a report", () => {
    expect(isRenderMixReport(ok())).toBe(true);
    expect(isRenderMixReport({ ok: false, error: "no" })).toBe(false);
    expect(isRenderMixReport({ ok: true, trackId: "m1", peak: 0.5 })).toBe(false);
    expect(isRenderMixReport({ ok: true, trackId: "m1", peak: "loud", clipped: 0 })).toBe(false);
    expect(isRenderMixReport({ ok: true, trackId: "m1", peak: 0.5, clipped: 0, silentTracks: "none" })).toBe(false);
    expect(isRenderMixReport({ ok: true, trackId: "m1", peak: 0.5, clipped: 0, headroomApplied: "1.2" })).toBe(false);
  });
});

describe("the pane keeps its honesty in the markup", () => {
  test("invariant 11: a row's label is one element holding ONE text node, never text beside a tag", () => {
    const label = "a narration title long enough that it must be ellipsized rather than wrap";
    const html = creatorMixerHtml(view({ graph: graph([track({ label })]) }));
    const m = /<span class="cmx-name"[^>]*>([^<]*)<\/span>/.exec(html);
    expect(m?.[1]).toBe(label); // [^<]* proves the span's only child is that text
  });

  test("a quiet row prints trackSilenceReason's sentence VERBATIM", () => {
    const html = creatorMixerHtml(view({ graph: graph([track({ muted: true })]) }));
    expect(html).toContain('class="cmx-silent"');
    expect(html).toContain(">muted<");
    expect(html).toContain('class="cmx-row quiet"');
  });

  test("a not-addable pick kills the Add button and prints the reason as prose", () => {
    const html = creatorMixerHtml(view({ library: [lib({ sampleRate: 48000 })] }));
    expect(html).toContain("data-cmx-add disabled");
    expect(html).toContain("This build ships no resampler");
    expect(html).toContain("48000Hz, stereo"); // the option still LISTS it, with its real format
    expect(html).toContain("cannot mix");
  });

  test("headroom is never pre-ticked, and the render button dies when the core found a problem", () => {
    const clean = creatorMixerHtml(view());
    expect(clean).toContain('type="checkbox" data-cmx-headroom />');
    expect(clean).not.toContain("data-cmx-render disabled");
    expect(creatorMixerHtml(view({ applyHeadroom: true }))).toContain("data-cmx-headroom checked");
    const bad = creatorMixerHtml(view({ graph: patchTrack(graph(), "t1", { fadeInMs: 1900, fadeOutMs: 1900 }) }));
    expect(bad).toContain("data-cmx-render disabled");
    expect(bad).toContain("1900ms in + 1900ms out exceeds 2000ms");
  });

  test("the status line is whatever last happened, printed verbatim with its tone", () => {
    const refusal = "mix is not renderable: clip mt-trk1-c1 has no length";
    const html = creatorMixerHtml(view({ status: refusal, statusTone: "error" }));
    expect(html).toContain(refusal);
    expect(html).toContain('class="cmx-status error"');
  });

  test("with no graph the pane says what it has not done yet, and a null view fails honest", () => {
    const empty = creatorMixerHtml(view({ graph: null, sampleRate: null, channels: null }));
    expect(empty).toContain("has not read the library yet");
    expect(empty).not.toContain("cmx-rows");
    expect(creatorMixerHtml(null)).toContain("Nothing was changed");
  });

  test("an empty mix says a mix of nothing renders nothing, and names the length once tracks exist", () => {
    expect(creatorMixerHtml(view({ graph: graph([]) }))).toContain("a mix of nothing has nothing to render");
    expect(mixerDurationLabel(graph([]))).toBe("Nothing on the mix yet.");
    expect(mixerDurationLabel(graph())).toBe("0:02 long, 1 track.");
    expect(mixerDurationLabel(graph([track({ clips: [] })]))).toContain("none of them holding a clip");
    expect(mixerDurationLabel(null)).toBe("Nothing on the mix yet.");
  });

  test("the report is rendered line for line, so nothing measured is summarised away", () => {
    const html = creatorMixerHtml(view({ report: ok({ peak: 0, clipped: 0 }) }));
    for (const line of reportLines(ok({ peak: 0, clipped: 0 }))) expect(html).toContain(line);
    expect(html).not.toContain("Infinity");
  });
});
