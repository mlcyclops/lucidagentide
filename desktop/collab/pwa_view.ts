// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/collab/pwa_view.ts — P-REMOTE.3 (ADR-0226/0227): the phone guest's PURE, DOM-free viewer core.
//
// The phone PWA (tools/remote-pwa/) drives CollabGuest exactly like the desktop, but renders on a small
// screen without the desktop renderer. This is the compact viewer: a PURE reducer that folds the host's
// ChatEvent stream into a list of view items, plus HTML renderers for each. No DOM, no globals — so the phone
// UI stays testable headless and the same logic the desktop guest shows (thinking + tool chips + subagents,
// ADR-0222) renders faithfully on mobile.
//
// SECURITY: every host-authored string (answer text, tool detail, subagent title, block reason) is ESCAPED
// before it becomes HTML. The frames are E2E from the host, but the host's session can echo untrusted content,
// so the phone treats all of it as text, never markup.

import type { ChatEvent } from "../renderer/chat_events.ts";
import { toolChip } from "../renderer/answer_chips.ts"; // P-REMOTE.9: reuse the desktop's +/- diffstat convention
import type { CollabSessionHeader, CollabTranscriptTurn } from "./frames.ts";
import type { GuestPhase, GuestView } from "./guest.ts";

/** Escape the five HTML-significant characters. The only text→markup boundary in the PWA. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;"));
}

/** One rendered block in the phone transcript. Token deltas accrete into the trailing `answer`; thinking,
 *  tools, subagents, and blocks are their own items so the reader sees what the agent is doing. */
export type ViewItem =
  | { kind: "user"; text: string; from?: string } // P-REMOTE.9/P-COLLAB.15: a user turn (own echo, or another participant's, labelled by `from`)
  | { kind: "answer"; text: string; streaming: boolean }
  | { kind: "thinking"; text: string }
  // P-REMOTE.9: `path` + `add`/`del` present for edit/write/patch tools (the +/- diffstat), else absent.
  | { kind: "tool"; name: string; detail: string; path?: string; add?: number; del?: number }
  | { kind: "subagent"; agent: string; title: string; count: number }
  | { kind: "block"; reason: string; severity: string }
  // P-PREVIEW-PWA.1: a preview snapshot the host sent. `image` is a data URL, hydrated as an <img> property by
  // the PWA (never inlined into the transcript HTML); `id` is stable across re-renders for that hydration.
  | { kind: "preview"; image: string; label?: string; id: string }
  | { kind: "note"; text: string };

/** Fold one host ChatEvent into the item list (PURE — returns a new list). Token/thinking deltas coalesce
 *  into the trailing item of their kind; `done` finalizes the streaming answer with its authoritative text. */
export function foldEvent(items: ViewItem[], e: ChatEvent): ViewItem[] {
  const out = items.slice();
  const last = out[out.length - 1];
  switch (e.type) {
    case "token": {
      if (last && last.kind === "answer" && last.streaming) out[out.length - 1] = { ...last, text: last.text + e.text };
      else out.push({ kind: "answer", text: e.text, streaming: true });
      return out;
    }
    case "thinking": {
      if (last && last.kind === "thinking") out[out.length - 1] = { kind: "thinking", text: last.text + e.text };
      else out.push({ kind: "thinking", text: e.text });
      return out;
    }
    case "tool": {
      // P-REMOTE.9: size the +/- diffstat from the tool's authored code (edit/write/patch) using the SAME
      // convention as the desktop chips; a read/search/bash tool has no code -> no diffstat.
      const chip = toolChip(e.name, e.detail, e.code);
      out.push({
        kind: "tool", name: e.name, detail: chip.detail,
        ...(e.code?.path ? { path: e.code.path } : {}),
        ...(chip.diffstat ? { add: chip.diffstat.add, del: chip.diffstat.del } : {}),
      });
      return out;
    }
    case "subagent":
      out.push({ kind: "subagent", agent: e.agent, title: e.title, count: e.assignments.length });
      return out;
    case "block":
      out.push({ kind: "block", reason: e.reason, severity: e.severity });
      return out;
    case "done": {
      // Reconcile the (lossy) streamed answer with the authoritative full text, and stop streaming.
      const text = typeof e.text === "string" && e.text ? e.text : last && last.kind === "answer" ? last.text : "";
      if (last && last.kind === "answer" && last.streaming) out[out.length - 1] = { kind: "answer", text, streaming: false };
      else if (text) out.push({ kind: "answer", text, streaming: false });
      return out;
    }
    case "no-response":
      out.push({ kind: "note", text: `The model (${e.model}) returned nothing.` });
      return out;
    case "preview-snapshot": {
      // P-PREVIEW-PWA.1: a preview capture from the host. Stable id = its index among previews (they only
      // append), so the PWA can re-hydrate its <img> src on every transcript re-render.
      const n = out.reduce((c, i) => c + (i.kind === "preview" ? 1 : 0), 0);
      out.push({ kind: "preview", image: e.image, ...(e.label ? { label: e.label } : {}), id: `shot-${n}` });
      return out;
    }
    // Desktop-only / non-viewer events (preview, design, goal, usage, slow, …) are ignored on the phone.
    default:
      return out;
  }
}

