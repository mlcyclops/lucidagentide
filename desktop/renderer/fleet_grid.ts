// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/fleet_grid.ts - P-FLEET.L1/L2: the LUCID Fleet dashboard. Multiple headless engine lanes
// on this machine, each rendered as a streaming, editable mini agent window inside one movable/resizable dock
// (the share/join dock geometry primitives under the fleet's own storage keys). The card FRAME is the status
// surface: the LED + border carry the lane color, and ONLY the two states that need the user - awaiting-input
// (amber) and needs-approval (red) - animate their glow. Self-contained: every engine call goes through the
// injected bridge functions; no direct HTTP here. Closing or minimizing the panel never touches the lanes -
// it is a viewport, not a lifecycle owner.
//
// P-FLEET.L2 adds three things:
//   - the new-lane form opens the REAL OS folder dialog (Explorer / Finder / zenity, create-new included)
//     and accepts a GitHub / GitLab / Azure DevOps https-or-ssh remote, with the token stored per HOST in
//     the machine's encrypted vault;
//   - the header reports SUSTAINED pressure (how long a metric has held the line) instead of a lane cap,
//     because the fleet no longer has one;
//   - MINIMIZED, the status-bar pill is a real snapshot: one colored dot per lane state with its count and
//     a hover naming the lanes. It is re-adopted after every status-bar repaint and only repainted when the
//     markup actually changes, which is what stops it flickering while a lane works.

import { $, el } from "./dom.ts";
import { esc } from "./format.ts";
import { icon } from "./icons.ts";
import { renderMarkdown } from "./markdown.ts";
import { clampToViewport, loadDockState, saveDockState, snapDecision, type DockShape, type DockState, type DockStorage } from "./share_dock.ts";
import { isPreviewablePath } from "./preview_tabs.ts";
import type { ApprovalScope, FleetStatusView, LaneEvent, LaneImage, LaneToolCode, LaneView, LucidBridge } from "./bridge.ts";
import { gitAuthHint, parseGitRemote, providerLabel } from "../git_url.ts";
import { laneRollup } from "../collab/fleet_status.ts"; // P-PWA-FLEET.2: order + wording + counts shared with the phone's fleet bar

/** The seven lane functions, typed straight off the bridge so the seam can never drift (results are
 *  nullable: getData/post resolve null on transport failure and the panel treats that as "offline"). */
type FleetFns = Pick<LucidBridge, "fleetStatus" | "fleetSpawn" | "fleetPrompt" | "fleetRetry" | "fleetRespawn" | "fleetQueueAdd" | "fleetQueueRemove" | "fleetQueueMove" | "fleetDrain" | "fleetAnswer" | "fleetAuto" | "fleetCancel" | "fleetStop" | "fleetSetModel" | "interject">;
type FleetResources = FleetStatusView["resources"];

export interface FleetGridDeps extends FleetFns {
  /** The master agent's current model - the default for a new lane. */
  getMasterModel: () => string;
  /** The model catalog for the per-lane pickers. */
  getModelOptions: () => { value: string; label?: string }[];
  /** The master agent's workspace folder - prefilled as a new lane's cwd. */
  getMasterCwd: () => string;
  /** The REAL OS folder dialog (app.ts pickFolderDialog: Electron dialog, else the local backend's
   *  Explorer/Finder/zenity, else the in-app browser). Resolves null on cancel - never re-prompt. */
  pickFolder: (opts?: { title?: string; confirm?: string }) => Promise<string | null>;
  /** Write a git token into the OS-encrypted vault under the ref for THIS host (git_url.gitCredRef).
   *  The plaintext never leaves the renderer except into main's safeStorage. */
  saveGitToken: (input: { host: string; token: string; label: string }) => Promise<{ ok: boolean; error?: string }>;
  /** Is the OS vault reachable at all (desktop shell)? A plain browser build can only use a token for the
   *  clone happening right now, so the form must say that rather than promise storage it cannot do. */
  vaultAvailable: () => boolean;
  /** P-PREVIEW.10: a lane wrote a browser-previewable file (html/svg) - surface it as that lane's own
   *  Preview panel tab. Optional and threaded from app.ts (like fleetAuto) so this module never imports
   *  the app shell; absent, previewable writes simply stay in the transcript. */
  previewLaneFile?: (laneId: string, laneName: string, path: string) => void;
}

const FLEET_DOCK_KEY = "lucid.fleetDock.v1";
const FLEET_DOCK_OPEN_KEY = "lucid.fleetDock.open";
const POLL_MS = 2500;
const UP_ARROW = `<svg class="sd-up" viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="M12 8l-6 7h12z" fill="currentColor"/></svg>`;

interface LaneTool { name: string; detail: string; code?: LaneToolCode }
interface LaneTurn { role: "user" | "assistant"; text: string; thinking?: string; tools?: LaneTool[]; error?: string; images?: string[] }
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
  /** P-FLEET.L3: images pasted into THIS lane's composer, waiting to ride the next send/stage. */
  attached: LaneImage[];
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
      <span class="fleet-headroom" id="fleetHeadroom" data-tip="Local headroom|Live CPU and memory. Lanes are UNLIMITED - a new one is refused only while a metric stays at or above the tick for 30 seconds straight, so a burst never blocks you."></span>
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
  dock.addEventListener("paste", onPaste); // P-FLEET.L3: paste an image into a lane composer
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
    pill = el(`<button id="fleetDockPill" class="share-dock-pill" aria-label="Restore the fleet panel">${icon("bolt", 12)}<span class="fleet-pips" data-fleet-pips></span>${UP_ARROW}</button>`);
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
/** The pill lives in the status bar, beside the share/join pills. `contains` first: re-appending an
 *  ALREADY-connected node detaches and reinserts it, which restarts its CSS animation - the pill would
 *  visibly blink every poll. */
