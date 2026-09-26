// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/creator_editor.ts - CREATOR-2 (ADR-0286): the follow-along audio editor (pure builders).
//
// The pane where audio follows the words: tap a word to seek, shift-click to take a span, drag it, delete
// it, lock it, split it, or re-render just that span. Every EDIT is a call into harness/creator/timeline.ts,
// which is pure and already tested; this module owns only the two things that module cannot: what the user
// SEES and what the user MEANS by a gesture.
//
// Why the split is drawn here rather than in app.ts: the interesting decisions in an editor are not the DOM
// calls, they are the little semantic maps - which chips a shift-click covers, where a drop lands, what a
// chip looks like at this playhead, what a confidence actually licenses us to claim. Those are pure
// functions here, unit-tested with no DOM, and app.ts is left with wiring it cannot get wrong quietly.
//
// The honesty rules this pane is responsible for:
//   * The alignment PROVENANCE note renders ONCE, as a block paragraph above the strip, in the words the
//     core gave us. A derived alignment is a measurement plus a distribution, and it says so.
//   * `confidenceLabel` branches on `source`, never on the number, and CAPS what a derived item may claim
//     at DERIVED_CONFIDENCE_CEILING. A guess can never be printed as engine timing, even if a malformed
//     document arrives claiming 1.0.
//   * A refused operation shows the core's own `error` string verbatim. There is no generic "that did not
//     work" anywhere in this file.
//
// Layering: view types are MIRRORED here (bridge.ts imports them from this file, never from the node-side
// desktop/creator_editor.ts), and harness/creator/timeline.ts is imported directly because it is pure and
// browser-safe - no node builtins anywhere in its import graph.

import { esc } from "./format.ts";
import { icon } from "./icons.ts";
import { DERIVED_CONFIDENCE_CEILING, docDurationMs, type TimelineDoc, type TimelineItem } from "../../harness/creator/timeline.ts";

// ── view types (mirror of desktop/creator_editor.ts; bridge.ts imports these) ──

/** One library track offered as a replacement source for a span re-render. `durationMs` is null when the
 *  library never measured it - null is unknown, never 0. */
export interface EditorSourceView { id: string; title: string; durationMs: number | null }

/** Everything one open editing session needs, in one payload: the document, the audio to play against it,
 *  the waveform the server already measured, and the provenance line to print verbatim. */
export interface EditorSession {
  trackId: string;
  title: string;
  doc: TimelineDoc;
  /** The alignment provenance line, shown verbatim in the UI. */
  note: string;
  peaks: number[];
  audioB64: string;
  mime: string;
  durationMs: number;
  /** Library track ids usable as replacement sources, newest first. */
  sources: EditorSourceView[];
}

/** Shape gate for the editor/open payload. Fail-closed: a malformed session opens nothing and the caller
 *  says the route did not answer, rather than painting a half-document. */
export function isEditorSession(v: unknown): v is EditorSession {
  const o = v as EditorSession | null;
  return !!o && typeof o.trackId === "string" && typeof o.audioB64 === "string" && typeof o.note === "string"
    && Array.isArray(o.peaks) && Array.isArray(o.sources)
    && !!o.doc && Array.isArray(o.doc.items) && Array.isArray(o.doc.clips) && typeof o.doc.sampleRate === "number";
}

/** One library track offered in the picker. */
export interface EditorTrackOption { id: string; title: string; mime: string }

/** The pane's whole renderer-side state. `status` is whatever last happened, printed verbatim. */
export interface CreatorEditorView {
  tracks: readonly EditorTrackOption[];
  trackId: string;
  text: string;
  session: EditorSession | null;
  /** The CURRENT document (the session's, plus every edit since). Null until a session opens. */
  doc: TimelineDoc | null;
  selected: readonly string[];
  playheadMs: number;
  playing: boolean;
  canUndo: boolean;
  canRedo: boolean;
  title: string;
  status: string;
  statusTone: "" | "ok" | "error";
  busy: string;
}

// ── pure helpers (the semantics of a gesture) ────────────────────────────────

const clamp = (n: number, lo: number, hi: number): number => (n < lo ? lo : n > hi ? hi : n);

/** mm:ss (h:mm:ss past an hour). A negative, NaN, or infinite input is NOT a clock reading, so it prints
 *  the zero clock rather than "NaN:aN" - the transport must never show the user a broken glyph. */
