// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/creator_pipeline.ts - CREATOR-3 (ADR-0287): the video and 3D render pane (pure builders).
//
// The renderer half of desktop/creator_pipeline.ts. Pure HTML strings only: no fetch, no node builtins, no
// DOM mutation, and no bridge.ts import (the layering rule), so the whole pane is unit-tested with no
// browser and no server. app.ts owns the wiring and the socket's lifetime; this module owns what a render
// LOOKS like, which is where a pipeline's honesty either survives or quietly dies.
//
// The four rules this pane exists to keep:
//
//   * A MALFORMED PAYLOAD PAINTS NOTHING. `isPipelineRunView` is a fail-closed gate. Half a report is worse
//     than no report, because a human reads a half-painted result as a finished render.
//   * A REFUSED OUTPUT IS SHOWN. `refusalListHtml` prints every refusal with the pipeline's own reason. A
//     silently dropped output is exactly how someone comes to believe a render succeeded.
//   * AN UNKNOWN PERCENT SAYS SO. `progressLine` never invents a bar. A null feed says the socket was not
//     open and that polling the history decided the outcome, because on this pipeline /history is the
//     authority and the websocket is only telemetry.
//   * EVERY REMOTE STRING IS ESCAPED (invariant 5). Filenames, mime types, model names, prompts, scan
//     verdicts, and refusal reasons all come from a server LUCID does not trust. They reach HTML only
//     through `esc`, the same escaper creator_editor.ts, creator_images.ts, and creator_monitor.ts use;
//     this file does NOT define a second one, it re-exports that one under the name the pane's callers ask
//     for, because a second escaper is a second place to get escaping wrong.
//
// Invariant 11 is structural here, not a comment. Every flex row emitted below is named `cpl-*-row` and
// holds ONLY element children, each with exactly one text node, so the CSS can nowrap/ellipsis a label
// without a sentence shattering into stacked slivers. Prose is a BLOCK paragraph (`<p class="cpl-*">`) that
// holds at most one leading icon plus one text node, the `.set-note` shape: the icon must be positioned
// absolutely in CSS so the sentence flows as normal prose. creator_pipeline.test.ts asserts both of those
// shapes against the emitted markup rather than trusting the author.

import { esc } from "./format.ts";
import { icon } from "./icons.ts";
import { fmtBytes } from "./creator_images.ts"; // CREATOR-IMG's byte formatter: one size format across both panes

/** The house escaper, under the name this pane's contract asks for. Not a new implementation: `esc` in
 *  ./format.ts is the one every other pane already uses. */
export { esc as escapeHtml } from "./format.ts";

// ── view types (mirror of desktop/creator_pipeline.ts; bridge.ts imports these) ──

/** One stored output, flattened for the view. `bytes`, `sha256`, and `scanned` are the provenance the card
 *  shows: what was written, what it hashed to, and what the scanner said about the metadata that came with
 *  it. Every field is a plain string or number so this type never drags the node-side artifact shape into
 *  the browser bundle. */
export interface PipelineMediaView {
  readonly id: string;
  readonly file: string;
  readonly mime: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly kind: string;
  readonly prompt: string;
  readonly model: string;
  /** The scan verdict's own words. Empty means no verdict travelled with the record, which the card SAYS
   *  rather than papering over with a checkmark. */
  readonly scanned: string;
}

/** One render, as the route reports it: the verdict, where it stopped, what it stored, and what it refused.
 *  `stage` and `kind` are plain strings on purpose - an unrecognised value from a newer server prints
 *  verbatim instead of being coerced into a member of a closed set it does not belong to. */
export interface PipelineRunView {
  readonly ok: boolean;
  readonly error: string;
  readonly jobId: string;
  readonly promptId: string;
  readonly stage: string;
  readonly kind: string;
  readonly media: readonly PipelineMediaView[];
  readonly refused: readonly { readonly filename: string; readonly reason: string }[];
  readonly unresolved: readonly string[];
  readonly note: string;
  /** The websocket's last word, when a socket was open. OPTIONAL on purpose: telemetry that is missing or
   *  malformed is not a malformed run, so its absence must never fail the shape gate and hide a real
   *  result. `progressLine(null)` then says the socket was not open, which is the truth. */
  readonly progress?: PipelineProgressView | null;
}

/** The websocket's last word, flattened. `pct` is null when the server reported no measurable progress, and
 *  null is UNKNOWN, never 0: a 0% bar reads as "nothing is happening" to someone deciding whether to kill a
 *  forty-minute render. */
export interface PipelineProgressView {
  readonly status: string;
  readonly node: string;
  readonly pct: number | null;
  readonly previewCount: number;
  readonly error: string;
}

/** Shape gate for one media record. A media list whose entries are not objects is a malformed payload, not
 *  a list of empty cards. */
