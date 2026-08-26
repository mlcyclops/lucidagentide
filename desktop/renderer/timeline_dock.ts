// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/timeline_dock.ts - P-FLEET.L5 (ADR-0274): the reviewable TIMELINE. Every session this
// machine has had - master chats, fleet lane sessions (labeled through the durable lane-session ledger),
// and kg-ingest throwaways - as one chronological surface, grouped by day, spanning every workspace.
// Click a row and the transcript expands IN PLACE (tail-limited), read-only: this is a review surface,
// never a lifecycle owner - nothing here can prompt, resume, or delete.
//
// Same movable/resizable/minimizable dock chrome as the fleet grid (share_dock primitives, own storage
// keys). Data loads on open + on the Refresh button - a review surface does not need a poll.

import { $, el } from "./dom.ts";
import { esc } from "./format.ts";
import { icon } from "./icons.ts";
import { clampToViewport, loadDockState, saveDockState, snapDecision, type DockShape, type DockState, type DockStorage } from "./share_dock.ts";
import type { LucidBridge, TimelineEntry, TimelineKind } from "./bridge.ts";

export interface TimelineDeps {
  timelineList: LucidBridge["timelineList"];
  timelineSession: LucidBridge["timelineSession"];
}

const TL_DOCK_KEY = "lucid.timelineDock.v1";
const TL_DOCK_OPEN_KEY = "lucid.timelineDock.open";
const PAGE = 100;
/** Row badge wording per kind - closed set, mirrors timeline.ts. */
const KIND_LABEL: Record<TimelineKind, string> = { chat: "chat", lane: "lane", ingest: "ingest" };

let deps: TimelineDeps | null = null;
let dock: HTMLElement | null = null;
let dockState: DockState | null = null;
let entries: TimelineEntry[] = [];
let total = 0;
/** The session whose transcript is expanded inline, if any. */
let openId: string | null = null;

function storage(): DockStorage {
  try { const ls = window.localStorage; return { get: (k) => ls.getItem(k), set: (k, v) => ls.setItem(k, v) }; }
  catch { return { get: () => null, set: () => { /* storage unavailable */ } }; }
}
function persist(): void { if (dockState) saveDockState(storage(), dockState, TL_DOCK_KEY); }

/** Tall and narrow: a chronology reads down. Clamped to the viewport on load. */
const tlFallback = (vw: number, vh: number): DockShape => {
  const w = Math.min(460, Math.max(320, vw - 24));
  return { x: Math.max(12, vw - w - 16), y: 60, w, h: Math.max(360, vh - 140) };
};

export function initTimelineDock(d: TimelineDeps): void {
  deps = d;
  if (storage().get(TL_DOCK_OPEN_KEY) === "1") openTimelineDock();
}

export function toggleTimelineDock(): void {
  if (!dock) { openTimelineDock(); return; }
  if (dockState?.minimized) { dockState.minimized = false; persist(); dock.hidden = false; return; }
  closeTimelineDock();
}

export function openTimelineDock(): void {
  if (!deps) return;
  storage().set(TL_DOCK_OPEN_KEY, "1");
  if (dock) { dockState!.minimized = false; persist(); dock.hidden = false; return; }
  dockState = loadDockState(storage(), window.innerWidth, window.innerHeight, TL_DOCK_KEY, tlFallback(window.innerWidth, window.innerHeight));
  dockState.minimized = false;
  dock = el(`<div id="timelineDock" class="share-dock tl-dock side-${dockState.side}" role="dialog" aria-label="Timeline - every session, reviewable">
    <div class="share-dock-head" data-dock-drag>
      <span class="share-dock-grip">${icon("clock", 14)}</span>
      <span class="share-dock-title">Timeline</span>
      <span class="tl-count" id="tlCount" data-tip="Sessions on this machine|Master chats, fleet lane sessions, and import throwaways - every workspace, newest first."></span>
      <button class="btn-mini" data-tl-refresh title="Re-scan the session history">${icon("refresh", 12)} Refresh</button>
      <button class="share-dock-btn" data-tl-close aria-label="Close the timeline" title="Close">${icon("close", 15)}</button>
    </div>
    <div class="share-dock-body tl-body"><div class="tl-list" id="tlList"></div></div>
    <div class="share-dock-rz e" data-dock-rz="e" aria-hidden="true"></div>
    <div class="share-dock-rz s" data-dock-rz="s" aria-hidden="true"></div>
    <div class="share-dock-rz se" data-dock-rz="se" aria-hidden="true"></div>
  </div>`);
  document.body.appendChild(dock);
  applyShape();
  wireDrag();
  wireResize();
  dock.addEventListener("click", onClick);
  window.addEventListener("resize", onWinResize);
  void refresh();
}

