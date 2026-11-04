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
  approvalButtons, armClick, REMOTE_STATE_LABEL, REMOTE_TONE, remoteGlance, taskButtons,
  type RecallView, type RemoteApprovalView, type RemoteHubView, type RemoteSpokeView,
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
  setText(card, ".orbit-name", s.label);
  setText(card, ".orbit-glance", remoteGlance(s));
  setText(card, ".orbit-model", s.model ?? "model not reported");
  card.title = `${s.label} (remote spoke ${s.node})\n${REMOTE_STATE_LABEL[s.state]}${s.error ? `\n${s.error}` : ""}`;
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

/** Remote spokes and how many are parked on an approval, for the Other hubs badge. */
export function remoteCounts(): { spokes: number; waiting: number } {
  const list = remoteList();
  return { spokes: list.length, waiting: list.filter((s) => s.state === "approval").length };
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
  const { hub, spokes } = snap;
  const waiting = spokes.filter((s) => s.state === "approval").length;
  return `<div class="orbit-hubrow rs-hubrow" title="${esc(hub.node)}">
      <span class="orbit-ghost-id"><b>${esc(hub.label)}</b><small>remote hub \u00b7 ${spokes.length} ${spokes.length === 1 ? "spoke" : "spokes"}${waiting ? ` \u00b7 ${waiting} waiting on you` : ""} \u00b7 may ${esc(hub.scopes.join(", ") || "nothing")}</small></span>
      <button class="btn-mini orbit-btn" data-rs-panel data-tip="Remote Spokes panel|Setup, user presence, custody, models and provisioning stay in the plugin's own panel.">${icon("link", 12)} Panel</button>
    </div>
    <div class="orbit-hubrow-lanes">${spokes.map((s) => `<button class="fleet-pip rs-pip rs-${REMOTE_TONE[s.state]}" data-rs-open="${esc(s.node)}" data-tip="${esc(s.label)}|${esc(remoteGlance(s))}"><i></i>${esc(s.label)}</button>`).join("")}</div>`;
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
}
let panel: PanelState | null = null;

export function remotePanelNode(): string | null { return panel?.node ?? null; }
export function closeRemotePanel(): void { panel = null; }

function spokeOf(node: string): RemoteSpokeView | null {
  return remoteList().find((s) => s.node === node) ?? null;
}

/** Paint the panel for `node` once; polls only touch its head and task list (typed text survives a poll). */
export function paintRemotePanel(box: HTMLElement, node: string, closeHtml: string): void {
  panel = { node, followTask: null, armed: {}, approvals: [], recall: null, sig: "" };
  const a = snap?.available ? snap.actions : null;
  box.innerHTML = `<div class="orbit-panel-h">${icon("link", 14)}<b data-rs-title></b><span class="rs-state" data-rs-state></span>${closeHtml}</div>
    <p class="rs-note" data-rs-sub></p>
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
    return;
  }
  setText(box, "[data-rs-title]", s.label);
  const st = $("[data-rs-state]", box) as HTMLElement;
  st.className = `rs-state rs-${REMOTE_TONE[s.state]}`;
  setText(box, "[data-rs-state]", REMOTE_STATE_LABEL[s.state]);
  const lanes = s.lanes ? `${s.lanes.live} of ${s.lanes.max} lanes in use` : "lanes not reported";
  setText(box, "[data-rs-sub]", `${lanes} \u00b7 ${s.model ?? "model not reported"}${s.checkedAt ? ` \u00b7 checked ${new Date(s.checkedAt).toLocaleTimeString()}` : ""}${s.error ? ` \u00b7 ${s.error}` : ""}`);
  const may = [a.recall && "recall", a.drive && "drive", a.approve && "approve"].filter(Boolean).join(", ");
  setText(box, "[data-rs-scopes]", `This hub's certificate allows: ${may || "nothing"}. Actions it does not allow are not offered.`);
  const host = $("[data-rs-tasks]", box) as HTMLElement;
  if (s.tasks.length === 0) { host.innerHTML = `<div class="orbit-ghosts-empty">No tasks on this spoke yet.</div>`; return; }
  host.innerHTML = s.tasks.map((t, i) => {
    const b = taskButtons(t, a);
    const meta = `${t.state.replace("_", " ")} \u00b7 ${t.turns} ${t.turns === 1 ? "turn" : "turns"} \u00b7 ${new Date(t.updatedAt).toLocaleString()}${t.reviewBranch ? ` \u00b7 review ${t.reviewBranch}` : ""}${t.interrupted ? " \u00b7 interrupted by a restart" : ""}${t.shadow ? " \u00b7 shadow" : ""}`;
    return `<div class="orbit-ghost rs-task" data-rs-task-i="${i}">
      <i class="orbit-ghost-dot rs-dot-${esc(t.state)}"></i>
      <span class="orbit-ghost-id"><b>${esc(t.name)}</b><small>${esc(meta)}</small></span>
      ${b.recall ? `<button class="btn-mini orbit-btn" data-rs-recall data-tip="Recall this task|Its journal entries, scanned.">${icon("restore", 12)}</button>` : ""}
      ${b.followup ? `<button class="btn-mini orbit-btn" data-rs-follow-open>${icon("send", 12)} Follow up</button>` : ""}
      ${b.cancel ? `<button class="btn-mini orbit-btn" data-rs-cancel>${icon("close", 12)} Cancel</button>` : ""}
      ${b.close ? `<button class="orbit-ghost-x" data-rs-close data-tip="Close|Ends this task's lane on the spoke and frees its slot. Click twice.">${icon("archive", 12)}</button>` : ""}
    </div>`;
  }).join("");
}

function showErr(box: HTMLElement, text: string): void { setText(box, "[data-rs-err]", text); }

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
    if (ctx) void navigator.clipboard.writeText(ctx).then(() => showErr(box, "Copied, delimited as untrusted content."), () => showErr(box, "The clipboard refused the copy."));
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

async function act(box: HTMLElement, op: "submit" | "followup" | "cancel" | "close", input: { task?: string; text?: string; name?: string }, done?: () => void): Promise<void> {
  if (!panel || !deps) return;
  const node = panel.node;
  showErr(box, "Sent; waiting for the spoke\u2026");
  const r = await deps.remoteSpokeAct(op, { node, ...input }).catch(() => null);
  if (panel?.node !== node) return;
  if (!r) { showErr(box, "The engine did not answer."); return; }
  if (!r.ok) { showErr(box, r.error); return; }
  showErr(box, op === "close" ? "Closed: the spoke freed the lane." : "Done.");
  done?.();
  await refreshRemote();
  if (panel?.node === node) { panel.sig = ""; refreshRemotePanel(box); }
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
  showErr(box, r.ok ? (allow ? "Approved: the spoke's engine verified the signed decision." : "Denied.") : r.error);
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

/** The hub picker's buttons (Start, Panel, a spoke pip). Returns the node to open, "handled", or null. */
export function onRemoteHubClick(t: HTMLElement): string | "handled" | null {
  if (!deps) return null;
  if (t.closest("[data-rs-start]")) { void deps.startRemoteSpokes().then(refreshRemote); return "handled"; }
  if (t.closest("[data-rs-panel]")) { deps.openRemoteSpokesPanel(); return "handled"; }
  const pip = t.closest("[data-rs-open]") as HTMLElement | null;
  return pip?.dataset.rsOpen ?? null;
}
