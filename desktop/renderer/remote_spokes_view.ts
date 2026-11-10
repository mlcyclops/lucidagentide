// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/remote_spokes_view.ts - P-RS-VIEW.1 (ADR-0533): the Remote spokes view.
//
// Remote spokes are other machines, and the Fleet Orbit is a map of work. Before this view every remote spoke the
// hub knew sat on the orbit's ring whether it was doing anything or not, and the plugin's own panel (setup, presence,
// custody, models, relays) opened as one more Preview tab. This view gives them one place of their own, opened from
// the left rail like Knowledge or Meetings:
//
//   Spokes  every spoke the hub holds, grouped Working (holding a task: also on the orbit), No task and Deactivated,
//           the hub's alert list, and on the right the picked spoke's panel (tasks, parked actions, models,
//           recall) or the Start-a-task selector. Both are orbit_remote.ts's own panels, so every untrusted-text,
//           scope and two-click rule there holds here unchanged.
//   Admin   a launcher for the remote-spokes plugin's own panel, which opens in a window of its own
//           (remote_admin_launch.ts, ADR-0537).
//
// The view and the orbit share orbit_remote.ts's one per-spoke panel state, so app.ts never lets both be open:
// opening either closes the other. The hub snapshot is shared too (refreshRemote is single-flight): this view polls
// it every 5 s while open, and every 30 s otherwise so the rail button can appear and badge what waits on you.

import { $ } from "./dom.ts";
import { esc } from "./format.ts";
import { icon } from "./icons.ts";
import {
  closeDeployPanel, closeRemotePanel, onDeployPanelClick, onRemoteChange, onRemoteHubClick, onRemotePanelClick, paintDeployPanel, paintRemotePanel,
  refreshDeployPanel, refreshRemote, refreshRemotePanel, remoteAlertListHtml, remoteCounts, remoteDeployVisible, remoteHubVisible, remoteSnapshot,
} from "./orbit_remote.ts";
import { onOrbit, REMOTE_TONE, remoteGlance, type RemoteSpokeView } from "./remote_spokes_model.ts";
import { adminLauncherHtml } from "./remote_admin_launch.ts";

/** The hub plugin's id (desktop/remote_spokes.ts REMOTE_SPOKES_PLUGIN, engine-side). */
export const REMOTE_SPOKES_PLUGIN = "remote-spokes";

export type RemoteViewTab = "spokes" | "admin";

/** Where to open the view: a tab, or one spoke on the Spokes tab. */
export interface RemoteViewTarget { tab?: RemoteViewTab; node?: string }

export interface RemoteViewDeps {
  /** app.ts's launchRemoteAdmin: open or bring forward the admin panel's own window (ADR-0537). */
  openAdmin: () => void;
  /** app.ts's close: the view, then the inspector and the rail's active mark. */
  close: () => void;
  /** The rail button: shown while the plugin is installed; `attention` is parked approvals plus open alerts. */
  paintRail: (visible: boolean, attention: number) => void;
}

const OPEN_POLL_MS = 5_000;
const IDLE_POLL_MS = 30_000;
const DETAIL_CLOSE = `<button class="orbit-ghost-x" data-rsv-detail-close data-tip="Close">${icon("close", 12)}</button>`;

let deps: RemoteViewDeps | null = null;
let root: HTMLElement | null = null;
let tab: RemoteViewTab = "spokes";
/** The right-hand pane: one spoke's panel, the Start-a-task selector, or nothing picked yet. */
let detail: { kind: "spoke"; node: string } | { kind: "deploy" } | null = null;
let openTimer: number | null = null;
/** The list markup last written. */
let listSig = "";

