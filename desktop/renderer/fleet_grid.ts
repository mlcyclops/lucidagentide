// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/fleet_grid.ts - P-FLEET.L1: the LUCID Fleet dashboard. Multiple headless engine lanes on
// this machine, each rendered as a streaming, editable mini agent window inside one movable/resizable dock
// (the share/join dock geometry primitives under the fleet's own storage keys). The card FRAME is the status
// surface: the LED + border carry the lane color, and ONLY the two states that need the user - awaiting-input
// (amber) and needs-approval (red) - animate their glow. Self-contained: every engine call goes through the
// injected bridge functions; no direct HTTP here. Closing or minimizing the panel never touches the lanes -
// it is a viewport, not a lifecycle owner.

import { $, el } from "./dom.ts";
import { esc } from "./format.ts";
import { icon } from "./icons.ts";
import { renderMarkdown } from "./markdown.ts";
import { clampToViewport, loadDockState, saveDockState, snapDecision, type DockShape, type DockState, type DockStorage } from "./share_dock.ts";
import type { FleetStatusView, LaneEvent, LaneView, LucidBridge } from "./bridge.ts";

/** The seven lane functions, typed straight off the bridge so the seam can never drift (results are
 *  nullable: getData/post resolve null on transport failure and the panel treats that as "offline"). */
type FleetFns = Pick<LucidBridge, "fleetStatus" | "fleetSpawn" | "fleetPrompt" | "fleetAnswer" | "fleetCancel" | "fleetStop" | "fleetSetModel">;
type FleetResources = FleetStatusView["resources"];

export interface FleetGridDeps extends FleetFns {
  /** The master agent's current model - the default for a new lane. */
  getMasterModel: () => string;
  /** The model catalog for the per-lane pickers. */
  getModelOptions: () => { value: string; label?: string }[];
  /** The master agent's workspace folder - prefilled as a new lane's cwd. */
  getMasterCwd: () => string;
}

const FLEET_DOCK_KEY = "lucid.fleetDock.v1";
const FLEET_DOCK_OPEN_KEY = "lucid.fleetDock.open";
const POLL_MS = 2500;
const UP_ARROW = `<svg class="sd-up" viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="M12 8l-6 7h12z" fill="currentColor"/></svg>`;

interface LaneTool { name: string; detail: string }
interface LaneTurn { role: "user" | "assistant"; text: string; thinking?: string; tools?: LaneTool[]; error?: string }
/** Per-lane render state: the LATEST server view + the locally accumulated stream transcript. Kept in the
 *  module (not the DOM) so a close/reopen of the panel repaints the full history. */
interface LaneRun {
  view: LaneView;
  turns: LaneTurn[];
  pending: string;
  pendingThinking: string;
  pendingTools: LaneTool[];
  streaming: boolean;
  collapsed: boolean;
  card: HTMLElement | null;
}

let deps: FleetGridDeps | null = null;
let dock: HTMLElement | null = null;
let dockState: DockState | null = null;
let pill: HTMLElement | null = null;
let pollTimer: number | null = null;
const runs = new Map<string, LaneRun>();

// localStorage-backed persistence; a broken/absent store degrades to in-memory (the dock still works).
function storage(): DockStorage {
  try { const ls = window.localStorage; return { get: (k) => ls.getItem(k), set: (k, v) => ls.setItem(k, v) }; }
  catch { return { get: () => null, set: () => { /* storage unavailable */ } }; }
}
function persist(): void { if (dockState) saveDockState(storage(), dockState, FLEET_DOCK_KEY); }

/** Wide and shallow: a grid of cards wants width first. Clamped to the viewport on load. */
const fleetFallback = (vw: number, vh: number): DockShape => {
  const w = Math.min(760, Math.max(320, vw - 24));
  return { x: Math.max(12, vw - w - 16), y: Math.max(12, vh - 540), w, h: 480 };
};

/** Called once from app.ts with the bridge seam; builds nothing until the panel is opened. An anchored
 *  (persisted-open) panel from the previous run is restored here, like the voice dock. */
export function initFleetGrid(d: FleetGridDeps): void {
  deps = d;
  if (storage().get(FLEET_DOCK_OPEN_KEY) === "1") openFleetGrid();
}

