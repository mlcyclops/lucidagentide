// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/creator_mixer.ts - CREATOR-5 (ADR-0289): the mixer pane (pure builders).
//
// CREATOR-2 gave one take an editable timeline. This is the other axis: several takes playing AT ONCE,
// each with its own level, pan, fades, and automation, summed to one file. The graph itself, every gain
// stage, and the render all live in harness/creator/mix.ts, which is pure and already tested. This module
// owns only the two things that core cannot: what the user SEES, and what a control move MEANS.
//
// Why the split is drawn here rather than in app.ts: the mix core deliberately ships NO mutators (a graph
// is data, and a setter that quietly clamped or reordered would be a second opinion about the shape). So
// the mutations a mixing desk needs - move a level, flip a mute, add a bed, drop a track, draw a ramp -
// are pure immutable helpers HERE, unit-tested with no DOM, and app.ts is left with wiring it cannot get
// wrong quietly. Every helper returns a NEW graph and never touches the one it was handed, so undo is a
// reference and a repaint can never observe a half-applied edit.
//
// The server is touched EXACTLY twice: once to list which library tracks can play together (and the
// format they share), once to render. A level move never round-trips.
//
// The honesty rules this pane is responsible for:
//   * NOTHING IS AUTOMATIC. The pane never normalizes, ducks, or limits. It prints the true peak (as a
//     percentage AND in dBFS), the clipped-sample count, and every silent track with the core's own
//     reason. Headroom is a CHECKBOX, and when it is used the exact gain applied is printed as a number.
//   * `null` MEANS UNKNOWN, NEVER 0. An unmeasured track cannot be added, and it says "never measured"
//     instead of showing a zero that reads like a measurement.
//   * A REFUSAL KEEPS ITS OWN WORDS. `trackSilenceReason`, `validateMix`, and the server's `error` are
//     printed verbatim. There is no generic "that did not work" anywhere in this file.
//   * A FALSE REFUSAL IS THE SAME LIE AS A SILENT FIX. A sample-rate mismatch really cannot be mixed (no
//     resampler ships here), so it is refused. A CHANNEL difference genuinely can be: the core folds
//     stereo down and duplicates mono up. So it is allowed, with a note saying what the render will do.
//
// Layering: view types are MIRRORED here (bridge.ts imports them from this file, never from the node-side
// desktop/creator_mixer.ts), and harness/creator/mix.ts is imported directly because it is pure and
// browser-safe - no node builtins anywhere in its import graph.

import { esc } from "./format.ts";
import { icon } from "./icons.ts";
import { formatClock } from "./creator_editor.ts"; // CREATOR-2's clock: one transport format across both panes
import {
  MAX_MIX_TRACKS, headroomGain, mixDurationMs, normalizeEnvelope, soloedTrackIds, trackSilenceReason,
  validateMix, type MixClip, type MixGraph, type MixTrack,
} from "../../harness/creator/mix.ts";

// ── view types (mirror of desktop/creator_mixer.ts; bridge.ts imports these) ──

/** One library track offered to the mix, with the format the server actually MEASURED. Every number here
 *  is nullable because "we never opened that file" is a real answer, and null is unknown, never 0. */
export interface MixerTrackView {
  id: string;
  title: string;
  mime: string;
  durationMs: number | null;
  sampleRate: number | null;
  channels: number | null;
}

/** What `GET /api/creator/mixer/tracks` answers: what can play together, and the format it will play at.
 *  The format is ABSENT when the library holds nothing this build can decode: no format is CLAIMED rather
 *  than a plausible default invented, so an empty library is a real answer and not a malformed one. */
export interface MixerTracksPayload {
  tracks: MixerTrackView[];
  sampleRate?: number;
  channels?: number;
}

/** What `POST /api/creator/mixer/render` answers, top-level (the editor/save shape). Every field past
 *  `ok` is a MEASUREMENT of the render that just happened, or absent. */
export interface RenderMixResult {
  ok: boolean;
  error?: string;
  trackId?: string;
  bytes?: number;
  durationMs?: number;
  peak?: number;
  clipped?: number;
  silentTracks?: { id: string; reason: string }[];
  panIgnored?: boolean;
  /** The exact gain applied when `applyHeadroom` was asked for, else absent. Never a silent change. */
  headroomApplied?: number;
}

