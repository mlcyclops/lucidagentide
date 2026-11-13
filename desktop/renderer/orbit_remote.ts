// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/orbit_remote.ts - P-IDE-SPOKES.1 (ADR-0506): remote spokes on the Fleet Orbit.
//
// The add-on hub (the remote-spokes server plugin) is the source of truth; the engine reads it and this file only
// draws: a remote node per spoke on the same ring as the local lanes (dashed frame, a "remote" tag, the shared
// state hues by remote_spokes_model.ts REMOTE_TONE), a Remote hub section in the Other hubs panel, and a side panel
// per spoke for its tasks, parked actions and recall. A remote spoke is never promoted into the composer: it is
// another machine, driven through its hub.
//
// ADR-0508 adds the Start-a-task selector (every spoke as a radio row with how fast it answers, its route, models,
// free lanes and certificate region and classification; ineligible rows say why) and a Models section in the
// per-spoke panel. Both start tasks through the same submit path as the panel's own "New task".
//
// ADR-0509: an alert line on each remote card (silent since, crashed, restarted, turn interrupted) and a
// dismissible alert list in the Remote hub section (dismissals kept in localStorage by a key stable across polls);
// host facts and the lane policy's why in the selector rows and the panel; a task a restart interrupted offers
// Resume, armed like Approve, which sends RESUME_TEXT through the existing followup route. Nothing re-runs alone.
//
// P-RS-VIEW.1 (ADR-0539): only a spoke holding a task is on the ring (remote_spokes_model.ts onOrbit). Every spoke,
// the alert list and the plugin's own panel live in the Remote spokes view (remote_spokes_view.ts, on the left
// rail), which reuses this file's per-spoke panel and Start-a-task selector; the Hubs panel keeps a one-line
// summary of the remote hub that opens it.
//
// P-RS-LANES.1 (ADR-0551): the Fleet lanes grid ends with a Remote section, one card per open remote task, built and
// answered here (paintRemoteLanes, onRemoteLaneClick) with the panel's own actions through the same sendAct and
// sendDecide. Every count of the remote hub (badges, the Fleet pill, the hub summary, the Remote spokes view) is
// remoteCounts, which is remote_spokes_model.ts remoteTotals.
//
// P-RS-SESSION.1 (ADR-0572): the per-spoke panel opens on a Session (the busiest task's, or the task row clicked) and
// each Fleet lane card shows its task's session too, kept live by remote_session.ts like a local lane's output.
//
// Untrusted text rule: everything a spoke wrote reaches the DOM through textContent or esc(), never as markup.
// Recalled entries arrive already scanned (a quarantined entry has no text at all); the only way recalled text
// leaves this panel is "Copy for a prompt", which copies the engine's delimited UNTRUSTED_CONTENT envelope.
// Buttons appear only for what the hub certificate's scopes allow; the engine re-checks every action anyway.
// Approve and Resume keep the plugin panel's two-click rule (armClick); Stop asks once, like a local lane's Stop
// (ADR-0576), and then sends `close`. On a `password` hub (ADR-0507 amendment) the
// first Approve click opens a password field instead, and the second signs with what was typed; the field is
// emptied at once and the password goes only into that one decide request.

import { $ } from "./dom.ts";
import { esc } from "./format.ts";
import { icon } from "./icons.ts";
import type { LucidBridge } from "./bridge.ts";
import type { OrbitSlot } from "./orbit_layout.ts";
import type { OrbitSpoke } from "./orbit_canvas.ts";
import { initRemoteSession, mountSession, rememberPrompt } from "./remote_session.ts";
import { showToast } from "./ui.ts";
import {
  approvalButtons, armClick, clockLabel, deployChoices, hostLabel, lanePolicyLabel, latencyLabel, mibLabel, modelCount, onOrbit, REMOTE_STATE_LABEL, REMOTE_TONE,
  remoteGlance, remoteLanes, remoteTotals, RESUME_TEXT, spokeActions, spokeAlerts, stateLabel, taskButtons, taskEnded, taskModelChoices, VIA_LABEL,
  type DeployChoice, type HubActions, type RecallView, type RemoteAlertItem, type RemoteApprovalView, type RemoteClassification, type RemoteHubView, type RemoteLane,
  type RemoteModelsView, type RemoteSpokeView, type RemoteTaskView, type RemoteTotals,
} from "./remote_spokes_model.ts";

export interface OrbitRemoteDeps {
  remoteSpokes: LucidBridge["remoteSpokes"];
  remoteSpokeRecall: LucidBridge["remoteSpokeRecall"];
  remoteSpokeApprovals: LucidBridge["remoteSpokeApprovals"];
  remoteSpokeStatus: LucidBridge["remoteSpokeStatus"];
  remoteSpokeDecide: LucidBridge["remoteSpokeDecide"];
  remoteSpokeAct: LucidBridge["remoteSpokeAct"];
  /** Start the remote-spokes plugin (the sanctioned pluginsStart path) so its spokes appear. */
  startRemoteSpokes: () => Promise<void>;
  /** P-RS-VIEW.1 (ADR-0539): open the Remote spokes view (rail), on a tab or on one spoke. app.ts closes the orbit
   *  first, so one surface drives a spoke at a time. */
  openRemoteView: (at?: { tab?: "spokes" | "admin"; node?: string }) => void;
  /** P-RS-WINDOW.1 (ADR-0543): open or bring forward the plugin's admin panel window (setup, presence, custody). */
  openRemoteAdmin: () => void;
}

let deps: OrbitRemoteDeps | null = null;
/** The engine's last answer; null before the first one (or when the engine did not answer). */
let snap: RemoteHubView | null = null;
const remoteNodes = new Map<string, { card: HTMLElement }>();
/** P-RS-VIEW.1: told after every hub read that got an answer (the rail button and the Remote spokes view). */
const listeners = new Set<() => void>();

export function initOrbitRemote(d: OrbitRemoteDeps): void { deps = d; initRemoteSession(d); }

/** P-RS-VIEW.1: call `fn` after each answered hub read, whoever asked for it. */
export function onRemoteChange(fn: () => void): void { listeners.add(fn); }

let inflight: Promise<void> | null = null;

/** Re-read the hub. Kept separate from the lane poll so a slow plugin never delays the local ring, and single-
 *  flight so polls that outpace a slow answer join it instead of stacking requests. */
export function refreshRemote(): Promise<void> {
  if (!deps) return Promise.resolve();
  if (inflight) return inflight;
  const d = deps;
  inflight = d.remoteSpokes().catch(() => null).then((s) => {
    if (!s) return;
    snap = s;
    for (const fn of listeners) fn();
  }).finally(() => { inflight = null; });
  return inflight;
}

export function remoteList(): RemoteSpokeView[] {
  return snap?.available ? snap.spokes : [];
}

/** P-RS-VIEW.1 (ADR-0539): the remote spokes the orbit draws: only those holding a task (onOrbit). */
export function orbitRemoteList(): RemoteSpokeView[] {
  return remoteList().filter(onOrbit);
}

/** P-RS-VIEW.1: the hub view as last read, for the Remote spokes view's header and notices. */
export function remoteSnapshot(): RemoteHubView | null { return snap; }

// ------------------------------------------------------------------------------ alerts (ADR-0509)

/** Alert lines the human dismissed, by RemoteAlertItem key. Kept across reloads: the hub keeps an alert until 20
 *  newer ones push it out, so a dismissal has to outlive the page. Capped, oldest dropped first. */
const DISMISS_KEY = "lucid.remoteSpokes.dismissedAlerts";
const DISMISS_MAX = 500;
let dismissed: Set<string> | null = null;

function dismissedAlerts(): Set<string> {
  if (dismissed) return dismissed;
  dismissed = new Set();
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(DISMISS_KEY) ?? "[]");
    if (Array.isArray(raw)) for (const k of raw) if (typeof k === "string") dismissed.add(k);
  } catch { /* degrade to per-session dismissals */ }
  return dismissed;
}

function dismissAlerts(keys: readonly string[]): void {
  const set = dismissedAlerts();
  for (const k of keys) set.add(k);
  try { localStorage.setItem(DISMISS_KEY, JSON.stringify([...set].slice(-DISMISS_MAX))); } catch { /* degrade to per-session dismissals */ }
}

/** Every spoke's alert lines the human has not dismissed, newest first. */
function openAlerts(now: number): RemoteAlertItem[] {
  const gone = dismissedAlerts();
  return remoteList().flatMap((s) => spokeAlerts(s, now)).filter((a) => !gone.has(a.key)).sort((x, y) => y.at - x.at);
}

// ------------------------------------------------------------------------------------ nodes on the ring

/** Create, repaint and drop remote nodes like reconcile() does for lanes (cards are never rebuilt). P-RS-VIEW.1:
 *  a spoke whose last task closes falls back into the hub like a dismissed lane, and one that takes a task flies out. */