export function closeTimelineDock(): void {
  storage().set(TL_DOCK_OPEN_KEY, "0");
  window.removeEventListener("resize", onWinResize);
  dock?.remove();
  dock = null;
  dockState = null;
  openId = null;
}

// ---------------------------------------------------------------- dock chrome (same shape as fleet_grid)

function applyShape(): void {
  if (!dock || !dockState) return;
  const s = dockState.shape;
  dock.style.left = `${s.x}px`; dock.style.top = `${s.y}px`; dock.style.width = `${s.w}px`; dock.style.height = `${s.h}px`;
}
function railWidth(): number { const r = document.querySelector(".rail") as HTMLElement | null; return r ? Math.round(r.getBoundingClientRect().width) : 56; }

function wireDrag(): void {
  const head = dock?.querySelector("[data-dock-drag]") as HTMLElement | null; if (!head) return;
  head.addEventListener("pointerdown", (e) => {
    if ((e.target as HTMLElement).closest("button")) return;
    if (!dockState) return;
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY, ox = dockState.shape.x, oy = dockState.shape.y;
    try { head.setPointerCapture(e.pointerId); } catch { /* non-fatal */ }
    const move = (ev: PointerEvent): void => {
      if (!dockState) return;
      dockState.shape = clampToViewport({ ...dockState.shape, x: ox + (ev.clientX - sx), y: oy + (ev.clientY - sy) }, window.innerWidth, window.innerHeight);
      applyShape();
    };
    const up = (): void => {
      head.removeEventListener("pointermove", move); head.removeEventListener("pointerup", up);
      if (!dockState) return;
      const snap = snapDecision(dockState.shape, window.innerWidth, window.innerHeight, railWidth());
      dockState.shape = snap.shape; dockState.side = snap.side; applyShape();
      persist();
    };
    head.addEventListener("pointermove", move); head.addEventListener("pointerup", up);
  });
}

function wireResize(): void {
  dock?.querySelectorAll("[data-dock-rz]").forEach((h) => {
    const dir = (h as HTMLElement).dataset.dockRz ?? "se";
    h.addEventListener("pointerdown", (e) => {
      const ev = e as PointerEvent; ev.preventDefault(); ev.stopPropagation();
      if (!dockState) return;
      const sx = ev.clientX, sy = ev.clientY, ow = dockState.shape.w, oh = dockState.shape.h;
      try { (h as HTMLElement).setPointerCapture(ev.pointerId); } catch { /* non-fatal */ }
      const move = (m: Event): void => {
        const pm = m as PointerEvent;
        if (!dockState) return;
        const w = dir.includes("e") ? ow + (pm.clientX - sx) : ow;
        const hh = dir.includes("s") ? oh + (pm.clientY - sy) : oh;
        dockState.shape = clampToViewport({ ...dockState.shape, w, h: hh }, window.innerWidth, window.innerHeight);
        applyShape();
      };
      const up = (): void => { h.removeEventListener("pointermove", move); h.removeEventListener("pointerup", up); persist(); };
      h.addEventListener("pointermove", move); h.addEventListener("pointerup", up);
    });
  });
}

const onWinResize = (): void => {
  if (!dock || !dockState) return;
  dockState.shape = clampToViewport(dockState.shape, window.innerWidth, window.innerHeight);
  applyShape();
  persist();
};

// ---------------------------------------------------------------- data + rows

async function refresh(): Promise<void> {
  if (!deps || !dock) return;
  const page = await deps.timelineList(PAGE, 0).catch(() => null);
  const list = $("#tlList", dock) as HTMLElement | null;
  const count = $("#tlCount", dock) as HTMLElement | null;
  if (!page) {
    if (list) list.innerHTML = `<div class="tl-empty"><span>Timeline unavailable - the engine did not answer.</span></div>`;
    return;
  }
  entries = page.entries;
  total = page.total;
  if (count) count.textContent = `${total} session${total === 1 ? "" : "s"}`;
  if (list) paintList(list);
}