function mountPill(): void {
  if (!pill) return;
  const host = document.getElementById("statusbar") ?? document.body;
  if (!host.contains(pill)) host.append(pill);
}
/** app.ts calls this straight after renderStatus() replaces the status bar's innerHTML, exactly as it
 *  re-adopts the trivia ticker and the share/join pills. Without it the minimized fleet pill was wiped by
 *  every status repaint and only came back on the next 2.5s poll: the lower-right flicker users saw while
 *  a lane was working. */
export function mountFleetPill(): void {
  if (dockState?.minimized) mountPill();
}

/** The minimized snapshot: one colored dot per state present, its lane COUNT beside it, and a hover that
 *  names the lanes - enough to keep working in the main window and still know a lane is blocked on you.
 *  Order, wording, and counting come from the shared `laneRollup` (P-PWA-FLEET.2), so this pill and the
 *  phone's collapsed fleet bar can never disagree; the dots reuse the cards' own `lane-<status>` classes,
 *  so neither can drift from the panel's colours either.
 *  The markup is compared before it is written, because an identical repaint every 2.5s is precisely what
 *  made the pulse animation stutter. */
function paintPill(): void {
  if (!pill) return;
  const roll = laneRollup([...runs.values()].map((r) => r.view));
  const box = $("[data-fleet-pips]", pill) as HTMLElement | null;
  if (box) {
    const html = roll.counts
      .map((c, i) => `<span class="fleet-pip lane-${c.status}" title="${esc(roll.lines[i] ?? "")}"><i aria-hidden="true"></i><b>${c.count}</b></span>`)
      .join("") || `<span class="fleet-pip lane-idle" title="No lanes running"><i aria-hidden="true"></i><b>0</b></span>`;
    if (box.innerHTML !== html) box.innerHTML = html;
  }
  const tip = roll.lines.length ? roll.lines.join(" \u00b7 ") : "no lanes running";
  pill.title = `LUCID Fleet - ${tip}. Click to reopen; lanes keep running either way.`;
  pill.classList.toggle("live", roll.busy);
  pill.classList.toggle("attn", roll.attention);
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
  if (dockState?.minimized) mountPill();
  const hr = dock ? $("#fleetHeadroom", dock) : null;
  if (!st) { if (hr) hr.innerHTML = `<span class="fleet-hr-off">fleet offline</span>`; return; }
  const grid = dock ? ($("#fleetGrid", dock) as HTMLElement | null) : null;
  const seen = new Set<string>();
  for (const lane of st.lanes) {
    seen.add(lane.id);
    let run = runs.get(lane.id);
    if (!run) {
      run = { view: lane, turns: [], pending: "", pendingThinking: "", pendingTools: [], streaming: false, collapsed: false, card: null, attached: [] };
      runs.set(lane.id, run);
    } else {
      run.view = lane; // the server is the source of truth on poll; stream events fill the gaps between
    }
    if (grid && !run.card) { run.card = buildCard(run); grid.append(run.card); paintOutput(run); }
    paintFrame(run);
    maybeDrain(run); // P-FLEET.L3: an idle lane with staged prompts runs the next one, streamed visibly
  }
  for (const [id, run] of [...runs]) {
    if (!seen.has(id)) { run.card?.remove(); runs.delete(id); } // lane fully gone (stopped lanes still list, dimmed)
  }
  if (hr) paintHeadroom(hr, st.resources, st.lanes.length);
  paintEmpty();
  paintPill();
}

/** The header HUD. There is no cap to show any more, so the numbers that matter are the two live percents
 *  and - when one of them is over the line - HOW LONG it has been over: `93% 12s/30s` is a burst you can
 *  ignore, `93% 31s/30s` is the refusal. */