export function toggleFleetGrid(): void {
  if (!dock) { openFleetGrid(); return; }
  if (dockState?.minimized) { restore(); return; }
  closeFleetGrid();
}

export function openFleetGrid(): void {
  if (!deps) return;
  storage().set(FLEET_DOCK_OPEN_KEY, "1");
  if (dock) { restore(); return; }
  dockState = loadDockState(storage(), window.innerWidth, window.innerHeight, FLEET_DOCK_KEY, fleetFallback(window.innerWidth, window.innerHeight));
  dockState.minimized = false; // an explicit open always shows the panel, never just the pill
  dock = el(`<div id="fleetDock" class="share-dock fleet-dock side-${dockState.side}" role="dialog" aria-label="LUCID Fleet - local lanes">
    <div class="share-dock-head" data-dock-drag>
      <span class="share-dock-grip">${icon("bolt", 14)}</span>
      <span class="share-dock-title">LUCID Fleet</span>
      <span class="fleet-headroom" id="fleetHeadroom" data-tip="Local headroom|CPU and memory vs the spawn watermark (the tick). New lanes are refused above it."></span>
      <button class="btn-mini fleet-add-btn" data-fleet-add title="Spawn a new local lane">${icon("plus", 12)} Lane</button>
      <button class="share-dock-btn" data-dock-min aria-label="Minimize to pill" title="Minimize (lanes keep running)">${UP_ARROW}</button>
      <button class="share-dock-btn" data-fleet-close aria-label="Close the fleet panel" title="Close (lanes keep running)">${icon("close", 15)}</button>
    </div>
    <div class="share-dock-body fleet-body"><div class="fleet-grid" id="fleetGrid"></div></div>
    <div class="share-dock-rz e" data-dock-rz="e" aria-hidden="true"></div>
    <div class="share-dock-rz s" data-dock-rz="s" aria-hidden="true"></div>
    <div class="share-dock-rz se" data-dock-rz="se" aria-hidden="true"></div>
  </div>`);
  document.body.appendChild(dock);
  applyShape();
  wireDrag();
  wireResize();
  dock.addEventListener("click", onClick);
  dock.addEventListener("change", onChange);
  dock.addEventListener("keydown", onDockKey);
  dock.addEventListener("input", onInput);
  window.addEventListener("resize", onWinResize);
  document.addEventListener("keydown", onKey);
  paintEmpty();
  startPoll();
}

export function closeFleetGrid(): void {
  storage().set(FLEET_DOCK_OPEN_KEY, "0");
  stopPoll();
  removePill();
  window.removeEventListener("resize", onWinResize);
  document.removeEventListener("keydown", onKey);
  dock?.remove();
  dock = null;
  dockState = null;
  for (const r of runs.values()) r.card = null; // transcripts survive in the module for the next open
}

// ---------------------------------------------------------------- dock chrome (drag / resize / minimize)

function applyShape(): void {
  if (!dock || !dockState) return;
  const s = dockState.shape;
  dock.style.left = `${s.x}px`; dock.style.top = `${s.y}px`; dock.style.width = `${s.w}px`; dock.style.height = `${s.h}px`;
}
function railWidth(): number { const r = document.querySelector(".rail") as HTMLElement | null; return r ? Math.round(r.getBoundingClientRect().width) : 56; }

