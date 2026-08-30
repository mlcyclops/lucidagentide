// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/creator_editor.test.ts - CREATOR-2 (ADR-0286).
//
// DOM-free, like every other renderer test here. What is worth testing in an editor is not that a click
// handler fires, it is what a gesture MEANS: which chips a shift-click covers, where a drop lands, what a
// chip looks like at this instant, and - the load-bearing one - that a derived alignment can never print
// itself as engine timing no matter what the document claims.

import { describe, expect, test } from "bun:test";
import {
  chipState, chipStripHtml, confidenceLabel, confidenceOpacity, creatorEditorHtml, dropTargetMs, formatClock,
  isEditorSession, isWavTrack, msAtX, playheadX, selectionRange, waveformBars,
  type CreatorEditorView, type EditorSession,
} from "./creator_editor.ts";
import { DERIVED_CONFIDENCE_CEILING, type TimelineDoc, type TimelineItem } from "../../harness/creator/timeline.ts";

const item = (id: string, text: string, startMs: number, endMs: number, over: Partial<TimelineItem> = {}): TimelineItem =>
  ({ id, text, startMs, endMs, confidence: 1, source: "vendor", locked: false, ...over });

const doc = (items: TimelineItem[] = [
  item("i1", "the", 0, 300),
  item("i2", "quick", 300, 800),
  item("i3", "brown", 800, 1400),
  item("i4", "fox", 1400, 2000),
]): TimelineDoc => ({
  sampleRate: 24000, channels: 1, bitsPerSample: 16, items,
  clips: [{ id: "c1", startMs: 0, endMs: 2000, sourceId: "trk1", srcStartMs: 0, gain: 1 }],
});

const session = (over: Partial<EditorSession> = {}): EditorSession => ({
  trackId: "trk1", title: "narration", doc: doc(),
  note: "Derived from the audio's own energy: 4 speech runs measured, words distributed by length.",
  peaks: [0.1, 0.9, 0.4], audioB64: "UklGRg==", mime: "audio/wav", durationMs: 2000,
  sources: [{ id: "trk2", title: "retake", durationMs: 900 }],
  ...over,
});

const view = (over: Partial<CreatorEditorView> = {}): CreatorEditorView => ({
  tracks: [{ id: "trk1", title: "narration", mime: "audio/wav" }],
  trackId: "trk1", text: "", session: session(), doc: doc(), selected: [], playheadMs: 0,
  playing: false, canUndo: false, canRedo: false, title: "narration (edit)", status: "", statusTone: "", busy: "",
  ...over,
});

describe("selectionRange: what a shift-click covers", () => {
  test("anchor to focus is inclusive and in DOCUMENT order, dragged either way", () => {
    expect(selectionRange(doc(), "i2", "i4")).toEqual(["i2", "i3", "i4"]);
    expect(selectionRange(doc(), "i4", "i2")).toEqual(["i2", "i3", "i4"]);
  });

  test("anchor equal to focus is the single word", () => {
    expect(selectionRange(doc(), "i3", "i3")).toEqual(["i3"]);
  });

  test("an id the document does not know is never invented into the range", () => {
    expect(selectionRange(doc(), "gone", "i2")).toEqual(["i2"]);
    expect(selectionRange(doc(), "i2", "gone")).toEqual(["i2"]);
    expect(selectionRange(doc(), "gone", "vanished")).toEqual([]);
  });
});

describe("formatClock: a transport never shows a broken glyph", () => {
  test("zero is 0:00 and seconds are two digits", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(7_000)).toBe("0:07");
  });

  test("it rolls over at the minute, not at 60 seconds of display", () => {
    expect(formatClock(59_999)).toBe("0:59");
    expect(formatClock(60_000)).toBe("1:00");
    expect(formatClock(605_000)).toBe("10:05");
  });

  test("past an hour it grows an hours field instead of counting to 97 minutes", () => {
    expect(formatClock(3_600_000)).toBe("1:00:00");
    expect(formatClock(3_725_000)).toBe("1:02:05");
  });

  test("a negative, NaN, or infinite input yields 0:00 - never NaN:aN", () => {
    for (const bad of [-1, -60_000, NaN, Infinity, -Infinity]) {
      expect(formatClock(bad)).toBe("0:00");
      expect(formatClock(bad)).not.toContain("NaN");
    }
  });
});

describe("dropTargetMs: where a dragged span lands", () => {
  test("a chip resolves to its own start instant", () => {
    expect(dropTargetMs(doc(), "i3", ["i1"])).toBe(800);
  });

  test("a chip the document does not have is not a target", () => {
    expect(dropTargetMs(doc(), "ghost", ["i1"])).toBeNull();
  });

  test("dropping a span onto itself is NOT a move (no history churn for nothing)", () => {
    expect(dropTargetMs(doc(), "i2", ["i1", "i2", "i3"])).toBeNull();
  });
});