/** Shape gate for the tracks payload. Fail-closed: a MALFORMED answer paints nothing and the caller says
 *  the route did not answer properly, rather than opening a mixer onto a format it invented. An answer
 *  with NO format at all is not malformed, it is the honest reply for a library holding nothing this
 *  build can decode, so it passes and the pane goes on to say no format was claimed. Do not re-tighten
 *  this to require the numbers: that turns an honest answer into a false refusal. */
export function isMixerTracksPayload(v: unknown): v is MixerTracksPayload {
  const o = v as MixerTracksPayload | null;
  if (!o || !Array.isArray(o.tracks)) return false;
  // An absent format is legal (nothing decodable in the library). A PRESENT one must be one the core can
  // actually render, so a nonsense rate cannot become the graph a level is built on.
  if (o.sampleRate !== undefined && !(typeof o.sampleRate === "number" && o.sampleRate > 0)) return false;
  if (o.channels !== undefined && o.channels !== 1 && o.channels !== 2) return false;
  if ((o.sampleRate === undefined) !== (o.channels === undefined)) return false; // half a format is not a format
  return o.tracks.every((t) => !!t
    && typeof t.id === "string" && typeof t.title === "string" && typeof t.mime === "string"
    && (t.durationMs === null || typeof t.durationMs === "number")
    && (t.sampleRate === null || typeof t.sampleRate === "number")
    && (t.channels === null || typeof t.channels === "number"));
}

/** Shape gate for a SUCCESSFUL render report. A report missing its measurements is not a report, so the
 *  caller turns it into a named refusal instead of printing blanks where numbers belong. */
export function isRenderMixReport(v: unknown): v is RenderMixResult {
  const o = v as RenderMixResult | null;
  if (!o || o.ok !== true) return false;
  if (typeof o.trackId !== "string" || typeof o.peak !== "number" || typeof o.clipped !== "number") return false;
  if (o.silentTracks !== undefined && !Array.isArray(o.silentTracks)) return false;
  if (o.headroomApplied !== undefined && typeof o.headroomApplied !== "number") return false;
  return true;
}

/** The format the mix runs at, as the SERVER reported it. Null until the route answered: this pane never
 *  guesses a sample rate, because a guessed rate is how a mixer silently resamples. */
export interface MixFormatView { sampleRate: number | null; channels: number | null }

/** The pane's whole renderer-side state. `status` is whatever last happened, printed verbatim. */
export interface CreatorMixerView {
  /** Every library track the server offered, addable or not. A refused one is still SHOWN, with why. */
  library: readonly MixerTrackView[];
  sampleRate: number | null;
  channels: number | null;
  /** The mix being built, edited here against the pure core. Null until the format is known. */
  graph: MixGraph | null;
  /** Which library track the add control has picked. */
  addId: string;
  title: string;
  /** Opt-in headroom. False is the default and stays the default; nothing ticks this for the user. */
  applyHeadroom: boolean;
  report: RenderMixResult | null;
  status: string;
  statusTone: "" | "ok" | "error";
  busy: string;
}

/** The top of a track level control. 4 is +12 dB: enough to rescue a quiet take, bounded so a slider
 *  cannot ask the render for a number nobody meant. */
export const MAX_MIX_GAIN = 4;

// ── pure helpers (the semantics of a control move) ───────────────────────────

/** A patched number, clamped into its own control's range, or the one already there. A non-finite reading
 *  (a half-typed field, an emptied input) is IGNORED rather than written, because a broken field must not
 *  silently zero a level. Every level, pan, and fade setter goes through this one decision. */
const patched = (v: number | undefined, current: number, lo: number, hi: number): number =>
  v === undefined || !Number.isFinite(v) ? current : (v < lo ? lo : v > hi ? hi : v);

const channelWord = (channels: number): string =>
  (channels === 1 ? "mono" : channels === 2 ? "stereo" : `${channels} channels`);

/** A ratio in decibels. The "-0.0" artifact of a hair under unity is folded to a clean 0.0, and a ratio
 *  of zero never reaches here: the log of nothing is not a reading, so callers branch first. */
function dbWords(ratio: number, unit: string): string {
  const db = 20 * Math.log10(ratio);
  const shown = Math.abs(db) < 0.05 ? 0 : db;
  return `${shown > 0 ? "+" : ""}${shown.toFixed(1)} ${unit}`;
}

