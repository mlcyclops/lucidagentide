// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/creator_drift_view.ts - the Studio Drift pane (pure builders, no bridge import).
//
// CutWire Drift is a GPLv3 video editor on this machine. LUCID talks to it over Drift's own localhost
// agent protocol (Settings -> Agent access), never by linking or bundling it. The pane is the user's side of
// a collaborative edit: the agent works through the drift_* tools, the user works in Drift itself, and the
// activity feed shows both sides so an agent batch can be undone from here in one step.
//
// Like the Video pane, every button states WHY it is disabled before the click (`driftConnectBlock`,
// `driftExportBlock`), with the same CUI verdict the server enforces.

import { esc } from "./format.ts";
import { icon } from "./icons.ts";
import { fmtAgo, probeLineHtml, type CuiVerdictView, type ProbeResultView } from "./creator_studio.ts";

/** One activity entry as GET /api/creator/drift/status reports it (newest first in the status payload). */
export interface DriftActivityView {
  seq: number; at: number; source: "agent" | "ui"; tool: string; ok: boolean; summary: string; undoable: boolean; revision: number | null;
}
export interface DriftEndpointView { id: string; label: string; baseUrl: string; source: "session" | "declared"; cui: CuiVerdictView }
/** GET /api/creator/drift/status `data` (never the token). */
export interface DriftStatusView {
  installed: boolean;
  exePath: string;
  session: { path: string; present: boolean; port: number; pid: number; error: string };
  endpoint: DriftEndpointView | null;
  lockdown: boolean;
  probe: ProbeResultView | null;
  version: string;
  activity: DriftActivityView[];
}
/** POST /api/creator/drift/call `data`. */
export interface DriftCallView {
  tool: string; isError: boolean; text: string; payload: unknown;
  images: { mimeType: string; data: string }[];
  entry: DriftActivityView;
}
/** What the pane shows of `inspect()`; every field is read defensively from Drift's payload. */
export interface DriftInspectView {
  name: string; width: number; height: number; fps: number; duration: number;
  tracks: number; clips: number; selection: number; revision: number | null; playhead: number | null;
}

export type DriftExportFormat = "mp4" | "webm" | "gif";
export const DRIFT_EXPORT_FORMATS: readonly DriftExportFormat[] = ["mp4", "webm", "gif"];

export interface CreatorDriftView extends DriftStatusView {
  /** Highest activity seq the pane has seen; the poll asks for `?since=` this. */
  lastSeq: number;
  inspect: DriftInspectView | null;
  /** Why the project summary is missing (Drift's own words), or "". */
  inspectNote: string;
  /** Capture time in seconds as typed; "" means the playhead. */
  captureAt: string;
  captureSrc: string;
  sheetSrc: string;
  exportPath: string;
  exportFormat: DriftExportFormat;
  exportProgress: number | null;
  exportState: "" | "running" | "done" | "failed";
  exportedPath: string;
  artifactId: string;
  busy: string;
  status: string;
  statusTone: "" | "ok" | "error";
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object";
const str = (v: unknown): string => typeof v === "string" ? v : "";
const num = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) ? v : null;

export function isDriftActivity(v: unknown): v is DriftActivityView {
  return isObj(v) && typeof v.seq === "number" && typeof v.tool === "string" && typeof v.summary === "string" && (v.source === "agent" || v.source === "ui");
}
export function isDriftStatus(v: unknown): v is DriftStatusView {
  return isObj(v) && typeof v.installed === "boolean" && isObj(v.session) && typeof v.session.present === "boolean"
    && Array.isArray(v.activity) && (v.endpoint === null || (isObj(v.endpoint) && typeof v.endpoint.baseUrl === "string"));
}
export function isDriftCall(v: unknown): v is DriftCallView {
  return isObj(v) && typeof v.tool === "string" && typeof v.isError === "boolean" && Array.isArray(v.images);
}