describe("chipState: how one word looks right now", () => {
  test("playing is half-open, matching itemAt - two chips never light on a boundary", () => {
    const [a, b] = [doc().items[1]!, doc().items[2]!];
    expect(chipState(a, 800, new Set()).playing).toBe(false); // its own end instant belongs to the next word
    expect(chipState(b, 800, new Set()).playing).toBe(true);
    expect(chipState(a, 799, new Set()).playing).toBe(true);
  });

  test("selection, lock, and provenance are read off the item, not guessed", () => {
    const it = item("i9", "maybe", 0, 100, { locked: true, source: "derived", confidence: 0.6 });
    const st = chipState(it, 50, new Set(["i9"]));
    expect(st).toEqual({ playing: true, selected: true, locked: true, derived: true });
  });

  test("a NaN playhead lights nothing rather than every chip", () => {
    expect(chipState(doc().items[0]!, NaN, new Set()).playing).toBe(false);
  });
});

describe("confidenceLabel: a guess can never print as engine timing", () => {
  test("a vendor item says so, with its own number", () => {
    expect(confidenceLabel(item("i1", "the", 0, 1))).toBe("Engine timing, 100% confidence.");
  });

  test("a DERIVED item claiming 1.0 is still capped and still refuses the vendor wording", () => {
    const lying = item("i1", "the", 0, 1, { source: "derived", confidence: 1 });
    const label = confidenceLabel(lying);
    expect(label).not.toContain("Engine timing");
    expect(label).toContain("derived guess");
    expect(label).toContain(`${Math.round(DERIVED_CONFIDENCE_CEILING * 100)}%`);
  });

  test("a NaN confidence reads as zero, not as a full-confidence claim", () => {
    expect(confidenceLabel(item("i1", "the", 0, 1, { confidence: NaN }))).toBe("Engine timing, 0% confidence.");
  });

  test("opacity carries confidence but a faint word stays visible and a derived one stays capped", () => {
    expect(confidenceOpacity(item("i1", "a", 0, 1, { confidence: 0 }))).toBe(0.45);
    expect(confidenceOpacity(item("i1", "a", 0, 1))).toBe(1);
    expect(confidenceOpacity(item("i1", "a", 0, 1, { source: "derived", confidence: 1 })))
      .toBe(confidenceOpacity(item("i1", "a", 0, 1, { source: "derived", confidence: DERIVED_CONFIDENCE_CEILING })));
  });
});

describe("the waveform mapping", () => {
  test("the playhead maps proportionally and clamps to the strip", () => {
    expect(playheadX(1000, 2000, 400)).toBe(200);
    expect(playheadX(9999, 2000, 400)).toBe(400);
    expect(playheadX(-5, 2000, 400)).toBe(0);
  });

  test("an unknown or zero duration pins it at 0 instead of dividing into NaN", () => {
    for (const bad of [0, -1, NaN, Infinity]) expect(playheadX(500, bad, 400)).toBe(0);
    expect(playheadX(NaN, 2000, 400)).toBe(0);
    expect(playheadX(500, 2000, 0)).toBe(0);
  });

  test("a click on the strip inverts back to the instant it points at", () => {
    expect(msAtX(200, 2000, 400)).toBe(1000);
    expect(msAtX(999, 2000, 400)).toBe(2000);
    expect(msAtX(-3, 2000, 400)).toBe(0);
    expect(msAtX(200, 0, 400)).toBe(0); // nothing measured -> seek to the start, not to NaN
  });

  test("NO peaks means NO bars - an unmeasured clip never fakes a flat line", () => {
    expect(waveformBars([], 400, 50)).toEqual([]);
    expect(waveformBars([0.5], 0, 50)).toEqual([]);
    expect(waveformBars([0.5], 400, 0)).toEqual([]);
  });

  test("peaks tile the width, and a full-scale peak fills the height", () => {
    const bars = waveformBars([0, 0.5, 1], 300, 40);
    expect(bars).toHaveLength(3);
    expect(bars.map((b) => b.x)).toEqual([0, 100, 200]);
    expect(bars[2]!.h).toBe(40);
    expect(bars[0]!.h).toBe(1); // a silent bucket is still one pixel, so the strip has no holes
  });
});

describe("which library tracks the editor can open", () => {
  test("PCM WAV yes, everything else no - the core parses one container", () => {
    expect(isWavTrack({ mime: "audio/wav", title: "take 1" })).toBe(true);
    expect(isWavTrack({ mime: "audio/x-wav", title: "take 1" })).toBe(true);
    expect(isWavTrack({ mime: "audio/mpeg", title: "take 1.mp3" })).toBe(false);
    expect(isWavTrack({ mime: "audio/flac", title: "take 1" })).toBe(false);
  });

  test("an unknown mime falls back to the file name rather than guessing yes", () => {
    expect(isWavTrack({ mime: "", title: "render.wav" })).toBe(true);
    expect(isWavTrack({ mime: "application/octet-stream", title: "render.WAV" })).toBe(true);
    expect(isWavTrack({ mime: "", title: "render" })).toBe(false);
  });
});