export function reconcileRemote(stage: HTMLElement, first: boolean): void {
  const spokes = orbitRemoteList();
  const seen = new Set<string>();
  spokes.forEach((s, i) => {
    seen.add(s.node);
    let entry = remoteNodes.get(s.node);
    if (!entry) {
      const card = buildRemoteNode(s.node);
      stage.appendChild(card);
      entry = { card };
      remoteNodes.set(s.node, entry);
      card.style.setProperty("--tx", "0px");
      card.style.setProperty("--ty", "0px");
      card.style.transitionDelay = first ? `${Math.min(i * 60, 600)}ms` : "0ms";
      card.classList.add("orbit-enter");
      requestAnimationFrame(() => card.classList.remove("orbit-enter"));
    }
    paintRemoteNode(entry.card, s);
  });
  for (const [node, entry] of remoteNodes) {
    if (seen.has(node)) continue;
    remoteNodes.delete(node);
    entry.card.classList.add("orbit-exit");
    entry.card.style.setProperty("--tx", "0px");
    entry.card.style.setProperty("--ty", "0px");
    window.setTimeout(() => entry.card.remove(), 420);
  }
}

function buildRemoteNode(node: string): HTMLElement {
  const t = document.createElement("template");
  t.innerHTML = `<div class="orbit-node remote" data-remote-node="${esc(node)}" role="button" tabindex="0">
    <div class="orbit-node-float">
      <div class="orbit-node-card">
        <div class="orbit-node-head"><i class="orbit-led"></i><b class="orbit-name"></b><span class="orbit-remote-tag">${icon("link", 11)} remote</span></div>
        <div class="orbit-glance"></div>
        <div class="orbit-alert" hidden></div>
        <div class="orbit-meta"><span class="orbit-model"></span></div>
        <div class="orbit-cta">${icon("arrowRight", 12)} open remote spoke</div>
      </div>
    </div>
  </div>`;
  const card = t.content.firstElementChild as HTMLElement;
  card.addEventListener("keydown", (e) => {
    if (e.target !== card || (e.key !== "Enter" && e.key !== " ")) return;
    e.preventDefault();
    card.click();
  });
  return card;
}

function setText(root: ParentNode, sel: string, text: string): void {
  const n = root.querySelector(sel);
  if (n && n.textContent !== text) n.textContent = text;
}

function paintRemoteNode(card: HTMLElement, s: RemoteSpokeView): void {
  const keep = card.classList.contains("orbit-enter") ? " orbit-enter" : "";
  const cls = `orbit-node remote rs-${REMOTE_TONE[s.state]}${keep}`;
  if (card.getAttribute("class") !== cls) card.setAttribute("class", cls);
  const now = Date.now();
  setText(card, ".orbit-name", s.label);
  setText(card, ".orbit-glance", remoteGlance(s, now));
  // ADR-0509: the newest alert line the human has not dismissed (a silence first: it is the one still going on).
  const gone = dismissedAlerts();
  const alert = spokeAlerts(s, now).find((a) => !gone.has(a.key)) ?? null;
  const line = card.querySelector<HTMLElement>(".orbit-alert");
  if (line) {
    line.hidden = alert === null;
    setText(card, ".orbit-alert", alert?.text ?? "");
    line.dataset.kind = alert?.kind ?? "";
  }
  setText(card, ".orbit-model", s.models.default ?? "model not reported");
  const host = hostLabel(s.host);
  card.title = `${s.label} (remote spoke ${s.node})\n${stateLabel(s, now)}\n${latencyLabel(s.latencyMs)}${s.via ? ` over ${VIA_LABEL[s.via]}` : ""}${host ? `\n${host}` : ""}${s.error ? `\n${s.error}` : ""}`;
}

/** ADR-0508: whether the orbit offers "Start a remote task": the hub may drive and has at least one spoke.
 *  ADR-0512: a deactivated spoke does not count. */
export function remoteDeployVisible(): boolean {
  return snap !== null && snap.available && snap.actions.drive && snap.spokes.some((s) => !s.deactivated);
}

/** Place remote nodes on the slots after the local lanes'; their lines go to the orbit canvas (ADR-0522). */
export function layoutRemote(slots: readonly OrbitSlot[]): OrbitSpoke[] {
  const lines: OrbitSpoke[] = [];
  orbitRemoteList().forEach((s, i) => {
    const entry = remoteNodes.get(s.node);
    const slot = slots[i];
    if (!entry || !slot) return;
    entry.card.style.setProperty("--tx", `${Math.round(slot.x)}px`);
    entry.card.style.setProperty("--ty", `${Math.round(slot.y)}px`);
    lines.push({ x: slot.x, y: slot.y, status: `remote-${REMOTE_TONE[s.state]}`, promoted: false });
  });
  return lines;
}

// ------------------------------------------------------------------------- the hub picker's section

/** Remote spokes, how many hold a task, how many are parked on an approval, and (ADR-0509) how many alert lines are
 *  not dismissed. P-RS-LANES.1 (ADR-0551): the one count (remote_spokes_model.ts remoteTotals) behind the Hubs
 *  badge, the rail badge, the Fleet pill, the hub summary and the Remote spokes view. */
export function remoteCounts(): RemoteTotals {
  return remoteTotals(remoteList(), openAlerts(Date.now()).length);
}

/** Whether the Other hubs panel has a Remote hub section to show: the hub's spokes, or a plugin that is installed
 *  but stopped or not set up (the section offers Start or the panel). An uninstalled plugin adds nothing. */
export function remoteHubVisible(): boolean {
  return snap !== null && (snap.available || snap.plugin !== "missing");
}

/** The Remote hub row of the Hubs panel: the add-on hub in one line, or why there are none. Empty while the engine
 *  has not answered, so a panel never flashes a wrong reason. P-RS-VIEW.1 (ADR-0539): the spoke list, its alerts
 *  and the plugin's own panel live in the Remote spokes view, which Open shows; this row only summarizes. */
export function remoteHubSectionHtml(): string {
  if (!snap || !remoteHubVisible()) return "";
  if (!snap.available) {
    const btn = snap.plugin === "stopped"
      ? `<button class="btn-mini orbit-btn" data-rs-start data-tip="Start Remote Spokes|Starts the Remote Spokes plugin so this hub's remote spokes can be reached.">${icon("bolt", 12)} Start</button>`
      : `<button class="btn-mini orbit-btn" data-rs-panel>${icon("link", 12)} Set up</button>`;
    return `<div class="orbit-hubrow rs-hubrow"><span class="orbit-ghost-id"><b>Remote hub</b><small>${esc(snap.reason)}</small></span>${btn}</div>`;
  }
  const { hub } = snap;
  const { spokes, working, waiting, alerts } = remoteCounts();
  const summary = [
    `${spokes} remote ${spokes === 1 ? "spoke" : "spokes"}`,
    working ? `${working} working` : "none working",
    waiting ? `${waiting} waiting on you` : "",
    alerts ? `${alerts} ${alerts === 1 ? "alert" : "alerts"}` : "",
  ].filter(Boolean).join(" \u00b7 ");
  return `<div class="orbit-hubrow rs-hubrow" title="${esc(hub.node)}">
      <span class="orbit-ghost-id"><b>${esc(hub.label)}</b><small>${esc(summary)}</small></span>
      ${remoteDeployVisible() ? `<button class="btn-mini orbit-btn" data-rs-deploy data-tip="Start a task on a remote spoke|Pick a spoke by how fast it answers, its models and its free lanes, then start a task there.">${icon("bolt", 12)} Start a task</button>` : ""}
      <button class="btn-mini orbit-btn" data-rs-view data-tip="Remote spokes|Every remote spoke and its alerts, in their own view, with a button for the hub's admin panel. Also on the left rail.">${icon("link", 12)} Open</button>
    </div>`;
}

/** ADR-0509: how many alert lines the Remote spokes view lists; the rest wait behind "Dismiss all". */
const ALERT_LIST_MAX = 12;

/** ADR-0509: the alert lines not dismissed yet, newest first: a spoke gone silent, crashed, restarted, or a turn a
 *  restart cut off (resumed from the spoke's panel, never on its own). Each line opens its spoke or is dismissed.
 *  Every spoke-written word goes through esc(); the dismiss key is built from the node id, a closed kind and a
 *  number. P-RS-VIEW.1: shown in the Remote spokes view; its clicks go through onRemoteHubClick. */
export function remoteAlertListHtml(): string {
  const items = openAlerts(Date.now());
  if (items.length === 0) return "";
  const more = items.length > ALERT_LIST_MAX ? `<div class="rs-alert-more">${items.length - ALERT_LIST_MAX} older not shown</div>` : "";
  return `<div class="rs-alerts">
      <div class="rs-sec-h"><span>Alerts \u00b7 ${items.length}</span><button class="btn-mini orbit-btn" data-rs-alert-clear data-tip="Dismiss all|Hides every alert listed here. A spoke that goes silent again, or a new alert, shows up again.">${icon("check", 12)} Dismiss all</button></div>
      ${items.slice(0, ALERT_LIST_MAX).map((a) => `<div class="rs-alert" data-kind="${esc(a.kind)}">
        <span class="rs-alert-text"><b>${esc(a.label)}</b> ${esc(a.text)}</span>
        <button class="btn-mini orbit-btn" data-rs-open="${esc(a.node)}">${icon("arrowRight", 12)} Open</button>
        <button class="orbit-ghost-x" data-rs-alert-x="${esc(a.key)}" data-tip="Dismiss|Hides this alert. Nothing on the spoke changes.">${icon("close", 12)}</button>
      </div>`).join("")}
      ${more}
    </div>`;
}

// ------------------------------------------------------------------------------- the per-spoke panel