/** One track's MEASURED format in words. Unknown stays unknown: null is not zero and not a guess. */
export function formatWords(f: { sampleRate: number | null; channels: number | null }): string {
  const rate = f.sampleRate === null ? "an unmeasured sample rate" : `${f.sampleRate}Hz`;
  const ch = f.channels === null ? "an unmeasured channel count" : channelWord(f.channels);
  return `${rate}, ${ch}`;
}

/** The mono/stereo indicator, built from the format the SERVER reported rather than from a default. */
export function mixFormatLabel(fmt: MixFormatView): string {
  if (fmt.sampleRate === null || fmt.channels === null) {
    return "The mixer has not reported a format yet, so this pane is not claiming one.";
  }
  return `This mix renders at ${fmt.sampleRate}Hz, ${channelWord(fmt.channels)}, 16-bit PCM.`;
}

/** A level said as the number that is ACTUALLY applied, plus its dB equivalent. Zero is silent, never
 *  "-Infinity dB". */
export function formatGain(gain: number): string {
  if (!Number.isFinite(gain) || gain <= 0) return "x0.00 (silent)";
  return `x${gain.toFixed(2)} (${dbWords(gain, "dB")})`;
}

/** Where a track sits in the image. A mono mix has nowhere to put it, and says so instead of drawing a
 *  control that does nothing. */
export function panWords(pan: number, channels: number | null): string {
  const p = Number.isFinite(pan) ? (pan < -1 ? -1 : pan > 1 ? 1 : pan) : 0;
  if (channels === 1) return "centre (a mono mix has nowhere to place a pan)";
  if (p === 0) return "centre";
  return `${Math.round(Math.abs(p) * 100)}% ${p < 0 ? "left" : "right"}`;
}

/** A track's automation in words, so a ramp is legible without drawing a graph. */
export function envelopeWords(track: MixTrack): string {
  if (track.envelope.length === 0) return "No automation: one flat level for the whole track.";
  const pts = track.envelope.map((p) => `${formatGain(p.gain)} at ${formatClock(p.atMs)}`).join(", then ");
  return `Automation: ${pts}. The core interpolates linearly between those points.`;
}

export interface Addability {
  addable: boolean;
  /** WHY, in words, either way: the refusal when it cannot be added, or the caveat when it can but the
   *  render will fold or duplicate its channels. Empty when it matches the mix exactly. */
  reason: string;
}

/** Whether one library track can join THIS mix, and the sentence the row shows either way. The reason is
 *  built from the track's own measured sampleRate/channels, never from its name or its mime.
 *
 *  A sample-rate mismatch is REFUSED: this build ships no resampler, so claiming one would be a lie. A
 *  channel difference is ALLOWED with a note, because the core really does fold stereo down and duplicate
 *  mono up - refusing it would be a false refusal, which is the same lie as a silent fix. */
export function trackAddability(track: MixerTrackView, mix: MixFormatView): Addability {
  if (mix.sampleRate === null || mix.channels === null) {
    return { addable: false, reason: "The mixer has not reported the format this mix runs at, so nothing can be added to it yet." };
  }
  if (track.sampleRate === null || track.channels === null) {
    return { addable: false, reason: `This track's format was never measured (${formatWords(track)}), and unknown is not a match.` };
  }
  if (track.sampleRate !== mix.sampleRate) {
    return { addable: false, reason: `This track is ${track.sampleRate}Hz and the mix runs at ${mix.sampleRate}Hz. This build ships no resampler, so it cannot be mixed in.` };
  }
  if (track.durationMs === null) {
    return { addable: false, reason: "This track's length was never measured, and a clip needs a real length. Null is unknown, never zero." };
  }
  if (!(track.durationMs > 0)) {
    return { addable: false, reason: "This track measured no length at all, so there is nothing to place on the timeline." };
  }
  if (track.channels !== mix.channels) {
    const what = mix.channels === 1
      ? "the render folds its channels down to one"
      : "the render puts the same signal on both sides";
    return { addable: true, reason: `This track is ${channelWord(track.channels)} and the mix is ${channelWord(mix.channels)}, so ${what}. That is what the core really does, so this is a note, not a refusal.` };
  }
  return { addable: true, reason: "" };
}