function paintHeadroom(hr: HTMLElement, res: FleetResources, laneCount: number): void {
  const line = res.pressurePct;
  const sustainS = Math.max(1, Math.round(res.sustainMs / 1000));
  const bar = (lbl: string, v: number | null, held: number): string => {
    const head = `<span class="fleet-hr-lbl">${lbl}</span>`;
    if (v == null) return `${head}<span class="fleet-hr-bar" style="--wm:${line}%"></span><span class="fleet-hr-val">--</span>`;
    const p = Math.max(0, Math.min(100, Math.round(v)));
    const over = held >= res.sustainMs;
    const c = over ? "var(--red)" : p >= line ? "var(--amber)" : "var(--green)";
    const hot = p >= line
      ? `<span class="fleet-hr-hot${over ? " over" : ""}" title="${lbl} has held ${line}%+ for ${Math.round(held / 1000)}s. New lanes are refused at ${sustainS}s.">${Math.round(held / 1000)}s/${sustainS}s</span>`
      : "";
    return `${head}<span class="fleet-hr-bar" style="--wm:${line}%"><span class="fleet-hr-fill" style="width:${p}%;background:${c}"></span></span><span class="fleet-hr-val">${p}%</span>${hot}`;
  };
  const lanes = `<span class="fleet-hr-lanes" title="Lanes running. There is no cap: a lane is refused only while CPU or memory stays at or above ${line}% for ${sustainS}s straight, so a burst never blocks you.">${laneCount} lane${laneCount === 1 ? "" : "s"}</span>`;
  hr.innerHTML = bar("CPU", res.cpuPct, res.cpuHotMs) + bar("MEM", res.memPct, res.memHotMs) + lanes;
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
      <span class="fleet-quiet" data-fleet-quiet hidden></span>
      <select class="fleet-model" data-fleet-model aria-label="Lane model"></select>
      <button class="fleet-card-btn fleet-auto-btn" data-fleet-auto aria-label="Toggle full auto-mode" title="Full auto-mode: approve every ask automatically">${icon("bolt", 12)}</button>
      <button class="fleet-card-btn" data-fleet-checkin aria-label="Check in on this lane" title="Check in: status, turns, last activity, queue depth">${icon("eye", 12)}</button>
      <button class="fleet-card-btn" data-fleet-collapse aria-label="Collapse the lane card" title="Collapse (keeps the header)">${icon("minus", 12)}</button>
      <button class="fleet-card-btn" data-fleet-stop aria-label="Stop this lane" title="Stop the lane">${icon("close", 12)}</button>
    </div>
    <div class="fleet-card-main">
      <div class="fleet-out" data-fleet-out></div>
      <div class="fleet-approve" data-fleet-approve hidden>
        <span class="fleet-approve-txt" data-fleet-approve-txt></span>
        <span class="fleet-approve-acts">
          <button class="btn-mini ok" data-fleet-allow>${icon("check", 11)} Allow</button>
          <button class="btn-mini ok" data-fleet-allow-session title="Approve this ask and every same-kind ask for the rest of this lane's session">${icon("check", 11)} Session</button>
          <button class="btn-mini danger" data-fleet-deny>${icon("close", 11)} Deny</button>
        </span>
      </div>
      <div class="fleet-recover" data-fleet-recover hidden>
        <span class="fleet-recover-txt" data-fleet-recover-txt></span>
        <span class="fleet-approve-acts">
          <button class="btn-mini ok" data-fleet-retry>${icon("refresh", 11)} Retry</button>
          <button class="btn-mini" data-fleet-respawn>${icon("bolt", 11)} Respawn</button>
        </span>
      </div>
      <div class="fleet-queue" data-fleet-queue hidden></div>
      <div class="fleet-attach" data-fleet-attach hidden></div>
      <div class="fleet-compose">
        <textarea class="fleet-input" rows="1" data-fleet-input placeholder="Prompt this lane\u2026" spellcheck="false"></textarea>
        <button class="fleet-card-btn fleet-send" data-fleet-send aria-label="Send to this lane" title="Send">${icon("send", 13)}</button>
        <button class="btn-mini danger fleet-cancel" data-fleet-cancel hidden>${icon("close", 11)} Cancel</button>
      </div>
    </div>
  </div>`);
}

/** Repaint everything on the card EXCEPT the output stream: the status frame (class + LED + border), the
 *  labels, the model pick, the approval bar, the recovery bar, the quiet chip, and the compose row's
 *  enable/cancel state. Never touches the textarea's value, and never rebuilds a focused select - polls
 *  must not eat what the user is doing. */
function paintFrame(run: LaneRun): void {
  const card = run.card; if (!card) return;
  const v = run.view;
  card.className = `fleet-card lane-${v.status}`;
  const name = $("[data-fleet-name]", card) as HTMLElement | null;
  if (name) {
    name.textContent = v.name || v.id;
    name.title = `${v.name || v.id} \u00b7 ${v.status} \u00b7 ${v.turns} turns${v.respawns ? ` \u00b7 respawned ${v.respawns}\u00d7, memory carried` : ""}`;
  }
  const cwd = $("[data-fleet-cwd]", card) as HTMLElement | null;
  if (cwd) { cwd.textContent = baseName(v.cwd); cwd.title = v.cwd; }
  // P-FLEET.L4: lanes have NO turn clock, so a long silent stretch must be LEGIBLE instead of fatal.
  const quiet = $("[data-fleet-quiet]", card) as HTMLElement | null;
  if (quiet) {
    const quietMs = v.status === "working" ? Date.now() - v.lastActivityAt : 0;
    quiet.hidden = quietMs <= 90_000;
    if (quietMs > 90_000) {
      const m = Math.floor(quietMs / 60_000);
      quiet.textContent = m >= 1 ? `quiet ${m}m` : `quiet ${Math.round(quietMs / 1000)}s`;
      quiet.title = `Nothing has streamed for ${Math.round(quietMs / 1000)}s. Long turns run to completion (no lane clock) - Cancel is yours whenever you want it.`;
    }
  }
  const sel = $("[data-fleet-model]", card) as HTMLSelectElement | null;
  if (sel && document.activeElement !== sel) fillModelSelect(sel, v.model);
  // Full auto-mode: the bolt is lit while ON; the title carries the state so hover always explains it.
  const auto = $("[data-fleet-auto]", card) as HTMLButtonElement | null;
  if (auto) {
    auto.classList.toggle("auto-on", v.autoApprove);
    auto.title = v.autoApprove
      ? "Full auto-mode is ON - every ask is approved automatically. Click to turn it off."
      : "Full auto-mode: approve every ask automatically";
  }
  const main = $(".fleet-card-main", card) as HTMLElement | null;
  if (main) main.hidden = run.collapsed;
  const ap = $("[data-fleet-approve]", card) as HTMLElement | null;
  if (ap) {
    ap.hidden = v.status !== "needs-approval";
    const txt = $("[data-fleet-approve-txt]", card) as HTMLElement | null;
    if (txt) { const s = v.pendingApproval?.summary ?? "The lane asks to run a gated action."; txt.textContent = s; txt.title = v.pendingApproval?.kind ? `${s} (${v.pendingApproval.kind})` : s; }
  }
  // P-FLEET.L4: error is a state, not a grave. Retry re-sends the last prompt (error lanes with one);
  // Respawn revives in place. A user-STOPPED lane gets Respawn only - stopping was a decision.
  const rec = $("[data-fleet-recover]", card) as HTMLElement | null;
  if (rec) {
    const show = (v.status === "error" || v.status === "stopped") && !run.streaming;
    rec.hidden = !show;
    if (show) {
      const txt = $("[data-fleet-recover-txt]", card) as HTMLElement | null;
      const msg = v.status === "error"
        ? "The lane failed. Retry re-sends the last prompt; either way its memory is carried."
        : "Lane stopped. Respawn revives it in place with its memory.";
      if (txt) { txt.textContent = msg; txt.title = msg; }
      const retry = $("[data-fleet-retry]", card) as HTMLButtonElement | null;
      if (retry) retry.hidden = v.status !== "error" || !v.canRetry;
    }
  }
  // P-FLEET.L3: the staged-prompt strip - one compact chip per queued prompt, in run order, each with
  // reorder/delete + Push now (P-INTERJECT.2: interject the RUNNING turn instead of waiting for idle).
  // Chips ellipsize on one line (invariant 11); the queue itself lives in the manager.
  const q = $("[data-fleet-queue]", card) as HTMLElement | null;
  if (q) {
    q.hidden = v.queued.length === 0;
    const html = v.queued
      .map((item, i) => `<span class="fleet-q-chip"><b>${i + 1}</b><span class="fleet-q-txt" title="${esc(item.text)}">${esc(item.text)}${item.images ? ` [${item.images} img]` : ""}</span><button class="fleet-q-btn fleet-q-push" data-q-go="${i}" title="Push now - interject this into the running turn instead of waiting" aria-label="Push staged prompt ${i + 1} into the running turn now">Push now</button><button class="fleet-q-btn" data-q-up="${i}" title="Run earlier" aria-label="Move staged prompt ${i + 1} up" ${i === 0 ? "disabled" : ""}>\u2191</button><button class="fleet-q-btn" data-q-dn="${i}" title="Run later" aria-label="Move staged prompt ${i + 1} down" ${i === v.queued.length - 1 ? "disabled" : ""}>\u2193</button><button class="fleet-q-btn" data-q-x="${i}" title="Remove" aria-label="Remove staged prompt ${i + 1}">\u00d7</button></span>`)
      .join("");
    if (q.innerHTML !== html) q.innerHTML = html;
  }
  const cancel = $("[data-fleet-cancel]", card) as HTMLElement | null;
  if (cancel) cancel.hidden = !(run.streaming || v.status === "working");
  const send = $("[data-fleet-send]", card) as HTMLButtonElement | null;
  if (send) {
    // P-FLEET.L3: a busy lane's Send becomes STAGE - never disabled mid-turn, because parking the next
    // thought is exactly what the user wants to do while a compact card streams.
    const staging = run.streaming || v.status === "working" || v.status === "needs-approval";
    send.disabled = v.status === "stopped";
    send.title = staging ? "Stage for later - runs in order when this lane goes idle" : "Send";
    send.classList.toggle("staging", staging);
  }
  const input = $("[data-fleet-input]", card) as HTMLTextAreaElement | null;
  if (input) {
    input.disabled = v.status === "stopped";
    input.placeholder = run.streaming || v.status === "working" ? "Stage the next prompt\u2026" : "Prompt this lane\u2026";
  }
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

/** P-FLEET.L3: the diffstat for a tool's authored code - added/removed line counts, the same signal the
 *  master's P-CHAT.B chips carry. A write counts all lines added; a patch is uncounted (shown raw). */
function diffStat(code: LaneToolCode): { added: number; removed: number } | null {
  if (typeof code.oldText === "string" || typeof code.newText === "string") {
    const removed = code.oldText ? code.oldText.split("\n").length : 0;
    const added = code.newText ? code.newText.split("\n").length : 0;
    return { added, removed };
  }
  if (typeof code.content === "string") return { added: code.content ? code.content.split("\n").length : 0, removed: 0 };
  return null;
}

/** P-FLEET.L3: the expandable body under a diff chip - old lines prefixed `-`, new prefixed `+`, a
 *  write's content prefixed `+`, a hashline patch shown raw. Escaped text in a <pre>; never markdown. */
function diffBody(code: LaneToolCode): string {
  if (typeof code.patch === "string") return esc(code.patch);
  const minus = (code.oldText ?? "").split("\n").filter((l, i, a) => l || i < a.length - 1).map((l) => `- ${l}`);
  const plus = ((code.newText ?? code.content) ?? "").split("\n").filter((l, i, a) => l || i < a.length - 1).map((l) => `+ ${l}`);
  return esc([...minus, ...plus].join("\n"));
}

function toolLine(t: LaneTool): string {
  const base = `${icon("command", 10)}<b>${esc(t.name)}</b><span class="fleet-tool-detail">${esc(t.detail.slice(0, 120))}</span>`;
  if (!t.code) return `<div class="fleet-tool">${base}</div>`;
  // A write/edit gets a DIFF CHIP: the +/- counts inline, the hunk one click away, exactly the master's
  // chip pattern scaled to a mini window. Lives in the module transcript, so a reopened card keeps it.
  const stat = diffStat(t.code);
  const chip = stat
    ? `<span class="fleet-diffstat"><ins>+${stat.added}</ins><del>-${stat.removed}</del></span>`
    : `<span class="fleet-diffstat"><ins>patch</ins></span>`;
  const file = t.code.path ? `<span class="fleet-diff-path" title="${esc(t.code.path)}">${esc(baseName(t.code.path))}</span>` : "";
  return `<details class="fleet-diff"><summary class="fleet-tool">${base}${file}${chip}</summary><pre class="fleet-diff-pre">${diffBody(t.code)}</pre></details>`;
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
    ? `<div class="fleet-turn-user" title="${esc(t.text)}">${(t.images ?? []).map((src) => `<img class="fleet-thumb" src="${src}" alt="pasted image" />`).join("")}${esc(t.text)}</div>`
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
    case "tool":
      run.pendingTools.push({ name: e.name, detail: e.detail, ...(e.code ? { code: e.code } : {}) });
      paintOutput(run);
      // P-PREVIEW.10: a previewable write (html/svg) earns the lane its own Preview panel tab.
      if (e.code?.path && isPreviewablePath(e.code.path)) deps?.previewLaneFile?.(run.view.id, run.view.name || run.view.id, e.code.path);
      break;
    case "permission":
      run.view.status = "needs-approval";
      run.view.pendingApproval = { summary: e.summary, kind: e.kind };
      paintFrame(run); paintPill();
      break;
    case "auto-approved":
      // Rides the tool-chip render path: the transcript shows WHAT was auto-granted and by which mode.
      run.pendingTools.push({ name: e.mode === "auto" ? "auto-approved" : "session-approved", detail: e.summary });
      paintOutput(run);
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

/** Send or STAGE: a busy lane cannot take a second turn (one turn per lane, the ADR-0268 lesson), so the
 *  same button stages the prompt into the manager-owned queue instead - it runs, in order, when the lane
 *  goes idle. Pasted images ride either path. */
function sendPrompt(run: LaneRun): void {
  if (!deps) return;
  const input = run.card ? ($("[data-fleet-input]", run.card) as HTMLTextAreaElement | null) : null;
  const text = input?.value.trim() ?? "";
  const images = run.attached.slice();
  if (!text && !images.length) return;
  const id = run.view.id;
  if (run.streaming || run.view.status === "working" || run.view.status === "needs-approval") {
    void deps.fleetQueueAdd(id, text, images).then((r) => {
      if (!r?.ok) { onLaneEvent(id, { type: "error", message: r?.reason ?? "could not stage the prompt" }); return; }
      if (input) { input.value = ""; input.style.height = ""; }
      run.attached = [];
      run.view.queued = [...run.view.queued, { text: text.length > 140 ? `${text.slice(0, 140)}\u2026` : text, images: images.length }];
      paintFrame(run); paintAttach(run);
    });
    return;
  }
  if (input) { input.value = ""; input.style.height = ""; }
  run.attached = [];
  run.turns.push({ role: "user", text, ...(images.length ? { images: images.map((im) => `data:${im.mimeType};base64,${im.data}`) } : {}) });
  run.pending = ""; run.pendingThinking = ""; run.pendingTools = [];
  run.streaming = true;
  run.view.status = "working"; // optimistic; the stream's status events correct it
  paintFrame(run); paintOutput(run); paintAttach(run); paintPill();
  void deps.fleetPrompt(id, text, (e) => onLaneEvent(id, e), images)
    .catch((err: unknown) => onLaneEvent(id, { type: "error", message: err instanceof Error ? err.message : String(err) }))
    .finally(() => { run.streaming = false; foldPending(run); paintFrame(run); paintOutput(run); paintPill(); maybeDrain(run); });
}

/** P-FLEET.L3: run the next STAGED prompt when the lane is idle - streamed into the card like any turn.
 *  Guarded so only one drain fires per lane; approvals still glow and wait for a human mid-drain. */
function maybeDrain(run: LaneRun): void {
  if (!deps || run.streaming) return;
  if (!run.view.queued.length) return;
  if (run.view.status !== "awaiting-input" && run.view.status !== "done") return;
  const id = run.view.id;
  const next = run.view.queued[0]!;
  run.view.queued = run.view.queued.slice(1);
  run.turns.push({ role: "user", text: next.text + (next.images ? ` [${next.images} image${next.images === 1 ? "" : "s"}]` : "") });
  run.pending = ""; run.pendingThinking = ""; run.pendingTools = [];
  run.streaming = true;
  run.view.status = "working";
  paintFrame(run); paintOutput(run); paintPill();
  void deps.fleetDrain(id, (e) => onLaneEvent(id, e))
    .catch((err: unknown) => onLaneEvent(id, { type: "error", message: err instanceof Error ? err.message : String(err) }))
    .finally(() => { run.streaming = false; foldPending(run); paintFrame(run); paintOutput(run); paintPill(); maybeDrain(run); });
}

/** The pasted-image strip above the composer: thumbnails with an x each, cleared on send/stage. */
function paintAttach(run: LaneRun): void {
  const card = run.card; if (!card) return;
  const strip = $("[data-fleet-attach]", card) as HTMLElement | null; if (!strip) return;
  strip.hidden = run.attached.length === 0;
  strip.innerHTML = run.attached
    .map((im, i) => `<span class="fleet-attach-item"><img class="fleet-thumb" src="data:${im.mimeType};base64,${im.data}" alt="pasted image ${i + 1}" /><button class="fleet-attach-x" data-attach-x="${i}" title="Remove this image" aria-label="Remove pasted image ${i + 1}">${icon("close", 9)}</button></span>`)
    .join("");
}

/** Retry the last turn: streams like sendPrompt but pushes NO new user turn - the transcript already
 *  shows the prompt from the failed attempt; only the fresh reply is new. */
function runRetry(run: LaneRun): void {
  if (!deps || run.streaming) return;
  run.pending = ""; run.pendingThinking = ""; run.pendingTools = [];
  run.streaming = true;
  run.view.status = "working"; // optimistic; the stream's status events correct it
  paintFrame(run); paintOutput(run); paintPill();
  const id = run.view.id;
  void deps.fleetRetry(id, (e) => onLaneEvent(id, e))
    .catch((err: unknown) => onLaneEvent(id, { type: "error", message: err instanceof Error ? err.message : String(err) }))
    .finally(() => { run.streaming = false; foldPending(run); paintFrame(run); paintOutput(run); paintPill(); });
}

/** Respawn in place (memory carried); the returned view or the next poll repaints the frame. */
function runRespawn(run: LaneRun): void {
  if (!deps) return;
  run.view.status = "starting"; paintFrame(run); paintPill();
  void deps.fleetRespawn(run.view.id)
    .then((r) => { if (r?.ok && r.lane) { run.view = r.lane; } paintFrame(run); paintOutput(run); paintPill(); })
    .catch(() => { /* the next poll corrects it */ });
}

function answer(run: LaneRun, allow: boolean, scope?: ApprovalScope): void {
  if (!deps) return;
  run.view.pendingApproval = undefined;
  run.view.status = "working"; // optimistic; the lane's status events / next poll correct it
  paintFrame(run); paintPill();
  void deps.fleetAnswer(run.view.id, allow, scope).catch(() => { /* the next poll re-surfaces it */ });
}

/** Auto-mode toggle: turning OFF is immediate (optimistic, the poll is truth); turning ON always routes
 *  through the risk modal - the acceptance is explicit every time the switch is thrown. */
function toggleAuto(run: LaneRun): void {
  if (!deps) return;
  if (run.view.autoApprove) {
    run.view.autoApprove = false; paintFrame(run);
    void deps.fleetAuto({ laneId: run.view.id, on: false }).catch(() => { /* the next poll corrects it */ });
    return;
  }
  openAutoRiskModal(run);
}

/** The full auto-mode risk gate (the app.ts first-open modal pattern; classes are global). Esc and Cancel
 *  close without action; Accept sends acceptRisk: true, which the server persists as the risk timestamp.
 *  The checkbox widens the switch to ALL lanes, including ones spawned later. */
function openAutoRiskModal(run: LaneRun): void {
  const ov = el(`<div class="modal-ov" id="fleetAutoRisk">
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="fleetAutoRiskTitle">
      <div class="modal-icon">${icon("bolt", 24)}</div>
      <h2 class="modal-title" id="fleetAutoRiskTitle">Enable full auto-mode?</h2>
      <p class="modal-desc">Every approval this lane asks for - commands, file edits, network access - will be granted automatically, without asking you.</p>
      <p class="modal-desc">LUCID's security gate still scans every tool call and quarantines suspicious content. Auto-mode removes the human approval step only.</p>
      <p class="modal-desc">By enabling it you accept the risk of the commands the agent chooses to run.</p>
      <label class="fleet-auto-all"><input type="checkbox" data-auto-all /><span>Apply to all lanes, including new ones</span></label>
      <div class="modal-actions">
        <button class="btn-mini" type="button" data-auto-cancel>Cancel</button>
        <button class="btn-mini danger" type="button" data-auto-accept>${icon("bolt", 12)} Accept risk and enable</button>
      </div>
    </div></div>`);
  const close = (): void => { window.removeEventListener("keydown", onEsc, true); ov.remove(); };
  const onEsc = (e: KeyboardEvent): void => {
    // Capture + stopPropagation: the dock's own Escape-minimizes handler must not also fire.
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
  };
  window.addEventListener("keydown", onEsc, true);
  $("[data-auto-cancel]", ov)?.addEventListener("click", close);
  $("[data-auto-accept]", ov)?.addEventListener("click", () => {
    const allLanes = ($("[data-auto-all]", ov) as HTMLInputElement | null)?.checked ?? false;
    void deps?.fleetAuto({ ...(allLanes ? {} : { laneId: run.view.id }), on: true, acceptRisk: true })
      .then((r) => {
        if (!r?.ok) return; // no toast surface in this module - the next poll re-states the truth
        const targets = allLanes ? [...runs.values()] : [run];
        for (const t of targets) { t.view.autoApprove = true; paintFrame(t); }
      })
      .catch(() => { /* the next poll corrects it */ });
    close();
  });
  document.body.appendChild(ov);
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
      <label class="fleet-spawn-lbl" data-spawn-cwd-lbl>Folder</label>
      <div class="fleet-spawn-row">
        <input class="fleet-spawn-in" data-spawn-cwd type="text" value="${esc(deps.getMasterCwd())}" spellcheck="false" aria-label="The folder this lane works in" />
        <button class="btn-mini fleet-browse" data-spawn-browse title="Open the OS folder dialog - browse anywhere on this machine, or create a new folder">${icon("folder", 12)} Browse</button>
      </div>
      <label class="fleet-spawn-lbl">Repo URL <span class="fleet-spawn-opt">optional</span></label>
      <input class="fleet-spawn-in" data-spawn-repo type="text" spellcheck="false" autocomplete="off" aria-label="A GitHub, GitLab or Azure DevOps repository URL to clone" placeholder="https://github.com/org/repo.git or git@github.com:org/repo.git" />
      <div class="fleet-spawn-note" data-spawn-repo-note hidden></div>
      <div class="fleet-spawn-auth" data-spawn-auth hidden>
        <input class="fleet-spawn-in" data-spawn-pat type="password" autocomplete="off" spellcheck="false" aria-label="Personal access token for this repository host" placeholder="Personal access token (private repos)" />
        <label class="fleet-spawn-save"><input type="checkbox" data-spawn-save checked /><span data-spawn-save-txt>Remember this token for this host</span></label>
      </div>
      <label class="fleet-spawn-lbl">Name <span class="fleet-spawn-opt">optional</span></label>
      <input class="fleet-spawn-in" data-spawn-name type="text" placeholder="lane-${runs.size + 1}" spellcheck="false" aria-label="A name for this lane" />
      <label class="fleet-spawn-lbl">Model</label>
      <select class="fleet-spawn-in" data-spawn-model aria-label="The model this lane runs">${opts}</select>
      <div class="fleet-spawn-err" data-spawn-err hidden></div>
      <div class="fleet-spawn-acts"><button class="btn-mini ok" data-spawn-go>${icon("bolt", 12)} Spawn</button></div>
    </div>
  </div>`);
  grid.prepend(form);
  paintEmpty();
  paintRepoHint(form);
  ($("[data-spawn-cwd]", form) as HTMLInputElement | null)?.focus();
}