interface PanelState {
  node: string;
  /** The task a follow-up goes to. */
  followTask: string | null;
  /** Two-click arms by button key (`approve:<task>:<ask>`, `close:<task>`). */
  armed: Record<string, number>;
  /** The approvals last shown, by index (the buttons address them by index, never by spoke-written ids). */
  approvals: RemoteApprovalView[];
  recall: Extract<RecallView, { ok: true }> | null;
  sig: string;
  /** The models last painted, so a poll repaints the Models section (and folds its lists) only on a change. */
  modelsSig: string;
  /** The awaiting-approval task ids whose parked actions were last read on their own ("" = none): a spoke with a
   *  parked action reads them once, and again when a new one parks (as a Fleet lane card's asksRead). */
  asksRead: string;
  /** P-RS-SESSION.1: the task whose session the panel shows; null picks the busiest, else the newest. */
  sessionTask: string | null;
}
let panel: PanelState | null = null;

export function remotePanelNode(): string | null { return panel?.node ?? null; }
export function closeRemotePanel(): void { panel = null; }

function spokeOf(node: string): RemoteSpokeView | null {
  return remoteList().find((s) => s.node === node) ?? null;
}

const CLASSIFICATION_LABEL: Readonly<Record<RemoteClassification, string>> = { private: "private", shareable: "shareable", cui: "CUI" };

/** ADR-0508: a model list longer than this folds into a details that shows its count. */
const MODELS_OPEN_MAX = 12;

/** One model list, built node by node (every id is spoke-written text): a heading, then the ids, the default
 *  marked. A long list folds; `open` keeps a fold the user opened open across a repaint. */
function modelGroup(title: string, ids: readonly string[], def: string | null, key: string, open: ReadonlySet<string>): HTMLElement {
  const list = document.createElement("ul");
  list.className = "rs-models";
  for (const id of ids) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.className = "rs-model-id";
    name.textContent = id;
    name.title = id;
    li.append(name);
    if (id === def) {
      const chip = document.createElement("span");
      chip.className = "rs-chip";
      chip.textContent = "default";
      li.append(chip);
    }
    list.append(li);
  }
  if (ids.length > MODELS_OPEN_MAX) {
    const fold = document.createElement("details");
    fold.className = "rs-models-fold";
    fold.dataset.rsGroup = key;
    fold.open = open.has(key);
    const summary = document.createElement("summary");
    summary.textContent = `${title} \u00b7 ${ids.length} models`;
    fold.append(summary, list);
    return fold;
  }
  const group = document.createElement("div");
  group.className = "rs-models-group";
  const head = document.createElement("div");
  head.className = "rs-models-h";
  head.textContent = ids.length ? title : `${title} \u00b7 signed in, models not listed by this spoke`;
  group.append(head, list);
  return group;
}

/** The panel's Models section: the default, the local models, then each signed-in frontier provider. */
function paintModels(host: HTMLElement, m: RemoteModelsView): void {
  const open = new Set([...host.querySelectorAll<HTMLDetailsElement>("details[data-rs-group]")].filter((d) => d.open).map((d) => d.dataset.rsGroup ?? ""));
  const groups: HTMLElement[] = [];
  if (m.default) groups.push(modelGroup("Default", [m.default], m.default, "default", open));
  if (m.local.length) groups.push(modelGroup("Local", m.local, m.default, "local", open));
  for (const f of m.frontier) groups.push(modelGroup(`${f.name}${f.account ? ` (${f.account})` : ""}`, f.models, m.default, `p:${f.provider}`, open));
  if (groups.length === 0) {
    const none = document.createElement("div");
    none.className = "orbit-ghosts-empty";
    none.textContent = "This spoke has not reported its models.";
    groups.push(none);
  }
  host.replaceChildren(...groups);
}

/** Paint the panel for `node` once; polls only touch its head and task list (typed text survives a poll). */
export function paintRemotePanel(box: HTMLElement, node: string, closeHtml: string): void {
  panel = { node, followTask: null, armed: {}, approvals: [], recall: null, sig: "", modelsSig: "", asksRead: "", sessionTask: null };
  // ADR-0512: a deactivated spoke's panel offers no new task, parked actions or recall.
  const s0 = spokeOf(node);
  const a = snap?.available ? (s0 ? spokeActions(s0, snap.actions) : snap.actions) : null;
  box.innerHTML = `<div class="orbit-panel-h">${icon("link", 14)}<b data-rs-title></b><span class="rs-state" data-rs-state></span>${closeHtml}</div>
    <p class="rs-note" data-rs-sub></p>
    <p class="rs-note" data-rs-host hidden></p>
    <p class="rs-note" data-rs-lanes hidden></p>
    <p class="rs-note" data-rs-scopes></p>
    ${a?.recall ? `<div class="rs-sec-h"><span>Session</span><small class="rs-note" data-rs-sess-name></small></div>
    <div data-rs-session></div>` : ""}
    <div class="rs-sec-h"><span>Tasks</span></div>
    <div data-rs-tasks></div>
    <div class="rs-form" data-rs-follow hidden>
      <label class="orbit-spawn-l"><span data-rs-follow-lbl>follow-up</span><textarea data-rs-follow-text rows="3" maxlength="32000" placeholder="what the task should do next"></textarea></label>
      <div class="orbit-spawn-row"><button class="btn-mini orbit-btn" data-rs-follow-go>${icon("send", 12)} Send follow-up</button></div>
    </div>
    ${a?.drive ? `<details class="orbit-spawn-more" data-rs-new>
      <summary>New task on this spoke</summary>
      <label class="orbit-spawn-l">name <i>optional</i><input type="text" data-rs-new-name maxlength="48" placeholder="what this task is for"></label>
      <label class="orbit-spawn-l">prompt<textarea data-rs-new-text rows="3" maxlength="32000" placeholder="the first turn"></textarea></label>
      <div class="orbit-spawn-row"><button class="btn-mini orbit-btn orbit-spawn-go" data-rs-new-go>${icon("bolt", 12)} Start task</button></div>
    </details>` : ""}
    <div class="rs-sec-h"><span>Models</span></div>
    <div data-rs-models></div>
    <p class="rs-note">The default is what new tasks use; change it in the Remote Spokes admin panel (it restarts the spoke's engine).</p>
    ${a?.recall ? `<div class="rs-sec-h"><span>Parked actions</span><button class="btn-mini orbit-btn" data-rs-approvals>${icon("refresh", 12)} Check</button></div>
    <div data-rs-approvals-out></div>
    <div class="rs-sec-h"><span>Recall</span><button class="btn-mini orbit-btn" data-rs-recall-all data-tip="Recall|Reads this spoke's signed journal. Every entry passes the scanner first; a flagged entry is withheld.">${icon("restore", 12)} Whole journal</button><button class="btn-mini orbit-btn" data-rs-copy hidden data-tip="Copy for a prompt|Copies the entries that passed the scanner inside UNTRUSTED_CONTENT delimiters, the only form recalled text may take into a prompt. Withheld entries are not included.">${icon("copy", 12)} Copy for a prompt</button></div>
    <div data-rs-recall-out></div>` : ""}
    <small class="orbit-ghost-err" data-rs-err></small>`;
  enterSends($<HTMLTextAreaElement>("[data-rs-follow-text]", box), $("[data-rs-follow-go]", box));
  enterSends($<HTMLTextAreaElement>("[data-rs-new-text]", box), $("[data-rs-new-go]", box));
  refreshRemotePanel(box);
}

/** P-RS-LANES.1 (ADR-0551): Enter (without Shift, outside an IME composition) in a remote prompt field presses its
 *  send button, as Enter does in a local lane's [data-fleet-input]; the click then takes the button's own path. */
function enterSends(field: HTMLTextAreaElement | null, go: HTMLElement | null): void {
  if (!field || !go) return;
  field.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
    e.preventDefault();
    go.click();
  });
}

/** A task row's buttons, shared by the per-spoke panel and the Fleet grid's remote lanes (P-RS-LANES.1), so both
 *  answer to the same clicks (taskOpClick). Resume and Close are armed (two clicks). */
const RESUME_BTN = `<button class="btn-mini orbit-btn rs-resume" data-rs-resume data-tip="Resume|Sends one follow-up asking the task to continue and to check what was already done first. Click twice. Nothing re-runs on its own.">${icon("restore", 12)} Resume</button>`;
const CANCEL_BTN = `<button class="btn-mini orbit-btn" data-rs-cancel>${icon("close", 12)} Cancel</button>`;
/** ADR-0576: Stop, as on a local lane, with one confirm (taskOpClick). It still sends `close`. */
const STOP_BTN = `<button class="btn-mini orbit-btn" data-rs-stop data-tip="Stop|Stops this agent on its computer. What it did so far is kept under Past tasks.">${icon("close", 12)} Stop</button>`;

/** ADR-0576: the reply box is always there for an open task; while it works, a note waits for its next step. */
const FOLLOW_IDLE = "Reply: what the agent should do next. Enter sends, Shift+Enter starts a new line.";
const FOLLOW_BUSY = "It is working. Your note waits for its next step. Enter sends, Shift+Enter starts a new line.";

/** A task's one-line facts: state, turns, last change, review branch, a restart's cut-off and the shadow mark. */
function taskMeta(t: RemoteTaskView, now: number): string {
  return `${t.state.replace("_", " ")} \u00b7 ${t.turns} ${t.turns === 1 ? "turn" : "turns"} \u00b7 ${new Date(t.updatedAt).toLocaleString()}${t.reviewBranch ? ` \u00b7 review ${t.reviewBranch}` : ""}${t.interrupted ? ` \u00b7 interrupted by a restart at ${clockLabel(t.interrupted, now)}` : ""}${t.shadow ? " \u00b7 shadow" : ""}`;
}

