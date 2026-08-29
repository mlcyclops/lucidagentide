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
/** P-TL.2: whether the repo's own echo/demo throwaways are shown. Off by default - they arrive dozens
 *  to the minute and bury every real session. */
const TL_JUNK_KEY = "lucid.timelineDock.selfTest";
const PAGE = 100;
/** Row badge wording per kind - closed set, mirrors timeline.ts. */
const KIND_LABEL: Record<TimelineKind, string> = { chat: "chat", lane: "lane", ingest: "ingest" };

let deps: TimelineDeps | null = null;
let dock: HTMLElement | null = null;
let dockState: DockState | null = null;
let entries: TimelineEntry[] = [];
let total = 0;
/** How many throwaways the engine held back (or marked, when they are shown). */
let selfTestCount = 0;
/** Show the throwaways? Persisted; off by default. */
let showSelfTest = false;
/** The header filter, lowercased. Client-side over the loaded page: a review surface, not a query. */
let filterText = "";
/** The session whose transcript is expanded inline, if any. */
let openId: string | null = null;

function storage(): DockStorage {
  try { const ls = window.localStorage; return { get: (k) => ls.getItem(k), set: (k, v) => ls.setItem(k, v) }; }
  catch { return { get: () => null, set: () => { /* storage unavailable */ } }; }
}
function persist(): void { if (dockState) saveDockState(storage(), dockState, TL_DOCK_KEY); }

/** Wide enough for the list AND the detail pane side by side (the two-pane inspector layout kicks in at
 *  620px of body width), but never wider than the viewport allows. Still tall: a chronology reads down.
 *  A dock the user has already sized keeps their shape - this is only the first-open fallback. */