function isMediaView(v: unknown): v is PipelineMediaView {
  const o = v as PipelineMediaView | null;
  return !!o && typeof o === "object"
    && typeof o.id === "string" && typeof o.file === "string" && typeof o.mime === "string"
    && typeof o.bytes === "number" && typeof o.sha256 === "string" && typeof o.kind === "string"
    && typeof o.prompt === "string" && typeof o.model === "string" && typeof o.scanned === "string";
}

/** Shape gate for one refusal. A refusal without its reason is not a refusal LUCID can show, and showing
 *  the filename alone would be the silent drop this pane exists to prevent. */
function isRefusalView(v: unknown): v is { filename: string; reason: string } {
  const o = v as { filename?: unknown; reason?: unknown } | null;
  return !!o && typeof o === "object" && typeof o.filename === "string" && typeof o.reason === "string";
}

/** Shape gate for the render route's payload. Fail-closed, in the style of `isEditorSession`: a malformed
 *  run paints NOTHING and the caller says the route did not answer, rather than painting a report with a
 *  missing verdict, a missing stage, or cards for records that are not records. */
export function isPipelineRunView(v: unknown): v is PipelineRunView {
  const o = v as PipelineRunView | null;
  if (!o || typeof o !== "object") return false;
  if (typeof o.ok !== "boolean" || typeof o.error !== "string" || typeof o.jobId !== "string"
    || typeof o.promptId !== "string" || typeof o.stage !== "string" || typeof o.kind !== "string"
    || typeof o.note !== "string") return false;
  if (!Array.isArray(o.media) || !Array.isArray(o.refused) || !Array.isArray(o.unresolved)) return false;
  // `progress` is deliberately NOT required: see the field's own note. A run whose telemetry is unreadable
  // still reports what it stored.
  return o.media.every(isMediaView)
    && o.refused.every(isRefusalView)
    && o.unresolved.every((u) => typeof u === "string");
}

// ── labels (data, so an unknown value falls through verbatim) ────────────────

/** Where the pipeline stopped, in words. An unrecognised stage prints as itself: the pane would rather show
 *  a server's raw word than translate it wrongly. */
const STAGE_LABEL: Record<string, string> = {
  capability: "capability check",
  admission: "resource admission",
  template: "workflow template",
  submit: "submit",
  wait: "waiting for the render",
  fetch: "download",
  scan: "metadata scan",
  store: "store",
  done: "done",
};

/** Artifact and request kinds share one map: the request side speaks image/video/model-3d, the stored side
 *  adds CREATOR-IMG's builder kinds. */
const KIND_LABEL: Record<string, string> = {
  image: "still image",
  video: "video",
  "model-3d": "3D model",
  sheet: "sprite sheet",
  gif: "gif",
  meme: "meme",
  markup: "markup",
};

// ── progress: one honest sentence, never a fake bar ─────────────────────────

/**
 * The single sentence under the render. Returns PLAIN TEXT (the caller escapes it), because the node name
 * and the error inside it came from a remote server.
 *
 * Null is not "0%": it means no `/ws` feed was open, so the outcome was decided by polling `/history`, and
 * the pane says exactly that. An unknown percent says it is unknown. A running node is NAMED, so a stuck
 * render is attributable to a node rather than to "something". An error is stated in the server's own
 * words, whatever the status claims alongside it.
 */
export function progressLine(p: PipelineProgressView | null): string {
  if (!p) {
    return "No progress socket was open, so polling the render history decided this outcome, not live telemetry.";
  }
  if (p.error) return `The render reported an error: ${p.error}`;
  const pct = p.pct === null || !Number.isFinite(p.pct) ? null : Math.max(0, Math.min(100, Math.round(p.pct)));
  const previews = p.previewCount > 0
    ? `, ${p.previewCount} preview frame${p.previewCount === 1 ? "" : "s"} received`
    : "";
  const node = p.node.trim();
  switch (p.status) {
    case "queued":
      return pct === null
        ? "Queued, no progress reported yet."
        : `Queued at ${pct}%${previews}.`;
    case "running":
      if (node) return pct === null ? `Running ${node}, no percent reported yet${previews}.` : `Running ${node} at ${pct}%${previews}.`;
      return pct === null
        ? `Running, the server has not named a node yet${previews}.`
        : `Running at ${pct}%, no node named${previews}.`;
    case "done":
      return `The render reported it finished${previews}.`;
    case "error":
      return "The render reported an error and named no reason for it.";
    case "interrupted":
      return `The render was interrupted before it finished, so any percent already shown is stale${previews}.`;
    default:
      return `The render reported a status LUCID does not recognise: ${p.status || "an empty status"}.`;
  }
}

// ── the pane ────────────────────────────────────────────────────────────────