/** Per poll: the head and the task list, only when they changed. Gone from the hub: say so, keep the panel. */
export function refreshRemotePanel(box: HTMLElement): void {
  if (!panel) return;
  const s = spokeOf(panel.node);
  const a = snap?.available && s ? spokeActions(s, snap.actions) : null;
  // A parked action shows without pressing Check: read once per new set of awaiting tasks, never per poll.
  const parkedKey = s && a?.recall ? s.tasks.filter((t) => t.state === "awaiting_approval").map((t) => t.id).sort().join(",") : "";
  if (!parkedKey) panel.asksRead = "";
  else if (parkedKey !== panel.asksRead && $("[data-rs-approvals-out]", box)) { panel.asksRead = parkedKey; void loadApprovals(box); }
  // P-RS-SESSION.1 (ADR-0572): the chosen task's session, kept live by remote_session.ts. With none chosen: a task
  // that works or waits on you, else the newest open one, else the newest.
  const sessHost = $("[data-rs-session]", box) as HTMLElement | null;
  if (s && a?.recall && sessHost) {
    const rank = (t: RemoteTaskView): number => (t.state === "working" || t.state === "awaiting_approval" ? 2 : taskEnded(t) ? 0 : 1);
    const pick = s.tasks.find((t) => t.id === panel!.sessionTask) ?? [...s.tasks].sort((x, y) => rank(y) - rank(x) || y.updatedAt - x.updatedAt)[0];
    if (pick) {
      mountSession(sessHost, s.node, pick.id, pick);
      setText(box, "[data-rs-sess-name]", `${pick.name} \u00b7 click a task below to show another`);
    } else if (!sessHost.dataset.rsSession) sessHost.innerHTML = `<div class="orbit-ghosts-empty">No task on this spoke yet: start one below.</div>`;
  }
  const sig = JSON.stringify([s, a, panel.sessionTask]);
  if (sig === panel.sig) return;
  panel.sig = sig;
  if (!s || !a) {
    setText(box, "[data-rs-title]", panel.node.slice(0, 12));
    setText(box, "[data-rs-sub]", snap && !snap.available ? snap.reason : "This spoke is no longer on the hub.");
    ($("[data-rs-tasks]", box) as HTMLElement).replaceChildren();
    ($("[data-rs-models]", box) as HTMLElement).replaceChildren();
    panel.modelsSig = "";
    return;
  }
  setText(box, "[data-rs-title]", s.label);
  const now = Date.now();
  const st = $("[data-rs-state]", box) as HTMLElement;
  st.className = `rs-state rs-${REMOTE_TONE[s.state]}`;
  setText(box, "[data-rs-state]", stateLabel(s, now));
  const lanes = s.lanes ? `${s.lanes.live} of ${s.lanes.max} lanes in use` : "lanes not reported";
  const cert = [s.region, s.classification && CLASSIFICATION_LABEL[s.classification]].filter(Boolean).join(", ");
  setText(box, "[data-rs-sub]", `${lanes} \u00b7 ${latencyLabel(s.latencyMs)}${s.via ? ` over ${VIA_LABEL[s.via]}` : ""}${s.engineVersion ? ` \u00b7 engine ${s.engineVersion}` : ""}${cert ? ` \u00b7 ${cert}` : ""}${s.checkedAt ? ` \u00b7 checked ${new Date(s.checkedAt).toLocaleTimeString()}` : ""}${s.lastSeen ? ` \u00b7 last relay poll ${clockLabel(s.lastSeen, now)}` : ""}${s.error ? ` \u00b7 ${s.error}` : ""}`);
  // ADR-0509: the machine the spoke runs on and why it runs as many lanes as it does.
  const h = s.host;
  const hostLine = h ? [
    hostLabel(h),
    h.os || h.arch ? [h.os, h.arch].filter(Boolean).join(" ") : "",
    h.diskFreeMiB !== null ? `${mibLabel(h.diskFreeMiB)} disk free` : "",
    h.localModel ? `local model at ${h.localModel.host} (${h.localModel.reachable ? "answering" : "not answering"})` : "",
  ].filter(Boolean).join(" \u00b7 ") : "";
  const hostEl = $("[data-rs-host]", box) as HTMLElement;
  hostEl.hidden = !hostLine;
  setText(box, "[data-rs-host]", hostLine ? `Machine: ${hostLine}` : "");
  const lanesEl = $("[data-rs-lanes]", box) as HTMLElement;
  lanesEl.hidden = !s.lanePolicy;
  setText(box, "[data-rs-lanes]", s.lanePolicy ? `Lanes: ${lanePolicyLabel(s.lanePolicy)}` : "");
  const modelsSig = JSON.stringify(s.models);
  if (modelsSig !== panel.modelsSig) {
    panel.modelsSig = modelsSig;
    paintModels($("[data-rs-models]", box) as HTMLElement, s.models);
  }
  const may = [a.recall && "recall", a.drive && "drive", a.approve && "approve"].filter(Boolean).join(", ");
  setText(box, "[data-rs-scopes]", s.deactivated
    ? `This spoke is deactivated, so nothing is sent to it. To use it again, run on the hub: hub reactivate --spoke ${s.node}`
    : `This hub's certificate allows: ${may || "nothing"}. Actions it does not allow are not offered.`);
  const host = $("[data-rs-tasks]", box) as HTMLElement;
  if (s.tasks.length === 0) { host.innerHTML = `<div class="orbit-ghosts-empty">No tasks on this spoke yet.</div>`; return; }
  // P-RS-PAST.1 (ADR-0574): open tasks are the list; closed and stopped ones (their lane is gone, nothing more runs)
  // fold into Past tasks, newest first, still a click away from their session and recall. A repaint keeps the fold
  // as the user left it. Rows keep their index into s.tasks, which the click handler reads.
  const row = (t: RemoteTaskView, i: number): string => {
    const b = taskButtons(t, a);
    const shown = $("[data-rs-session]", box)?.getAttribute("data-rs-session") === `${s.node}:${t.id}`;
    return `<div class="orbit-ghost rs-task${t.interrupted ? " interrupted" : ""}${shown ? " shown" : ""}" data-rs-task-i="${i}" data-tip="Show this task's session above">
      <i class="orbit-ghost-dot rs-dot-${esc(t.state)}"></i>
      <span class="orbit-ghost-id"><b>${esc(t.name)}</b><small>${esc(taskMeta(t, now))}</small></span>
      ${b.resume ? RESUME_BTN : ""}
      ${b.recall ? `<button class="btn-mini orbit-btn" data-rs-recall data-tip="Recall this task|Its journal entries, scanned.">${icon("restore", 12)}</button>` : ""}
      ${b.followup ? `<button class="btn-mini orbit-btn" data-rs-follow-open>${icon("send", 12)} Follow up</button>` : ""}
      ${b.cancel ? CANCEL_BTN : ""}
      ${b.close ? STOP_BTN : ""}
    </div>`;
  };
  const indexed = s.tasks.map((t, i) => ({ t, i }));
  const open = indexed.filter(({ t }) => !taskEnded(t));
  const past = indexed.filter(({ t }) => taskEnded(t)).sort((x, y) => y.t.updatedAt - x.t.updatedAt);
  const pastOpen = ($<HTMLDetailsElement>("[data-rs-past]", host))?.open ?? false;
  host.innerHTML = (open.length ? open.map(({ t, i }) => row(t, i)).join("") : `<div class="orbit-ghosts-empty">No open tasks. Start one below, or open a past task to read it.</div>`)
    + (past.length ? `<details class="rs-past" data-rs-past${pastOpen ? " open" : ""}>
      <summary data-tip="Past tasks|Closed, or ended when the spoke's engine restarted. Nothing more runs in them; click one to read its session.">Past tasks (${past.length})</summary>
      ${past.map(({ t, i }) => row(t, i)).join("")}
    </details>` : "");
}

/** The panel's one status line. `ok` marks a success ("Task started", "Approved") so it is not drawn in the error
 *  red; every other message (refusals, waiting notes) keeps the default. */
function showErr(box: HTMLElement, text: string, ok = false): void {
  setText(box, "[data-rs-err]", text);
  const el = $("[data-rs-err]", box) as HTMLElement | null;
  if (el) el.dataset.tone = ok ? "ok" : "";
}