const tlFallback = (vw: number, vh: number): DockShape => {
  const w = Math.min(880, Math.max(320, vw - 24));
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
      <button class="tl-junk" id="tlJunk" data-tl-junk hidden></button>
      <button class="btn-mini" data-tl-refresh title="Re-scan the session history">${icon("refresh", 12)} Refresh</button>
      <button class="share-dock-btn" data-tl-close aria-label="Close the timeline" title="Close">${icon("close", 15)}</button>
    </div>
    <div class="share-dock-body tl-body">
      <div class="tl-tools">
        <input class="tl-search" id="tlSearch" type="search" placeholder="Filter by title, workspace, or lane" aria-label="Filter sessions" spellcheck="false" />
      </div>
      <div class="tl-panes">
        <div class="tl-left" id="tlLeft"><div class="tl-list" id="tlList"></div></div>
        <div class="tl-detail" id="tlDetail"></div>
      </div>
    </div>
    <div class="share-dock-rz e" data-dock-rz="e" aria-hidden="true"></div>
    <div class="share-dock-rz s" data-dock-rz="s" aria-hidden="true"></div>
    <div class="share-dock-rz se" data-dock-rz="se" aria-hidden="true"></div>
  </div>`);
  document.body.appendChild(dock);
  applyShape();
  wireDrag();
  wireResize();
  dock.addEventListener("click", onClick);
  dock.addEventListener("keydown", onKeydown);
  const search = $("#tlSearch", dock) as HTMLInputElement | null;
  search?.addEventListener("input", () => {
    filterText = search.value.trim().toLowerCase();
    const list = dock ? ($("#tlList", dock) as HTMLElement | null) : null;
    if (list) paintList(list);
  });
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
  showSelfTest = storage().get(TL_JUNK_KEY) === "1";
  const page = await deps.timelineList(PAGE, 0, showSelfTest).catch(() => null);
  const list = $("#tlList", dock) as HTMLElement | null;
  const count = $("#tlCount", dock) as HTMLElement | null;
  if (!page) {
    if (list) list.innerHTML = `<div class="tl-empty"><span>Timeline unavailable - the engine did not answer.</span></div>`;
    return;
  }
  entries = page.entries;
  total = page.total;
  selfTestCount = page.selfTest;
  if (count) count.textContent = `${total} session${total === 1 ? "" : "s"}`;
  paintJunkChip();
  if (list) paintList(list);
  // The selection cannot survive a re-scan (the row may be gone), so the pane returns to its prompt.
  const detail = $("#tlDetail", dock) as HTMLElement | null;
  if (detail && !openId) paintDetailEmpty(detail);
}

/** The header chip: how many self-test throwaways are being held back, and the click that flips it.
 *  Hidden entirely when the corpus has none, so a clean machine never sees the concept. */
function paintJunkChip(): void {
  const chip = dock ? ($("#tlJunk", dock) as HTMLElement | null) : null;
  if (!chip) return;
  chip.hidden = selfTestCount === 0;
  if (selfTestCount === 0) return;
  chip.classList.toggle("on", showSelfTest);
  chip.textContent = showSelfTest ? `${selfTestCount} self-test shown` : `${selfTestCount} self-test hidden`;
  chip.title = showSelfTest
    ? "Throwaway sessions from this repo's own echo and demo scripts are included. Click to hide them."
    : "Throwaway sessions from this repo's own echo and demo scripts are hidden. Click to show them.";
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

/** One row: FIXED metadata columns first (so every title starts at the same x and the eye can scan a
 *  column), then the title at its natural width. The left pane scrolls horizontally, so a long title is
 *  reachable in full instead of ellipsized away. A lane row shows its LANE name in the workspace slot
 *  (the cwd stays in the tooltip): four columns, always aligned, nothing lost. */
function rowHtml(e: TimelineEntry): string {
  const t = new Date(e.updatedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const isLane = e.kind === "lane" && !!e.laneName;
  const slot = isLane
    ? `<span class="tl-ws lane" title="Lane ${esc(e.laneId ?? "")}${e.laneEvents && e.laneEvents > 1 ? ` \u00b7 ${e.laneEvents} spawns` : ""} \u00b7 ${esc(e.cwd)}">${esc(e.laneName ?? "")}</span>`
    : `<span class="tl-ws" title="${esc(e.cwd || "no folder recorded")}">${esc(e.wsName || "-")}</span>`;
  const junk = e.selfTest ? " self-test" : "";
  const badge = e.selfTest ? "self-test" : KIND_LABEL[e.kind];
  return `<div class="tl-row kind-${e.kind}${junk}${openId === e.sessionId ? " sel" : ""}" data-tl-id="${esc(e.sessionId)}" role="button" tabindex="0" aria-label="Read the transcript of ${esc(e.title)}">
    <span class="tl-time">${t}</span>
    <span class="tl-kind">${badge}</span>
    ${slot}
    <span class="tl-turns" title="Completed turns">${e.turns}t</span>
    <span class="tl-title">${esc(e.title)}</span>
    <span class="tl-model">${esc(e.model)}</span>
  </div>`;
}

/** One day's header: the label, how many sessions filed under it, and a composition strip whose
 *  segments are that day's mix of chats, lanes and ingests. Every number here is counted from the
 *  rows actually on screen - nothing is estimated. */
function dayHeadHtml(day: string, rows: TimelineEntry[]): string {
  const counts: Record<TimelineKind, number> = { chat: 0, lane: 0, ingest: 0 };
  for (const r of rows) counts[r.kind]++;
  const order: TimelineKind[] = ["chat", "lane", "ingest"];
  const live = order.filter((k) => counts[k] > 0);
  const segs = live.map((k) => `<i class="tl-seg kind-${k}" style="flex:${counts[k]}"></i>`).join("");
  const tip = live.map((k) => `${counts[k]} ${KIND_LABEL[k]}`).join(", ");
  return `<div class="tl-day">
    <span class="tl-day-label">${esc(day)}</span>
    <span class="tl-day-n">${rows.length}</span>
    <span class="tl-strip" title="${esc(tip)}">${segs}</span>
  </div>`;
}

/** The rows the filter lets through. Matches title, workspace, and lane name so typing a repo name or
 *  a lane name narrows a long day to the thing being looked for. */
function visible(): TimelineEntry[] {
  if (!filterText) return entries;
  return entries.filter((e) => `${e.title} ${e.wsName} ${e.laneName ?? ""}`.toLowerCase().includes(filterText));
}

function paintList(list: HTMLElement): void {
  const rows = visible();
  if (!rows.length) {
    const why = filterText
      ? `Nothing matches "${filterText}".`
      : selfTestCount > 0 && !showSelfTest
        ? `Nothing here but self-test throwaways. ${selfTestCount} are hidden - use the header chip to show them.`
        : "No sessions recorded yet - chats and fleet lanes will appear here as they run.";
    list.innerHTML = `<div class="tl-empty"><span>${esc(why)}</span></div>`;
    return;
  }
  // Group FIRST, so a day header can carry its own count and composition before its rows are emitted.
  const days: { day: string; rows: TimelineEntry[] }[] = [];
  for (const e of rows) {
    const day = dayLabel(e.updatedAt);
    const cur = days[days.length - 1];
    if (cur && cur.day === day) cur.rows.push(e);
    else days.push({ day, rows: [e] });
  }
  const parts: string[] = [];
  for (const g of days) {
    parts.push(dayHeadHtml(g.day, g.rows));
    for (const e of g.rows) parts.push(rowHtml(e));
  }
  const shown = filterText ? `${rows.length} of ${entries.length} loaded match.` : entries.length < total ? `Showing the newest ${entries.length} of ${total}.` : "";
  if (shown) parts.push(`<div class="tl-more"><span>${esc(shown)}</span></div>`);
  list.innerHTML = parts.join("");
}

/** Select a row and read its transcript into the DETAIL pane (right when the dock is wide, below when
 *  narrow). A pane rather than inline expansion: the chronology never reflows under the cursor, and the
 *  transcript gets real room. Clicking the selected row again clears the pane. */
async function selectSession(id: string): Promise<void> {
  if (!deps || !dock) return;
  const detail = $("#tlDetail", dock) as HTMLElement | null;
  if (!detail) return;
  for (const r of dock.querySelectorAll(".tl-row.sel")) r.classList.remove("sel");
  if (openId === id) { openId = null; paintDetailEmpty(detail); return; }
  openId = id;
  (dock.querySelector(`[data-tl-id="${CSS.escape(id)}"]`) as HTMLElement | null)?.classList.add("sel");
  const entry = entries.find((e) => e.sessionId === id);
  detail.innerHTML = `${entry ? detailHeadHtml(entry) : ""}<div class="tl-loading"><span>Reading the transcript\u2026</span></div>`;
  const page = await deps.timelineSession(id, 40).catch(() => null);
  if (openId !== id) return; // the user moved on while we read
  const head = entry ? detailHeadHtml(entry) : "";
  if (!page) { detail.innerHTML = `${head}<div class="tl-empty"><span>Could not read this transcript.</span></div>`; return; }
  const clipped = page.messages.length < page.total ? `<div class="tl-clip"><span>Showing the last ${page.messages.length} of ${page.total} messages.</span></div>` : "";
  detail.innerHTML = `${head}${clipped}<div class="tl-msgs">${page.messages.map(msgHtml).join("")}</div>`;
}

function paintDetailEmpty(detail: HTMLElement): void {
  detail.innerHTML = `<div class="tl-empty"><span>Pick a session on the left to read it here.</span></div>`;
}

/** The detail pane's header: everything known about the session, in block lines so prose never lives
 *  in a flex row. This is where the model and the full folder path finally get room to be readable. */
function detailHeadHtml(e: TimelineEntry): string {
  const when = new Date(e.updatedAt).toLocaleString();
  const badge = e.selfTest ? "self-test" : KIND_LABEL[e.kind];
  const lane = e.kind === "lane" && e.laneName
    ? `<div class="tl-d-line"><span>Lane ${esc(e.laneName)}${e.laneEvents && e.laneEvents > 1 ? ` (${e.laneEvents} spawns)` : ""}</span></div>`
    : "";
  return `<div class="tl-d-head">
    <div class="tl-d-top">
      <span class="tl-kind">${badge}</span>
      <span class="tl-d-when">${esc(when)}</span>
    </div>
    <div class="tl-d-title"><span>${esc(e.title)}</span></div>
    ${lane}
    <div class="tl-d-line"><span>${esc(e.cwd || "no folder recorded")}</span></div>
    <div class="tl-d-line"><span>${esc(e.model)} \u00b7 ${e.turns} turn${e.turns === 1 ? "" : "s"}</span></div>
  </div>`;
}

/** Which gutter label a transcript role gets. Closed set over what the session parser actually emits;
 *  anything unrecognised keeps its own name rather than being mislabelled as the agent. */
const ROLE_LABEL: Record<string, string> = { user: "you", assistant: "agent", agent: "agent", tool: "tool", system: "system" };

/** One transcript message: an uppercase monospace role in a fixed left gutter, the text as a block
 *  paragraph beside it. The gutter is what makes a long transcript scannable by source. */
function msgHtml(m: { role: string; text: string }): string {
  const role = m.role.toLowerCase();
  const label = ROLE_LABEL[role] ?? role.slice(0, 8);
  return `<div class="tl-msg role-${esc(role)}">
    <span class="tl-role">${esc(label)}</span>
    <span class="tl-text">${esc(m.text.slice(0, 4000))}</span>
  </div>`;
}

function onClick(ev: Event): void {
  const t = ev.target as HTMLElement;
  if (t.closest("[data-tl-close]")) { closeTimelineDock(); return; }
  if (t.closest("[data-tl-refresh]")) { void refresh(); return; }
  if (t.closest("[data-tl-junk]")) {
    storage().set(TL_JUNK_KEY, showSelfTest ? "0" : "1");
    openId = null; // the selected row may be filtered away by the flip
    void refresh();
    return;
  }
  const row = t.closest("[data-tl-id]") as HTMLElement | null;
  if (row?.dataset.tlId) void selectSession(row.dataset.tlId);
}

/** Keyboard parity: rows are role=button, so Enter and Space must select (a div gets neither for free),
 *  and Up/Down walk the chronology without the mouse. Escape hands focus back out of the filter. */
function onKeydown(ev: KeyboardEvent): void {
  if (!dock) return;
  const t = ev.target as HTMLElement;
  if (t.id === "tlSearch") {
    if (ev.key === "Escape") { (t as HTMLInputElement).blur(); }
    return;
  }
  const row = t.closest("[data-tl-id]") as HTMLElement | null;
  if (!row) return;
  if (ev.key === "Enter" || ev.key === " ") {
    ev.preventDefault();
    if (row.dataset.tlId) void selectSession(row.dataset.tlId);
    return;
  }
  if (ev.key !== "ArrowDown" && ev.key !== "ArrowUp") return;
  ev.preventDefault();
  const all = [...dock.querySelectorAll("[data-tl-id]")].filter((n): n is HTMLElement => n instanceof HTMLElement);
  const i = all.indexOf(row);
  const next = all[i + (ev.key === "ArrowDown" ? 1 : -1)];
  next?.focus();
}