const SEV_CLASS: Record<string, string> = { high: "sev-high", medium: "sev-med", low: "sev-low" };

/** One-line gist of a thinking block for its collapsed summary: the LAST non-empty line (the freshest
 *  thought while the stream grows), whitespace-collapsed and clipped. Pure; "" for blank text. */
export function thinkingGist(text: string, max = 64): string {
  const lines = text.split(/\n+/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  const last = lines[lines.length - 1] ?? "";
  return last.length > max ? `${last.slice(0, max - 1).trimEnd()}…` : last;
}

/** Render one view item to a mobile HTML fragment (all host text escaped).
 *  `i` keys a thinking block's `data-think` so the PWA can preserve the user's open/closed choice across
 *  the per-event innerHTML repaints (which otherwise reset every <details> to collapsed - the "can't open
 *  Thinking while the agent streams" bug). `activeThinking` renders the block OPEN by default: desktop
 *  parity, where the live reasoning streams visibly and collapses once the answer starts. */
export function renderItem(item: ViewItem, i = 0, activeThinking = false): string {
  switch (item.kind) {
    case "user": {
      // P-COLLAB.15: label a turn from ANOTHER participant with its author; the guest's own echo has no `from`.
      const who = item.from ? `<span class="msg-from">${escapeHtml(item.from)}</span>` : "";
      return `<div class="msg user">${who}${escapeHtml(item.text)}</div>`;
    }
    case "answer":
      return `<div class="msg answer${item.streaming ? " streaming" : ""}">${escapeHtml(item.text)}</div>`;
    case "thinking": {
      const gist = thinkingGist(item.text);
      const g = gist ? ` <span class="gist">${escapeHtml(gist)}</span>` : "";
      return `<details class="msg thinking"${activeThinking ? " open" : ""} data-think="${i}"><summary>Thinking${g}</summary><div>${escapeHtml(item.text)}</div></details>`;
    }
    case "tool": {
      // For an edit/write, show the file path + a +/- diffstat; for other tools, the compact detail.
      const label = item.path ? escapeHtml(item.path) : escapeHtml(item.detail);
      const body = label ? `<span class="chip-detail">${label}</span>` : "";
      const stat = (item.add != null || item.del != null)
        ? `<span class="chip-stat"><span class="add">+${item.add ?? 0}</span> <span class="del">\u2212${item.del ?? 0}</span></span>`
        : "";
      return `<div class="chip tool"><span class="chip-name">${escapeHtml(item.name)}</span>${body}${stat}</div>`;
    }
    case "subagent":
      return `<div class="chip subagent"><span class="chip-name">${escapeHtml(item.agent)}</span><span class="chip-detail">${escapeHtml(item.title)} · ${item.count} task${item.count === 1 ? "" : "s"}</span></div>`;
    case "block":
      return `<div class="chip block ${SEV_CLASS[item.severity] ?? "sev-med"}">Blocked: ${escapeHtml(item.reason)}</div>`;
    case "preview": {
      // The image data URL is set as an <img> PROPERTY by the PWA after render (never inlined here). The
      // button opens the fullscreen viewer (save / mark-up); `data-shot` keys both the hydration + the tap.
      const cap = item.label ? `<div class="cu-shot-cap">${escapeHtml(item.label)}</div>` : "";
      return `<div class="msg shot"><button class="cu-shot-btn" type="button" data-shot="${escapeHtml(item.id)}" aria-label="Open preview snapshot"><img class="cu-shot-img" alt="preview snapshot" /></button>${cap}</div>`;
    }
    case "note":
      return `<div class="msg note">${escapeHtml(item.text)}</div>`;
  }
}

/** Render the whole transcript (prior turns from `welcome`, then the folded live items). */
export function renderTranscript(prior: CollabTranscriptTurn[], items: ViewItem[]): string {
  const priorHtml = prior
    .map((t) => `<div class="msg ${t.role === "user" ? "user" : "answer"}">${escapeHtml(t.text)}</div>`)
    .join("");
  // A thinking block that is still the TRAILING item is the live reasoning - render it open (it collapses
  // naturally when the first answer token / tool chip lands after it). data-think = the item index.
  return priorHtml + items.map((it, i) => renderItem(it, i, it.kind === "thinking" && i === items.length - 1)).join("");
}

/** The header line (title + model + host) for the top bar. Metadata only — no credentials, no paths. */
export function renderHeader(header: CollabSessionHeader | null): string {
  if (!header) return `<span class="hdr-title">Connecting…</span>`;
  return `<span class="hdr-title">${escapeHtml(header.title || "LUCID session")}</span>` +
    `<span class="hdr-sub">${escapeHtml(header.model)} · ${escapeHtml(header.hostName)}</span>`;
}

/** P-COLLAB.14: the EDIT guest's model + already-used-folder pickers. Renders two `<select>`s (data-role
 *  `model` / `workspace`) ONLY for a live, writable guest that the host offered `options`; otherwise "" (a
 *  view guest never sees them). Every model/folder NAME is escaped (host-authored). Values are the model id
 *  and the OPAQUE folder id - no filesystem path is ever present. The PWA wires `change` to guest.setModel/
 *  setWorkspace. */
export function renderControls(view: GuestView): string {
  if (view.readOnly || view.phase === "ended" || !view.options) return "";
  const o = view.options;
  const modelOpts = o.models
    .map((m) => `<option value="${escapeHtml(m.value)}"${m.value === o.activeModel ? " selected" : ""}>${escapeHtml(m.name || m.value)}</option>`)
    .join("");
  const wsOpts = o.workspaces
    .map((w) => `<option value="${escapeHtml(w.id)}"${w.id === o.activeWorkspaceId ? " selected" : ""}>${escapeHtml(w.name)}${w.isGit ? " \u00b7 git" : ""}</option>`)
    .join("");
  const model = o.models.length
    ? `<label class="ctl"><span class="ctl-l">Model</span><select class="ctl-sel" data-role="model" aria-label="Model">${modelOpts}</select></label>`
    : "";
  const workspace = o.workspaces.length
    ? `<label class="ctl"><span class="ctl-l">Folder</span><select class="ctl-sel" data-role="workspace" aria-label="Folder">${wsOpts}</select></label>`
    : "";
  return model + workspace;
}

/** A short connection-status label + tone for the banner. */
export function statusLabel(view: GuestView): { text: string; tone: "live" | "wait" | "ended" } {
  // P-REMOTE.8: a transient reconnect is a WAIT (amber), not an ended (red) state - and once the socket
  // recovers, guest.ts clears the note + goes live, so the banner flips back to "Live" on its own.
  if (view.phase === "reconnecting") return { text: view.note ?? "Reconnecting\u2026", tone: "wait" };
  if (view.note) return { text: view.note, tone: "ended" };
  const byPhase: Record<GuestPhase, { text: string; tone: "live" | "wait" | "ended" }> = {
    connecting: { text: "Connecting…", tone: "wait" },
    reconnecting: { text: "Reconnecting…", tone: "wait" },
    live: { text: view.readOnly ? "Live · view only" : "Live · you can drive", tone: "live" },
    ended: { text: "Session ended", tone: "ended" },
  };
  return byPhase[view.phase];
}

// ── P-REMOTE.9 (ADR-0230): end-of-run mobile engineering report ───────────────────────────────────────────

export interface ReportFile { path: string; add: number; del: number }
export interface TurnReport {
  model: string;
  contextPct: number | null;
  task: string;    // the user prompt that started the turn (empty when the host drove it)
  answer: string;  // the final assistant reply
  files: ReportFile[]; // files edited/written, +/- summed per path
  tools: { name: string; n: number }[]; // tool-use counts, busiest first
  totalAdd: number;
  totalDel: number;
}

/** Build a per-turn engineering report from ONE turn's folded view items (PURE). Merges edit/write diffstats
 *  per file, counts tool uses, and captures the task prompt + final answer. */
export function buildTurnReport(items: ViewItem[], view: { header: CollabSessionHeader | null; contextPct: number | null }): TurnReport {
  const byPath = new Map<string, ReportFile>();
  const counts = new Map<string, number>();
  let task = "", answer = "";
  for (const it of items) {
    if (it.kind === "user") task = it.text;
    else if (it.kind === "answer") answer = it.text;
    else if (it.kind === "tool") {
      counts.set(it.name, (counts.get(it.name) ?? 0) + 1);
      if (it.path && (it.add != null || it.del != null)) {
        const f = byPath.get(it.path) ?? { path: it.path, add: 0, del: 0 };
        f.add += it.add ?? 0;
        f.del += it.del ?? 0;
        byPath.set(it.path, f);
      }
    }
  }
  const files = [...byPath.values()];
  const tools = [...counts.entries()].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n);
  return {
    model: view.header?.model ?? "",
    contextPct: view.contextPct,
    task, answer, files, tools,
    totalAdd: files.reduce((s, f) => s + f.add, 0),
    totalDel: files.reduce((s, f) => s + f.del, 0),
  };
}