/** Clicks inside the remote panel. Returns true when the click was one of its controls. */
export function onRemotePanelClick(t: HTMLElement, box: HTMLElement): boolean {
  if (!panel || !deps) return false;
  const s = spokeOf(panel.node);
  const row = t.closest("[data-rs-task-i]") as HTMLElement | null;
  const task = row && s ? s.tasks[Number(row.dataset.rsTaskI)] ?? null : null;
  if (task && t.closest("[data-rs-recall]")) { void runRecall(box, task.id); return true; }
  if (task && t.closest("[data-rs-follow-open]")) {
    panel.followTask = task.id;
    const f = $("[data-rs-follow]", box) as HTMLElement;
    f.hidden = false;
    setText(box, "[data-rs-follow-lbl]", `follow-up to ${task.name}`);
    const field = $("[data-rs-follow-text]", box) as HTMLTextAreaElement;
    field.placeholder = task.state === "working" || task.state === "awaiting_approval" ? FOLLOW_BUSY : FOLLOW_IDLE;
    field.focus();
    return true;
  }
  if (task && taskOpClick(t, task, s?.label ?? panel.node, panel.armed, (op, input) => void act(box, op, input))) return true;
  if (t.closest("[data-rs-follow-go]")) {
    const text = ($("[data-rs-follow-text]", box) as HTMLTextAreaElement).value;
    if (panel.followTask && text.trim()) void act(box, "followup", { task: panel.followTask, text }, () => {
      ($("[data-rs-follow-text]", box) as HTMLTextAreaElement).value = "";
      ($("[data-rs-follow]", box) as HTMLElement).hidden = true;
    });
    return true;
  }
  if (t.closest("[data-rs-new-go]")) {
    const text = ($("[data-rs-new-text]", box) as HTMLTextAreaElement).value;
    const name = ($("[data-rs-new-name]", box) as HTMLInputElement).value.trim();
    if (!text.trim()) { showErr(box, "Write the task's first turn."); return true; }
    void act(box, "submit", { text, ...(name ? { name } : {}) }, () => { ($("[data-rs-new-text]", box) as HTMLTextAreaElement).value = ""; });
    return true;
  }
  if (t.closest("[data-rs-approvals]")) { void loadApprovals(box); return true; }
  if (t.closest("[data-rs-recall-all]")) { void runRecall(box, undefined); return true; }
  if (t.closest("[data-rs-copy]")) {
    const ctx = panel.recall?.context ?? "";
    if (ctx) void navigator.clipboard.writeText(ctx).then(() => showErr(box, "Copied, delimited as untrusted content.", true), () => showErr(box, "The clipboard refused the copy."));
    return true;
  }
  const card = t.closest<HTMLElement>("[data-rs-ask-i]");
  const item = card ? panel.approvals[Number(card.dataset.rsAskI)] : undefined;
  if (item && card && askClick(t, card, item, panel.armed, box, (allow, password) => void decide(box, item, allow, password))) return true;
  // P-RS-SESSION.1: a click on a task row (not one of its buttons) shows that task's session.
  if (task && !t.closest("button")) {
    panel.sessionTask = task.id;
    panel.sig = "";
    refreshRemotePanel(box);
    return true;
  }
  return t.closest("[data-rs-new], [data-rs-follow], [data-rs-password], [data-rs-session], [data-rs-past]") !== null;
}

/** A task's Cancel, Resume and Stop, for the per-spoke panel and the Fleet grid's remote lanes alike. ADR-0509:
 *  Resume is the human's call, armed like Approve; the second click sends RESUME_TEXT as a follow-up. Stop asks
 *  once (ADR-0576) and then sends `close`. `computer` is the spoke's label, for the question. Every write goes to
 *  `send` (act or laneAct, both through sendAct). True when the click was one of them. */
function taskOpClick(t: HTMLElement, task: RemoteTaskView, computer: string, armed: Record<string, number>, send: (op: RemoteOp, input: { task: string; text?: string }) => void): boolean {
  if (t.closest("[data-rs-cancel]")) { send("cancel", { task: task.id }); return true; }
  const resumeBtn = t.closest<HTMLElement>("[data-rs-resume]");
  if (resumeBtn) {
    const key = `resume:${task.id}`;
    const step = armClick(armed[key] ?? null, Date.now());
    if (step.act === "arm") { armed[key] = step.armedAt!; resumeBtn.textContent = "Click again to resume"; resumeBtn.classList.add("armed"); return true; }
    delete armed[key];
    send("followup", { task: task.id, text: RESUME_TEXT });
    return true;
  }
  if (t.closest("[data-rs-stop]")) {
    showToast({
      tone: "warn",
      title: `Stop "${task.name}" on ${computer}?`,
      desc: "What it did so far is kept under Past tasks.",
      timeout: 0,
      actions: [{ label: "Stop", kind: "danger", run: () => send("close", { task: task.id }) }, { label: "Keep running" }],
    });
    return true;
  }
  return false;
}

/** A parked action's Approve and Deny (`card` is its approvalCard), for the per-spoke panel and the remote lanes
 *  alike. `go` signs or refuses (decide or laneDecide, both through sendDecide). True when the click was one of them. */
function askClick(t: HTMLElement, card: HTMLElement, item: RemoteApprovalView, armed: Record<string, number>, box: HTMLElement, go: (allow: boolean, password?: string) => void): boolean {
  const approve = t.closest<HTMLButtonElement>("[data-rs-approve]");
  const field = card.querySelector<HTMLInputElement>("[data-rs-password]");
  if (approve && field) {
    // A password hub: the first click opens the field, the next (or Enter) signs with what was typed. The field
    // is emptied at once; the password lives only in this one request.
    if (field.hidden) { field.hidden = false; approve.textContent = "Sign with the hub's password"; approve.classList.add("armed"); field.focus(); return true; }
    const password = field.value;
    field.value = "";
    if (!password) { showErr(box, "Type this hub's presence password to sign the approval."); field.focus(); return true; }
    go(true, password);
    return true;
  }
  if (approve) {
    const key = `approve:${item.task}:${item.ask.id}`;
    const step = armClick(armed[key] ?? null, Date.now());
    if (step.act === "arm") { armed[key] = step.armedAt!; approve.textContent = "Click again to sign the approval"; approve.classList.add("armed"); return true; }
    delete armed[key];
    go(true);
    return true;
  }
  if (t.closest("[data-rs-deny]")) { go(false); return true; }
  return false;
}

type RemoteOp = "submit" | "followup" | "cancel" | "close";

/** One action on a spoke through the engine, then a fresh hub read so every view shows its effect. The panel's
 *  buttons, the Start-a-task selector and the Fleet grid's remote lanes (P-RS-LANES.1) all go through here.
 *  `error` is null when the spoke accepted it, else the refusal in words (an older spoke's own text included).
 *  `queued` (ADR-0576): the spoke took a follow-up while the task works and gives it after the current step. */
async function sendAct(node: string, op: RemoteOp, input: { task?: string; text?: string; name?: string; model?: string }): Promise<{ error: string | null; queued: boolean }> {
  if (!deps) return { error: "The fleet is not ready.", queued: false };
  // P-RS-SESSION.1: the spoke journals a prompt as its hash only; remembered here, its session shows the text.
  if ((op === "submit" || op === "followup") && input.text) await rememberPrompt(input.text).catch(() => undefined);
  const r = await deps.remoteSpokeAct(op, { node, ...input }).catch(() => null);
  if (!r) return { error: "The engine did not answer.", queued: false };
  if (!r.ok) return { error: r.error, queued: false };
  await refreshRemote();
  const d = r.data;
  return { error: null, queued: typeof d === "object" && d !== null && "queued" in d && d.queued === true };
}

const QUEUED_TEXT = "Queued: it reads this after its current step.";

async function act(box: HTMLElement, op: RemoteOp, input: { task?: string; text?: string; name?: string }, done?: () => void): Promise<void> {
  if (!panel) return;
  const node = panel.node;
  showErr(box, "Sent; waiting for the spoke\u2026");
  const { error, queued } = await sendAct(node, op, input);
  if (panel?.node !== node) return;
  if (error) { showErr(box, error); return; }
  showErr(box, queued ? QUEUED_TEXT : op === "close" ? "Stopped. What it did so far is kept under Past tasks." : "Done.", true);
  done?.();
  panel.sig = "";
  refreshRemotePanel(box);
}

async function loadApprovals(box: HTMLElement): Promise<void> {
  if (!panel) return;
  const node = panel.node;
  const out = $("[data-rs-approvals-out]", box);
  if (!out) return;
  const list = await readApprovals(out, node, null, () => panel?.node === node, "Nothing is waiting on this spoke.");
  if (list && panel) panel.approvals = list;
}

/** Read a spoke's parked actions into `out` as approvalCards (only `task`'s when one is named) and return them in
 *  card order, since the buttons address them by index; null when the read failed (`out` says why) or `current`
 *  says the panel or lane moved on while the spoke answered. */
async function readApprovals(out: HTMLElement, node: string, task: string | null, current: () => boolean, empty: string): Promise<RemoteApprovalView[] | null> {
  if (!deps) return null;
  out.textContent = "Asking the spoke\u2026";
  const r = await deps.remoteSpokeApprovals(node).catch(() => null);
  if (!current()) return null;
  if (!r || !r.ok) { out.textContent = r ? r.error : "The engine did not answer."; return null; }
  const list = task ? r.approvals.filter((v) => v.task === task) : r.approvals;
  const s = spokeOf(node);
  const a = snap?.available && s ? spokeActions(s, snap.actions) : null;
  if (list.length === 0) out.textContent = empty;
  else out.replaceChildren(...list.map((v, i) => approvalCard(v, i, a ? approvalButtons(v, a) : { approve: false, deny: false })));
  return list;
}

