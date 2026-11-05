// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/orbit_remote.ts - P-IDE-SPOKES.1 (ADR-0487): remote spokes on the Fleet Orbit.
//
// The add-on hub (the remote-spokes server plugin) is the source of truth; the engine reads it and this file only
// draws: a remote node per spoke on the same ring as the local lanes (dashed frame, a "remote" tag, the shared
// state hues by remote_spokes_model.ts REMOTE_TONE), a Remote hub section in the Other hubs panel, and a side panel
// per spoke for its tasks, parked actions and recall. A remote spoke is never promoted into the composer: it is
// another machine, driven through its hub.
//
// ADR-0489 adds the Start-a-task selector (every spoke as a radio row with how fast it answers, its route, models,
// free lanes and certificate region and classification; ineligible rows say why) and a Models section in the
// per-spoke panel. Both start tasks through the same submit path as the panel's own "New task".
//
// ADR-0490: an alert line on each remote card (silent since, crashed, restarted, turn interrupted) and a
// dismissible alert list in the Remote hub section (dismissals kept in localStorage by a key stable across polls);
// host facts and the lane policy's why in the selector rows and the panel; a task a restart interrupted offers
// Resume, armed like Approve, which sends RESUME_TEXT through the existing followup route. Nothing re-runs alone.
//
// Untrusted text rule: everything a spoke wrote reaches the DOM through textContent or esc(), never as markup.
// Recalled entries arrive already scanned (a quarantined entry has no text at all); the only way recalled text
// leaves this panel is "Copy for a prompt", which copies the engine's delimited UNTRUSTED_CONTENT envelope.
// Buttons appear only for what the hub certificate's scopes allow; the engine re-checks every action anyway.
// Approve and Close keep the plugin panel's two-click rule (armClick). On a `password` hub (ADR-0488 amendment) the
// first Approve click opens a password field instead, and the second signs with what was typed; the field is
// emptied at once and the password goes only into that one decide request.

import { $ } from "./dom.ts";
import { esc } from "./format.ts";
import { icon } from "./icons.ts";
import type { LucidBridge } from "./bridge.ts";
import type { OrbitSlot } from "./orbit_layout.ts";
import {
  approvalButtons, armClick, clockLabel, deployChoices, hostLabel, lanePolicyLabel, latencyLabel, mibLabel, modelCount, REMOTE_TONE, remoteGlance, RESUME_TEXT,
  spokeAlerts, stateLabel, taskButtons, VIA_LABEL,
  type DeployChoice, type RecallView, type RemoteAlertItem, type RemoteApprovalView, type RemoteClassification, type RemoteHubView, type RemoteModelsView,
  type RemoteSpokeView,
} from "./remote_spokes_model.ts";

export interface OrbitRemoteDeps {
  remoteSpokes: LucidBridge["remoteSpokes"];
  remoteSpokeRecall: LucidBridge["remoteSpokeRecall"];
  remoteSpokeApprovals: LucidBridge["remoteSpokeApprovals"];
  remoteSpokeDecide: LucidBridge["remoteSpokeDecide"];
  remoteSpokeAct: LucidBridge["remoteSpokeAct"];
  /** Start the remote-spokes plugin (the sanctioned pluginsStart path) so its spokes appear. */
  startRemoteSpokes: () => Promise<void>;
  /** Start it and open its own panel in a plugin tab (setup, presence, custody: everything the IDE leaves there). */
  openRemoteSpokesPanel: () => void;
}

let deps: OrbitRemoteDeps | null = null;
/** The engine's last answer; null before the first one (or when the engine did not answer). */
let snap: RemoteHubView | null = null;
const remoteNodes = new Map<string, { card: HTMLElement; line: SVGLineElement }>();

export function initOrbitRemote(d: OrbitRemoteDeps): void { deps = d; }

let inflight: Promise<void> | null = null;

/** Re-read the hub. Kept separate from the lane poll so a slow plugin never delays the local ring, and single-
 *  flight so polls that outpace a slow answer join it instead of stacking requests. */
export function refreshRemote(): Promise<void> {
  if (!deps) return Promise.resolve();
  if (inflight) return inflight;
  const d = deps;
  inflight = d.remoteSpokes().catch(() => null).then((s) => { if (s) snap = s; }).finally(() => { inflight = null; });
  return inflight;
}