/** The REAL OS dialog (Explorer / Finder / zenity), where the user can also CREATE the folder. A cancel
 *  resolves null and must leave whatever is already typed alone - never clear the field, never re-prompt. */
async function browseSpawnFolder(): Promise<void> {
  if (!dock || !deps) return;
  const form = $(".fleet-spawn-card", dock) as HTMLElement | null; if (!form) return;
  const picked = await deps.pickFolder({ title: "Choose or create the folder this lane works in", confirm: "Use this folder" }).catch(() => null);
  if (!picked) return;
  const input = $("[data-spawn-cwd]", form) as HTMLInputElement | null;
  if (input) input.value = picked;
  paintRepoHint(form);
}

/** Live feedback under the repo field: what was recognized, where the clone will land, and which credential
 *  that remote actually needs. An ssh remote HIDES the token row entirely - it authenticates with keys, and
 *  asking for a PAT there would be a lie the user then debugs for twenty minutes. */
function paintRepoHint(form: HTMLElement): void {
  const raw = ($("[data-spawn-repo]", form) as HTMLInputElement | null)?.value.trim() ?? "";
  const note = $("[data-spawn-repo-note]", form) as HTMLElement | null;
  const auth = $("[data-spawn-auth]", form) as HTMLElement | null;
  const lbl = $("[data-spawn-cwd-lbl]", form) as HTMLElement | null;
  const remote = raw ? parseGitRemote(raw) : null;
  if (lbl) lbl.textContent = remote ? "Clone into" : "Folder";
  const hide = (): void => { if (note) { note.hidden = true; note.textContent = ""; } if (auth) auth.hidden = true; };
  if (!raw) { hide(); return; }
  if (!remote) {
    if (auth) auth.hidden = true;
    if (note) { note.hidden = false; note.className = "fleet-spawn-note bad"; note.textContent = "Not a repo URL. Paste an https:// link, or a git@host:org/repo remote."; }
    return;
  }
  const parent = ($("[data-spawn-cwd]", form) as HTMLInputElement | null)?.value.trim() || "the shared LUCID workspaces folder";
  if (note) {
    note.hidden = false;
    note.className = "fleet-spawn-note";
    note.textContent = `${providerLabel(remote.provider)}: ${remote.owner ? `${remote.owner}/` : ""}${remote.repo} - clones into ${parent}, reusing it if already there. ${gitAuthHint(remote)}`;
  }
  if (auth) auth.hidden = remote.scheme !== "https";
  const vault = deps?.vaultAvailable() === true;
  const saveTxt = $("[data-spawn-save-txt]", form) as HTMLElement | null;
  if (saveTxt) saveTxt.textContent = vault ? `Remember this token for ${remote.host}, encrypted by this machine` : "This build cannot store tokens - it will be used for this clone only";
  const save = $("[data-spawn-save]", form) as HTMLInputElement | null;
  if (save) { save.disabled = !vault; if (!vault) save.checked = false; }
}

