// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/creator/drift_policy.ts - CREATOR-DRIFT: the PURE policy for CutWire Drift's agent protocol.
//
// Drift (GPL-3.0, github.com/CutWire-Studios/Drift) serves a localhost MCP endpoint when the user turns on
// Agent access. LUCID talks to it over that protocol and nothing else. Three questions are answered here
// and nowhere else, so the engine route, the omp tools, and the Studio tab agree byte for byte:
//
//   1. Which tools are READ-ONLY (safe for drift_read without a write approval).
//   2. Which ops reach a cloud from inside Drift (cloud voices, the CutWire marketplace, ElevenLabs
//      transcription) and are therefore refused under the CUI lockdown, recursively inside apply({ops}).
//   3. Which ops mutate the project, so the collaboration feed can mark them undoable.
//
// Pure: no fetch, no fs, no clock. Every string here is DATA from a tool call; nothing is interpreted.

export const DRIFT_PROVIDER_ID = "drift";

/** Drift's homepage tools: the ones served directly on /mcp alongside every toolbox op. */
export const DRIFT_HOMEPAGE_TOOLS = ["catalog", "search", "toolbox", "apply", "inspect", "activity", "frames", "capture"] as const;

const READ_TOOLS: Record<string, true> = {
  catalog: true, search: true, toolbox: true, inspect: true, activity: true, frames: true, capture: true,
  export_status: true, market_status: true, market_item: true, market_downloads: true, ai_capabilities: true,
  cloud_provider_status: true, sample_depth: true, list_history: true,
};
const READ_PREFIXES = ["list_", "get_", "inspect_", "describe_", "find_"] as const;
/** Never read-only, whatever their prefix says. */
const NEVER_READ: Record<string, true> = { apply: true, undo: true, redo: true, undo_to: true };

/** Read-only tools the agent may call through drift_read: the homepage read tools, plus list_*, get_*,
 *  inspect_*, describe_*, find_* ops and the status-style ops. Never apply, undo, export, or import. */
export function isDriftReadTool(tool: string): boolean {
  const name = typeof tool === "string" ? tool.trim() : "";
  if (!name || NEVER_READ[name]) return false;
  if (READ_TOOLS[name]) return true;
  if (/^(export|import)_/.test(name)) return false;
  return READ_PREFIXES.some((p) => name.startsWith(p));
}

export type DriftOpVerdict = { allowed: true } | { allowed: false; reason: string; tool: string; index?: number };

/** The voice toolbox: ElevenLabs / Fish Audio, billable, the audio leaves this machine. */
const VOICE_OPS: Record<string, true> = { tts_generate: true, sfx_generate: true, list_voices: true, cloud_provider_status: true };
/** Ops whose `engine` argument can pick ElevenLabs Scribe (billable, cloud). */
const ENGINE_OPS: Record<string, true> = { transcribe: true, diarize: true, generate_subtitles: true };

/** Narrow unknown JSON to a plain object, else an empty one. Used at every payload boundary in this file. */
function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** A string or finite number rendered as text; anything else is empty. */
function str(v: unknown): string {
  return typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : "";
}

function singleOpVerdict(tool: string, args: unknown): DriftOpVerdict {
  if (VOICE_OPS[tool]) {
    return { allowed: false, tool, reason: `${tool} uses Drift's cloud voice providers (ElevenLabs / Fish Audio): the text leaves this machine and is billed.` };
  }
  if (tool.startsWith("market_")) {
    return { allowed: false, tool, reason: `${tool} reaches the CutWire marketplace: a cloud service that spends the user's quota.` };
  }
  if (ENGINE_OPS[tool] && str(rec(args).engine).trim().toLowerCase() === "elevenlabs") {
    return { allowed: false, tool, reason: `${tool} with engine "elevenlabs" sends the audio to ElevenLabs Scribe: use the local engine instead.` };
  }
  return { allowed: true };
}

/** Ops that reach a cloud from inside Drift. Refused under CUI lockdown, by name, with the reason. Applies
 *  recursively to each op inside apply({ops}), naming the failing op and its index. When `locked` is false
 *  everything is allowed. */