/** Read the project summary from Drift's `inspect` payload, which is
 *  `{name, w, h, fps, dur, tracks:[{i,type,clips,...}], clips:<count>, selection:{clip,track,index}, revision,
 *  playhead, undo:{can,canRedo}}` (with `clips:true` the `clips` field becomes the rows). Read defensively: a
 *  missing number shows as 0 (or null for revision/playhead), never as a throw. */
export function driftInspectFromPayload(payload: unknown): DriftInspectView {
  const p = isObj(payload) ? payload : {};
  const tracks = Array.isArray(p.tracks) ? p.tracks : null;
  const clipRows = Array.isArray(p.clips) ? p.clips : null;
  const clipCount = clipRows ? clipRows.length
    : num(p.clips) ?? (tracks ?? []).reduce<number>((n, t) => n + (isObj(t) ? (Array.isArray(t.clips) ? t.clips.length : num(t.clips) ?? 0) : 0), 0);
  // The selection is one clip ref ({clip, track, index}), a list of refs, or absent.
  const sel = p.selection;
  const selection = Array.isArray(sel) ? sel.length : isObj(sel) && (typeof sel.clip === "string" || typeof sel.index === "number") ? 1 : 0;
  return {
    name: str(p.name) || "Untitled Project",
    width: num(p.w) ?? num(p.width) ?? 0,
    height: num(p.h) ?? num(p.height) ?? 0,
    fps: num(p.fps) ?? 0,
    duration: num(p.dur) ?? num(p.duration) ?? 0,
    tracks: tracks ? tracks.length : num(p.tracks) ?? 0,
    clips: clipCount,
    selection,
    revision: num(p.revision),
    playhead: num(p.playhead),
  };
}

export const DRIFT_ENABLE_STEPS = "In Drift: 1) open Settings, 2) switch Agent access to On, 3) press Refresh here. (Start agent on startup keeps it on.)";

/** Why Capture, Undo and Export are disabled, or "" when Drift can be reached. */
export function driftConnectBlock(v: CreatorDriftView): string {
  if (v.busy) return v.busy;
  if (!v.endpoint) {
    if (!v.installed && !v.session.present) return "Drift is not installed on this machine (drift.exe was not found). Install CutWire Drift, or connect a headless Drift endpoint.";
    if (v.session.error) return `Drift's session file could not be read (${v.session.error}). ${DRIFT_ENABLE_STEPS}`;
    return `Agent access is off, so Drift is not listening. ${DRIFT_ENABLE_STEPS}`;
  }
  if (v.endpoint.cui && !v.endpoint.cui.allowed) return `Refused under CUI lockdown: ${v.endpoint.cui.reason}`;
  return "";
}

const ABSOLUTE_PATH = /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/;

/** Why Export is disabled, or "". */
export function driftExportBlock(v: CreatorDriftView): string {
  const conn = driftConnectBlock(v);
  if (conn) return conn;
  if (v.exportState === "running") return `Export in progress${v.exportProgress !== null ? ` (${Math.round(v.exportProgress)}%)` : ""}...`;
  if (!ABSOLUTE_PATH.test(v.exportPath.trim())) return "Enter an absolute output path for the export (e.g. C:\\Videos\\cut.mp4).";
  return "";
}

/** The output path Drift is asked to write and the format that goes with it. Drift's `export_video` takes
 *  no format argument: the extension decides (plus `gif:true`). A path without an extension gets the
 *  selected one; a path with one of ours wins and the select follows it. */
export function driftExportTarget(path: string, format: DriftExportFormat): { path: string; format: DriftExportFormat; gif: boolean; args: Record<string, unknown> } {
  const trimmed = path.trim();
  const m = /\.([a-zA-Z0-9]+)$/.exec(trimmed.split(/[\\/]/).pop() ?? "");
  const ext = m ? m[1].toLowerCase() : "";
  const known = DRIFT_EXPORT_FORMATS.find((f) => f === ext);
  const chosen = known ?? format;
  const out = ext ? trimmed : `${trimmed}.${chosen}`;
  // Drift reuses the LAST agent export's codecs, so a .webm after an H.264 .mp4 fails inside FFmpeg ("Could not
  // write the file header"): every non-GIF export names codecs that fit its container (ids from list_export_options).
  const container = ext || chosen; // a .mov or other extension Drift accepts keeps its own container
  const codecs = container === "gif" ? { gif: true } : container === "webm" ? { video: "vp9", audio: "opus" } : { video: "h264", audio: "aac" };
  return { path: out, format: chosen, gif: chosen === "gif", args: { path: out, wait: false, ...codecs } };
}