async function submitSpawn(): Promise<void> {
  if (!dock || !deps) return;
  const form = $(".fleet-spawn-card", dock) as HTMLElement | null; if (!form) return;
  const cwd = ($("[data-spawn-cwd]", form) as HTMLInputElement | null)?.value.trim() ?? "";
  const name = ($("[data-spawn-name]", form) as HTMLInputElement | null)?.value.trim() ?? "";
  const model = ($("[data-spawn-model]", form) as HTMLSelectElement | null)?.value ?? "";
  const repoRaw = ($("[data-spawn-repo]", form) as HTMLInputElement | null)?.value.trim() ?? "";
  const patInput = $("[data-spawn-pat]", form) as HTMLInputElement | null;
  const pat = patInput?.value ?? "";
  const remember = ($("[data-spawn-save]", form) as HTMLInputElement | null)?.checked === true;
  const err = $("[data-spawn-err]", form) as HTMLElement | null;
  const fail = (msg: string): void => { if (err) { err.textContent = msg; err.hidden = false; } };
  const remote = repoRaw ? parseGitRemote(repoRaw) : null;
  if (repoRaw && !remote) { fail("That is not a repo URL. Paste an https:// link, or a git@host:org/repo remote."); return; }
  if (!repoRaw && !cwd) { fail("Pick the folder the lane works in, or paste a repo URL to clone."); return; }
  const go = $("[data-spawn-go]", form) as HTMLButtonElement | null;
  const goHtml = go?.innerHTML ?? "";
  if (err) err.hidden = true;
  // A clone can take minutes on a big repo, so the button says which phase we are in rather than just dying.
  if (go) { go.disabled = true; go.innerHTML = remote ? `${icon("git", 12)} Cloning\u2026` : `${icon("bolt", 12)} Spawning\u2026`; }
  // The token is vaulted BEFORE the clone (a slow clone must not be able to lose it) and always under the
  // HOST it was typed for - never a global "git token" any other remote could reach for. Failing to STORE it
  // is a warning, not a stop: the inline copy still authenticates this clone.
  let warn = "";
  if (remote && remote.scheme === "https" && pat && remember) {
    const s = await deps.saveGitToken({ host: remote.host, token: pat, label: `${providerLabel(remote.provider)} token (${remote.host})` })
      .catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    if (!s.ok) warn = `Token not saved (${s.error ?? "vault unavailable"}) - used for this clone only.`;
  }
  const r = await deps.fleetSpawn({
    cwd,
    model: model || undefined,
    name: name || undefined,
    ...(remote ? { repoUrl: repoRaw } : {}),
    ...(remote && pat ? { pat } : {}),
  }).catch((e: unknown) => ({ ok: false, reason: e instanceof Error ? e.message : String(e) }));
  if (patInput) patInput.value = ""; // never leave the plaintext sitting in the DOM
  if (r?.ok) { form.remove(); paintEmpty(); await refresh(); return; }
  if (go) { go.disabled = false; go.innerHTML = goHtml; }
  // A refusal carries the measured numbers ("system CPU has been at 93% for 34s") or the redacted git
  // failure - show it verbatim, it is the whole point of the guard.
  fail([warn, r?.reason || "The engine refused the lane."].filter(Boolean).join(" "));
}