/** A parked action, built node by node: every spoke-written field is textContent. */
function approvalCard(v: RemoteApprovalView, i: number, b: { approve: boolean; deny: boolean }): HTMLElement {
  const card = document.createElement("div");
  card.className = `rs-ask${v.quarantined ? " quarantined" : ""}`;
  card.dataset.rsAskI = String(i);
  const head = document.createElement("div");
  head.className = "rs-ask-h";
  head.textContent = `${v.name || v.task}: ${v.ask.tier} ${v.ask.kind}`;
  card.append(head);
  if (v.quarantined) {
    const note = document.createElement("p");
    note.className = "rs-note bad";
    note.textContent = `Withheld by the scanner (${v.quarantined}). Only Deny is offered.`;
    card.append(note);
  } else {
    const title = document.createElement("p");
    title.className = "rs-note";
    title.textContent = v.ask.title;
    const input = document.createElement("pre");
    input.className = "rs-pre";
    input.textContent = v.ask.input;
    card.append(title, input);
    if (v.ask.reason) { const why = document.createElement("p"); why.className = "rs-note"; why.textContent = v.ask.reason; card.append(why); }
  }
  const row = document.createElement("div");
  row.className = "orbit-spawn-row";
  if (b.approve) {
    const ok = document.createElement("button"); ok.className = "btn-mini orbit-allow"; ok.dataset.rsApprove = ""; ok.textContent = "Approve";
    // ADR-0507 amendment: a `password` hub's Approve opens this field; the typed password is the second step.
    // Plugin ADR-A105: while the hub holds its presence key unlocked, Approve signs with it and asks for nothing.
    if (snap?.available && snap.hub.presence === "password" && !snap.hub.presenceUnlocked) {
      const pw = document.createElement("input");
      pw.type = "password"; pw.className = "rs-pw"; pw.dataset.rsPassword = ""; pw.hidden = true; pw.maxLength = 1024; pw.autocomplete = "off"; pw.placeholder = "the hub's presence password";
      pw.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); ok.click(); } });
      row.append(pw);
    }
    row.append(ok);
  }
  if (b.deny) { const no = document.createElement("button"); no.className = "btn-mini orbit-deny"; no.dataset.rsDeny = ""; no.textContent = "Deny"; row.append(no); }
  if (v.ask.expiresAt) { const exp = document.createElement("small"); exp.className = "rs-note"; exp.textContent = `expires ${new Date(v.ask.expiresAt).toLocaleTimeString()}`; row.append(exp); }
  card.append(row);
  return card;
}

/** `password`: a password hub's presence password for this one allow; passed straight to the engine, never kept. */
async function decide(box: HTMLElement, item: RemoteApprovalView, allow: boolean, password?: string): Promise<void> {
  if (!panel) return;
  const node = panel.node;
  await sendDecide(node, item, allow, password, (text, ok) => { if (panel?.node === node) showErr(box, text, ok); });
  if (panel?.node === node) await loadApprovals(box);
}

/** One approve or deny on a spoke through the engine, then a fresh hub read so every view and count shows it. The
 *  panel (decide) and the Fleet grid's remote lanes (laneDecide) both go through here; `say` reports each step. */
async function sendDecide(node: string, item: RemoteApprovalView, allow: boolean, password: string | undefined, say: (text: string, ok?: boolean) => void): Promise<void> {
  if (!deps) return;
  say(allow ? (password ? "Signing with the hub's password\u2026" : "Signing (with the hub's remembered password if unlocked); the hub may ask you to confirm it is you\u2026") : "Denying\u2026");
  const r = await deps.remoteSpokeDecide({ node, task: item.task, ask: item.ask.id, digest: item.ask.digest, allow, ...(password ? { password } : {}) }).catch(() => null);
  if (!r) { say("The engine did not answer."); return; }
  say(r.ok ? (allow ? "Approved: the spoke's engine verified the signed decision." : "Denied.") : r.error, r.ok);
  if (r.ok) await refreshRemote();
}

// ------------------------------------------------- P-RS-LANES.1 (ADR-0551): remote tasks as Fleet grid lanes
//
// Fleet mode has two faces, the orbit and the lanes grid. Before this a remote spoke's tasks were on the orbit's
// ring and in the Remote spokes view only, so the lanes grid lost them. The grid now ends with a Remote section: one
// card per open remote task (remote_spokes_model.ts remoteLanes), offering exactly what the hub's scopes and the
// task's state allow (taskButtons, approvalButtons). This file builds, repaints and answers the cards; fleet_grid.ts
// only places them. Every write goes through sendAct and sendDecide like the panel's, every spoke-written word
// reaches the DOM as textContent, and a remote lane is never promoted into the composer.

/** One remote lane's card, kept across polls so a typed follow-up, an open password field and an armed button
 *  survive a repaint. */
interface LaneCard {
  card: HTMLElement;
  node: string;
  /** The task this lane is; null for a waiting spoke with no open task listed. */
  task: string | null;
  /** Two-click arms by button key, as the panel's. */
  armed: Record<string, number>;
  /** The parked actions last shown, by index (the buttons address them by index, never by spoke-written ids). */
  approvals: RemoteApprovalView[];
  sig: string;
  /** Whether the parked actions were read since the lane became parked: a parked lane reads them once on its own. */
  asksRead: boolean;
}
const laneCards = new Map<string, LaneCard>();

/** The card's frame, all static markup; paintLaneCard fills in what the spoke wrote, as text. */
function buildLaneCard(lane: RemoteLane): LaneCard {
  const card = document.createElement("div");
  card.className = "fleet-card rs-lane";
  card.dataset.rsLane = lane.key;
  card.innerHTML = `<div class="rs-lane-head">
      <i class="orbit-led" aria-hidden="true"></i>
      <b class="rs-lane-spoke" data-rs-lane-spoke></b>
      <span class="orbit-remote-tag">${icon("link", 10)} remote</span>
      <span class="rs-state" data-rs-lane-state></span>
      <button class="btn-mini orbit-btn rs-lane-open" data-rs-lane-open data-tip="Open|This spoke's own panel in the Remote spokes view: every task, parked actions, models and recall.">${icon("arrowRight", 12)} Open</button>
      <button class="fleet-card-btn fleet-dismiss" data-rs-stop aria-label="Stop this agent" title="Stop this agent. What it did so far is kept under Past tasks." hidden>${icon("close", 12)}</button>
    </div>
    <div class="fleet-card-main rs-lane-main">
      <div class="rs-lane-task"><b data-rs-lane-task></b><small data-rs-lane-meta></small></div>
      <div class="rs-lane-session" data-rs-lane-session hidden></div>
      <div class="rs-lane-acts" data-rs-lane-acts></div>
      <div class="rs-lane-follow" data-rs-lane-follow hidden>
        <textarea data-rs-follow-text rows="2" maxlength="32000" placeholder="${FOLLOW_IDLE}"></textarea>
        <button class="btn-mini orbit-btn" data-rs-lane-send>${icon("send", 12)} Send</button>
      </div>
      <div class="rs-lane-asks" data-rs-lane-asks hidden>
        <div class="rs-sec-h"><span>Parked actions</span><button class="btn-mini orbit-btn" data-rs-lane-check>${icon("refresh", 12)} Check</button></div>
        <div data-rs-lane-asks-out></div>
      </div>
      <small class="orbit-ghost-err" data-rs-err></small>
    </div>`;
  enterSends($<HTMLTextAreaElement>("[data-rs-follow-text]", card), $("[data-rs-lane-send]", card));
  return { card, node: lane.spoke.node, task: lane.task?.id ?? null, armed: {}, approvals: [], sig: "", asksRead: false };
}

/** Per poll: the frame's tone always, the words and buttons only when they changed (a typed follow-up and the
 *  parked actions shown are never rebuilt). A lane that becomes parked reads its parked actions once. */
function paintLaneCard(entry: LaneCard, lane: RemoteLane, a: HubActions, now: number): void {
  const { card } = entry;
  const s = lane.spoke;
  const t = lane.task;
  const cls = `fleet-card rs-lane rs-${REMOTE_TONE[lane.state]}`;
  if (card.className !== cls) card.className = cls;
  const parked = a.recall && lane.state === "approval";
  if (!parked) entry.asksRead = false;
  const sig = JSON.stringify([s.label, s.state, s.silentSince, lane.state, t, a]);
  if (sig !== entry.sig) {
    entry.sig = sig;
    card.title = `${s.label} (${s.node})`;
    setText(card, "[data-rs-lane-spoke]", s.label);
    setText(card, "[data-rs-lane-state]", lane.state === s.state ? stateLabel(s, now) : REMOTE_STATE_LABEL[lane.state]);
    setText(card, "[data-rs-lane-task]", t ? t.name : "Waiting on you, no open task listed");
    setText(card, "[data-rs-lane-meta]", t ? taskMeta(t, now) : "The spoke parked an action: check it below, or open the spoke.");
    const b = t ? taskButtons(t, a) : null;
    // The task buttons are rebuilt, so their arms go; an armed Approve lives on in the parked actions shown.
    for (const k of Object.keys(entry.armed)) if (!k.startsWith("approve:")) delete entry.armed[k];
    const acts = $("[data-rs-lane-acts]", card);
    if (acts) acts.innerHTML = b ? `${b.resume ? RESUME_BTN : ""}${b.cancel ? CANCEL_BTN : ""}` : "";
    // ADR-0576: Stop sits in the header, where a local lane's Stop is.
    const stop = $("[data-rs-stop]", card) as HTMLElement | null;
    if (stop) stop.hidden = !b?.close;
    const follow = $("[data-rs-lane-follow]", card);
    if (follow) follow.hidden = !b?.followup;
    const field = $<HTMLTextAreaElement>("[data-rs-follow-text]", card);
    if (field && t) field.placeholder = t.state === "working" || t.state === "awaiting_approval" ? FOLLOW_BUSY : FOLLOW_IDLE;
    const asks = $("[data-rs-lane-asks]", card);
    if (asks) asks.hidden = !parked;
  }
  if (parked && !entry.asksRead) { entry.asksRead = true; void loadLaneAsks(entry); }
  // P-RS-SESSION.1 (ADR-0572): the task's session in the card, live like a local lane's output.
  const sess = $("[data-rs-lane-session]", card) as HTMLElement | null;
  if (sess) {
    sess.hidden = !(t && a.recall);
    if (t && a.recall) mountSession(sess, s.node, t.id, t);
  }
}