/**
 * One stored output. Two `cpl-card-row` flex rows of single-text spans (invariant 11: the filename takes
 * the slack and ellipsizes, the kind/size/digest chips stay nowrap), then the model, prompt, and scan
 * verdict as BLOCK paragraphs, because those are prose and prose in a flex row shatters.
 *
 * Every string here is remote: the filename and the mime came from the render server, the prompt and model
 * came back through the artifact record. All of them go through `esc`.
 */
export function mediaCardHtml(m: PipelineMediaView): string {
  const kind = KIND_LABEL[m.kind] ?? m.kind;
  const digest = m.sha256 ? m.sha256.slice(0, 12) : "no digest";
  return `<div class="cpl-card" data-cpl-media="${esc(m.id)}">
    <div class="cpl-card-row">
      <span class="cpl-file" data-tip="File|${esc(m.file || "This output arrived with no filename.")}" data-tip-side="top">${esc(m.file || "unnamed output")}</span>
      <span class="cpl-kind">${esc(kind)}</span>
    </div>
    <div class="cpl-card-row">
      <span class="cpl-mime">${esc(m.mime || "type unknown")}</span>
      <span class="cpl-bytes">${esc(fmtBytes(m.bytes))}</span>
      <span class="cpl-sha" data-tip="Provenance|sha256 ${esc(m.sha256 || "not recorded")}" data-tip-side="top">${esc(digest)}</span>
    </div>
    ${m.model ? `<p class="cpl-model">${esc(m.model)}</p>` : ""}
    ${m.prompt ? `<p class="cpl-prompt">${esc(m.prompt)}</p>` : ""}
    <p class="cpl-scan">${esc(m.scanned || "No scan verdict came back with this record, so LUCID will not claim its metadata was checked.")}</p>
  </div>`;
}

/**
 * The outputs LUCID would not store, each with the pipeline's own reason. Returns "" only for an empty
 * list: a non-empty list ALWAYS renders, because a refused output that is not shown is indistinguishable,
 * from the user's side, from a render that quietly produced less than it claimed.
 *
 * The reason is a block paragraph rather than a row chip: a scan verdict or a mime contradiction is a
 * sentence, and it must be readable in full rather than ellipsized into a hint.
 */
export function refusalListHtml(refused: readonly { readonly filename: string; readonly reason: string }[]): string {
  if (!refused.length) return "";
  const items = refused.map((r) => `<div class="cpl-refused-item">
    <div class="cpl-refused-row">
      <span class="cpl-refused-file">${esc(r.filename || "unnamed output")}</span>
      <span class="cpl-refused-tag">not stored</span>
    </div>
    <p class="cpl-refused-why">${esc(r.reason || "The pipeline refused this output and named no reason, which is itself a reason to distrust it.")}</p>
  </div>`).join("");
  return `<section class="cpl-refused">
    <h5 class="cpl-refused-h">${icon("shield", 12)}<span class="cpl-refused-h-t">${esc(`${refused.length} output${refused.length === 1 ? "" : "s"} refused, none of them stored`)}</span></h5>
    ${items}
  </section>`;
}

/**
 * The whole report for one run: the verdict row, the error, the progress sentence, the refusals, any
 * unresolved template placeholders, the pipeline's note, and the cards.
 *
 * A failed run names its STAGE and its ERROR and claims NOTHING it does not have: with no stored media it
 * says so in words instead of rendering an empty grid that reads as "still loading". A run that stored some
 * media and then failed shows both, because that is what happened.
 */
export function runReportHtml(run: PipelineRunView, p: PipelineProgressView | null): string {
  const stage = STAGE_LABEL[run.stage] ?? run.stage;
  const kind = KIND_LABEL[run.kind] ?? run.kind;
  const n = run.media.length;
  const verdict = run.ok
    ? `Stored ${n} output${n === 1 ? "" : "s"}`
    : `Stopped at the ${stage} stage`;
  const empty = run.ok
    ? "This run finished with nothing to store: the server produced no output LUCID could keep."
    : "No media was stored, so nothing from this run reached the library.";
  const unresolved = run.unresolved.length
    ? `<p class="cpl-run-unresolved">${esc(`The workflow template left ${run.unresolved.length} placeholder${run.unresolved.length === 1 ? "" : "s"} unresolved: ${run.unresolved.join(", ")}. A template LUCID cannot fill is never submitted.`)}</p>`
    : "";
  return `<section class="cpl-run ${run.ok ? "ok" : "bad"}" data-cpl-job="${esc(run.jobId)}">
    <div class="cpl-run-row">
      <span class="cpl-run-verdict">${esc(verdict)}</span>
      <span class="cpl-run-kind">${esc(kind)}</span>
      <span class="cpl-run-job">${esc(run.jobId || "no job id")}</span>
    </div>
    <div class="cpl-run-row">
      <span class="cpl-run-stage">${esc(`stage: ${stage}`)}</span>
      <span class="cpl-run-prompt-id">${esc(run.promptId ? `prompt ${run.promptId}` : "no prompt id")}</span>
    </div>
    ${run.error ? `<p class="cpl-run-error">${icon("shield", 12)}${esc(run.error)}</p>` : ""}
    <p class="cpl-run-progress">${esc(progressLine(p))}</p>
    ${unresolved}
    ${run.note ? `<p class="cpl-run-note">${esc(run.note)}</p>` : ""}
    ${refusalListHtml(run.refused)}
    ${n ? `<div class="cpl-media">${run.media.map((m) => mediaCardHtml(m)).join("")}</div>`
        : `<p class="cpl-run-empty">${esc(empty)}</p>`}
  </section>`;
}