// ---------------------------------------------------------------- delegated events

function onClick(ev: Event): void {
  const t = ev.target as HTMLElement;
  if (t.closest("[data-fleet-close]")) { closeFleetGrid(); return; }
  if (t.closest("[data-dock-min]")) { minimize(); return; }
  if (t.closest("[data-fleet-add]")) { toggleSpawnForm(); return; }
  if (t.closest("[data-spawn-go]")) { void submitSpawn(); return; }
  if (t.closest("[data-spawn-cancel]")) { toggleSpawnForm(); return; }
  if (t.closest("[data-spawn-browse]")) { void browseSpawnFolder(); return; }
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
  if (t.closest("[data-fleet-allow-session]")) { answer(run, true, "session"); return; }
  if (t.closest("[data-fleet-auto]")) { toggleAuto(run); return; }
  if (t.closest("[data-fleet-allow]")) { answer(run, true); return; }
  if (t.closest("[data-fleet-deny]")) { answer(run, false); return; }
  if (t.closest("[data-fleet-retry]")) { runRetry(run); return; }
  if (t.closest("[data-fleet-respawn]")) { runRespawn(run); return; }
  // P-INTERJECT.2/.3: the per-lane Check in card + its actions (before the generic chip handlers so
  // clicks inside the card never fall through to them).
  if (t.closest("[data-fleet-checkin]")) { toggleLaneCheckin(run); return; }
  if (t.closest("[data-fleet-ck-x]")) { $("[data-fleet-checkin-card]", card)?.remove(); return; }
  const ask = t.closest("[data-fleet-ask]") as HTMLButtonElement | null;
  if (ask) {
    ask.disabled = true; ask.textContent = "Sent - answers at the next tool boundary";
    void deps.interject(run.view.id, LANE_STATUS_ASK).catch(() => { /* the reply simply never lands */ });
    return;
  }
  const qgo = t.closest("[data-q-go]") as HTMLElement | null;
  if (qgo) {
    const i = Number(qgo.dataset.qGo);
    const item = run.view.queued[i]; if (!item) return;
    run.view.queued = run.view.queued.filter((_, n) => n !== i); // optimistic; the poll is truth
    paintFrame(run);
    void deps.interject(run.view.id, item.text).catch(() => { /* the next poll corrects it */ });
    void deps.fleetQueueRemove(run.view.id, i).catch(() => { /* the next poll corrects it */ });
    return;
  }
  // P-FLEET.L3: the pasted-image strip and the staged-prompt chips.
  const ax = t.closest("[data-attach-x]") as HTMLElement | null;
  if (ax) { run.attached.splice(Number(ax.dataset.attachX), 1); paintAttach(run); return; }
  const qx = t.closest("[data-q-x]") as HTMLElement | null;
  if (qx) {
    const i = Number(qx.dataset.qX);
    run.view.queued = run.view.queued.filter((_, n) => n !== i); // optimistic; the poll is truth
    paintFrame(run);
    void deps.fleetQueueRemove(run.view.id, i).catch(() => { /* the next poll corrects it */ });
    return;
  }
  const qup = t.closest("[data-q-up]") as HTMLElement | null;
  const qdn = t.closest("[data-q-dn]") as HTMLElement | null;
  if (qup || qdn) {
    const i = Number((qup ?? qdn)!.dataset[qup ? "qUp" : "qDn"]);
    const dir: -1 | 1 = qup ? -1 : 1;
    const to = i + dir;
    if (to >= 0 && to < run.view.queued.length) {
      const next = run.view.queued.slice();
      const [item] = next.splice(i, 1);
      next.splice(to, 0, item!);
      run.view.queued = next; // optimistic; the poll is truth
      paintFrame(run);
      void deps.fleetQueueMove(run.view.id, i, dir).catch(() => { /* the next poll corrects it */ });
    }
    return;
  }
}