export function remoteList(): RemoteSpokeView[] {
  return snap?.available ? snap.spokes : [];
}

// ------------------------------------------------------------------------------ alerts (ADR-0490)

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

/** Create, repaint and drop remote nodes like reconcile() does for lanes (cards are never rebuilt). */
export function reconcileRemote(stage: HTMLElement, svg: SVGSVGElement, first: boolean): void {
  const spokes = remoteList();
  const seen = new Set<string>();
  spokes.forEach((s, i) => {
    seen.add(s.node);
    let entry = remoteNodes.get(s.node);
    if (!entry) {
      const card = buildRemoteNode(s.node);
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      svg.appendChild(line);
      stage.appendChild(card);
      entry = { card, line };
      remoteNodes.set(s.node, entry);
      card.style.setProperty("--tx", "0px");
      card.style.setProperty("--ty", "0px");
      card.style.transitionDelay = first ? `${Math.min(i * 60, 600)}ms` : "0ms";
      card.classList.add("orbit-enter");
      requestAnimationFrame(() => card.classList.remove("orbit-enter"));
    }
    paintRemoteNode(entry.card, s);
    entry.line.setAttribute("class", `orbit-line remote rs-${REMOTE_TONE[s.state]}`);
  });
  for (const [node, entry] of remoteNodes) {
    if (seen.has(node)) continue;
    remoteNodes.delete(node);
    entry.line.remove();
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
  // ADR-0490: the newest alert line the human has not dismissed (a silence first: it is the one still going on).
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

/** ADR-0489: whether the orbit offers "Start a remote task": the hub may drive and has at least one spoke. */
export function remoteDeployVisible(): boolean {
  return snap !== null && snap.available && snap.actions.drive && snap.spokes.length > 0;
}

/** Place remote nodes on the slots after the local lanes'. */
export function layoutRemote(slots: readonly OrbitSlot[], cx: number, cy: number): void {
  remoteList().forEach((s, i) => {
    const entry = remoteNodes.get(s.node);
    const slot = slots[i];
    if (!entry || !slot) return;
    entry.card.style.setProperty("--tx", `${Math.round(slot.x)}px`);
    entry.card.style.setProperty("--ty", `${Math.round(slot.y)}px`);
    entry.line.setAttribute("x1", String(cx));
    entry.line.setAttribute("y1", String(cy));
    entry.line.setAttribute("x2", String(cx + slot.x));
    entry.line.setAttribute("y2", String(cy + slot.y));
  });
}

// ------------------------------------------------------------------------- the hub picker's section

/** Remote spokes, how many are parked on an approval, and (ADR-0490) how many alert lines are not dismissed, for
 *  the Other hubs badge. */
export function remoteCounts(): { spokes: number; waiting: number; alerts: number } {
  const list = remoteList();
  return { spokes: list.length, waiting: list.filter((s) => s.state === "approval").length, alerts: openAlerts(Date.now()).length };
}

/** Whether the Other hubs panel has a Remote hub section to show: the hub's spokes, or a plugin that is installed
 *  but stopped or not set up (the section offers Start or the panel). An uninstalled plugin adds nothing. */
export function remoteHubVisible(): boolean {
  return snap !== null && (snap.available || snap.plugin !== "missing");
}

/** The Remote hub section of the Other hubs panel: the add-on hub and its spokes, or why there are none. Empty
 *  while the engine has not answered, so a panel never flashes a wrong reason. */
export function remoteHubSectionHtml(): string {
  if (!snap || !remoteHubVisible()) return "";
  if (!snap.available) {
    const btn = snap.plugin === "stopped"
      ? `<button class="btn-mini orbit-btn" data-rs-start data-tip="Start Remote Spokes|Starts the Remote Spokes plugin so this hub's remote spokes join the orbit.">${icon("bolt", 12)} Start</button>`
      : `<button class="btn-mini orbit-btn" data-rs-panel>${icon("link", 12)} Open panel</button>`;
    return `<div class="orbit-hubrow rs-hubrow"><span class="orbit-ghost-id"><b>Remote hub</b><small>${esc(snap.reason)}</small></span>${btn}</div>`;
  }
  const { hub, spokes, actions } = snap;
  const waiting = spokes.filter((s) => s.state === "approval").length;
  return `<div class="orbit-hubrow rs-hubrow" title="${esc(hub.node)}">
      <span class="orbit-ghost-id"><b>${esc(hub.label)}</b><small>remote hub \u00b7 ${spokes.length} ${spokes.length === 1 ? "spoke" : "spokes"}${waiting ? ` \u00b7 ${waiting} waiting on you` : ""} \u00b7 may ${esc(hub.scopes.join(", ") || "nothing")}</small></span>
      ${actions.drive ? `<button class="btn-mini orbit-btn" data-rs-deploy data-tip="Start a task on a remote spoke|Pick a spoke by how fast it answers, its models and its free lanes, then start a task there.">${icon("bolt", 12)} Start a task</button>` : ""}
      <button class="btn-mini orbit-btn" data-rs-panel data-tip="Remote Spokes panel|Setup, user presence, custody, models and provisioning stay in the plugin's own panel.">${icon("link", 12)} Panel</button>
    </div>
    <div class="orbit-hubrow-lanes">${spokes.map((s) => `<button class="fleet-pip rs-pip rs-${REMOTE_TONE[s.state]}" data-rs-open="${esc(s.node)}" data-tip="${esc(s.label)}|${esc(remoteGlance(s))}"><i></i>${esc(s.label)}</button>`).join("")}</div>${alertListHtml()}`;
}

/** ADR-0490: how many alert lines the Remote hub section lists; the rest wait behind "Dismiss all". */
const ALERT_LIST_MAX = 12;

/** ADR-0490: the alert lines not dismissed yet, newest first: a spoke gone silent, crashed, restarted, or a turn a
 *  restart cut off (resumed from the spoke's panel, never on its own). Each line opens its spoke or is dismissed.
 *  Every spoke-written word goes through esc(); the dismiss key is built from the node id, a closed kind and a
 *  number. */
function alertListHtml(): string {
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
}
let panel: PanelState | null = null;

export function remotePanelNode(): string | null { return panel?.node ?? null; }
export function closeRemotePanel(): void { panel = null; }

function spokeOf(node: string): RemoteSpokeView | null {
  return remoteList().find((s) => s.node === node) ?? null;
}

const CLASSIFICATION_LABEL: Readonly<Record<RemoteClassification, string>> = { private: "private", shareable: "shareable", cui: "CUI" };

/** ADR-0489: a model list longer than this folds into a details that shows its count. */
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
  panel = { node, followTask: null, armed: {}, approvals: [], recall: null, sig: "", modelsSig: "" };
  const a = snap?.available ? snap.actions : null;
  box.innerHTML = `<div class="orbit-panel-h">${icon("link", 14)}<b data-rs-title></b><span class="rs-state" data-rs-state></span>${closeHtml}</div>
    <p class="rs-note" data-rs-sub></p>
    <p class="rs-note" data-rs-host hidden></p>
    <p class="rs-note" data-rs-lanes hidden></p>
    <p class="rs-note" data-rs-scopes></p>
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
    <p class="rs-note">The default is what new tasks use; change it in the Remote Spokes panel (it restarts the spoke's engine).</p>
    ${a?.recall ? `<div class="rs-sec-h"><span>Parked actions</span><button class="btn-mini orbit-btn" data-rs-approvals>${icon("refresh", 12)} Check</button></div>
    <div data-rs-approvals-out></div>
    <div class="rs-sec-h"><span>Recall</span><button class="btn-mini orbit-btn" data-rs-recall-all data-tip="Recall|Reads this spoke's signed journal. Every entry passes the scanner first; a flagged entry is withheld.">${icon("restore", 12)} Whole journal</button><button class="btn-mini orbit-btn" data-rs-copy hidden data-tip="Copy for a prompt|Copies the entries that passed the scanner inside UNTRUSTED_CONTENT delimiters, the only form recalled text may take into a prompt. Withheld entries are not included.">${icon("copy", 12)} Copy for a prompt</button></div>
    <div data-rs-recall-out></div>` : ""}
    <small class="orbit-ghost-err" data-rs-err></small>`;
  refreshRemotePanel(box);
}

/** Per poll: the head and the task list, only when they changed. Gone from the hub: say so, keep the panel. */
export function refreshRemotePanel(box: HTMLElement): void {
  if (!panel) return;
  const s = spokeOf(panel.node);
  const a = snap?.available ? snap.actions : null;
  const sig = JSON.stringify([s, a]);
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
  // ADR-0490: the machine the spoke runs on and why it runs as many lanes as it does.
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
  setText(box, "[data-rs-scopes]", `This hub's certificate allows: ${may || "nothing"}. Actions it does not allow are not offered.`);
  const host = $("[data-rs-tasks]", box) as HTMLElement;
  if (s.tasks.length === 0) { host.innerHTML = `<div class="orbit-ghosts-empty">No tasks on this spoke yet.</div>`; return; }
  host.innerHTML = s.tasks.map((t, i) => {
    const b = taskButtons(t, a);
    const meta = `${t.state.replace("_", " ")} \u00b7 ${t.turns} ${t.turns === 1 ? "turn" : "turns"} \u00b7 ${new Date(t.updatedAt).toLocaleString()}${t.reviewBranch ? ` \u00b7 review ${t.reviewBranch}` : ""}${t.interrupted ? ` \u00b7 interrupted by a restart at ${clockLabel(t.interrupted, now)}` : ""}${t.shadow ? " \u00b7 shadow" : ""}`;
    return `<div class="orbit-ghost rs-task${t.interrupted ? " interrupted" : ""}" data-rs-task-i="${i}">
      <i class="orbit-ghost-dot rs-dot-${esc(t.state)}"></i>
      <span class="orbit-ghost-id"><b>${esc(t.name)}</b><small>${esc(meta)}</small></span>
      ${b.resume ? `<button class="btn-mini orbit-btn rs-resume" data-rs-resume data-tip="Resume|Sends one follow-up asking the task to continue and to check what was already done first. Click twice. Nothing re-runs on its own.">${icon("restore", 12)} Resume</button>` : ""}
      ${b.recall ? `<button class="btn-mini orbit-btn" data-rs-recall data-tip="Recall this task|Its journal entries, scanned.">${icon("restore", 12)}</button>` : ""}
      ${b.followup ? `<button class="btn-mini orbit-btn" data-rs-follow-open>${icon("send", 12)} Follow up</button>` : ""}
      ${b.cancel ? `<button class="btn-mini orbit-btn" data-rs-cancel>${icon("close", 12)} Cancel</button>` : ""}
      ${b.close ? `<button class="orbit-ghost-x" data-rs-close data-tip="Close|Ends this task's lane on the spoke and frees its slot. Click twice.">${icon("archive", 12)}</button>` : ""}
    </div>`;
  }).join("");
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
    ($("[data-rs-follow-text]", box) as HTMLTextAreaElement).focus();
    return true;
  }
  if (task && t.closest("[data-rs-cancel]")) { void act(box, "cancel", { task: task.id }); return true; }
  // ADR-0490: Resume is the human's call, armed like Approve; the second click sends RESUME_TEXT as a follow-up.
  const resumeBtn = t.closest("[data-rs-resume]") as HTMLElement | null;
  if (task && resumeBtn) {
    const key = `resume:${task.id}`;
    const step = armClick(panel.armed[key] ?? null, Date.now());
    if (step.act === "arm") { panel.armed[key] = step.armedAt!; resumeBtn.textContent = "Click again to resume"; resumeBtn.classList.add("armed"); return true; }
    delete panel.armed[key];
    void act(box, "followup", { task: task.id, text: RESUME_TEXT });
    return true;
  }
  const closeBtn = t.closest("[data-rs-close]") as HTMLElement | null;
  if (task && closeBtn) {
    const key = `close:${task.id}`;
    const step = armClick(panel.armed[key] ?? null, Date.now());
    if (step.act === "arm") { panel.armed[key] = step.armedAt!; closeBtn.classList.add("armed"); closeBtn.dataset.tip = "Click again to close|Ends the lane on the spoke."; return true; }
    delete panel.armed[key];
    void act(box, "close", { task: task.id });
    return true;
  }
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
  const card = t.closest("[data-rs-ask-i]") as HTMLElement | null;
  const item = card ? panel.approvals[Number(card.dataset.rsAskI)] : undefined;
  if (item && card) {
    const approve = t.closest("[data-rs-approve]") as HTMLButtonElement | null;
    const field = card.querySelector("[data-rs-password]") as HTMLInputElement | null;
    if (approve && field) {
      // A password hub: the first click opens the field, the next (or Enter) signs with what was typed. The field
      // is emptied at once; the password lives only in this one request.
      if (field.hidden) { field.hidden = false; approve.textContent = "Sign with the hub's password"; approve.classList.add("armed"); field.focus(); return true; }
      const password = field.value;
      field.value = "";
      if (!password) { showErr(box, "Type this hub's presence password to sign the approval."); field.focus(); return true; }
      void decide(box, item, true, password);
      return true;
    }
    if (approve) {
      const key = `approve:${item.task}:${item.ask.id}`;
      const step = armClick(panel.armed[key] ?? null, Date.now());
      if (step.act === "arm") { panel.armed[key] = step.armedAt!; approve.textContent = "Click again to sign the approval"; approve.classList.add("armed"); return true; }
      delete panel.armed[key];
      void decide(box, item, true);
      return true;
    }
    if (t.closest("[data-rs-deny]")) { void decide(box, item, false); return true; }
  }
  return t.closest("[data-rs-new], [data-rs-follow], [data-rs-password]") !== null;
}