/** The newest undoable entry, when it came from the agent (the Undo-last-agent-batch gate). */
export function newestUndoableIsAgent(activity: readonly DriftActivityView[]): boolean {
  const newest = activity.find((e) => e.undoable && e.ok);
  return !!newest && newest.source === "agent";
}

/** Composer prompts offered under the feed; the user reviews and sends them (never auto-sent). */
export const DRIFT_ASK_PROMPTS: readonly { label: string; prompt: string }[] = [
  { label: "Propose a tighter cut", prompt: "Look at my Drift timeline (drift_status, then frames) and propose a tighter cut" },
  { label: "Remove filler and silences", prompt: "Transcribe the talking clip and remove the filler words and silences" },
  { label: "Add captions", prompt: "Add captions in a clean style from the speech, then capture a frame to check them" },
  { label: "Cut to the beat", prompt: "Cut the montage to the beat of the music track" },
];

function fmtSeconds(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "0s";
  if (s < 60) return `${Math.round(s * 10) / 10}s`;
  const m = Math.floor(s / 60);
  const r = Math.round(s - m * 60);
  return `${m}m ${r}s`;
}

function option(value: string, label: string, selected: string): string {
  return `<option value="${esc(value)}"${value === selected ? " selected" : ""}>${esc(label)}</option>`;
}

function connectionHtml(v: CreatorDriftView, now: number): string {
  const refused = !!v.endpoint?.cui && !v.endpoint.cui.allowed;
  const installLine = v.installed
    ? `Drift is installed${v.exePath ? ` (${v.exePath})` : ""}${v.version ? `, version ${v.version}` : ""}.`
    : "Drift was not found on this machine.";
  const accessLine = v.endpoint
    ? v.endpoint.source === "session"
      ? `Agent access is on: ${v.endpoint.baseUrl}${v.session.pid ? ` (pid ${v.session.pid})` : ""}.`
      : `Headless endpoint ${v.endpoint.label} (${v.endpoint.id}) at ${v.endpoint.baseUrl}.`
    : v.session.error
      ? `Drift's session file could not be read: ${v.session.error}`
      : "Agent access is off (no session file).";
  const enable = v.endpoint ? "" : `<p class="cpl-gate">${icon("shield", 13)}${esc(`Drift is not listening. ${DRIFT_ENABLE_STEPS}`)}</p>`;
  return `<section class="cim-gen">
    <div class="cim-tools-h"><span class="cim-tools-t">${icon("clock", 14)}<span>Connection</span></span>${v.lockdown ? `<span class="cim-count">CUI lockdown</span>` : ""}</div>
    <p class="cdr-line">${esc(installLine)}</p>
    <p class="cdr-line">${esc(accessLine)}</p>
    ${enable}
    ${refused ? `<p class="cpl-run-error">${icon("shield", 13)}${esc(`Refused under CUI lockdown: ${v.endpoint!.cui.reason}`)}</p>` : ""}
    ${probeLineHtml(v.probe ?? undefined, now)}
    <div class="cim-row cim-row-wrap">
      <button type="button" class="btn-mini" data-cdr-probe${v.busy ? " disabled" : ""}>${icon("bolt", 12)} Probe</button>
      <button type="button" class="btn-mini" data-cdr-refresh${v.busy ? " disabled" : ""}>${icon("refresh", 12)} Refresh</button>
      <button type="button" class="btn-mini" data-cdr-connect data-tip="Connect headless|Declare a Drift started with --headless --mcp-port and the NAME of the vault credential holding its token.">Connect headless</button>
    </div>
  </section>`;
}

