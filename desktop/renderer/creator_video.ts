// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/creator_video.ts - the Studio Video pane (pure builders, no bridge import).
//
// Two render paths, both free and self-hosted:
//   * dgx-avatar: a talking-head render on a DGX enclave box (MuseTalk / EchoMimic), optionally composed
//     with a HyperFrames title card and estimated-timing captions, through POST /api/creator/avatar/render.
//   * HyperFrames: render a local HTML composition project to video with the pinned CLI on this machine.
//   * OpenFilm (ADR-0457): `look` (same t, same picture check + contact sheet) and `render` of a local
//     film.html project with the user's openfilm CLI on this machine; the verdict text is untrusted data.
//
// The pane states WHY Render is disabled before the click (`videoRenderBlock`), with the same CUI verdict
// the server enforces, so a refusal is read up front instead of discovered after a failed round trip.

import { esc } from "./format.ts";
import { icon } from "./icons.ts";
import { creatorJobsHtml, type CuiVerdictView, type JobView } from "./creator_studio.ts";

export interface AvatarTemplateView { path: string; name: string; sizeBytes: number }
export interface AvatarTemplatesView { templates: AvatarTemplateView[]; folders: string[] }
/** GET /api/creator/avatar/job */
export interface AvatarJobStatusView { state: string; stage: string; message: string; error?: string; artifactId?: string }
export interface VideoEndpointView { id: string; label: string; cui?: CuiVerdictView }

export type AvatarEngine = "musetalk" | "echomimic";
export type HyperframesFormat = "mp4" | "webm" | "mov";
export type HyperframesQuality = "draft" | "standard" | "high";
export type OpenfilmFormat = "mp4" | "webm" | "mov";

/** GET /api/creator/openfilm/job `look`: every string is film-derived and UNTRUSTED (rendered as data). */
export interface OpenfilmLookVerdictView {
  ok: boolean;
  exitCode: number | null;
  head: string;
  errors: string[];
  warnings: string[];
  passed: string[];
  notes: string[];
  /** Artifact ids of the stored contact-sheet / frame PNGs. */
  sheets: string[];
}
export type OpenfilmJobState = "queued" | "running" | "done" | "failed" | "cancelled" | "refused" | "unknown";
/** GET /api/creator/openfilm/job */
export interface OpenfilmJobView {
  jobId: string;
  kind: "look" | "render";
  state: OpenfilmJobState;
  error: string;
  artifacts: string[];
  look: OpenfilmLookVerdictView | null;
}

const OPENFILM_STATES: Record<OpenfilmJobState, true> = { queued: true, running: true, done: true, failed: true, cancelled: true, refused: true, unknown: true };
const isStringList = (x: unknown): x is string[] => Array.isArray(x) && x.every((s) => typeof s === "string");

function isOpenfilmLook(d: unknown): d is OpenfilmLookVerdictView {
  if (!d || typeof d !== "object") return false;
  const o = d as Record<string, unknown>;
  return typeof o.ok === "boolean" && (o.exitCode === null || typeof o.exitCode === "number") && typeof o.head === "string"
    && isStringList(o.errors) && isStringList(o.warnings) && isStringList(o.passed) && isStringList(o.notes) && isStringList(o.sheets);
}

/** Wire guard for GET /api/creator/openfilm/job: a payload this pane cannot read is refused, never half-painted. */
export function isOpenfilmJob(d: unknown): d is OpenfilmJobView {
  if (!d || typeof d !== "object") return false;
  const o = d as Record<string, unknown>;
  return typeof o.jobId === "string" && (o.kind === "look" || o.kind === "render") && typeof o.state === "string" && Object.hasOwn(OPENFILM_STATES, o.state)
    && typeof o.error === "string" && isStringList(o.artifacts) && (o.look === null || isOpenfilmLook(o.look));
}

export interface OpenfilmPaneView {
  cui?: CuiVerdictView;
  projectDir: string;
  format: OpenfilmFormat;
  fps: number;
  fourK: boolean;
  blur: boolean;
  /** The render job being watched. */
  jobId: string;
  /** The look job being watched. */
  lookJobId: string;
  status: string;
  statusTone: "" | "ok" | "error";
  look: OpenfilmLookVerdictView | null;
}