/** The view's shell, placed by app.ts beside the other right-edge surfaces. */
export function remoteViewHtml(): string {
  return `<aside class="kg rsv" id="remoteSpokes" hidden>
    <div class="resizer resizer-l" data-resize="remoteSpokes" data-tip="Drag to resize|Widen the view or collapse toward the chat" data-tip-side="left"></div>
    <div class="set-head">
      <div class="set-title" data-tip="Remote spokes|LUCID engines on your other machines, reached through this hub. The orbit shows only the ones working; every one is here.">${icon("link", 17)} Remote spokes <span class="set-sub" data-rsv-sub></span></div>
      <div class="kg-tools">
        <div class="rsv-tabs" role="tablist" aria-label="Remote spokes">
          <button class="rsv-tab on" role="tab" aria-selected="true" data-rsv-tab="spokes">Spokes</button>
          <button class="rsv-tab" role="tab" aria-selected="false" data-rsv-tab="admin" data-tip="Admin|The hub's own panel: add, approve and remove spokes, presence, custody, models, relays and licenses. It opens in a window of its own.">Admin</button>
        </div>
        <button class="btn-mini" data-rs-deploy hidden data-tip="Start a task on a remote spoke|Pick a spoke by how fast it answers, its models and its free lanes, then start a task there.">${icon("bolt", 13)} Start a task</button>
        <button class="btn-mini btn-icon" data-rsv-refresh data-tip="Refresh|Re-read the hub.">${icon("refresh", 14)}</button>
        <button class="set-close" data-rsv-close data-tip="Close">${icon("close", 16)}</button>
      </div>
    </div>
    <div class="rsv-main" data-rsv-spokes>
      <div class="rsv-list" data-rsv-list></div>
      <div class="rsv-detail" data-rsv-detail></div>
    </div>
    <div class="rsv-admin" data-rsv-admin hidden>${adminLauncherHtml()}</div>
  </aside>`;
}

export function initRemoteView(el: HTMLElement, d: RemoteViewDeps): void {
  root = el;
  deps = d;
  el.addEventListener("click", onClick);
  onRemoteChange(onSnapshot);
  void refreshRemote();
  window.setInterval(() => { if (!isRemoteViewOpen() && document.visibilityState === "visible") void refreshRemote(); }, IDLE_POLL_MS);
}

export function isRemoteViewOpen(): boolean {
  return root !== null && !root.hidden;
}

/** Show the view (app.ts has closed the orbit and the other right-edge surfaces). */
export function showRemoteView(at: RemoteViewTarget = {}): void {
  if (!root) return;
  root.hidden = false;
  if (at.node) pickSpoke(at.node);
  setTab(at.tab ?? (at.node ? "spokes" : tab));
  if (openTimer === null) openTimer = window.setInterval(() => void refreshRemote(), OPEN_POLL_MS);
  void refreshRemote();
}

/** Hide the view. The detail pane keeps no DOM, so a typed follow-up or a presence password field is not left behind. */
export function hideRemoteView(): void {
  if (!root || root.hidden) return;
  root.hidden = true;
  if (openTimer !== null) { window.clearInterval(openTimer); openTimer = null; }
  clearDetail();
}

// ----------------------------------------------------------------------------------------------- tabs

function setTab(next: RemoteViewTab): void {
  if (!root) return;
  tab = next;
  for (const b of root.querySelectorAll<HTMLElement>("[data-rsv-tab]")) {
    const on = b.dataset.rsvTab === next;
    b.classList.toggle("on", on);
    b.setAttribute("aria-selected", String(on));
  }
  ($("[data-rsv-spokes]", root) as HTMLElement).hidden = next !== "spokes";
  ($("[data-rsv-admin]", root) as HTMLElement).hidden = next !== "admin";
  paint();
}

// ------------------------------------------------------------------------------------------ painting

function onSnapshot(): void {
  const c = remoteCounts();
  deps?.paintRail(remoteHubVisible(), c.waiting + c.alerts);
  paint();
}

function paint(): void {
  if (!root || root.hidden) return;
  const snap = remoteSnapshot();
  const sub = !snap ? "" : !snap.available ? "not running" : `${snap.hub.label} \u00b7 ${snap.spokes.length} ${snap.spokes.length === 1 ? "spoke" : "spokes"}`;
  const subEl = $("[data-rsv-sub]", root) as HTMLElement;
  if (subEl.textContent !== sub) subEl.textContent = sub;
  ($("[data-rs-deploy]", root) as HTMLElement).hidden = !remoteDeployVisible();
  if (tab !== "spokes") return;
  // Compared with what was last written, not with innerHTML (the browser re-serializes it), so a poll that changes
  // nothing never replaces a row under the pointer.
  const html = listHtml();
  if (html !== listSig) { listSig = html; ($("[data-rsv-list]", root) as HTMLElement).innerHTML = html; }
  const box = $("[data-rsv-detail]", root) as HTMLElement;
  if (detail?.kind === "spoke") refreshRemotePanel(box);
  else if (detail?.kind === "deploy") refreshDeployPanel(box);
  else if (!box.firstChild) box.innerHTML = `<div class="orbit-ghosts-empty">Pick a spoke to see its tasks, parked actions, models and journal.</div>`;
}