function projectHtml(v: CreatorDriftView, block: string): string {
  const i = v.inspect;
  const facts = i
    ? `<div class="cdr-facts">
        <span class="cdr-fact">${esc(`Project: ${i.name}`)}</span>
        <span class="cdr-fact">${esc(`Canvas: ${i.width} x ${i.height}`)}</span>
        <span class="cdr-fact">${esc(`FPS: ${i.fps}`)}</span>
        <span class="cdr-fact">${esc(`Duration: ${fmtSeconds(i.duration)}`)}</span>
        <span class="cdr-fact">${esc(`Tracks: ${i.tracks}`)}</span>
        <span class="cdr-fact">${esc(`Clips: ${i.clips}`)}</span>
        <span class="cdr-fact">${esc(`Selected: ${i.selection}`)}</span>
        <span class="cdr-fact">${esc(`Revision: ${i.revision ?? "unknown"}`)}</span>
        ${i.playhead !== null ? `<span class="cdr-fact">${esc(`Playhead: ${fmtSeconds(i.playhead)}`)}</span>` : ""}
      </div>`
    : `<p class="cim-hint">${esc(v.inspectNote || (v.endpoint ? "No project summary yet. Refresh to ask Drift." : "Connect Drift to see the open project."))}</p>`;
  const dis = block ? " disabled" : "";
  const ph = i?.playhead ?? null;
  const placeholder = ph !== null ? `playhead (${fmtSeconds(ph)})` : "playhead";
  return `<section class="cim-gen">
    <div class="cim-tools-h"><span class="cim-tools-t">${icon("layout", 14)}<span>Project</span></span>
      <button type="button" class="btn-mini" data-cdr-inspect${dis}>${icon("refresh", 12)} Refresh</button></div>
    ${facts}
    <div class="cim-row cim-row-wrap">
      <span class="cim-lbl">Capture at</span>
      <input class="prov-key cdr-time" id="cdrCaptureAt" value="${esc(v.captureAt)}" placeholder="${esc(placeholder)}" inputmode="decimal" spellcheck="false" />
      <span class="cim-lbl">s</span>
      <button type="button" class="btn-mini" data-cdr-capture${dis}>${icon("eye", 12)} Capture</button>
      <button type="button" class="btn-mini" data-cdr-sheet${dis}>Contact sheet</button>
      <button type="button" class="btn-mini" data-cdr-undo${dis}>${icon("restore", 12)} Undo</button>
      <button type="button" class="btn-mini" data-cdr-redo${dis}>Redo</button>
    </div>
    <p class="cpl-status${block ? "" : " ok"}" data-gate="drift">${esc(block || "Drift is listening.")}</p>
    ${v.captureSrc ? `<img class="cdr-img" alt="Captured frame" src="${esc(v.captureSrc)}" />` : ""}
    ${v.sheetSrc ? `<img class="cdr-img" alt="Contact sheet" src="${esc(v.sheetSrc)}" />` : ""}
  </section>`;
}

function feedHtml(v: CreatorDriftView, block: string, now: number): string {
  const rows = v.activity.length
    ? v.activity.slice(0, 60).map((e) => `<div class="cdr-feed-row${e.ok ? "" : " bad"}">
        <span class="cdr-src cdr-src-${e.source}">${e.source === "agent" ? "agent" : "you"}</span>
        <span class="cdr-tool">${esc(e.tool)}</span>
        <span class="cdr-sum">${esc(e.summary)}</span>
        <span class="cdr-age">${esc(fmtAgo(e.at, now))}</span>
      </div>`).join("")
    : `<p class="cst-empty">Nothing yet. Edits made through the agent and from this pane show up here as they happen.</p>`;
  const undoAgent = newestUndoableIsAgent(v.activity)
    ? `<button type="button" class="btn-mini" data-cdr-undo-agent${block ? " disabled" : ""}>${icon("restore", 12)} Undo last agent batch</button>`
    : "";
  const asks = DRIFT_ASK_PROMPTS.map((a, n) => `<button type="button" class="btn-mini" data-cdr-ask="${n}" data-tip="${esc(`Ask the agent|${a.prompt}`)}">${esc(a.label)}</button>`).join("");
  return `<section class="cim-gen">
    <div class="cim-tools-h"><span class="cim-tools-t">${icon("chat", 14)}<span>Collaboration feed</span></span>${v.activity.length ? `<span class="cim-count">${v.activity.length}</span>` : ""}${undoAgent}</div>
    <div class="cdr-feed">${rows}</div>
    <p class="cim-hint">Ask the agent (the prompt lands in the composer for you to review and send):</p>
    <div class="cim-tool-row">${asks}</div>
  </section>`;
}