export function formatClock(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0:00";
  const total = Math.floor(ms / 1000);
  const ss = String(total % 60).padStart(2, "0");
  const mins = Math.floor(total / 60);
  const hours = Math.floor(mins / 60);
  return hours > 0 ? `${hours}:${String(mins % 60).padStart(2, "0")}:${ss}` : `${mins}:${ss}`;
}

/** The item ids a shift-click covers: everything between the anchor chip and the focus chip, INCLUSIVE, in
 *  document order whichever way the user dragged their attention. An id the document does not know is not
 *  invented into the range; if neither end exists there is nothing to select. */
export function selectionRange(doc: TimelineDoc, anchorId: string, focusId: string): string[] {
  const ids = doc.items.map((it) => it.id);
  const a = ids.indexOf(anchorId);
  const b = ids.indexOf(focusId);
  if (a < 0 && b < 0) return [];
  if (a < 0) return [ids[b]!];
  if (b < 0) return [ids[a]!];
  return ids.slice(Math.min(a, b), Math.max(a, b) + 1);
}

/** Where a span dropped onto `chipId` should land. Null means there is no move to make: the chip is not in
 *  the document, or it is part of the span being dragged (dropping a span on itself is not an edit, and
 *  calling moveSpan for it would churn history for nothing). */
export function dropTargetMs(doc: TimelineDoc, chipId: string, moving: readonly string[]): number | null {
  if (moving.includes(chipId)) return null;
  const item = doc.items.find((it) => it.id === chipId);
  return item ? item.startMs : null;
}

export interface ChipState { playing: boolean; selected: boolean; locked: boolean; derived: boolean }

/** How one chip should look right now. `playing` is HALF-OPEN on purpose, matching `itemAt`: at exactly the
 *  end instant the next word has the playhead, so two chips never light at once on a boundary. */
export function chipState(item: TimelineItem, playheadMs: number, selected: ReadonlySet<string>): ChipState {
  return {
    playing: Number.isFinite(playheadMs) && playheadMs >= item.startMs && playheadMs < item.endMs,
    selected: selected.has(item.id),
    locked: item.locked,
    derived: item.source === "derived",
  };
}

/** What we are allowed to claim about one item's timing. Branches on SOURCE, never on the number, and caps
 *  a derived claim at DERIVED_CONFIDENCE_CEILING - so a document that arrives claiming a derived item is
 *  vendor-grade still cannot print itself as engine timing. */
export function confidenceLabel(item: TimelineItem): string {
  const raw = Number.isFinite(item.confidence) ? clamp(item.confidence, 0, 1) : 0;
  if (item.source === "vendor") return `Engine timing, ${Math.round(raw * 100)}% confidence.`;
  const capped = Math.min(raw, DERIVED_CONFIDENCE_CEILING);
  return `LUCID measured this: ${Math.round(capped * 100)}% confidence at most. A derived guess, never engine timing.`;
}

/** Chip opacity from confidence: a low-confidence word is visibly fainter, but never invisible. */
export function confidenceOpacity(item: TimelineItem): number {
  const raw = Number.isFinite(item.confidence) ? clamp(item.confidence, 0, 1) : 0;
  const capped = item.source === "vendor" ? raw : Math.min(raw, DERIVED_CONFIDENCE_CEILING);
  return Math.round((0.45 + capped * 0.55) * 100) / 100;
}

/** Playhead x in canvas pixels. An unknown or zero duration pins it at the left edge rather than dividing
 *  by zero into NaN and losing the whole paint. */
export function playheadX(ms: number, durationMs: number, width: number): number {
  if (!Number.isFinite(ms) || !Number.isFinite(durationMs) || durationMs <= 0 || !(width > 0)) return 0;
  return clamp((ms / durationMs) * width, 0, width);
}

/** The inverse: which instant the user clicked on the strip. Same degenerate guard, so a click on an
 *  empty waveform seeks to 0 instead of to NaN. */
export function msAtX(x: number, durationMs: number, width: number): number {
  if (!Number.isFinite(x) || !Number.isFinite(durationMs) || durationMs <= 0 || !(width > 0)) return 0;
  return clamp((x / width) * durationMs, 0, durationMs);
}