async function loadLaneAsks(entry: LaneCard): Promise<void> {
  const out = $("[data-rs-lane-asks-out]", entry.card);
  if (!out) return;
  const list = await readApprovals(out, entry.node, entry.task, () => entry.card.isConnected, entry.task ? "Nothing is waiting on this task now." : "Nothing is waiting on this spoke now.");
  if (list) entry.approvals = list;
}

async function laneAct(entry: LaneCard, op: RemoteOp, input: { task: string; text?: string }, done?: () => void): Promise<void> {
  showErr(entry.card, "Sent; waiting for the spoke\u2026");
  const { error, queued } = await sendAct(entry.node, op, input);
  if (error) { showErr(entry.card, error); return; }
  showErr(entry.card, queued ? QUEUED_TEXT : op === "close" ? "Stopped. What it did so far is kept under Past tasks." : "Done.", true);
  done?.();
}

async function laneDecide(entry: LaneCard, item: RemoteApprovalView, allow: boolean, password?: string): Promise<void> {
  await sendDecide(entry.node, item, allow, password, (text, ok) => showErr(entry.card, text, ok));
  if (entry.card.isConnected) await loadLaneAsks(entry);
}

/** Paint the grid's Remote section into `host`, a wrapper fleet_grid.ts keeps after the local lanes: a head (the
 *  hub and the lane count), then one card per remote lane in remoteLanes order. Cards are kept by lane key and
 *  moved only when out of place, so a poll never restarts a glow or drops typed text. */
export function paintRemoteLanes(host: HTMLElement): void {
  const lanes = snap?.available ? remoteLanes(snap.spokes) : [];
  if (!snap?.available || lanes.length === 0) {
    if (host.firstChild) host.replaceChildren();
    laneCards.clear();
    return;
  }
  let head = $(":scope > .fleet-remote-head", host);
  if (!head) {
    head = document.createElement("div");
    head.className = "fleet-group-head fleet-remote-head";
    head.innerHTML = `${icon("link", 11)}<b>Remote</b><span data-rs-lanes-n></span><small data-rs-lanes-hub></small>`;
    host.prepend(head);
  }
  setText(head, "[data-rs-lanes-n]", String(lanes.length));
  setText(head, "[data-rs-lanes-hub]", `on ${snap.hub.label}`);
  const now = Date.now();
  const seen = new Set<string>();
  let prev: Element = head;
  for (const lane of lanes) {
    seen.add(lane.key);
    let entry = laneCards.get(lane.key);
    if (!entry) { entry = buildLaneCard(lane); laneCards.set(lane.key, entry); }
    paintLaneCard(entry, lane, spokeActions(lane.spoke, snap.actions), now);
    if (prev.nextElementSibling !== entry.card) prev.after(entry.card);
    prev = entry.card;
  }
  for (const [key, entry] of laneCards) {
    if (seen.has(key)) continue;
    entry.card.remove();
    laneCards.delete(key);
  }
}

/** Clicks inside a remote lane card. Open shows the spoke's own panel in the Remote spokes view (the per-spoke panel
 *  the orbit and that view share); the rest are the panel's own actions on this one task. True for any click inside
 *  a remote card, so the grid never reads it as a local lane's. */
export function onRemoteLaneClick(t: HTMLElement): boolean {
  const card = t.closest<HTMLElement>("[data-rs-lane]");
  if (!card) return false;
  const entry = laneCards.get(card.dataset.rsLane ?? "");
  if (!entry || !deps) return true;
  if (t.closest("[data-rs-lane-open]")) { deps.openRemoteView({ node: entry.node }); return true; }
  if (t.closest("[data-rs-lane-check]")) { void loadLaneAsks(entry); return true; }
  const spoke = spokeOf(entry.node);
  const task = entry.task ? spoke?.tasks.find((x) => x.id === entry.task) ?? null : null;
  if (task && t.closest("[data-rs-lane-send]")) {
    const field = $<HTMLTextAreaElement>("[data-rs-follow-text]", card);
    const text = field?.value ?? "";
    if (!text.trim()) { showErr(card, "Write the follow-up first."); field?.focus(); return true; }
    void laneAct(entry, "followup", { task: task.id, text }, () => { if (field) field.value = ""; });
    return true;
  }
  if (task && taskOpClick(t, task, spoke?.label ?? entry.node, entry.armed, (op, input) => void laneAct(entry, op, input))) return true;
  const ask = t.closest<HTMLElement>("[data-rs-ask-i]");
  const item = ask ? entry.approvals[Number(ask.dataset.rsAskI)] : undefined;
  if (item && ask) askClick(t, ask, item, entry.armed, card, (allow, password) => void laneDecide(entry, item, allow, password));
  return true;
}

async function runRecall(box: HTMLElement, task: string | undefined): Promise<void> {
  if (!panel || !deps) return;
  const node = panel.node;
  const out = $("[data-rs-recall-out]", box) as HTMLElement | null;
  const copy = $("[data-rs-copy]", box) as HTMLElement | null;
  if (!out) return;
  out.textContent = "Recalling and scanning\u2026";
  if (copy) copy.hidden = true;
  const r = await deps.remoteSpokeRecall(node, task).catch(() => null);
  if (panel?.node !== node) return;
  if (!r || !r.ok) { out.textContent = r ? r.error : "The engine did not answer."; panel.recall = null; return; }
  panel.recall = r;
  if (copy) copy.hidden = r.context === "";
  const summary = document.createElement("p");
  summary.className = "rs-note";
  summary.textContent = `${r.entries.length} ${r.entries.length === 1 ? "entry" : "entries"}${r.task ? ` of task ${r.task}` : ""}, ${r.quarantined} withheld by the scanner${r.omitted ? `, ${r.omitted} older not shown` : ""}. Spoke output is untrusted and shown as text.`;
  out.replaceChildren(summary, ...r.entries.slice().reverse().map((e) => {
    const row = document.createElement("div");
    row.className = `rs-entry trust-${e.trust}`;
    const head = document.createElement("div");
    head.className = "rs-entry-h";
    const pill = document.createElement("span");
    pill.className = `pill ${e.trust}`;
    pill.textContent = e.trust;
    const label = document.createElement("span");
    label.textContent = `#${e.seq} ${e.kind}${e.task !== "-" ? ` ${e.task}` : ""} \u00b7 ${e.ts ? new Date(e.ts).toLocaleString() : "no time"}`;
    head.append(pill, label);
    const body = document.createElement("pre");
    body.className = "rs-pre";
    body.textContent = e.trust === "quarantined" ? `Withheld: ${e.reason ?? "flagged by the scanner"}` : e.text;
    row.append(head, body);
    return row;
  }));
}

// ------------------------------------------------------------- the Start-a-task selector (ADR-0508)

interface DeployState {
  /** The spoke picked last; kept across polls while it stays eligible. */
  chosen: string | null;
  sig: string;
  busy: boolean;
}
let deploy: DeployState | null = null;

export function closeDeployPanel(): void { deploy = null; }

/** A certificate that has expired or expires within this window gets a warning chip. */
const CERT_WARN_MS = 14 * 24 * 3_600_000;

/** One selector row. The radio carries the node id (validated against NODE_RE by the model); every other value
 *  a spoke wrote goes through esc(). */
function choiceHtml(c: DeployChoice, checked: boolean, now: number): string {
  const s = c.spoke;
  const lanes = s.lanes ? `${s.lanes.free}/${s.lanes.max} free` : "lanes not reported";
  const n = modelCount(s);
  const first = `${stateLabel(s, now)} \u00b7 ${lanes} \u00b7 ${s.models.default ?? "model not reported"}${n ? ` \u00b7 ${n} ${n === 1 ? "model" : "models"}` : ""}`;
  // ADR-0509: the machine (cores, memory, each GPU and its memory) and why the spoke runs as many lanes as it does.
  const host = hostLabel(s.host);
  const policy = s.lanePolicy ? lanePolicyLabel(s.lanePolicy) : "";
  const answers = `${latencyLabel(s.latencyMs)}${s.via ? ` over ${VIA_LABEL[s.via]}` : ""}`;
  const expiry = s.certExpires === null ? ""
    : s.certExpires <= now ? `<span class="rs-chip bad">certificate expired</span>`
    : s.certExpires - now <= CERT_WARN_MS ? `<span class="rs-chip warn">certificate expires ${esc(new Date(s.certExpires).toLocaleDateString())}</span>` : "";
  const chips = [
    s.region ? `<span class="rs-chip">${esc(s.region)}</span>` : "",
    s.classification ? `<span class="rs-chip cls-${s.classification}">${CLASSIFICATION_LABEL[s.classification]}</span>` : "",
    s.engineVersion ? `<span class="rs-chip">engine ${esc(s.engineVersion)}</span>` : "",
    expiry,
  ].join("");
  const checkedAt = s.checkedAt ? `checked ${new Date(s.checkedAt).toLocaleTimeString()}` : "not checked yet";
  return `<label class="rs-choice rs-${REMOTE_TONE[s.state]}${c.eligible ? "" : " off"}" title="${esc(s.label)} (${esc(s.node)})">
      <input type="radio" name="rs-deploy" value="${esc(s.node)}"${checked ? " checked" : ""}${c.eligible ? "" : " disabled"}>
      <i class="orbit-led"></i>
      <span class="rs-choice-main">
        <b>${esc(s.label)}</b>
        <small>${esc(first)}</small>
        <small>${esc(answers)} \u00b7 ${esc(checkedAt)}</small>
        ${host ? `<small class="rs-host">${esc(host)}</small>` : ""}
        ${policy ? `<small class="rs-policy">${esc(policy)}</small>` : ""}
        ${chips ? `<small class="rs-chips">${chips}</small>` : ""}
        ${c.why ? `<small class="rs-why">${esc(c.why)}</small>` : ""}
      </span>
    </label>`;
}