function exportHtml(v: CreatorDriftView): string {
  const block = driftExportBlock(v);
  const progress = v.exportState === "running"
    ? `<p class="cpl-run-progress">${esc(`Rendering${v.exportProgress !== null ? ` ${Math.round(v.exportProgress)}%` : ""}...`)}</p>`
    : v.exportState === "done"
      ? `<p class="cpl-run-progress">${esc(`Exported ${v.exportedPath}.`)}</p>`
      : "";
  const save = v.exportState === "done" && v.exportedPath && !v.artifactId
    ? `<button type="button" class="btn-mini ok" data-cdr-save${v.busy ? " disabled" : ""}>${icon("download", 12)} Save to library</button>`
    : "";
  return `<section class="cim-gen">
    <div class="cim-tools-h"><span class="cim-tools-t">${icon("download", 14)}<span>Export</span></span></div>
    <div class="cim-row"><span class="cim-lbl">Output</span><input class="prov-key cvd-grow" id="cdrExportPath" value="${esc(v.exportPath)}" placeholder="C:\\Videos\\cut.mp4" spellcheck="false" /></div>
    <div class="cim-row"><span class="cim-lbl">Format</span><select class="prov-key" id="cdrExportFormat">${DRIFT_EXPORT_FORMATS.map((f) => option(f, f, v.exportFormat)).join("")}</select></div>
    <div class="cpl-form-row">
      <span class="cpl-status${block ? "" : " ok"}" data-gate="drift-export">${esc(block || "Ready to export.")}</span>
      <button type="button" class="cpl-go" data-cdr-export${block ? " disabled" : ""}>${icon("bolt", 12)} Export</button>
    </div>
    ${progress}
    ${save ? `<div class="cim-row">${save}</div>` : ""}
    ${v.artifactId ? `<div class="cim-tools-h"><span class="cim-tools-t">${icon("eye", 14)}<span>Result</span></span><span class="cim-count">${esc(v.artifactId)}</span></div>
      <video class="cvd-video" controls preload="metadata" data-cdr-video="${esc(v.artifactId)}"></video>` : ""}
  </section>`;
}

const LICENSE_NOTE = "Drift is GPL-3.0 and is reached over its own localhost agent protocol; nothing is linked or bundled. "
  + "Drift Assets (the Market tab) are CC BY-NC-SA 4.0: credit \"Drift Assets\", non-commercial, share-alike, so keep them off monetized channels. "
  + "The Stock tab browses third-party sources whose terms you accept in Drift. "
  + "Cloud voices are billable and leave this machine; they are refused under CUI lockdown.";

export function creatorDriftHtml(v: CreatorDriftView | null, now = Date.now()): string {
  if (!v) return `<p class="cst-empty">Loading the Drift pane...</p>`;
  const block = driftConnectBlock(v);
  return `<div class="cpl-pane cvd-pane cdr-pane">
    ${connectionHtml(v, now)}
    ${v.status ? `<p class="cpl-status${v.statusTone ? ` ${v.statusTone}` : ""}">${esc(v.status)}</p>` : ""}
    ${projectHtml(v, block)}
    ${feedHtml(v, block, now)}
    ${exportHtml(v)}
    <p class="set-note cdr-note">${icon("shield", 13)}${esc(LICENSE_NOTE)}</p>
  </div>`;
}