export interface WaveBar { x: number; w: number; h: number }

/** The waveform strip as bars. NO peaks means NO bars: the pane draws an empty trough and says the audio
 *  was never measured, rather than inventing a flat line that reads as silence. */
export function waveformBars(peaks: readonly number[], width: number, height: number): WaveBar[] {
  if (peaks.length === 0 || !(width > 0) || !(height > 0)) return [];
  const w = width / peaks.length;
  return peaks.map((p, i) => ({
    x: i * w,
    w,
    h: Math.max(1, clamp(Number.isFinite(p) ? p : 0, 0, 1) * height),
  }));
}

/** Whether a library track can be opened as an editable timeline. The editor reads PCM/RIFF WAV only (the
 *  one container the pure core parses), so an mp3 is refused up front instead of failing server-side. */
export function isWavTrack(track: { mime: string; title: string }): boolean {
  const mime = track.mime.toLowerCase();
  if (mime.startsWith("audio/")) return mime.includes("wav");
  return /\.wav$/i.test(track.title.trim());
}

// ── the pane ─────────────────────────────────────────────────────────────────

/** The picker: which library WAV to follow, and the words to follow it with. */
function openerHtml(v: CreatorEditorView): string {
  const wavs = v.tracks.filter(isWavTrack);
  const options = wavs.length
    ? wavs.map((t) => `<option value="${esc(t.id)}"${t.id === v.trackId ? " selected" : ""}>${esc(t.title || t.id)}</option>`).join("")
    : `<option value="">no WAV tracks in the library</option>`;
  const blocked = wavs.length === 0 || !!v.busy;
  return `<section class="ced-open">
    <div class="ced-row">
      <label class="ced-lbl" for="cedTrack">Track</label>
      <select id="cedTrack" class="prov-key ced-pick"${wavs.length ? "" : " disabled"}
        data-tip="Track|The editor reads PCM WAV, the one container the timeline core parses. Import a WAV render to edit it word by word.">${options}</select>
      <button type="button" class="btn-mini ok" data-ced-open${blocked ? " disabled" : ""}>${v.busy ? esc(v.busy) : "Open"}</button>
    </div>
    <textarea id="cedText" class="prov-key ced-text" rows="3" spellcheck="false"
      placeholder="The words this audio says. Leave it empty to use the track's own lyrics or prompt.">${esc(v.text)}</textarea>
    ${wavs.length ? "" : `<p class="ced-hint">Nothing here is a WAV yet. The follow-along editor needs PCM WAV, because that is what the timeline core can cut without a second decoder.</p>`}
  </section>`;
}

/** One word. ONE line, always: nowrap plus an ellipsis plus a max-width, so a pathological token cannot
 *  blow the strip out (invariant 11). Its confidence is in its opacity, and a derived word wears a dotted
 *  underline so provenance is legible at a glance, not only in the tooltip. */
function chipHtml(item: TimelineItem, st: ChipState): string {
  const cls = ["ced-chip"];
  if (st.derived) cls.push("derived");
  if (st.playing) cls.push("on");
  if (st.selected) cls.push("sel");
  if (st.locked) cls.push("lock");
  return `<button type="button" class="${cls.join(" ")}" data-ced-chip="${esc(item.id)}"
    draggable="${st.selected ? "true" : "false"}" aria-pressed="${st.selected ? "true" : "false"}"
    style="--conf:${confidenceOpacity(item)}"
    data-tip="${esc(item.text)}|${esc(confidenceLabel(item))}${item.locked ? " Locked: edits refuse to retime it." : ""}">${esc(item.text)}</button>`;
}

/** The word strip. The provenance note is NOT here - it is a block paragraph of its own above it. */
export function chipStripHtml(doc: TimelineDoc, playheadMs: number, selected: readonly string[]): string {
  if (doc.items.length === 0) {
    return `<p class="cst-empty">This document has audio but no words. Paste the script above and open it again to align them.</p>`;
  }
  const sel = new Set(selected);
  return `<div class="ced-chips" data-ced-chips>${doc.items.map((it) => chipHtml(it, chipState(it, playheadMs, sel))).join("")}</div>`;
}

/** Waveform + transport. The canvas is painted by app.ts from `session.peaks`; the clock and the scrub are
 *  the same instant expressed twice, so a drag and a play move together. */
