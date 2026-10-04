// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/creator_video.ts - the Studio Video pane (pure builders, no bridge import).
//
// Two render paths, both free and self-hosted:
//   * dgx-avatar: a talking-head render on a DGX enclave box (MuseTalk / EchoMimic), optionally composed
//     with a HyperFrames title card and estimated-timing captions, through POST /api/creator/avatar/render.
//   * HyperFrames: render a local HTML composition project to video with the pinned CLI on this machine.
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
    <section class="cst-group"><h4 class="cst-h4">Recent jobs</h4>${creatorJobsHtml(v.jobs)}</section>
  </div>`;
}