// P-INTERJECT.3: the per-lane Check in card - a compact snapshot inline in the lane body (status, turns,
// last activity, queue depth; one block element per line) + a canned status ask routed as an interject.
const LANE_STATUS_ASK = "Please give a brief status update: what is finished, what you are doing now, what remains. Then continue.";
function toggleLaneCheckin(run: LaneRun): void {
  const card = run.card; if (!card) return;
  const old = $("[data-fleet-checkin-card]", card); if (old) { old.remove(); return; }
  const v = run.view;
  const secs = Math.max(0, Math.round((Date.now() - v.lastActivityAt) / 1000));
  const ck = el(`<div class="fleet-checkin" data-fleet-checkin-card>
    <div class="fleet-ck-line" data-ck-status></div>
    <div class="fleet-ck-line" data-ck-turns></div>
    <div class="fleet-ck-line" data-ck-act></div>
    <div class="fleet-ck-line" data-ck-queue></div>
    <div class="fleet-ck-acts"><button class="btn-mini" data-fleet-ask>${icon("send", 11)} Ask for status</button><button class="btn-mini" data-fleet-ck-x>${icon("close", 11)} Close</button></div>
  </div>`);
  ($("[data-ck-status]", ck) as HTMLElement).textContent = `Status: ${v.status}`;
  ($("[data-ck-turns]", ck) as HTMLElement).textContent = `Turns: ${v.turns}`;
  ($("[data-ck-act]", ck) as HTMLElement).textContent = `Last activity: ${secs}s ago`;
  ($("[data-ck-queue]", ck) as HTMLElement).textContent = `Queue depth: ${v.queued.length}`;
  ($(".fleet-card-main", card) as HTMLElement | null)?.prepend(ck);
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

/** P-FLEET.L3: paste an image into a lane composer - the master chat's paste-to-thumbnail, per card.
 *  Text pastes fall through untouched; only image clipboard items are captured. Cap 6, like /api/chat. */
function onPaste(ev: Event): void {
  const e = ev as ClipboardEvent;
  const t = e.target as HTMLElement;
  if (!(t instanceof HTMLTextAreaElement) || !t.matches("[data-fleet-input]")) return;
  const card = t.closest(".fleet-card[data-lane]") as HTMLElement | null;
  const run = card ? runs.get(card.dataset.lane ?? "") : null;
  if (!run) return;
  const items = [...(e.clipboardData?.items ?? [])].filter((it) => it.kind === "file" && it.type.startsWith("image/"));
  if (!items.length) return;
  e.preventDefault();
  for (const it of items) {
    if (run.attached.length >= 6) break;
    const file = it.getAsFile();
    if (!file) continue;
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result ?? "");
      const comma = url.indexOf(",");
      if (comma < 0) return;
      if (run.attached.length >= 6) return;
      run.attached.push({ mimeType: file.type, data: url.slice(comma + 1) });
      paintAttach(run);
    };
    reader.readAsDataURL(file);
  }
}

function onInput(ev: Event): void {
  const t = ev.target;
  if (t instanceof HTMLTextAreaElement && t.matches("[data-fleet-input]")) {
    t.style.height = "auto";
    t.style.height = `${Math.min(64, t.scrollHeight)}px`; // 1-2 rows, grows to a small cap
    return;
  }
  // Typing a remote (or changing the destination) re-derives the provider, the clone path, and whether a
  // token is even relevant, so the form never asks for the wrong credential.
  if (t instanceof HTMLInputElement && (t.matches("[data-spawn-repo]") || t.matches("[data-spawn-cwd]"))) {
    const form = t.closest(".fleet-spawn-card") as HTMLElement | null;
    if (form) paintRepoHint(form);
  }
}