type RemoteOp = "submit" | "followup" | "cancel" | "close";

/** One action on a spoke through the engine, then a fresh hub read so every view shows its effect. The panel's
 *  buttons and the Start-a-task selector both go through here. Returns null when the spoke accepted it, else
 *  the refusal in words. */
async function sendAct(node: string, op: RemoteOp, input: { task?: string; text?: string; name?: string }): Promise<string | null> {
  if (!deps) return "The fleet is not ready.";
  const r = await deps.remoteSpokeAct(op, { node, ...input }).catch(() => null);
  if (!r) return "The engine did not answer.";
  if (!r.ok) return r.error;
  await refreshRemote();
  return null;
}

async function act(box: HTMLElement, op: RemoteOp, input: { task?: string; text?: string; name?: string }, done?: () => void): Promise<void> {
  if (!panel) return;
  const node = panel.node;
  showErr(box, "Sent; waiting for the spoke\u2026");
  const error = await sendAct(node, op, input);
  if (panel?.node !== node) return;
  if (error) { showErr(box, error); return; }
  showErr(box, op === "close" ? "Closed: the spoke freed the lane." : "Done.", true);
  done?.();
  panel.sig = "";
  refreshRemotePanel(box);
}

async function loadApprovals(box: HTMLElement): Promise<void> {
  if (!panel || !deps) return;
  const node = panel.node;
  const out = $("[data-rs-approvals-out]", box) as HTMLElement | null;
  if (!out) return;
  out.textContent = "Asking the spoke\u2026";
  const r = await deps.remoteSpokeApprovals(node).catch(() => null);
  if (panel?.node !== node) return;
  if (!r || !r.ok) { out.textContent = r ? r.error : "The engine did not answer."; return; }
  panel.approvals = r.approvals;
  const a = snap?.available ? snap.actions : null;
  if (r.approvals.length === 0) { out.textContent = "Nothing is waiting on this spoke."; return; }
  out.replaceChildren(...r.approvals.map((v, i) => approvalCard(v, i, a ? approvalButtons(v, a) : { approve: false, deny: false })));
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
    // ADR-0488 amendment: a `password` hub's Approve opens this field; the typed password is the second step.
    if (snap?.available && snap.hub.presence === "password") {
      const pw = document.createElement("input");
      pw.type = "password"; pw.dataset.rsPassword = ""; pw.hidden = true; pw.maxLength = 1024; pw.autocomplete = "off"; pw.placeholder = "the hub's presence password";
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
  if (!panel || !deps) return;
  const node = panel.node;
  showErr(box, allow ? (password ? "Signing with the hub's password\u2026" : "Signing; the hub may ask you to confirm it is you\u2026") : "Denying\u2026");
  const r = await deps.remoteSpokeDecide({ node, task: item.task, ask: item.ask.id, digest: item.ask.digest, allow, ...(password ? { password } : {}) }).catch(() => null);
  if (panel?.node !== node) return;
  if (!r) { showErr(box, "The engine did not answer."); return; }
  showErr(box, r.ok ? (allow ? "Approved: the spoke's engine verified the signed decision." : "Denied.") : r.error, r.ok);
  await loadApprovals(box);
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

// ------------------------------------------------------------- the Start-a-task selector (ADR-0489)

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
  // ADR-0490: the machine (cores, memory, each GPU and its memory) and why the spoke runs as many lanes as it does.
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
  const eligible = choices.filter((c) => c.eligible).length;
  setText(box, "[data-rs-dep-n]", choices.length ? `${eligible} of ${choices.length} ready` : "");
  const go = $("[data-rs-dep-go]", box) as HTMLButtonElement | null;
  if (go) go.disabled = deploy.busy || eligible === 0;
  if (!snap || !snap.available) { list.innerHTML = `<div class="orbit-ghosts-empty">${esc(snap ? snap.reason : "Asking the hub\u2026")}</div>`; return; }
  if (choices.length === 0) { list.innerHTML = `<div class="orbit-ghosts-empty">This hub has no spokes yet. Enroll one in the Remote Spokes panel.</div>`; return; }
  const now = Date.now();
  list.innerHTML = choices.map((c) => choiceHtml(c, c.spoke.node === deploy?.chosen, now)).join("");
}

function showDeployErr(box: HTMLElement, text: string): void { setText(box, "[data-rs-dep-err]", text); }

/** Clicks inside the selector. `openSpoke` opens a spoke's side panel (the orbit owns the panels). Returns true
 *  when the click was one of its controls. */
export function onDeployPanelClick(t: HTMLElement, box: HTMLElement, openSpoke: (node: string) => void): boolean {
  if (!deploy) return false;
  if (t.closest("[data-rs-dep-go]")) { void startDeploy(box, openSpoke); return true; }
  return t.closest("[data-rs-dep-list], [data-rs-dep-name], [data-rs-dep-text]") !== null;
}

async function startDeploy(box: HTMLElement, openSpoke: (node: string) => void): Promise<void> {
  if (!deploy || deploy.busy) return;
  const node = box.querySelector<HTMLInputElement>("input[name=rs-deploy]:checked")?.value ?? null;
  const choice = snap?.available ? deployChoices(snap.spokes, snap.actions).find((c) => c.spoke.node === node) : undefined;
  if (!node || !choice) { showDeployErr(box, "Pick a spoke first."); return; }
  if (!choice.eligible) { showDeployErr(box, `${choice.spoke.label} cannot take a task now: ${choice.why}.`); return; }
  const text = ($("[data-rs-dep-text]", box) as HTMLTextAreaElement).value;
  const name = ($("[data-rs-dep-name]", box) as HTMLInputElement).value.trim();
  if (!text.trim()) { showDeployErr(box, "Write the task's first turn."); return; }
  const state = deploy;
  state.busy = true;
  const go = $("[data-rs-dep-go]", box) as HTMLButtonElement;
  go.disabled = true;
  showDeployErr(box, `Sent to ${choice.spoke.label}; waiting for the spoke\u2026`);
  const error = await sendAct(node, "submit", { text, ...(name ? { name } : {}) });
  state.busy = false;
  if (deploy !== state) return; // the selector was closed meanwhile; the task still started (or not) on the spoke
  if (error) { go.disabled = false; showDeployErr(box, error); return; }
  openSpoke(node);
  showErr(box, `Task started on ${choice.spoke.label}; it shows in Tasks at the next refresh (up to 15 s).`, true);
}

/** The hub picker's buttons (Start, Panel, Start a task, a spoke pip or alert's Open, an alert's dismiss). Returns
 *  the node to open, "deploy" for the Start-a-task selector, "repaint" after a dismissal (the section, the badge
 *  and the cards' alert lines change), "handled", or null. */
export function onRemoteHubClick(t: HTMLElement): string | "deploy" | "repaint" | "handled" | null {
  if (!deps) return null;
  const x = t.closest("[data-rs-alert-x]") as HTMLElement | null;
  if (x) { dismissAlerts([x.dataset.rsAlertX ?? ""]); return "repaint"; }
  if (t.closest("[data-rs-alert-clear]")) { dismissAlerts(openAlerts(Date.now()).map((a) => a.key)); return "repaint"; }
  if (t.closest("[data-rs-start]")) { void deps.startRemoteSpokes().then(refreshRemote); return "handled"; }
  if (t.closest("[data-rs-panel]")) { deps.openRemoteSpokesPanel(); return "handled"; }
  if (t.closest("[data-rs-deploy]")) return "deploy";
  const pip = t.closest("[data-rs-open]") as HTMLElement | null;
  return pip?.dataset.rsOpen ?? null;
}