/** "Today" / "Yesterday" / a locale date - the day header a row files under. */
function dayLabel(ts: number): string {
  const d = new Date(ts);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const yday = new Date(today.getTime() - 86_400_000);
  if (d >= today) return "Today";
  if (d >= yday) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}

function rowHtml(e: TimelineEntry): string {
  const t = new Date(e.updatedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const lane = e.kind === "lane" && e.laneName ? `<span class="tl-lane-name" title="Lane ${esc(e.laneId ?? "")}${e.laneEvents && e.laneEvents > 1 ? ` \u00b7 ${e.laneEvents} spawns` : ""}">${esc(e.laneName)}</span>` : "";
  const ws = e.wsName ? `<span class="tl-ws" title="${esc(e.cwd)}">${esc(e.wsName)}</span>` : "";
  return `<div class="tl-row kind-${e.kind}${openId === e.sessionId ? " open" : ""}" data-tl-id="${esc(e.sessionId)}" role="button" tabindex="0" aria-label="Open the transcript of ${esc(e.title)}">
    <span class="tl-time">${t}</span>
    <span class="tl-kind">${KIND_LABEL[e.kind]}</span>
    ${lane}
    <span class="tl-title" title="${esc(e.title)}">${esc(e.title)}</span>
    ${ws}
    <span class="tl-turns" title="Completed turns \u00b7 model ${esc(e.model)}">${e.turns}t</span>
  </div>
  <div class="tl-transcript" data-tl-body="${esc(e.sessionId)}" hidden></div>`;
}

function paintList(list: HTMLElement): void {
  if (!entries.length) {
    list.innerHTML = `<div class="tl-empty"><span>No sessions recorded yet - chats and fleet lanes will appear here as they run.</span></div>`;
    return;
  }
  let lastDay = "";
  const parts: string[] = [];
  for (const e of entries) {
    const day = dayLabel(e.updatedAt);
    if (day !== lastDay) { parts.push(`<div class="tl-day">${esc(day)}</div>`); lastDay = day; }
    parts.push(rowHtml(e));
  }
  if (entries.length < total) parts.push(`<div class="tl-more"><span>Showing the newest ${entries.length} of ${total}.</span></div>`);
  list.innerHTML = parts.join("");
}

/** Expand a row's transcript in place (tail-limited read; "showing last N of M" when clipped). */
async function toggleTranscript(id: string): Promise<void> {
  if (!deps || !dock) return;
  const body = dock.querySelector(`[data-tl-body="${CSS.escape(id)}"]`) as HTMLElement | null;
  const row = dock.querySelector(`[data-tl-id="${CSS.escape(id)}"]`) as HTMLElement | null;
  if (!body || !row) return;
  if (openId === id) { openId = null; body.hidden = true; row.classList.remove("open"); return; }
  // Close the previously open one (single expansion keeps the chronology scannable).
  if (openId) {
    const prev = dock.querySelector(`[data-tl-body="${CSS.escape(openId)}"]`) as HTMLElement | null;
    prev?.setAttribute("hidden", "");
    (dock.querySelector(`[data-tl-id="${CSS.escape(openId)}"]`) as HTMLElement | null)?.classList.remove("open");
  }
  openId = id;
  row.classList.add("open");
  body.hidden = false;
  body.innerHTML = `<div class="tl-loading"><span>Reading the transcript\u2026</span></div>`;
  const page = await deps.timelineSession(id, 40).catch(() => null);
  if (openId !== id) return; // the user moved on while we read
  if (!page) { body.innerHTML = `<div class="tl-empty"><span>Could not read this transcript.</span></div>`; return; }
  const clipped = page.messages.length < page.total ? `<div class="tl-clip"><span>Showing the last ${page.messages.length} of ${page.total} messages.</span></div>` : "";
  body.innerHTML = clipped + page.messages
    .map((m) => `<div class="tl-msg ${m.role === "user" ? "u" : "a"}"><span class="tl-role">${m.role === "user" ? "you" : "agent"}</span><span class="tl-text">${esc(m.text.slice(0, 4000))}</span></div>`)
    .join("");
}

function onClick(ev: Event): void {
  const t = ev.target as HTMLElement;
  if (t.closest("[data-tl-close]")) { closeTimelineDock(); return; }
  if (t.closest("[data-tl-refresh]")) { void refresh(); return; }
  const row = t.closest("[data-tl-id]") as HTMLElement | null;
  if (row?.dataset.tlId) void toggleTranscript(row.dataset.tlId);
}