function wireDrag(): void {
  const head = dock?.querySelector("[data-dock-drag]") as HTMLElement | null; if (!head) return;
  head.addEventListener("pointerdown", (e) => {
    if ((e.target as HTMLElement).closest("button")) return; // header buttons act, they don't drag
    if (!dockState) return;
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY, ox = dockState.shape.x, oy = dockState.shape.y;
    try { head.setPointerCapture(e.pointerId); } catch { /* non-fatal */ }
    dock?.classList.add("dragging");
    const move = (ev: PointerEvent): void => {
      if (!dockState) return;
      dockState.shape = clampToViewport({ ...dockState.shape, x: ox + (ev.clientX - sx), y: oy + (ev.clientY - sy) }, window.innerWidth, window.innerHeight);
      applyShape();
    };
    const up = (): void => {
      head.removeEventListener("pointermove", move); head.removeEventListener("pointerup", up);
      dock?.classList.remove("dragging");
      if (!dockState) return;
      const snap = snapDecision(dockState.shape, window.innerWidth, window.innerHeight, railWidth());
      dockState.shape = snap.shape; dockState.side = snap.side; applyShape();
      dock?.classList.toggle("snap-left", snap.side === "left");
      dock?.classList.toggle("snap-right", snap.side === "right");
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
// Escape MINIMIZES (non-destructive - the lanes keep running), and only when focus is inside this dock,
// mirroring the join dock's convention.
const onKey = (e: KeyboardEvent): void => {
  if (e.key === "Escape" && dock && !dock.hidden && dock.contains(document.activeElement)) { e.preventDefault(); minimize(); }
};

function minimize(): void {
  if (!dock || !dockState) return;
  dockState.minimized = true; persist();
  dock.hidden = true;
  if (!pill) {
    pill = el(`<button id="fleetDockPill" class="share-dock-pill" title="LUCID Fleet - lanes keep running" aria-label="Restore the fleet panel">${icon("bolt", 12)}<span class="sd-live-dot"></span>${UP_ARROW}</button>`);
    pill.addEventListener("click", restore);
  }
  mountPill();
  paintPill();
}
function restore(): void {
  if (!dock || !dockState) return;
  dockState.minimized = false; persist();
  removePill();
  dock.hidden = false;
}
function removePill(): void { pill?.remove(); pill = null; }
/** The pill lives in the status bar (beside the share/join pills); its innerHTML gets swapped by status
 *  re-renders, so the poll re-adopts a detached pill. */
function mountPill(): void {
  if (!pill) return;
  const sb = document.getElementById("statusbar");
  (sb ?? document.body).append(pill);
}
function paintPill(): void {
  if (!pill) return;
  let working = false, attn = false;
  for (const r of runs.values()) {
    if (r.streaming || r.view.status === "working") working = true;
    if (r.view.status === "needs-approval" || r.view.status === "awaiting-input") attn = true;
  }
  pill.querySelector(".sd-live-dot")?.classList.toggle("on", working);
  pill.classList.toggle("attn", attn);
}

// ---------------------------------------------------------------- polling + reconciliation

function startPoll(): void {
  if (pollTimer != null) return;
  void refresh();
  pollTimer = window.setInterval(() => void refresh(), POLL_MS);
}
function stopPoll(): void {
  if (pollTimer != null) { window.clearInterval(pollTimer); pollTimer = null; }
}

async function refresh(): Promise<void> {
  if (!deps) return;
  let st: FleetStatusView | null = null;
  try { st = await deps.fleetStatus(); } catch { st = null; }
  if (pill && !pill.isConnected && dockState?.minimized) mountPill();
  const hr = dock ? $("#fleetHeadroom", dock) : null;
  if (!st) { if (hr) hr.innerHTML = `<span class="fleet-hr-off">fleet offline</span>`; return; }
  const grid = dock ? ($("#fleetGrid", dock) as HTMLElement | null) : null;
  const seen = new Set<string>();
  for (const lane of st.lanes) {
    seen.add(lane.id);
    let run = runs.get(lane.id);
    if (!run) {
      run = { view: lane, turns: [], pending: "", pendingThinking: "", pendingTools: [], streaming: false, collapsed: false, card: null };
      runs.set(lane.id, run);
    } else {
      run.view = lane; // the server is the source of truth on poll; stream events fill the gaps between
    }
    if (grid && !run.card) { run.card = buildCard(run); grid.append(run.card); paintOutput(run); }
    paintFrame(run);
  }
  for (const [id, run] of [...runs]) {
    if (!seen.has(id)) { run.card?.remove(); runs.delete(id); } // lane fully gone (stopped lanes still list, dimmed)
  }
  if (hr) paintHeadroom(hr, st.resources, st.lanes.length);
  paintEmpty();
  paintPill();
}

function paintHeadroom(hr: HTMLElement, res: FleetResources, laneCount: number): void {
  const bar = (lbl: string, v: number | null): string => {
    if (v == null) return `<span class="fleet-hr-lbl">${lbl}</span><span class="fleet-hr-bar" style="--wm:${res.watermarkPct}%"></span><span class="fleet-hr-val">--</span>`;
    const p = Math.max(0, Math.min(100, Math.round(v)));
    const c = p >= res.watermarkPct ? "var(--red)" : p >= res.watermarkPct - 15 ? "var(--amber)" : "var(--green)";
    return `<span class="fleet-hr-lbl">${lbl}</span><span class="fleet-hr-bar" style="--wm:${res.watermarkPct}%"><span class="fleet-hr-fill" style="width:${p}%;background:${c}"></span></span><span class="fleet-hr-val">${p}%</span>`;
  };
  hr.innerHTML = bar("CPU", res.cpuPct) + bar("MEM", res.memPct) + `<span class="fleet-hr-lanes" title="Lanes running / cap">${laneCount}/${res.maxLanes}</span>`;
}

function paintEmpty(): void {
  if (!dock) return;
  const grid = $("#fleetGrid", dock) as HTMLElement | null; if (!grid) return;
  const empty = $(".fleet-empty", grid);
  const need = runs.size === 0 && !$(".fleet-spawn-card", grid);
  if (need && !empty) grid.append(el(`<div class="fleet-empty">${icon("info", 13)}<span>No lanes yet - spawn one with + Lane. Each lane is a headless LUCID engine working its own folder.</span></div>`));
  else if (!need && empty) empty.remove();
}

// ---------------------------------------------------------------- lane cards

const baseName = (p: string): string => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;

function buildCard(run: LaneRun): HTMLElement {
  return el(`<div class="fleet-card" data-lane="${esc(run.view.id)}">
    <div class="fleet-card-head">
      <span class="fleet-led" aria-hidden="true"></span>
      <span class="fleet-lane-name" data-fleet-name></span>
      <span class="fleet-cwd-chip" data-fleet-cwd></span>
      <select class="fleet-model" data-fleet-model aria-label="Lane model"></select>
      <button class="fleet-card-btn" data-fleet-collapse aria-label="Collapse the lane card" title="Collapse (keeps the header)">${icon("minus", 12)}</button>
      <button class="fleet-card-btn" data-fleet-stop aria-label="Stop this lane" title="Stop the lane">${icon("close", 12)}</button>
    </div>
    <div class="fleet-card-main">
      <div class="fleet-out" data-fleet-out></div>
      <div class="fleet-approve" data-fleet-approve hidden>
        <span class="fleet-approve-txt" data-fleet-approve-txt></span>
        <span class="fleet-approve-acts">
          <button class="btn-mini ok" data-fleet-allow>${icon("check", 11)} Allow</button>
          <button class="btn-mini danger" data-fleet-deny>${icon("close", 11)} Deny</button>
        </span>
      </div>
      <div class="fleet-compose">
        <textarea class="fleet-input" rows="1" data-fleet-input placeholder="Prompt this lane\u2026" spellcheck="false"></textarea>
        <button class="fleet-card-btn fleet-send" data-fleet-send aria-label="Send to this lane" title="Send">${icon("send", 13)}</button>
        <button class="btn-mini danger fleet-cancel" data-fleet-cancel hidden>${icon("close", 11)} Cancel</button>
      </div>
    </div>
  </div>`);
}

/** Repaint everything on the card EXCEPT the output stream: the status frame (class + LED + border), the
 *  labels, the model pick, the approval bar, and the compose row's enable/cancel state. Never touches the
 *  textarea's value, and never rebuilds a focused select - polls must not eat what the user is doing. */
function paintFrame(run: LaneRun): void {
  const card = run.card; if (!card) return;
  const v = run.view;
  card.className = `fleet-card lane-${v.status}`;
  const name = $("[data-fleet-name]", card) as HTMLElement | null;
  if (name) { name.textContent = v.name || v.id; name.title = `${v.name || v.id} \u00b7 ${v.status} \u00b7 ${v.turns} turns`; }
  const cwd = $("[data-fleet-cwd]", card) as HTMLElement | null;
  if (cwd) { cwd.textContent = baseName(v.cwd); cwd.title = v.cwd; }
  const sel = $("[data-fleet-model]", card) as HTMLSelectElement | null;
  if (sel && document.activeElement !== sel) fillModelSelect(sel, v.model);
  const main = $(".fleet-card-main", card) as HTMLElement | null;
  if (main) main.hidden = run.collapsed;
  const ap = $("[data-fleet-approve]", card) as HTMLElement | null;
  if (ap) {
    ap.hidden = v.status !== "needs-approval";
    const txt = $("[data-fleet-approve-txt]", card) as HTMLElement | null;
    if (txt) { const s = v.pendingApproval?.summary ?? "The lane asks to run a gated action."; txt.textContent = s; txt.title = s; }
  }
  const cancel = $("[data-fleet-cancel]", card) as HTMLElement | null;
  if (cancel) cancel.hidden = !(run.streaming || v.status === "working");
  const send = $("[data-fleet-send]", card) as HTMLButtonElement | null;
  if (send) send.disabled = run.streaming || v.status === "stopped";
  const input = $("[data-fleet-input]", card) as HTMLTextAreaElement | null;
  if (input) input.disabled = v.status === "stopped";
}

function fillModelSelect(sel: HTMLSelectElement, current: string): void {
  const opts = deps?.getModelOptions() ?? [];
  const all = opts.some((o) => o.value === current) || !current ? opts : [{ value: current, label: current }, ...opts];
  const sig = all.map((o) => o.value).join("\n");
  if (sel.dataset.sig !== sig) {
    sel.dataset.sig = sig;
    sel.innerHTML = all.map((o) => `<option value="${esc(o.value)}">${esc(o.label ?? o.value)}</option>`).join("");
  }
  sel.value = current || (all[0]?.value ?? "");
}

// ---------------------------------------------------------------- output stream

function toolLine(t: LaneTool): string {
  return `<div class="fleet-tool">${icon("command", 10)}<b>${esc(t.name)}</b><span class="fleet-tool-detail">${esc(t.detail.slice(0, 120))}</span></div>`;
}
function assistantHtml(text: string, thinking: string, tools: LaneTool[], live: boolean, error?: string): string {
  const think = thinking.trim() ? `<div class="fleet-think">${esc(thinking)}</div>` : "";
  const lines = tools.map(toolLine).join("");
  // Completed turns get real markdown; the live stream stays escaped text (cheap + stable while tokens land).
  const body = live
    ? `<div class="fleet-text">${esc(text)}<span class="fleet-cursor">\u258b</span></div>`
    : (text.trim() ? `<div class="fleet-md">${renderMarkdown(text)}</div>` : "");
  const err = error ? `<div class="fleet-errline">${icon("info", 11)}<span title="${esc(error)}">${esc(error)}</span></div>` : "";
  return think + lines + body + err;
}
function idleLabel(run: LaneRun): string {
  if (run.view.status === "starting") return "Starting the lane\u2026";
  if (run.view.status === "stopped") return "Lane stopped.";
  return "No output yet - prompt this lane below.";
}
function outputHtml(run: LaneRun): string {
  const turns = run.turns.map((t) => t.role === "user"
    ? `<div class="fleet-turn-user" title="${esc(t.text)}">${esc(t.text)}</div>`
    : assistantHtml(t.text, t.thinking ?? "", t.tools ?? [], false, t.error)).join("");
  const hasPending = run.streaming || run.pending || run.pendingThinking || run.pendingTools.length;
  const pending = hasPending ? assistantHtml(run.pending, run.pendingThinking, run.pendingTools, true) : "";
  return (turns + pending) || `<div class="fleet-out-empty"><span>${esc(idleLabel(run))}</span></div>`;
}
function paintOutput(run: LaneRun): void {
  const card = run.card; if (!card) return;
  const out = $("[data-fleet-out]", card) as HTMLElement | null; if (!out) return;
  const nearBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 28;
  out.innerHTML = outputHtml(run);
  if (nearBottom) out.scrollTop = out.scrollHeight; // keep the latest in view, but never fight a user scroll
}

function foldPending(run: LaneRun, error?: string): void {
  if (run.pending.trim() || run.pendingThinking.trim() || run.pendingTools.length || error) {
    run.turns.push({
      role: "assistant",
      text: run.pending,
      thinking: run.pendingThinking.trim() || undefined,
      tools: run.pendingTools.length ? run.pendingTools.slice() : undefined,
      error,
    });
  }
  run.pending = ""; run.pendingThinking = ""; run.pendingTools = [];
}

function onLaneEvent(id: string, e: LaneEvent): void {
  const run = runs.get(id); if (!run) return;
  switch (e.type) {
    case "token": run.pending += e.text; paintOutput(run); break;
    case "thinking": run.pendingThinking += e.text; paintOutput(run); break;
    case "tool": run.pendingTools.push({ name: e.name, detail: e.detail }); paintOutput(run); break;
    case "permission":
      run.view.status = "needs-approval";
      run.view.pendingApproval = { summary: e.summary };
      paintFrame(run); paintPill();
      break;
    case "status":
      run.view.status = e.status;
      if (e.status !== "needs-approval") run.view.pendingApproval = undefined;
      paintFrame(run); paintPill();
      break;
    case "done": foldPending(run); paintOutput(run); break;
    case "error":
      foldPending(run, e.message);
      run.view.status = "error";
      paintFrame(run); paintOutput(run); paintPill();
      break;
  }
}

function sendPrompt(run: LaneRun): void {
  if (!deps || run.streaming) return;
  const input = run.card ? ($("[data-fleet-input]", run.card) as HTMLTextAreaElement | null) : null;
  const text = input?.value.trim() ?? "";
  if (!text) return;
  if (input) { input.value = ""; input.style.height = ""; }
  run.turns.push({ role: "user", text });
  run.pending = ""; run.pendingThinking = ""; run.pendingTools = [];
  run.streaming = true;
  run.view.status = "working"; // optimistic; the stream's status events correct it
  paintFrame(run); paintOutput(run); paintPill();
  const id = run.view.id;
  void deps.fleetPrompt(id, text, (e) => onLaneEvent(id, e))
    .catch((err: unknown) => onLaneEvent(id, { type: "error", message: err instanceof Error ? err.message : String(err) }))
    .finally(() => { run.streaming = false; foldPending(run); paintFrame(run); paintOutput(run); paintPill(); });
}

function answer(run: LaneRun, allow: boolean): void {
  if (!deps) return;
  run.view.pendingApproval = undefined;
  run.view.status = "working"; // optimistic; the lane's status events / next poll correct it
  paintFrame(run); paintPill();
  void deps.fleetAnswer(run.view.id, allow).catch(() => { /* the next poll re-surfaces it */ });
}

// ---------------------------------------------------------------- the + Lane form

function toggleSpawnForm(): void {
  if (!dock || !deps) return;
  const existing = $(".fleet-spawn-card", dock);
  if (existing) { existing.remove(); paintEmpty(); return; }
  const grid = $("#fleetGrid", dock) as HTMLElement | null; if (!grid) return;
  const master = deps.getMasterModel();
  const options = deps.getModelOptions();
  const all = options.some((o) => o.value === master) || !master ? options : [{ value: master, label: master }, ...options];
  const opts = all.map((o) => `<option value="${esc(o.value)}"${o.value === master ? " selected" : ""}>${esc(o.label ?? o.value)}</option>`).join("");
  const form = el(`<div class="fleet-card fleet-spawn-card">
    <div class="fleet-card-head">
      <span class="fleet-led" aria-hidden="true"></span>
      <span class="fleet-lane-name">New lane</span>
      <button class="fleet-card-btn" data-spawn-cancel aria-label="Close the new-lane form" title="Close">${icon("close", 12)}</button>
    </div>
    <div class="fleet-spawn">
      <label class="fleet-spawn-lbl">Folder</label>
      <input class="fleet-spawn-in" data-spawn-cwd type="text" value="${esc(deps.getMasterCwd())}" spellcheck="false" />
      <label class="fleet-spawn-lbl">Name <span class="fleet-spawn-opt">optional</span></label>
      <input class="fleet-spawn-in" data-spawn-name type="text" placeholder="lane-${runs.size + 1}" spellcheck="false" />
      <label class="fleet-spawn-lbl">Model</label>
      <select class="fleet-spawn-in" data-spawn-model>${opts}</select>
      <div class="fleet-spawn-err" data-spawn-err hidden></div>
      <div class="fleet-spawn-acts"><button class="btn-mini ok" data-spawn-go>${icon("bolt", 12)} Spawn</button></div>
    </div>
  </div>`);
  grid.prepend(form);
  paintEmpty();
  ($("[data-spawn-cwd]", form) as HTMLInputElement | null)?.focus();
}

async function submitSpawn(): Promise<void> {
  if (!dock || !deps) return;
  const form = $(".fleet-spawn-card", dock) as HTMLElement | null; if (!form) return;
  const cwd = ($("[data-spawn-cwd]", form) as HTMLInputElement | null)?.value.trim() ?? "";
  const name = ($("[data-spawn-name]", form) as HTMLInputElement | null)?.value.trim() ?? "";
  const model = ($("[data-spawn-model]", form) as HTMLSelectElement | null)?.value ?? "";
  const err = $("[data-spawn-err]", form) as HTMLElement | null;
  if (!cwd) { if (err) { err.textContent = "Pick the folder the lane works in."; err.hidden = false; } return; }
  const go = $("[data-spawn-go]", form) as HTMLButtonElement | null;
  if (go) go.disabled = true;
  const r = await deps.fleetSpawn({ cwd, model: model || undefined, name: name || undefined })
    .catch((e: unknown) => ({ ok: false, reason: e instanceof Error ? e.message : String(e) }));
  if (r?.ok) { form.remove(); paintEmpty(); await refresh(); return; }
  if (go) go.disabled = false;
  // The refusal reason carries the measured numbers (e.g. "cpu 82% > 75% watermark") - show it prominently.
  if (err) { err.textContent = r?.reason || "The engine refused the lane."; err.hidden = false; }
}

// ---------------------------------------------------------------- delegated events

function onClick(ev: Event): void {
  const t = ev.target as HTMLElement;
  if (t.closest("[data-fleet-close]")) { closeFleetGrid(); return; }
  if (t.closest("[data-dock-min]")) { minimize(); return; }
  if (t.closest("[data-fleet-add]")) { toggleSpawnForm(); return; }
  if (t.closest("[data-spawn-go]")) { void submitSpawn(); return; }
  if (t.closest("[data-spawn-cancel]")) { toggleSpawnForm(); return; }
  const card = t.closest(".fleet-card[data-lane]") as HTMLElement | null; if (!card || !deps) return;
  const run = runs.get(card.dataset.lane ?? ""); if (!run) return;
  if (t.closest("[data-fleet-collapse]")) { run.collapsed = !run.collapsed; paintFrame(run); return; }
  if (t.closest("[data-fleet-stop]")) {
    run.view.status = "stopped"; paintFrame(run); paintOutput(run); paintPill();
    void deps.fleetStop(run.view.id).catch(() => { /* the next poll corrects it */ });
    return;
  }
  if (t.closest("[data-fleet-send]")) { sendPrompt(run); return; }
  if (t.closest("[data-fleet-cancel]")) { void deps.fleetCancel(run.view.id).catch(() => { /* stream end resolves the state */ }); return; }
  if (t.closest("[data-fleet-allow]")) { answer(run, true); return; }
  if (t.closest("[data-fleet-deny]")) { answer(run, false); return; }
}

function onChange(ev: Event): void {
  const sel = ev.target;
  if (!(sel instanceof HTMLSelectElement) || !sel.matches("[data-fleet-model]") || !deps) return;
  const card = sel.closest(".fleet-card[data-lane]") as HTMLElement | null;
  const run = card ? runs.get(card.dataset.lane ?? "") : null; if (!run) return;
  const next = sel.value;
  void deps.fleetSetModel(run.view.id, next)
    .then((r) => { if (r?.ok) run.view.model = r.model ?? next; else fillModelSelect(sel, run.view.model); })
    .catch(() => fillModelSelect(sel, run.view.model));
}

function onDockKey(ev: KeyboardEvent): void {
  const t = ev.target as HTMLElement;
  if (ev.key !== "Enter") return;
  if (!ev.shiftKey && t instanceof HTMLTextAreaElement && t.matches("[data-fleet-input]")) {
    ev.preventDefault();
    const card = t.closest(".fleet-card[data-lane]") as HTMLElement | null;
    const run = card ? runs.get(card.dataset.lane ?? "") : null;
    if (run) sendPrompt(run);
    return;
  }
  if (t instanceof HTMLInputElement && t.closest(".fleet-spawn-card")) { ev.preventDefault(); void submitSpawn(); }
}

function onInput(ev: Event): void {
  const t = ev.target;
  if (t instanceof HTMLTextAreaElement && t.matches("[data-fleet-input]")) {
    t.style.height = "auto";
    t.style.height = `${Math.min(64, t.scrollHeight)}px`; // 1-2 rows, grows to a small cap
  }
}