describe("the pane keeps its honesty in the markup", () => {
  test("every chip is ONE line: nowrap, ellipsis, and a max-width in the stylesheet class", () => {
    const html = chipStripHtml(doc(), 0, []);
    for (const word of ["the", "quick", "brown", "fox"]) expect(html).toContain(`>${word}</button>`);
    // the class boundary matters: `ced-chips` is the CONTAINER, not a fifth chip
    expect(html.match(/class="ced-chip[ "]/g)).toHaveLength(4);
    expect(html).toContain('class="ced-chips"');
  });

  test("the playing chip and the selected chips are marked apart", () => {
    const html = chipStripHtml(doc(), 900, ["i2", "i3"]);
    expect(html).toContain('class="ced-chip on sel"'); // i3: under the playhead AND selected
    expect(html).toContain('class="ced-chip sel" data-ced-chip="i2"');
    expect(html).toContain('draggable="true"');
  });

  test("a derived word wears its provenance in the class, not only in a tooltip", () => {
    const html = chipStripHtml(doc([item("i1", "maybe", 0, 100, { source: "derived", confidence: 0.7 })]), 0, []);
    expect(html).toContain("ced-chip derived on");
    expect(html).toContain("never engine timing");
  });

  test("the provenance note renders ONCE, as a block paragraph above the strip", () => {
    const html = creatorEditorHtml(view());
    const note = session().note;
    expect(html.split(note)).toHaveLength(2); // exactly one occurrence
    expect(html).toContain(`<p class="ced-note">`);
    expect(html.indexOf(note)).toBeLessThan(html.indexOf("ced-chips"));
  });

  test("a refusal shows the core's own sentence VERBATIM, never a generic message", () => {
    const refusal = "that span contains an item locked to the text";
    const html = creatorEditorHtml(view({ status: refusal, statusTone: "error" }));
    expect(html).toContain(refusal);
    expect(html).toContain('class="ced-status error"');
  });

  test("with no session the pane is just the opener, and it says what a WAV-less library means", () => {
    const html = creatorEditorHtml(view({ session: null, doc: null, tracks: [{ id: "t", title: "song", mime: "audio/mpeg" }] }));
    expect(html).toContain("no WAV tracks in the library");
    expect(html).toContain("data-ced-open disabled");
    expect(html).not.toContain("ced-chips");
  });

  test("span buttons are disabled until words are selected, and undo/redo follow the history", () => {
    const none = creatorEditorHtml(view());
    expect(none).toContain("data-ced-delete disabled");
    expect(none).toContain("data-ced-rerender disabled");
    expect(none).toContain("data-ced-undo disabled");
    const picked = creatorEditorHtml(view({ selected: ["i2"], canUndo: true }));
    expect(picked).not.toContain("data-ced-delete disabled");
    expect(picked).not.toContain("data-ced-undo disabled");
    expect(picked).toContain("1 word selected");
  });

  test("the lock button names the direction it would go", () => {
    expect(creatorEditorHtml(view({ selected: ["i2"] }))).toContain(">Lock<");
    const locked = doc([item("i1", "the", 0, 300, { locked: true })]);
    expect(creatorEditorHtml(view({ doc: locked, selected: ["i1"] }))).toContain(">Unlock<");
  });

  test("the clock shows elapsed over total, both formatted", () => {
    expect(creatorEditorHtml(view({ playheadMs: 65_000, session: session({ durationMs: 125_000 }) })))
      .toContain("1:05 / 2:05");
  });

  test("a null view fails honest instead of painting a half-document", () => {
    expect(creatorEditorHtml(null)).toContain("Nothing was changed");
  });

  test("audio base64 is NEVER interpolated into the markup (it goes to a blob URL in app.ts)", () => {
    const html = creatorEditorHtml(view({ session: session({ audioB64: "SECRETSAMPLES" }) }));
    expect(html).not.toContain("SECRETSAMPLES");
  });
});

describe("the open-session shape gate", () => {
  test("a well-formed session passes", () => {
    expect(isEditorSession(session())).toBe(true);
  });

  test("a payload missing the document, the peaks, or the audio is refused", () => {
    expect(isEditorSession(null)).toBe(false);
    expect(isEditorSession({ ...session(), doc: undefined })).toBe(false);
    expect(isEditorSession({ ...session(), peaks: "lots" })).toBe(false);
    expect(isEditorSession({ ...session(), audioB64: 42 })).toBe(false);
    expect(isEditorSession({ ...session(), sources: null })).toBe(false);
  });
});