export interface CreatorVideoView {
  lockdown: boolean;
  endpoints: VideoEndpointView[];
  endpointId: string;
  engine: AvatarEngine;
  templates: AvatarTemplateView[];
  templatesNote: string;
  templatePath: string;
  voices: { id: string; name: string }[];
  voice: string;
  text: string;
  title: string;
  subtitle: string;
  captions: boolean;
  busy: string;
  status: string;
  statusTone: "" | "ok" | "error";
  jobId: string;
  job: AvatarJobStatusView | null;
  /** The artifact the player shows (the avatar result or a finished HyperFrames job). */
  artifactId: string;
  hyperframes: { cui?: CuiVerdictView; projectDir: string; format: HyperframesFormat; quality: HyperframesQuality; jobId: string; status: string; statusTone: "" | "ok" | "error" };
  openfilm: OpenfilmPaneView;
  jobs: readonly JobView[];
}

/** Why the avatar Render button is disabled, or "" when it may be pressed. */
export function videoRenderBlock(v: CreatorVideoView): string {
  if (v.busy) return v.busy;
  if (!v.endpoints.length) return "No dgx-avatar endpoint is declared. Import one from the DGX Loader or connect one under Integrations.";
  const ep = v.endpoints.find((e) => e.id === v.endpointId);
  if (!ep) return "Pick a dgx-avatar endpoint.";
  if (ep.cui && !ep.cui.allowed) return `Refused under CUI lockdown: ${ep.cui.reason}`;
  if (!v.templatePath) return "Pick a template (a portrait video or image on the DGX box).";
  if (!v.text.trim()) return "Write what the avatar should say.";
  if (!v.voice) return "Pick a voice for the dots-tts narration.";
  return "";
}

/** Why the HyperFrames Render button is disabled, or "". */
export function hyperframesRenderBlock(v: CreatorVideoView): string {
  const hf = v.hyperframes;
  if (hf.cui && !hf.cui.allowed) return `Refused under CUI lockdown: ${hf.cui.reason}`;
  if (!hf.projectDir.trim()) return "Enter the HyperFrames project directory (the folder holding index.html).";
  return "";
}

/** Why the OpenFilm Render (or, with "look", the Look) button is disabled, or "". FPS only gates a render. */
export function openfilmBlock(v: CreatorVideoView, action: "look" | "render" = "render"): string {
  const of = v.openfilm;
  if (of.cui && !of.cui.allowed) return `Refused under CUI lockdown: ${of.cui.reason}`;
  if (!of.projectDir.trim()) return "Enter the OpenFilm project directory (the folder holding film.html).";
  if (action === "render" && !(Number.isInteger(of.fps) && of.fps >= 1 && of.fps <= 240)) return "FPS must be a whole number from 1 to 240.";
  return "";
}

/** What a settled (or still running) OpenFilm job means for the pane: the status line, the look verdict
 *  to show, and the video to play. `settled` is false while the job is still queued or running. */
export function openfilmJobOutcome(job: OpenfilmJobView): { settled: boolean; status: string; statusTone: "" | "ok" | "error"; look: OpenfilmLookVerdictView | null; artifactId: string } {
  const what = job.kind === "look" ? "look" : "render";
  const look = job.kind === "look" ? job.look : null;
  if (job.state === "queued" || job.state === "running") {
    return { settled: false, status: `OpenFilm ${what} ${job.state} (job ${job.jobId}).`, statusTone: "", look: null, artifactId: "" };
  }
  if (job.state === "unknown") {
    return { settled: true, status: `OpenFilm ${what} job ${job.jobId} is no longer known to the engine.`, statusTone: "error", look: null, artifactId: "" };
  }
  if (job.state !== "done") {
    return { settled: true, status: `OpenFilm ${what} ${job.state}: ${job.error || "no reason given"}`, statusTone: "error", look, artifactId: "" };
  }
  if (job.kind === "render") {
    const artifactId = job.artifacts[0] ?? "";
    return artifactId
      ? { settled: true, status: "OpenFilm render complete; the video is in the Creator library.", statusTone: "ok", look: null, artifactId }
      : { settled: true, status: "OpenFilm render finished but stored no video.", statusTone: "error", look: null, artifactId: "" };
  }
  if (!look) return { settled: true, status: "OpenFilm look finished; the engine restarted since, so the verdict is gone. Run Look again.", statusTone: "error", look: null, artifactId: "" };
  return look.ok
    ? { settled: true, status: "Look passed: the same t drew the same picture.", statusTone: "ok", look, artifactId: "" }
    : { settled: true, status: "Look found film errors.", statusTone: "error", look, artifactId: "" };
}