// ---- the pane shell ----

/** Everything the Render tab holds: the request the user is composing, what the live probe proved this
 *  install can do, and the last run's report. `models` and `attested` come from the server, never from a
 *  hardcoded list, so an install that proves nothing offers nothing. */
export interface CreatorRenderView {
  readonly kind: string;
  readonly prompt: string;
  readonly model: string;
  readonly models: readonly string[];
  readonly endpoint: string;
  readonly attested: readonly string[];
  readonly note: string;
  readonly busy: string;
  readonly status: string;
  readonly statusTone: "" | "ok" | "error";
  readonly run: PipelineRunView | null;
  readonly progress: PipelineProgressView | null;
}

/** The three kinds this pane can ask for, each paired with the capability a probe must have ATTESTED before
 *  the request is worth sending. The pairing is the point: the button is not a wish. */
const RENDER_KINDS: readonly { readonly id: string; readonly label: string; readonly capability: string }[] = [
  { id: "video", label: "Video", capability: "video" },
  { id: "model-3d", label: "3D model", capability: "model-3d" },
  { id: "image", label: "Still image", capability: "image" },
];

/**
 * The Render tab. The gate is stated BEFORE the button rather than after the failure: when no live probe has
 * attested the selected kind, the pane says so in one sentence, names what WAS attested, and disables the
 * request, because a button that always submits and always fails teaches a user to distrust the whole panel.
 *
 * Invariant 11: the kind chips and the model row are flex rows of single-text elements, and every
 * explanation is a block paragraph.
 */
export function creatorRenderHtml(v: CreatorRenderView | null): string {
  if (!v) return `<p class="cst-empty">${esc("Reading what this ComfyUI install can prove...")}</p>`;
  const chips = RENDER_KINDS.map((k) =>
    `<button type="button" class="cpl-kind-chip${v.kind === k.id ? " on" : ""}" data-cpl-kind="${esc(k.id)}">${esc(k.label)}</button>`,
  ).join("");
  const wanted = RENDER_KINDS.find((k) => k.id === v.kind)?.capability ?? v.kind;
  const proven = v.attested.includes(wanted);
  const models = v.models.length
    ? v.models.map((m) => `<option value="${esc(m)}"${m === v.model ? " selected" : ""}>${esc(m)}</option>`).join("")
    : `<option value="">${esc("no models published")}</option>`;
  const gate = proven
    ? ""
    : `<p class="cpl-gate">${icon("shield", 12)}${esc(
        v.attested.length
          ? `No live probe has attested ${wanted} on this install. It proved: ${v.attested.join(", ")}. Probe again after installing the nodes that save this format.`
          : "No live probe has attested anything on this install yet, or the last probe expired. Probe the provider in Integrations, then come back.",
      )}</p>`;
  const status = v.status ? `<p class="cpl-status${v.statusTone ? ` ${v.statusTone}` : ""}">${esc(v.status)}</p>` : "";
  return `<section class="cpl-pane">
    <div class="cpl-kinds">${chips}</div>
    ${gate}
    <textarea id="cplPrompt" class="cpl-prompt-in" rows="3" placeholder="${esc("What should this render show? The words go into your workflow's {{prompt}}.")}">${esc(v.prompt)}</textarea>
    <div class="cpl-form-row">
      <select id="cplModel" class="cpl-model-in">${models}</select>
      <button type="button" id="cplRun" class="cpl-go"${proven && !v.busy ? "" : " disabled"}>${esc(v.busy || "Render")}</button>
    </div>
    ${v.endpoint ? `<p class="cpl-endpoint">${esc(`Through your own workflow on ${v.endpoint}. LUCID never invents a graph.`)}</p>` : ""}
    ${v.note ? `<p class="cpl-note">${esc(v.note)}</p>` : ""}
    ${status}
    ${v.run ? runReportHtml(v.run, v.progress) : ""}
  </section>`;
}