export function driftOpPolicy(tool: string, args: unknown, locked: boolean): DriftOpVerdict {
  if (!locked) return { allowed: true };
  const name = typeof tool === "string" ? tool.trim() : "";
  if (name !== "apply") return singleOpVerdict(name, args);
  const ops = rec(args).ops;
  if (!Array.isArray(ops)) return { allowed: true };
  for (let i = 0; i < ops.length; i++) {
    const op = rec(ops[i]);
    const opTool = str(op.tool).trim();
    if (!opTool) continue;
    const v = singleOpVerdict(opTool, op.args);
    if (!v.allowed) return { allowed: false, tool: opTool, index: i, reason: `apply op ${i} (${opTool}): ${v.reason}` };
  }
  return { allowed: true };
}

/** Ops that only move the playhead, the selection, the view, or an editor preference, or step the undo stack:
 *  not project mutations. `set_volume` is NOT here: Drift has no track volume, so it is a per-clip edit. */
const NON_MUTATING: Record<string, true> = {
  play: true, pause: true, stop: true, seek: true, toggle_play: true, set_playhead: true, set_loop_work_area: true,
  select_clip: true, select_clips: true, clear_selection: true, set_overlap: true, set_ripple: true, set_snap: true,
  set_theme: true, set_shortcut: true, reset_shortcuts: true, set_beat_layers: true,
  undo: true, redo: true, undo_to: true, take_snapshot: true,
};

/** Ops that change the project (anything not read-only and not playback/undo/redo/seek). apply is undoable. */
export function isDriftMutation(tool: string): boolean {
  const name = typeof tool === "string" ? tool.trim() : "";
  if (!name) return false;
  if (name === "apply") return true;
  if (isDriftReadTool(name) || NON_MUTATING[name]) return false;
  if (/^(play|pause|seek|scroll|zoom)_/.test(name)) return false;
  return true;
}

const SUMMARY_MAX = 160;

/** Only printable characters survive, bounded to SUMMARY_MAX: a tool payload is DATA, never a terminal
 *  control sequence, and the feed row is one line. */
function bound(s: string): string {
  const c = s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim();
  return c.length > SUMMARY_MAX ? `${c.slice(0, SUMMARY_MAX - 1)}\u2026` : c;
}

/** One-line human summary for the activity feed. Pure, bounded to 160 chars, no control characters. */
export function summarizeDriftCall(tool: string, args: unknown, payload: unknown, isError: boolean): string {
  const name = bound(str(tool)) || "(unknown tool)";
  const a = rec(args);
  const p = rec(payload);
  if (isError) {
    const code = str(p.error) || "error";
    const detail = str(p.detail);
    if (name === "apply" && code === "apply_failed") {
      const failed = str(rec(p.failed).error) || str(p.failed);
      return bound(`apply failed at op ${str(p.stopped)} (${str(p.tool)})${failed ? `: ${failed}` : ""}`);
    }
    return bound(`${name} failed: ${code}${detail ? ` (${detail})` : ""}`);
  }
  if (name === "apply") {
    const ops = Array.isArray(a.ops) ? a.ops : [];
    const names = ops.map((op) => str(rec(op).tool)).filter(Boolean);
    const shown = names.slice(0, 6).join(", ") + (names.length > 6 ? `, +${names.length - 6}` : "");
    return bound(`apply: ${ops.length} op${ops.length === 1 ? "" : "s"}${shown ? ` (${shown})` : ""}`);
  }
  if (name === "export_video") {
    const path = str(p.path) || str(a.path);
    return bound(path ? `export_video -> ${path}` : "export_video started");
  }
  if (name === "capture") {
    const at = str(a.at);
    return bound(at ? `capture at ${at}s` : "capture at playhead");
  }
  if (name === "frames") return "frames: contact sheet";
  if (name === "inspect" || name === "undo" || name === "redo") {
    return bound(p.revision !== undefined ? `${name} (revision ${str(p.revision)})` : name);
  }
  const argText = Object.keys(a).filter((k) => str(a[k]) !== "").slice(0, 4).map((k) => `${k}=${str(a[k]).slice(0, 40)}`).join(", ");
  return bound(argText ? `${name}: ${argText}` : name);
}