/** Paint the selector once: the list, then name, prompt and Start. Polls repaint only the list. */
export function paintDeployPanel(box: HTMLElement, closeHtml: string): void {
  deploy = { chosen: null, sig: "", busy: false };
  box.innerHTML = `<div class="orbit-panel-h">${icon("bolt", 14)}<b>Start a task on a remote spoke</b><span data-rs-dep-n></span>${closeHtml}</div>
    <p class="rs-note">Fastest first. "Answers in" is the hub's last round trip to the spoke, including its mailbox poll (about 2 s), not a network ping.</p>
    <div class="rs-choices" role="radiogroup" aria-label="Remote spokes" data-rs-dep-list></div>
    <label class="orbit-spawn-l">name <i>optional</i><input type="text" data-rs-dep-name maxlength="48" placeholder="what this task is for"></label>
    <label class="orbit-spawn-l">model<select data-rs-dep-model></select></label>
    <label class="orbit-spawn-l">prompt<textarea data-rs-dep-text rows="3" maxlength="32000" placeholder="the first turn"></textarea></label>
    <div class="orbit-spawn-row"><button class="btn-mini orbit-btn orbit-spawn-go" data-rs-dep-go>${icon("bolt", 12)} Start task</button></div>
    <small class="orbit-ghost-err" data-rs-dep-err></small>`;
  refreshDeployPanel(box);
}

/** Per poll: the rows, only when they changed. The pick survives a repaint while that spoke stays eligible;
 *  otherwise the first eligible spoke (the fastest) is picked. */
export function refreshDeployPanel(box: HTMLElement): void {
  if (!deploy) return;
  const list = $("[data-rs-dep-list]", box) as HTMLElement | null;
  if (!list) return;
  const checked = list.querySelector<HTMLInputElement>("input[name=rs-deploy]:checked");
  if (checked) deploy.chosen = checked.value;
  const choices = snap?.available ? deployChoices(snap.spokes, snap.actions) : [];
  const chosen = choices.find((c) => c.eligible && c.spoke.node === deploy?.chosen) ?? choices.find((c) => c.eligible) ?? null;
  deploy.chosen = chosen?.spoke.node ?? null;
  const sig = JSON.stringify([choices, deploy.chosen, snap && !snap.available ? snap.reason : null]);
  if (sig === deploy.sig) return;
  deploy.sig = sig;
  fillDeployModels(box, chosen?.spoke ?? null);
  const eligible = choices.filter((c) => c.eligible).length;
  setText(box, "[data-rs-dep-n]", choices.length ? `${eligible} of ${choices.length} ready` : "");
  const go = $("[data-rs-dep-go]", box) as HTMLButtonElement | null;
  if (go) go.disabled = deploy.busy || eligible === 0;
  if (!snap || !snap.available) { list.innerHTML = `<div class="orbit-ghosts-empty">${esc(snap ? snap.reason : "Asking the hub\u2026")}</div>`; return; }
  if (choices.length === 0) {
    // ADR-0512: deactivated spokes are not targets, so a hub with only those has none to offer.
    list.innerHTML = snap.spokes.length
      ? `<div class="orbit-ghosts-empty">Every spoke on this hub is deactivated. Reactivate one on the hub (hub reactivate) to start a task there.</div>`
      : `<div class="orbit-ghosts-empty">This hub has no spokes yet. Enroll one in the Remote Spokes admin panel.</div>`;
    return;
  }
  const now = Date.now();
  list.innerHTML = choices.map((c) => choiceHtml(c, c.spoke.node === deploy?.chosen, now)).join("");
}

function showDeployErr(box: HTMLElement, text: string): void { setText(box, "[data-rs-dep-err]", text); }

/** Clicks inside the selector. `openSpoke` opens a spoke's side panel (the orbit owns the panels). Returns true
 *  when the click was one of its controls. */
export function onDeployPanelClick(t: HTMLElement, box: HTMLElement, openSpoke: (node: string) => void): boolean {
  if (!deploy) return false;
  if (t.closest("[data-rs-dep-go]")) { void startDeploy(box, openSpoke); return true; }
  // ADR-0511: a newly picked spoke shows its own models at once, not at the next poll. The radio's own click comes
  // after it is checked (a click on its label only forwards one), so this reads the new pick.
  if (t.matches("input[name=rs-deploy]")) { refreshDeployPanel(box); return true; }
  return t.closest("[data-rs-dep-list], [data-rs-dep-name], [data-rs-dep-model], [data-rs-dep-text]") !== null;
}

/** ADR-0511: the picked spoke's models for this task, its default first (sent as no model, so the spoke engine's
 *  default runs). A model picked before stays picked while the spoke still offers it. Every id is spoke-written,
 *  so options are built node by node. */
function fillDeployModels(box: HTMLElement, s: RemoteSpokeView | null): void {
  const select = $("[data-rs-dep-model]", box) as HTMLSelectElement | null;
  if (!select) return;
  const keep = select.value;
  const option = (value: string, text: string): HTMLOptionElement => {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = text;
    return o;
  };
  const ids = s ? taskModelChoices(s) : [];
  select.replaceChildren(option("", s?.models.default ? `${s.models.default} (default)` : "the spoke's default"), ...ids.map((id) => option(id, id)));
  select.value = ids.includes(keep) ? keep : "";
}

async function startDeploy(box: HTMLElement, openSpoke: (node: string) => void): Promise<void> {
  if (!deploy || deploy.busy) return;
  const node = box.querySelector<HTMLInputElement>("input[name=rs-deploy]:checked")?.value ?? null;
  const choice = snap?.available ? deployChoices(snap.spokes, snap.actions).find((c) => c.spoke.node === node) : undefined;
  if (!node || !choice) { showDeployErr(box, "Pick a spoke first."); return; }
  if (!choice.eligible) { showDeployErr(box, `${choice.spoke.label} cannot take a task now: ${choice.why}.`); return; }
  const text = ($("[data-rs-dep-text]", box) as HTMLTextAreaElement).value;
  const name = ($("[data-rs-dep-name]", box) as HTMLInputElement).value.trim();
  // ADR-0511: "" is the spoke's default; any other value is one of the picked spoke's own models.
  const model = ($("[data-rs-dep-model]", box) as HTMLSelectElement | null)?.value ?? "";
  if (!text.trim()) { showDeployErr(box, "Write the task's first turn."); return; }
  const state = deploy;
  state.busy = true;
  const go = $("[data-rs-dep-go]", box) as HTMLButtonElement;
  go.disabled = true;
  showDeployErr(box, `Sent to ${choice.spoke.label}; waiting for the spoke\u2026`);
  const { error } = await sendAct(node, "submit", { text, ...(name ? { name } : {}), ...(model ? { model } : {}) });
  state.busy = false;
  if (deploy !== state) return; // the selector was closed meanwhile; the task still started (or not) on the spoke
  if (error) { go.disabled = false; showDeployErr(box, error); return; }
  openSpoke(node);
  showErr(box, `Task started on ${choice.spoke.label}; it shows in Tasks at the next refresh (up to 15 s).`, true);
}

/** The remote hub's buttons, in the Hubs panel and the Remote spokes view (Start, Set up, Open, Start a task, a
 *  spoke row or alert's Open, an alert's dismiss). Returns the node to open, "deploy" for the Start-a-task
 *  selector, "repaint" after a dismissal (the alert list, the badges and the cards' alert lines change),
 *  "handled", or null. */
export function onRemoteHubClick(t: HTMLElement): string | "deploy" | "repaint" | "handled" | null {
  if (!deps) return null;
  const x = t.closest("[data-rs-alert-x]") as HTMLElement | null;
  if (x) { dismissAlerts([x.dataset.rsAlertX ?? ""]); return "repaint"; }
  if (t.closest("[data-rs-alert-clear]")) { dismissAlerts(openAlerts(Date.now()).map((a) => a.key)); return "repaint"; }
  if (t.closest("[data-rs-start]")) { void deps.startRemoteSpokes().then(refreshRemote); return "handled"; }
  if (t.closest("[data-rs-panel]")) { deps.openRemoteAdmin(); return "handled"; }
  if (t.closest("[data-rs-view]")) { deps.openRemoteView(); return "handled"; }
  if (t.closest("[data-rs-deploy]")) return "deploy";
  const pip = t.closest("[data-rs-open]") as HTMLElement | null;
  return pip?.dataset.rsOpen ?? null;
}