/** Render the report as mobile-friendly, screenshot-friendly CARDS (all host text escaped). */
export function renderReportHtml(r: TurnReport): string {
  const ctx = r.contextPct != null ? `${r.contextPct}%` : "-";
  const filesRows = r.files.length
    ? r.files.map((f) => `<div class="rp-row"><span class="rp-path">${escapeHtml(f.path)}</span><span class="rp-stat"><span class="add">+${f.add}</span> <span class="del">\u2212${f.del}</span></span></div>`).join("")
    : `<div class="rp-empty">No files changed this run.</div>`;
  const toolsRows = r.tools.length
    ? r.tools.map((t) => `<div class="rp-row"><span>${escapeHtml(t.name)}</span><span class="rp-n">\u00d7${t.n}</span></div>`).join("")
    : `<div class="rp-empty">No tools used.</div>`;
  const taskCard = r.task ? `<div class="rp-card"><div class="rp-h">Task</div><div class="rp-body">${escapeHtml(r.task)}</div></div>` : "";
  const answerCard = r.answer ? `<div class="rp-card"><div class="rp-h">Summary</div><div class="rp-body">${escapeHtml(r.answer)}</div></div>` : "";
  return `<div class="rp-card rp-summary">`
    + `<div class="rp-metric"><div class="rp-k">Model</div><div class="rp-v">${escapeHtml(r.model || "-")}</div></div>`
    + `<div class="rp-metric"><div class="rp-k">Files</div><div class="rp-v">${r.files.length}</div></div>`
    + `<div class="rp-metric"><div class="rp-k">Lines</div><div class="rp-v"><span class="add">+${r.totalAdd}</span> <span class="del">\u2212${r.totalDel}</span></div></div>`
    + `<div class="rp-metric"><div class="rp-k">Context</div><div class="rp-v">${ctx}</div></div>`
    + `</div>`
    + taskCard
    + `<div class="rp-card"><div class="rp-h">Files changed</div>${filesRows}</div>`
    + `<div class="rp-card"><div class="rp-h">Tools</div>${toolsRows}</div>`
    + answerCard;
}

/** The report as copyable Markdown (plain text; the user pastes it into a doc/ticket). */
export function reportMarkdown(r: TurnReport): string {
  const lines = ["# LUCID run report", ""];
  lines.push(`- **Model:** ${r.model || "unknown"}`);
  if (r.contextPct != null) lines.push(`- **Context fill:** ${r.contextPct}%`);
  lines.push(`- **Files changed:** ${r.files.length} (+${r.totalAdd} / \u2212${r.totalDel})`);
  if (r.task) lines.push("", "## Task", r.task);
  if (r.files.length) { lines.push("", "## Files"); for (const f of r.files) lines.push(`- \`${f.path}\` +${f.add} / \u2212${f.del}`); }
  if (r.tools.length) { lines.push("", "## Tools"); for (const t of r.tools) lines.push(`- ${t.name} \u00d7${t.n}`); }
  if (r.answer) lines.push("", "## Summary", r.answer);
  return lines.join("\n");
}