function transportHtml(v: CreatorEditorView, durationMs: number): string {
  const at = clamp(v.playheadMs, 0, Math.max(0, durationMs));
  return `<section class="ced-stage">
    <canvas class="ced-wave" data-ced-wave aria-label="waveform"></canvas>
    <div class="ced-transport">
      <button type="button" class="btn-mini ced-play" data-ced-play aria-label="${v.playing ? "Pause" : "Play"}">${icon(v.playing ? "square" : "chevron", 13)}</button>
      <input type="range" class="ced-scrub" data-ced-scrub min="0" max="${Math.max(1, Math.round(durationMs))}"
        value="${Math.round(at)}" step="10" aria-label="scrub" />
      <span class="ced-clock" data-ced-clock>${esc(`${formatClock(at)} / ${formatClock(durationMs)}`)}</span>
    </div>
  </section>`;
}

/** The edit bar. Every span button is disabled with a reason in its tooltip rather than silently inert. */
function actionsHtml(v: CreatorEditorView, doc: TimelineDoc): string {
  const n = v.selected.length;
  const span = n > 0 ? "" : " disabled";
  const sel = new Set(v.selected);
  const anyUnlocked = doc.items.some((it) => sel.has(it.id) && !it.locked);
  return `<section class="ced-acts">
    <div class="ced-act-row">
      <span class="ced-count">${esc(n ? `${n} word${n === 1 ? "" : "s"} selected` : "tap a word, shift-click for a span")}</span>
      <button type="button" class="btn-mini" data-ced-split data-tip="Split at the playhead|A text-level cut: the word under the playhead becomes two. The audio is untouched.">Split</button>
      <button type="button" class="btn-mini" data-ced-lock${span} data-tip="Lock or unlock|A locked word keeps its timing through a re-align and refuses to be dragged.">${anyUnlocked ? "Lock" : "Unlock"}</button>
      <button type="button" class="btn-mini danger" data-ced-delete${span} data-tip="Delete the span|Its clips and its words go, and the timeline closes up behind them.">Delete</button>
      <button type="button" class="btn-mini" data-ced-rerender${span} data-tip="Re-render the span|A new clip replaces exactly this span, carrying the prompt and its parent clip. Audio outside the span is byte-identical.">Re-render</button>
    </div>
    <div class="ced-act-row">
      <button type="button" class="btn-mini" data-ced-undo${v.canUndo ? "" : " disabled"}>Undo</button>
      <button type="button" class="btn-mini" data-ced-redo${v.canRedo ? "" : " disabled"}>Redo</button>
      <input id="cedTitle" class="prov-key ced-title" value="${esc(v.title)}" spellcheck="false" placeholder="title for the saved render" />
      <button type="button" class="btn-mini ok" data-ced-save${v.busy ? " disabled" : ""}>Save</button>
    </div>
  </section>`;
}

/** The whole pane. `status` is the last thing that happened, printed verbatim: a refusal keeps the core's
 *  own words, because those are the ones that tell the user what to do differently. */
export function creatorEditorHtml(v: CreatorEditorView | null): string {
  if (!v) {
    return `<div class="ced-body"><p class="cst-empty">The editor could not read its state. Nothing was changed; switch tabs and back to reload it.</p></div>`;
  }
  const status = v.status
    ? `<p class="ced-status${v.statusTone ? ` ${v.statusTone}` : ""}">${icon(v.statusTone === "error" ? "alertBadge" : "info", 12)}${esc(v.status)}</p>`
    : "";
  const doc = v.doc;
  if (!doc || !v.session) {
    return `<div class="ced-body">${status}${openerHtml(v)}
      <p class="ced-hint">Open a track to get its words on a timeline. From there a tap seeks, a shift-click takes a span, and a span can be moved, deleted, locked, split, or re-rendered on its own.</p>
    </div>`;
  }
  const durationMs = Math.max(docDurationMs(doc), v.session.durationMs);
  return `<div class="ced-body">
    ${status}
    ${openerHtml(v)}
    <p class="ced-note">${icon("info", 12)}${esc(v.session.note)}</p>
    ${transportHtml(v, durationMs)}
    ${chipStripHtml(doc, v.playheadMs, v.selected)}
    ${actionsHtml(v, doc)}
  </div>`;
}