/** The look verdict card. Every verdict string is untrusted film text: escaped, one block paragraph each. */
export function openfilmLookHtml(look: OpenfilmLookVerdictView | null, jobId: string): string {
  if (!look) return "";
  const para = (cls: string, ic: string, text: string) => `<p class="${cls}">${ic ? icon(ic, 13) : ""}${esc(text)}</p>`;
  const verdict = look.ok ? "Look passed" : "Look found errors";
  const sheets = look.sheets.map((id) =>
    `<img class="cvd-video" data-cvd-sheet="${esc(id)}" alt="${esc(`OpenFilm contact sheet ${id}`)}" title="${esc(id)}" />`).join("");
  return `<div class="cpl-run${look.ok ? " ok" : " bad"}">
    <div class="cpl-run-row">
      <span class="cpl-run-verdict" title="${esc(look.head)}">${esc(look.head ? `${verdict}: ${look.head}` : verdict)}</span>
      <span class="cpl-run-job" title="${esc(jobId)}">${esc(jobId)}</span>
    </div>
    ${look.errors.map((e) => para("cpl-run-error", "alertBadge", e)).join("")}
    ${look.warnings.map((w) => para("cpl-gate", "alertBadge", w)).join("")}
    ${look.passed.map((p) => para("cpl-run-note", "", `Passed: ${p}`)).join("")}
    ${look.notes.map((n) => para("cpl-run-progress", "", n)).join("")}
    ${sheets}
  </div>`;
}

const OPENFILM_FORMATS: readonly (readonly [OpenfilmFormat, string])[] = [["mp4", "mp4"], ["webm", "webm (transparent)"], ["mov", "mov (transparent)"]];

const ENGINE_LABEL: Record<AvatarEngine, string> = { musetalk: "MuseTalk", echomimic: "EchoMimic" };

function option(value: string, label: string, selected: string): string {
  return `<option value="${esc(value)}"${value === selected ? " selected" : ""}>${esc(label)}</option>`;
}

function jobCardHtml(v: CreatorVideoView): string {
  const j = v.job;
  if (!v.jobId || !j) return "";
  const bad = j.state === "failed" || j.state === "cancelled" || j.state === "refused";
  return `<div class="cpl-run${j.state === "done" ? " ok" : bad ? " bad" : ""}">
    <div class="cpl-run-row">
      <span class="cpl-run-verdict">${esc(`Avatar ${j.state}`)}</span>
      <span class="cpl-run-stage">${esc(j.stage)}</span>
      <span class="cpl-run-job">${esc(v.jobId)}</span>
    </div>
    ${j.message ? `<p class="cpl-run-progress">${esc(j.message)}</p>` : ""}
    ${j.error ? `<p class="cpl-run-error">${icon("alertBadge", 13)}${esc(j.error)}</p>` : ""}
  </div>`;
}