/** A track id nothing else on the graph is using, derived from the source so a row is readable. Layering
 *  the same bed twice is legitimate, so the second copy gets a suffix rather than a refusal. */
function freshTrackId(graph: MixGraph, sourceId: string): string {
  const taken = new Set(graph.tracks.map((t) => t.id));
  const base = `mt-${sourceId}`;
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

export type AddTrackResult =
  | { ok: true; graph: MixGraph; trackId: string }
  | { ok: false; error: string };

/** Add one library track as a NEW mix track carrying its whole file as a single clip at zero. The result
 *  is a refusal with its own sentence when the track cannot join this mix, so the pane never has to
 *  invent a reason the core would not recognize. The graph handed in is never touched. */
export function addLibraryTrack(graph: MixGraph, track: MixerTrackView): AddTrackResult {
  if (graph.tracks.length >= MAX_MIX_TRACKS) {
    return { ok: false, error: `a mix holds at most ${MAX_MIX_TRACKS} tracks; remove one before adding another` };
  }
  const verdict = trackAddability(track, { sampleRate: graph.sampleRate, channels: graph.channels });
  if (!verdict.addable) return { ok: false, error: verdict.reason };
  const durationMs = track.durationMs ?? 0; // trackAddability already refused null and zero
  const trackId = freshTrackId(graph, track.id);
  const clip: MixClip = {
    id: `${trackId}-c1`,
    sourceId: track.id,
    startMs: 0,
    durationMs,
    srcStartMs: 0,
    gain: 1,
    fadeInMs: 0,
    fadeOutMs: 0,
  };
  const next: MixTrack = {
    id: trackId,
    label: track.title || track.id,
    clips: [clip],
    gain: 1,
    pan: 0,
    muted: false,
    solo: false,
    envelope: [],
  };
  return { ok: true, graph: { ...graph, tracks: [...graph.tracks, next] }, trackId };
}

/** Drop one track. A mix without it is a different mix, not a broken one, so this cannot fail: an id the
 *  graph does not hold simply removes nothing. */
export function removeTrack(graph: MixGraph, trackId: string): MixGraph {
  return { ...graph, tracks: graph.tracks.filter((t) => t.id !== trackId) };
}

export interface TrackPatch {
  gain?: number;
  pan?: number;
  muted?: boolean;
  solo?: boolean;
  fadeInMs?: number;
  fadeOutMs?: number;
}

/** Move one track's level, pan, mute, solo, or its clip fades, and get a NEW graph back. Each number is
 *  clamped to its own control's range (a slider cannot ask for a pan of 4), and a non-finite reading is
 *  ignored rather than written. Fade LENGTHS are deliberately not clamped against each other: two fades
 *  that overlap are a real conflict between two fields, and `validateMix` names it in the user's own
 *  numbers, which a silent clamp would have hidden. An id the graph does not hold changes nothing. */
export function patchTrack(graph: MixGraph, trackId: string, patch: TrackPatch): MixGraph {
  const touchesFades = patch.fadeInMs !== undefined || patch.fadeOutMs !== undefined;
  const tracks = graph.tracks.map((t) => {
    if (t.id !== trackId) return t;
    return {
      ...t,
      gain: patched(patch.gain, t.gain, 0, MAX_MIX_GAIN),
      pan: patched(patch.pan, t.pan, -1, 1),
      muted: patch.muted ?? t.muted,
      solo: patch.solo ?? t.solo,
      clips: touchesFades
        ? t.clips.map((c) => ({
          ...c,
          fadeInMs: patched(patch.fadeInMs, c.fadeInMs, 0, Number.MAX_SAFE_INTEGER),
          fadeOutMs: patched(patch.fadeOutMs, c.fadeOutMs, 0, Number.MAX_SAFE_INTEGER),
        }))
        : t.clips,
    };
  });
  return { ...graph, tracks };
}

/** Set the master level. Same rules as a track level, and it applies LAST, exactly as the core says. */
export function setMasterGain(graph: MixGraph, gain: number): MixGraph {
  return { ...graph, masterGain: patched(gain, graph.masterGain, 0, MAX_MIX_GAIN) };
}

/** Set one track's automation to exactly two points: `fromGain` where its audio starts and `toGain` where
 *  its audio ends. Two points is the whole vocabulary this pane offers, because the core interpolates
 *  linearly and a ramp is the automation people actually draw.
 *
 *  The endpoints are the TRACK's own span, not the mix's: a bed that stops halfway should finish its fade
 *  where it stops, not where some other track ends. A track with no clips has no span, so its envelope
 *  comes back EMPTY (a flat 1) rather than two points stacked at zero pretending to be a ramp. */
export function setTwoPointEnvelope(graph: MixGraph, trackId: string, fromGain: number, toGain: number): MixGraph {
  const tracks = graph.tracks.map((t) => {
    if (t.id !== trackId) return t;
    let startMs = Number.POSITIVE_INFINITY;
    let endMs = 0;
    for (const c of t.clips) {
      if (c.startMs < startMs) startMs = c.startMs;
      if (c.startMs + c.durationMs > endMs) endMs = c.startMs + c.durationMs;
    }
    if (!Number.isFinite(startMs) || endMs <= startMs) return { ...t, envelope: [] };
    return { ...t, envelope: normalizeEnvelope([{ atMs: startMs, gain: fromGain }, { atMs: endMs, gain: toGain }]) };
  });
  return { ...graph, tracks };
}

export interface MixerRowState {
  muted: boolean;
  solo: boolean;
  /** The CORE's own sentence for why this track puts nothing into the mix, or "" when it is audible.
   *  Printed verbatim, so the row and the render can never disagree about why a mix is quiet. */
  silence: string;
  audible: boolean;
  /** The clip this row's fade fields edit, or null when there is no clip to fade. */
  clip: MixClip | null;
}

/** How one row should read right now. `soloed` comes from the core so an exclusive solo is decided once
 *  for the whole graph, exactly as the render decides it. */
export function rowState(graph: MixGraph, track: MixTrack, soloed: Set<string> | null): MixerRowState {
  const silence = trackSilenceReason(graph, track, soloed);
  return {
    muted: track.muted,
    solo: track.solo,
    silence: silence ?? "",
    audible: silence === null,
    clip: track.clips[0] ?? null,
  };
}

/** Which library track the saved mix records as its PARENT. A mix has many inputs and the library ledger
 *  has one parent slot, so the first audible track's source is named, and the pane says out loud that
 *  this is what it did. Null when there is nothing to name. */
export function primarySourceId(graph: MixGraph, soloed: Set<string> | null): string | null {
  for (const t of graph.tracks) {
    if (trackSilenceReason(graph, t, soloed) !== null) continue;
    const clip = t.clips[0];
    if (clip) return clip.sourceId;
  }
  return graph.tracks[0]?.clips[0]?.sourceId ?? null;
}

// ── the report, in the user's numbers ────────────────────────────────────────

/** The true peak said twice: as a percentage of full scale and in dBFS. A peak of zero is SILENCE, never
 *  "-Infinity dBFS", because the log of nothing is not a reading. An absent peak is UNKNOWN, not zero. */
export function formatPeak(peak: number | null | undefined): string {
  if (typeof peak !== "number" || !Number.isFinite(peak)) {
    return "Peak was not reported, so this build does not know how hot the mix ran. Unknown is not zero.";
  }
  if (peak <= 0) {
    return "Peak 0% of full scale: silence. Nothing rose above zero, so there is no dBFS reading to give.";
  }
  return `Peak ${(peak * 100).toFixed(1)}% of full scale, ${dbWords(peak, "dBFS")}.`;
}

/** The clipping line. Nothing clipped SAYS so: printing a scary zero next to the word "clipped" reads as
 *  damage that did not happen. An absent count is unknown, not a clean bill of health. */
export function formatClipping(clipped: number | null | undefined): string {
  if (typeof clipped !== "number" || !Number.isFinite(clipped)) {
    return "The clipped-sample count was not reported, so this build cannot say whether anything hit the rail.";
  }
  if (clipped <= 0) return "Nothing clipped: not one sample hit the rail.";
  return `${clipped} sample${clipped === 1 ? "" : "s"} clipped: they hit the rail and were held there. Drop a level or apply headroom, then render again.`;
}

/** What an opt-in headroom pass WOULD scale by, given the last measured peak. Null when nothing has been
 *  measured yet: an unrendered mix has no peak, and 1 is not a measurement. */
export function headroomOffer(peak: number | null | undefined): string | null {
  if (typeof peak !== "number" || !Number.isFinite(peak) || peak <= 0) return null;
  const g = headroomGain(peak);
  if (g === 1) return "The last render already peaked at exactly full scale, so headroom has nothing to recover.";
  const dir = g > 1 ? "up" : "down";
  return `The last render peaked at ${(peak * 100).toFixed(1)}%, so headroom would scale the whole mix ${dir} by x${g.toFixed(4)}.`;
}

/** The render report, in full, as the lines the pane prints. Every number the core measured appears here
 *  exactly once, nothing is rounded away, and nothing that was not measured is invented. */
export function reportLines(r: RenderMixResult): string[] {
  if (!r.ok) return [r.error ?? "The mixer refused the render and did not say why."];
  const out: string[] = [];
  out.push(r.trackId
    ? `Saved as library track ${r.trackId}.`
    : "Rendered, but the mixer did not name the saved track.");
  if (typeof r.durationMs === "number" && typeof r.bytes === "number") {
    out.push(`${formatClock(r.durationMs)} of audio, ${r.bytes} bytes on disk.`);
  }
  out.push(formatPeak(r.peak));
  out.push(formatClipping(r.clipped));
  if (r.panIgnored) {
    out.push("Pan was ignored: this mix renders to one channel, and a mono render has nowhere to place a pan.");
  }
  for (const s of r.silentTracks ?? []) out.push(`Track ${s.id} contributed nothing: ${s.reason}.`);
  if (typeof r.headroomApplied === "number") {
    out.push(`Headroom applied: every sample was scaled by x${r.headroomApplied.toFixed(4)}, because you asked for it. Nothing was scaled on its own.`);
  }
  return out;
}

// ── the pane ─────────────────────────────────────────────────────────────────

/** Master level + the format indicator. The indicator reads the SERVER's numbers, never the graph's
 *  defaults, so it cannot drift into claiming a rate nobody reported. */
function masterHtml(v: CreatorMixerView, graph: MixGraph): string {
  return `<section class="cmx-master">
    <div class="cmx-ctl">
      <label class="cmx-lbl" for="cmxMaster">Master</label>
      <input id="cmxMaster" type="range" class="cmx-range" data-cmx-master min="0" max="${MAX_MIX_GAIN}" step="0.01"
        value="${graph.masterGain}" aria-label="master level" />
      <span class="cmx-val">${esc(formatGain(graph.masterGain))}</span>
    </div>
    <p class="cmx-fmt">${icon("info", 12)}${esc(`${mixFormatLabel({ sampleRate: v.sampleRate, channels: v.channels })} ${mixerDurationLabel(graph)}`)}</p>
  </section>`;
}

/** The add control. Every offered track is LISTED, matched or not, and a refused one keeps its option so
 *  the user can select it and read why. The button is what goes dead, with the reason as prose beneath. */
function addHtml(v: CreatorMixerView): string {
  const fmt: MixFormatView = { sampleRate: v.sampleRate, channels: v.channels };
  const rows = v.library.map((t) => ({ track: t, verdict: trackAddability(t, fmt) }));
  const options = rows.length
    ? rows.map(({ track, verdict }) => {
      const label = `${track.title || track.id} (${formatWords(track)})${verdict.addable ? "" : " cannot mix"}`;
      return `<option value="${esc(track.id)}"${track.id === v.addId ? " selected" : ""}>${esc(label)}</option>`;
    }).join("")
    : `<option value="">the library offered nothing this mix can take</option>`;
  const verdict = rows.find((r) => r.track.id === v.addId)?.verdict;
  const blocked = !verdict || !verdict.addable || !!v.busy;
  const note = verdict && verdict.reason
    ? `<p class="cmx-note">${icon(verdict.addable ? "info" : "alertBadge", 12)}${esc(verdict.reason)}</p>`
    : "";
  return `<section class="cmx-add">
    <div class="cmx-ctl">
      <label class="cmx-lbl" for="cmxAdd">Add track</label>
      <select id="cmxAdd" class="prov-key cmx-pick"${rows.length ? "" : " disabled"}
        data-tip="Add track|Every library track is listed with the format it was actually measured at. One whose sample rate differs cannot be mixed in, because this build ships no resampler.">${options}</select>
      <button type="button" class="btn-mini ok" data-cmx-add${blocked ? " disabled" : ""}>Add</button>
    </div>
    ${note}
  </section>`;
}

/** One mix track. Invariant 11: the label is a single nowrap line with an ellipsis and a hard max-width,
 *  and every flex child holds ONE text node, so a pathological title cannot blow the row out. Prose (the
 *  silence reason, the automation line) is always a BLOCK paragraph, never a flex sibling of a tag. */
function rowHtml(graph: MixGraph, track: MixTrack, soloed: Set<string> | null): string {
  const st = rowState(graph, track, soloed);
  const id = esc(track.id);
  const clip = st.clip;
  const clips = `${track.clips.length} clip${track.clips.length === 1 ? "" : "s"}`;
  const fades = clip
    ? `<div class="cmx-ctl">
        <label class="cmx-lbl" for="cmxIn-${id}">Fade in</label>
        <input id="cmxIn-${id}" type="number" class="prov-key cmx-num" data-cmx-fadein="${id}" min="0" step="10"
          value="${clip.fadeInMs}" aria-label="fade in, milliseconds" />
        <label class="cmx-lbl" for="cmxOut-${id}">Fade out</label>
        <input id="cmxOut-${id}" type="number" class="prov-key cmx-num" data-cmx-fadeout="${id}" min="0" step="10"
          value="${clip.fadeOutMs}" aria-label="fade out, milliseconds" />
      </div>`
    : `<p class="cmx-note">This track holds no clip, so there is no fade to set.</p>`;
  return `<section class="cmx-row${st.audible ? "" : " quiet"}">
    <div class="cmx-head">
      <span class="cmx-name" data-tip="${esc(track.label)}|${esc(`${clips}, source ${clip ? clip.sourceId : "none"}.`)}">${esc(track.label)}</span>
      <button type="button" class="btn-mini${st.muted ? " danger" : ""}" data-cmx-mute="${id}" aria-pressed="${st.muted}">Mute</button>
      <button type="button" class="btn-mini${st.solo ? " ok" : ""}" data-cmx-solo="${id}" aria-pressed="${st.solo}">Solo</button>
      <button type="button" class="btn-mini" data-cmx-env="${id}"
        data-tip="Ramp|A two-point gain ramp across this track's own span. The core interpolates linearly between the two points.">Ramp</button>
      <button type="button" class="btn-mini danger" data-cmx-remove="${id}" aria-label="remove ${esc(track.label)}">${icon("trash", 12)}</button>
    </div>
    <div class="cmx-ctl">
      <label class="cmx-lbl" for="cmxGain-${id}">Level</label>
      <input id="cmxGain-${id}" type="range" class="cmx-range" data-cmx-gain="${id}" min="0" max="${MAX_MIX_GAIN}" step="0.01"
        value="${track.gain}" aria-label="level" />
      <span class="cmx-val">${esc(formatGain(track.gain))}</span>
    </div>
    <div class="cmx-ctl">
      <label class="cmx-lbl" for="cmxPan-${id}">Pan</label>
      <input id="cmxPan-${id}" type="range" class="cmx-range" data-cmx-pan="${id}" min="-1" max="1" step="0.05"
        value="${track.pan}" aria-label="pan" />
      <span class="cmx-val">${esc(panWords(track.pan, graph.channels))}</span>
    </div>
    ${fades}
    ${st.silence ? `<p class="cmx-silent">${icon("alertBadge", 12)}${esc(st.silence)}</p>` : ""}
    ${track.envelope.length ? `<p class="cmx-note">${icon("info", 12)}${esc(envelopeWords(track))}</p>` : ""}
  </section>`;
}

function rowsHtml(graph: MixGraph, soloed: Set<string> | null): string {
  if (graph.tracks.length === 0) {
    return `<p class="cmx-hint">No tracks on the mix yet. Add one above: a mix of nothing has nothing to render, and this pane will say that rather than write an empty file.</p>`;
  }
  return `<div class="cmx-rows">${graph.tracks.map((t) => rowHtml(graph, t, soloed)).join("")}</div>`;
}

/** Every structural problem the core found, in its own words. These are why Render is dead, so they are
 *  printed BEFORE the button rather than discovered by pressing it. */
function problemsHtml(problems: readonly string[]): string {
  if (problems.length === 0) return "";
  return `<div class="cmx-problems">${problems.map((p) => `<p class="cmx-silent">${icon("alertBadge", 12)}${esc(p)}</p>`).join("")}</div>`;
}

/** Render, plus the opt-in headroom checkbox. Headroom is never ticked for the user, and the line under
 *  it says what it would do using the last render's own peak. */
function renderHtml(v: CreatorMixerView, graph: MixGraph, soloed: Set<string> | null, problems: readonly string[]): string {
  const blocked = problems.length > 0 || graph.tracks.length === 0 || !!v.busy;
  const parent = primarySourceId(graph, soloed);
  const offer = headroomOffer(v.report?.peak)
    ?? "Headroom is never applied on its own. Tick this and the render is scaled by one over the peak, and the report names the exact number it used.";
  const parentLine = parent
    ? `Saved with ${parent} recorded as this mix's parent: a mix has many inputs and the library ledger has one parent slot, so the first audible track's source is the one named.`
    : "There is no audible track to record as this mix's parent yet.";
  return `<section class="cmx-render">
    <div class="cmx-ctl">
      <label class="cmx-lbl" for="cmxTitle">Title</label>
      <input id="cmxTitle" class="prov-key cmx-title" value="${esc(v.title)}" spellcheck="false" placeholder="title for the saved mix" />
      <button type="button" class="btn-mini ok" data-cmx-render${blocked ? " disabled" : ""}>${v.busy ? esc(v.busy) : "Render"}</button>
    </div>
    <label class="cmx-check" for="cmxHeadroom">
      <input id="cmxHeadroom" type="checkbox" data-cmx-headroom${v.applyHeadroom ? " checked" : ""} />
      <span>Apply headroom, opt in</span>
    </label>
    <p class="cmx-hint">${esc(offer)}</p>
    <p class="cmx-hint">${esc(parentLine)}</p>
  </section>`;
}

/** The last report, verbatim, one line per measurement. */
function reportHtml(r: RenderMixResult | null): string {
  if (!r) return "";
  return `<section class="cmx-report">${reportLines(r).map((l) => `<p class="cmx-line">${esc(l)}</p>`).join("")}</section>`;
}

/** The whole pane. `status` is the last thing that happened, printed verbatim: a refusal keeps the
 *  server's own words, because those are the ones that tell the user what to do differently. */
export function creatorMixerHtml(v: CreatorMixerView | null): string {
  if (!v) {
    return `<div class="cmx-body"><p class="cst-empty">The mixer could not read its state. Nothing was changed; switch tabs and back to reload it.</p></div>`;
  }
  const status = v.status
    ? `<p class="cmx-status${v.statusTone ? ` ${v.statusTone}` : ""}">${icon(v.statusTone === "error" ? "alertBadge" : "info", 12)}${esc(v.status)}</p>`
    : "";
  const graph = v.graph;
  if (!graph) {
    return `<div class="cmx-body">${status}
      <p class="cmx-hint">The mixer has not read the library yet. It asks the server exactly twice: once for the tracks that can play together and the format they share, once to render. Every level, pan, fade, and ramp in between happens here, against the same code the render uses.</p>
    </div>`;
  }
  const soloed = soloedTrackIds(graph);
  const problems = validateMix(graph);
  return `<div class="cmx-body">
    ${status}
    ${masterHtml(v, graph)}
    ${addHtml(v)}
    ${rowsHtml(graph, soloed)}
    ${problemsHtml(problems)}
    ${renderHtml(v, graph, soloed, problems)}
    ${reportHtml(v.report)}
  </div>`;
}

/** The mix's own length, for the pane's header line. Kept here so app.ts never reaches past this seam. */
export function mixerDurationLabel(graph: MixGraph | null): string {
  if (!graph || graph.tracks.length === 0) return "Nothing on the mix yet.";
  const ms = mixDurationMs(graph);
  return ms > 0
    ? `${formatClock(ms)} long, ${graph.tracks.length} track${graph.tracks.length === 1 ? "" : "s"}.`
    : `${graph.tracks.length} track${graph.tracks.length === 1 ? "" : "s"}, none of them holding a clip with a length.`;
}