/** One spoke as a row. The node id is NODE_RE-checked by the model; every spoke-written word goes through esc(). */
function rowHtml(s: RemoteSpokeView, now: number): string {
  const on = detail?.kind === "spoke" && detail.node === s.node;
  return `<button class="rsv-row rs-${REMOTE_TONE[s.state]}${on ? " on" : ""}" data-rs-open="${esc(s.node)}" title="${esc(s.label)} (${esc(s.node)})">
      <i class="orbit-led"></i>
      <span class="rsv-row-main"><b>${esc(s.label)}</b><small>${esc(remoteGlance(s, now))}</small><small class="rsv-row-model">${esc(s.models.default ?? "model not reported")}</small></span>
    </button>`;
}

function groupHtml(title: string, spokes: readonly RemoteSpokeView[], now: number): string {
  if (spokes.length === 0) return "";
  return `<div class="rs-sec-h"><span>${title} \u00b7 ${spokes.length}</span></div><div class="rsv-rows">${spokes.map((s) => rowHtml(s, now)).join("")}</div>`;
}

function listHtml(): string {
  const snap = remoteSnapshot();
  if (!snap) return `<div class="orbit-ghosts-empty">Asking the hub\u2026</div>`;
  if (!snap.available) {
    const btn = snap.plugin === "stopped"
      ? `<button class="btn-mini" data-rs-start>${icon("bolt", 12)} Start Remote Spokes</button>`
      : snap.plugin === "running" ? `<button class="btn-mini" data-rsv-admin-open>${icon("link", 12)} Set up in the admin panel</button>` : "";
    return `<div class="rsv-notice"><p class="rs-note">${esc(snap.reason)}</p>${btn}</div>`;
  }
  if (snap.spokes.length === 0) {
    return `<div class="rsv-notice"><p class="rs-note">This hub has no spokes yet.</p><button class="btn-mini" data-rsv-admin-open>${icon("plus", 12)} Add a spoke in the admin panel</button></div>`;
  }
  const now = Date.now();
  const working = snap.spokes.filter(onOrbit);
  // Online and free, offline, silent or still being checked: what they share is that no task is on them.
  const noTask = snap.spokes.filter((s) => !s.deactivated && !onOrbit(s));
  const off = snap.spokes.filter((s) => s.deactivated);
  return remoteAlertListHtml()
    + groupHtml("Working", working, now)
    + groupHtml("No task", noTask, now)
    + groupHtml("Deactivated", off, now)
    + (working.length === 0 ? `<p class="rs-note rsv-foot">No remote spoke holds a task, so none is on the Fleet Orbit. A spoke joins the orbit when it starts one.</p>` : "");
}

// -------------------------------------------------------------------------------------- the detail pane

function pickSpoke(node: string): void {
  if (!root) return;
  closeDeployPanel();
  detail = { kind: "spoke", node };
  paintRemotePanel($("[data-rsv-detail]", root) as HTMLElement, node, DETAIL_CLOSE);
}

function pickDeploy(): void {
  if (!root) return;
  closeRemotePanel();
  detail = { kind: "deploy" };
  paintDeployPanel($("[data-rsv-detail]", root) as HTMLElement, DETAIL_CLOSE);
}

function clearDetail(): void {
  closeRemotePanel();
  closeDeployPanel();
  detail = null;
  if (root) ($("[data-rsv-detail]", root) as HTMLElement).replaceChildren();
}

function onClick(ev: Event): void {
  if (!root || !deps) return;
  const t = ev.target as HTMLElement;
  if (t.closest("[data-rsv-close]")) { deps.close(); return; }
  const tabBtn = t.closest("[data-rsv-tab]") as HTMLElement | null;
  if (tabBtn) { setTab(tabBtn.dataset.rsvTab === "admin" ? "admin" : "spokes"); return; }
  if (t.closest("[data-rsv-admin-open]")) { deps.openAdmin(); return; }
  if (t.closest("[data-rsv-refresh]")) { void refreshRemote(); return; }
  if (t.closest("[data-rsv-detail-close]")) { clearDetail(); paint(); return; }
  const box = $("[data-rsv-detail]", root) as HTMLElement;
  if (box.contains(t)) {
    if (detail?.kind === "spoke") onRemotePanelClick(t, box);
    // ADR-0508: a started task opens its spoke's panel, here as on the orbit.
    else if (detail?.kind === "deploy") onDeployPanelClick(t, box, (node) => { pickSpoke(node); paint(); });
    return;
  }
  const hit = onRemoteHubClick(t);
  if (hit === "deploy") { pickDeploy(); paint(); return; }
  if (hit === "repaint") { onSnapshot(); return; }
  if (hit && hit !== "handled") { pickSpoke(hit); paint(); }
}