export function creatorVideoHtml(v: CreatorVideoView | null): string {
  if (!v) return `<p class="cst-empty">Loading the Video pane...</p>`;
  const block = videoRenderBlock(v);
  const ep = v.endpoints.find((e) => e.id === v.endpointId);
  const refused = !!ep?.cui && !ep.cui.allowed;
  const endpointRow = v.endpoints.length
    ? `<div class="cim-row"><span class="cim-lbl">Endpoint</span><select class="prov-key cvd-grow" id="cvdEndpoint">${v.endpoints.map((e) => option(e.id, `${e.label} (${e.id})`, v.endpointId)).join("")}</select>
        <button type="button" class="btn-mini" data-cvd-import data-tip="Import from the DGX Loader|Rescans ~/.omp/creator_endpoints for lucid-creator-endpoint files the Loader exported.">Import</button></div>`
    : `<p class="cpl-gate">${icon("shield", 13)}No dgx-avatar endpoint is declared. Export one from the DGX Loader and import it here, or connect one under Integrations.</p>
       <div class="cim-row"><button type="button" class="btn-mini ok" data-cvd-import>Import from the DGX Loader</button></div>`;
  const engines = (Object.keys(ENGINE_LABEL) as AvatarEngine[]).map((e) =>
    `<button type="button" class="cpl-kind-chip${v.engine === e ? " on" : ""}" data-cvd-engine="${e}">${esc(ENGINE_LABEL[e])}</button>`).join("");
  const templates = v.templates.length
    ? `<select class="prov-key cvd-grow" id="cvdTemplate">${option("", "Pick a template", v.templatePath)}${v.templates.map((t) => option(t.path, t.name, v.templatePath)).join("")}</select>`
    : `<span class="cvd-none">${esc(v.templatesNote || "No templates listed yet.")}</span>`;
  const voices = v.voices.length
    ? `<select class="prov-key cvd-grow" id="cvdVoice">${v.voices.map((x) => option(x.id, x.name, v.voice)).join("")}</select>`
    : `<input class="prov-key cvd-grow" id="cvdVoice" value="${esc(v.voice)}" placeholder="dots-tts voice id" spellcheck="false" />`;
  const hf = v.hyperframes;
  const hfBlock = hyperframesRenderBlock(v);
  const of = v.openfilm;
  const ofBlock = openfilmBlock(v);
  const ofLookBlock = openfilmBlock(v, "look");
  return `<div class="cpl-pane cvd-pane">
    <section class="cim-gen">
      <div class="cim-tools-h"><span class="cim-tools-t">${icon("user", 14)}<span>Avatar video (DGX enclave)</span></span></div>
      <p class="cim-hint">Speech is synthesized by your dots-tts engine, then MuseTalk or EchoMimic renders the talking head on the DGX box. Optional HyperFrames compose adds a title card and captions with estimated timing.</p>
      ${endpointRow}
      ${refused ? `<p class="cpl-run-error">${icon("shield", 13)}${esc(`Refused under CUI lockdown: ${ep!.cui!.reason}`)}</p>` : ""}
      <div class="cim-row"><span class="cim-lbl">Engine</span><div class="cpl-kinds">${engines}</div></div>
      <div class="cim-row"><span class="cim-lbl">Template</span>${templates}
        <button type="button" class="btn-mini" data-cvd-templates${v.endpoints.length && !refused ? "" : " disabled"}>${icon("refresh", 12)} List</button></div>
      <div class="cim-row"><span class="cim-lbl">Voice</span>${voices}</div>
      <textarea class="cpl-prompt-in" id="cvdText" rows="4" placeholder="What the avatar says">${esc(v.text)}</textarea>
      <div class="cim-row"><span class="cim-lbl">Title</span><input class="prov-key cvd-grow" id="cvdTitle" value="${esc(v.title)}" placeholder="optional title card" spellcheck="false" /></div>
      <div class="cim-row"><span class="cim-lbl">Subtitle</span><input class="prov-key cvd-grow" id="cvdSubtitle" value="${esc(v.subtitle)}" placeholder="optional subtitle" spellcheck="false" /></div>
      <label class="cim-row cvd-check"><input type="checkbox" id="cvdCaptions"${v.captions ? " checked" : ""} /><span>Burn in captions from the script (estimated timing)</span></label>
      <div class="cpl-form-row">
        <span class="cpl-status${block ? "" : " ok"}" data-gate="avatar">${esc(block || "Ready to render.")}</span>
        <button type="button" class="cpl-go" id="cvdRender"${block ? " disabled" : ""}>${icon("bolt", 12)} Render</button>
      </div>
      ${v.status ? `<p class="cpl-status${v.statusTone ? ` ${v.statusTone}` : ""}">${esc(v.status)}</p>` : ""}
      ${jobCardHtml(v)}
    </section>
    ${v.artifactId ? `<section class="cim-gen"><div class="cim-tools-h"><span class="cim-tools-t">${icon("eye", 14)}<span>Result</span></span><span class="cim-count">${esc(v.artifactId)}</span></div>
      <video class="cvd-video" controls preload="metadata" data-cvd-video="${esc(v.artifactId)}"></video></section>` : ""}
    <section class="cim-gen">
      <div class="cim-tools-h"><span class="cim-tools-t">${icon("layout", 14)}<span>HyperFrames composition (on-device)</span></span></div>
      <p class="cim-hint">Renders a local HyperFrames project (an index.html composition) with the pinned hyperframes CLI, headless Chromium and FFmpeg on this machine. Telemetry is disabled; cloud, publish and lambda commands are never invoked.</p>
      <div class="cim-row"><span class="cim-lbl">Project</span><input class="prov-key cvd-grow" id="cvdHfDir" value="${esc(hf.projectDir)}" placeholder="C:\\path\\to\\composition" spellcheck="false" /></div>
      <div class="cim-row"><span class="cim-lbl">Format</span><select class="prov-key" id="cvdHfFormat">${(["mp4", "webm", "mov"] as const).map((f) => option(f, f, hf.format)).join("")}</select>
        <span class="cim-lbl">Quality</span><select class="prov-key" id="cvdHfQuality">${(["draft", "standard", "high"] as const).map((q) => option(q, q, hf.quality)).join("")}</select></div>
      <div class="cpl-form-row">
        <span class="cpl-status${hfBlock ? "" : " ok"}" data-gate="hf">${esc(hfBlock || "Ready to render.")}</span>
        <button type="button" class="cpl-go" id="cvdHfRender"${hfBlock ? " disabled" : ""}>${icon("bolt", 12)} Render</button>
      </div>
      ${hf.status ? `<p class="cpl-status${hf.statusTone ? ` ${hf.statusTone}` : ""}">${esc(hf.status)}</p>` : ""}
    </section>
    <section class="cim-gen">
      <div class="cim-tools-h"><span class="cim-tools-t">${icon("eye", 14)}<span>OpenFilm film (on-device)</span></span></div>
      <p class="cim-hint">Checks and renders a local OpenFilm project (a folder with film.html) with your openfilm CLI, headless Chromium and FFmpeg on this machine. The get, open and update commands are never run.</p>
      <div class="cim-row"><span class="cim-lbl">Project</span><input class="prov-key cvd-grow" id="cvdOfDir" value="${esc(of.projectDir)}" placeholder="C:\\path\\to\\film" spellcheck="false" /></div>
      <div class="cim-row"><span class="cim-lbl">Format</span><select class="prov-key" id="cvdOfFormat">${OPENFILM_FORMATS.map(([f, label]) => option(f, label, of.format)).join("")}</select>
        <span class="cim-lbl">FPS</span><input class="prov-key" id="cvdOfFps" type="number" min="1" max="240" step="1" value="${Number.isFinite(of.fps) ? String(of.fps) : ""}" /></div>
      <label class="cim-row cvd-check"><input type="checkbox" id="cvdOfFourK"${of.fourK ? " checked" : ""} /><span>4K</span></label>
      <label class="cim-row cvd-check"><input type="checkbox" id="cvdOfBlur"${of.blur ? " checked" : ""} /><span>Motion blur</span></label>
      <div class="cpl-form-row">
        <span class="cpl-status${ofBlock ? "" : " ok"}" data-gate="of">${esc(ofBlock || "Ready to look or render.")}</span>
        <button type="button" class="btn-mini" id="cvdOfLook"${ofLookBlock ? " disabled" : ""}>${icon("eye", 12)} Look</button>
        <button type="button" class="cpl-go" id="cvdOfRender"${ofBlock ? " disabled" : ""}>${icon("bolt", 12)} Render</button>
      </div>
      ${of.status ? `<p class="cpl-status${of.statusTone ? ` ${of.statusTone}` : ""}">${esc(of.status)}</p>` : ""}
      ${openfilmLookHtml(of.look, of.lookJobId)}
    </section>
    <section class="cst-group"><h4 class="cst-h4">Recent jobs</h4>${creatorJobsHtml(v.jobs)}</section>
  </div>`;
}
