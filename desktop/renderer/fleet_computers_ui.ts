// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/fleet_computers_ui.ts - P-FLEET-COMPUTERS.1 (ADR-0615): phase 3 of ADR-0575 in the Fleet window.
//
// Two drawers the Fleet header opens:
//   Computers: This PC and every computer this hub added, with room and state in words, and + Add a computer, a
//     guided copy-paste of the steps that already exist (the other computer's Set up, the org key's Approve a
//     spoke, the other computer's Activate), whose last step (paste the connection card, Add) runs here.
//   This computer is helping <hub>: shown only once this computer helps a hub (add-on This PC is on or off). The
//     person here sees what hubs run here, pauses new work, stops one task or all, and turns helping off or on.
//     They never approve: asks stay the hub's signed decisions (add-on ADR-A109).
// Words and rules are pure, in fleet_computers.ts. Everything a plugin or spoke wrote is set as text, never HTML.

import type { LucidBridge } from "./bridge.ts";
import { $ } from "./dom.ts";
import {
  computerRows, helpingTitle, localTaskWords, parseCard, showsHelping,
  type LocalWorkAnswer, type LocalWorkView, type ThisPcAnswer, type ThisPcView,
} from "./fleet_computers.ts";
import { icon } from "./icons.ts";
import { onRemoteChange, refreshRemote, remoteSnapshot } from "./orbit_remote.ts";
import { armClick, clockLabel } from "./remote_spokes_model.ts";
import { showToast } from "./ui.ts";

export interface ComputersDeps extends Pick<LucidBridge, "addComputer" | "thisPc" | "thisPcWork" | "thisPcAct" | "hubUnlock" | "hubLock"> {
  /** Agents running on This PC now (the Fleet grid's local lanes that have not ended). */
  localRunning: () => number;
  /** Open the Remote Spokes panel's own window, where the other steps of + Add a computer happen. */
  openRemoteAdmin?: () => void;
}

let deps: ComputersDeps | null = null;
let pc: ThisPcView | null = null;
let work: LocalWorkView | null = null;
let pcAt = 0;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();
/** The This PC answer is re-read at most this often from the Fleet poll; an open Helping drawer reads faster. */
const PC_MS = 10_000;
const HELPING_POLL_MS = 3_000;

type DrawerKind = "computers" | "helping" | "unlock";
let drawer: { kind: DrawerKind; node: HTMLElement; close: () => void } | null = null;
/** Armed two-step buttons in the Helping drawer ("stop-all", "off", or a task id): when each was first clicked. */
let armed: Record<string, number> = {};
let helpingTimer: number | null = null;

export function initFleetComputers(d: ComputersDeps): void {
  deps = d;
  onRemoteChange(() => { if (drawer?.kind === "computers") paintComputerList(drawer.node); });
}

/** Call `fn` after every This PC read, so the Fleet header can show or hide its Helping button. */
export function onThisPcChange(fn: () => void): void { listeners.add(fn); }

/** What the Fleet header's Helping button shows: hidden unless this computer helps a hub. */
export function helpingBadge(): { show: boolean; count: number; paused: boolean } {
  return { show: showsHelping(pc), count: work?.tasks.length ?? 0, paused: work?.paused === true };
}

/** Re-read This PC (and its work when it helps a hub). Single flight; `force` skips the PC_MS throttle. */
export function refreshThisPc(force = false): Promise<void> {
  if (!deps) return Promise.resolve();
  if (inflight) return inflight;
  if (!force && Date.now() - pcAt < PC_MS) return Promise.resolve();
  const d = deps;
  pcAt = Date.now();
  inflight = (async () => {
    const a = await d.thisPc().catch(() => null);
    pc = a?.ok ? a.thisPc : null;
    if (showsHelping(pc)) {
      const w = await d.thisPcWork().catch(() => null);
      work = w?.ok ? w.work : null;
    } else work = null;
    for (const fn of listeners) fn();
    if (drawer?.kind === "helping") paintHelping(drawer.node);
  })().finally(() => { inflight = null; });
  return inflight;
}

/** One modal at a time, closed by Done, the backdrop or Escape (captured, so the dock's own Escape does not also
 *  minimize the Fleet window). */
function openDrawer(kind: DrawerKind, html: string): HTMLElement {
  drawer?.close();
  const ov = document.createElement("div");
  ov.className = "modal-ov";
  ov.innerHTML = html;
  const onEsc = (e: KeyboardEvent): void => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
  };
  const close = (): void => {
    window.removeEventListener("keydown", onEsc, true);
    ov.remove();
    if (drawer?.node === ov) drawer = null;
    if (helpingTimer !== null) { window.clearInterval(helpingTimer); helpingTimer = null; }
  };
  window.addEventListener("keydown", onEsc, true);
  ov.addEventListener("click", (e) => { if (e.target === ov || (e.target as HTMLElement).closest("[data-comp-close]")) close(); });
  document.body.appendChild(ov);
  drawer = { kind, node: ov, close };
  return ov;
}

// --------------------------------------------------------------------------------------------- Computers

export function openComputers(): void {
  if (!deps) return;
  const admin = deps.openRemoteAdmin
    ? `<button class="btn-mini" type="button" data-comp-admin>${icon("plugins", 12)} Open Remote Spokes</button>`
    : "";
  const ov = openDrawer("computers", `<div class="modal fleet-comp-modal" role="dialog" aria-modal="true" aria-labelledby="fleetCompTitle">
    <h2 class="modal-title" id="fleetCompTitle">Computers</h2>
    <p class="modal-desc">Computers that run agents for this hub. Each one says how much room it has.</p>
    <div class="fleet-comp-list" data-comp-list></div>
    <details class="fleet-comp-add" data-comp-add>
      <summary>+ Add a computer</summary>
      <ol class="fleet-comp-steps">
        <li><b>On the other computer</b>, open LUCID, then Remote Spokes, <b>This PC as a spoke</b>, and press <b>Set up</b>. It shows a request and a check code. A Linux server runs the installer command instead (see the Remote Spokes guide).</li>
        <li><b>On the computer that holds your org key</b>, open Remote Spokes, <b>Approve a spoke</b>: paste that request, make sure the check code matches the one the other computer shows, and type the org key's password. Copy the certificate it gives you.</li>
        <li><b>Back on the other computer</b>, paste the certificate and press <b>Activate</b>. Copy the connection card it shows: one line that starts with lucid-spoke-card:</li>
        <li><b>Here</b>, paste the card and press Add.</li>
      </ol>
      <textarea class="fleet-spawn-in fleet-comp-card" data-comp-card rows="3" spellcheck="false" autocomplete="off" aria-label="The connection card from the other computer" placeholder="lucid-spoke-card:..."></textarea>
      <div class="fleet-spawn-err" data-comp-err hidden></div>
      <div class="modal-actions">${admin}<button class="btn-mini ok" type="button" data-comp-add-go>${icon("plus", 12)} Add</button></div>
      <p class="fleet-comp-why">Your org key signs each computer, so only computers approved with it can take work from this hub. The card holds nothing secret.</p>
    </details>
    <div class="modal-actions"><button class="btn-mini" type="button" data-comp-close>Done</button></div>
  </div>`);
  paintComputerList(ov);
  ov.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (t.closest("[data-comp-admin]")) { deps?.openRemoteAdmin?.(); return; }
    if (t.closest("[data-comp-add-go]")) void addComputer(ov);
  });
  void refreshRemote();
}

function paintComputerList(ov: HTMLElement): void {
  const list = $("[data-comp-list]", ov);
  const snap = remoteSnapshot();
  if (!list || !deps) return;
  const hub = snap ?? { available: false as const, plugin: "running" as const, reason: "Still reading the computers this hub added." };
  const { rows, note } = computerRows(hub, deps.localRunning(), Date.now());
  list.replaceChildren(...rows.map((r) => {
    const row = document.createElement("div");
    row.className = "fleet-comp-row";
    const name = document.createElement("span");
    name.className = "fleet-comp-name";
    const b = document.createElement("b");
    b.textContent = r.name;
    const small = document.createElement("small");
    small.textContent = r.what;
    name.append(b, small);
    const room = document.createElement("span");
    room.className = "fleet-comp-room";
    room.textContent = r.room;
    const state = document.createElement("span");
    state.className = `fleet-comp-state tone-${r.tone}`;
    state.textContent = r.state;
    if (r.detail) state.title = r.detail;
    row.append(name, room, state);
    return row;
  }));
  if (note) {
    const n = document.createElement("p");
    n.className = "fleet-comp-note";
    n.textContent = note;
    list.append(n);
  }
}

async function addComputer(ov: HTMLElement): Promise<void> {
  if (!deps) return;
  const input = $<HTMLTextAreaElement>("[data-comp-card]", ov);
  const err = $("[data-comp-err]", ov);
  const go = $<HTMLButtonElement>("[data-comp-add-go]", ov);
  const fail = (msg: string): void => { if (err) { err.textContent = msg; err.hidden = false; } };
  const card = parseCard(input?.value ?? "");
  if (!card.ok) { fail(card.error); return; }
  if (err) err.hidden = true;
  if (go) go.disabled = true;
  const r = await deps.addComputer(card.cert).catch(() => null);
  if (go) go.disabled = false;
  if (!r) { fail("The engine did not answer."); return; }
  if (!r.ok) { fail(r.error); return; }
  if (input) input.value = "";
  showToast({ title: "Computer added", desc: "It shows in the list once it answers this hub, usually within a minute." });
  await refreshRemote();
  paintComputerList(ov);
}

// --------------------------------------------------------------------------------------------- Unlock approvals

/** P-FLEET-UNLOCK.1 (ADR-0616): type the hub's presence password once; approvals then sign with one click for the
 *  hub's remember window (Remote Spokes, Admin, Approvals). The field is cleared at once and the password is kept
 *  nowhere here. */
export function openUnlock(): void {
  if (!deps) return;
  const ov = openDrawer("unlock", `<div class="modal fleet-unlock-modal" role="dialog" aria-modal="true" aria-labelledby="fleetUnlockTitle">
    <h2 class="modal-title" id="fleetUnlockTitle">Unlock approvals</h2>
    <p class="modal-desc">Type this hub's presence password once. Until it locks again, approving a computer's waiting action takes one click. How long it stays unlocked is set in Remote Spokes, Admin, Approvals.</p>
    <form data-unlock-form>
      <label class="fleet-spawn-lbl" for="fleetUnlockPw">Presence password</label>
      <input class="fleet-spawn-in fleet-unlock-pw" id="fleetUnlockPw" type="password" autocomplete="off" maxlength="1024" required />
      <div class="fleet-spawn-err" data-unlock-err hidden></div>
      <div class="modal-actions">
        <button class="btn-mini" type="button" data-comp-close>Cancel</button>
        <button class="btn-mini ok" type="submit" data-unlock-go>${icon("shield", 12)} Unlock</button>
      </div>
    </form>
  </div>`);
  const input = $<HTMLInputElement>("#fleetUnlockPw", ov);
  input?.focus();
  $("[data-unlock-form]", ov)?.addEventListener("submit", (e) => {
    e.preventDefault();
    void (async () => {
      const go = $<HTMLButtonElement>("[data-unlock-go]", ov);
      const err = $("[data-unlock-err]", ov);
      const password = input?.value ?? "";
      if (input) input.value = "";
      if (!password || !deps) return;
      if (go) go.disabled = true;
      const r = await deps.hubUnlock(password).catch(() => null);
      if (go) go.disabled = false;
      if (!r || !r.ok) {
        if (err) { err.textContent = r ? r.error : "The engine did not answer."; err.hidden = false; }
        input?.focus();
        return;
      }
      drawer?.close();
      showToast({ title: "Approvals unlocked", desc: r.unlockedUntil ? `Until ${clockLabel(r.unlockedUntil, Date.now())}. Approving a waiting action now takes one click.` : "Approving a waiting action now takes one click." });
      await refreshRemote();
    })();
  });
}

/** Lock the hub's presence key now; the next approval asks for the password again. */
export async function lockApprovals(): Promise<void> {
  if (!deps) return;
  const r = await deps.hubLock().catch(() => null);
  if (!r || !r.ok) { showToast({ title: "Approvals not locked", desc: r ? r.error : "The engine did not answer.", tone: "warn" }); return; }
  showToast({ title: "Approvals locked", desc: "The next approval asks for the presence password again." });
  await refreshRemote();
}

// --------------------------------------------------------------------------------------------- This computer is helping

export function openHelping(): void {
  if (!deps) return;
  const ov = openDrawer("helping", `<div class="modal fleet-help-modal" role="dialog" aria-modal="true" aria-labelledby="fleetHelpTitle">
    <h2 class="modal-title" id="fleetHelpTitle" data-help-title></h2>
    <p class="modal-desc">Work from your hub runs here in its own engine and folder, as your account on this computer. You can always stop it. Approvals stay with the person at the hub.</p>
    <div class="fleet-help-acts" data-help-acts>
      <button class="btn-mini" type="button" data-help-pause></button>
      <button class="btn-mini danger" type="button" data-help-stopall>Stop all work here now</button>
    </div>
    <div class="fleet-help-list" data-help-list></div>
    <details class="fleet-help-past" data-help-past><summary data-help-past-n></summary><div data-help-ended></div></details>
    <div class="fleet-help-foot"><span data-help-foot></span><button class="btn-mini" type="button" data-help-onoff></button></div>
    <div class="fleet-spawn-err" data-help-err hidden></div>
    <div class="modal-actions"><button class="btn-mini" type="button" data-comp-close>Done</button></div>
  </div>`);
  armed = {};
  paintHelping(ov);
  ov.addEventListener("click", (e) => void onHelpingClick(e.target as HTMLElement, ov));
  helpingTimer = window.setInterval(() => void refreshThisPc(true), HELPING_POLL_MS);
  void refreshThisPc(true);
}

function paintHelping(ov: HTMLElement): void {
  const title = $("[data-help-title]", ov);
  const list = $("[data-help-list]", ov);
  if (!title || !list) return;
  const now = Date.now();
  const w: LocalWorkView = work ?? { paused: false, since: 0, tasks: [], ended: [] };
  if (!pc || !showsHelping(pc)) {
    title.textContent = "This computer is not helping a hub";
    list.replaceChildren(text("p", "fleet-comp-note", "Nothing from a hub runs here. To let this computer help, open Remote Spokes, This PC as a spoke."));
    for (const sel of ["[data-help-acts]", "[data-help-past]", ".fleet-help-foot"]) { const n = $(sel, ov); if (n) n.hidden = true; }
    return;
  }
  title.textContent = helpingTitle(pc, w);
  const on = pc.state === "on";
  const acts = $("[data-help-acts]", ov);
  if (acts) acts.hidden = !on;
  const pause = $("[data-help-pause]", ov);
  if (pause) pause.textContent = w.paused ? "Resume new work" : "Pause new work";
  const stopAll = $("[data-help-stopall]", ov);
  if (stopAll) { stopAll.textContent = "stop-all" in armed ? "Click again to stop everything here" : "Stop all work here now"; stopAll.hidden = w.tasks.length === 0; }

  list.replaceChildren(...(w.tasks.length === 0
    ? [text("p", "fleet-comp-note", on ? (w.paused ? "Nothing runs here now, and new work is paused." : "Nothing from a hub runs here right now.") : "Helping is off, so nothing runs here.")]
    : w.tasks.map((t) => {
      const row = document.createElement("div");
      row.className = "fleet-help-row";
      const main = document.createElement("span");
      main.className = "fleet-help-main";
      const b = document.createElement("b");
      b.textContent = t.name;
      main.append(b, text("small", "", `from ${t.hub} \u00b7 ${localTaskWords(t)}${t.waitingOn ? `: ${t.waitingOn}` : ""} \u00b7 ${clockLabel(t.updatedAt, now)}`));
      const x = document.createElement("button");
      x.className = "fleet-card-btn fleet-help-x";
      x.type = "button";
      x.dataset.helpStop = t.id;
      x.disabled = t.stopping;
      x.setAttribute("aria-label", `Stop ${t.name}`);
      if (t.id in armed) { x.textContent = "Click again to stop"; x.classList.add("armed"); } else x.innerHTML = icon("close", 12);
      row.append(main, x);
      return row;
    })));

  const past = $("[data-help-past]", ov);
  if (past) {
    past.hidden = w.ended.length === 0;
    const n = $("[data-help-past-n]", ov);
    if (n) n.textContent = `Finished here (${w.ended.length})`;
    $("[data-help-ended]", ov)?.replaceChildren(...w.ended.map((t) => text("div", "fleet-help-ended", `${t.name} \u00b7 from ${t.hub} \u00b7 ${t.state === "closed" ? "closed" : "stopped"} ${clockLabel(t.updatedAt, now)}`)));
  }
  const foot = $(".fleet-help-foot", ov);
  if (foot) foot.hidden = false;
  const footText = $("[data-help-foot]", ov);
  if (footText) {
    footText.textContent = !on
      ? "Helping is off: no hub can start work here. Turn it back on to help again."
      : w.paused
        ? `New work is paused${w.since ? ` since ${clockLabel(w.since, now)}` : ""}. What runs keeps running.`
        : "Helping is on. Turn it off to stop all work and refuse new work until you turn it back on.";
  }
  const onoff = $("[data-help-onoff]", ov);
  if (onoff) onoff.textContent = on ? ("off" in armed ? "Click again to stop helping" : "Stop helping") : "Turn helping back on";
}

function text(tag: string, cls: string, value: string): HTMLElement {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  n.textContent = value;
  return n;
}

/** The Helping drawer's buttons. Stop one, Stop all and Stop helping ask once (a second click within ARM_MS). */
async function onHelpingClick(t: HTMLElement, ov: HTMLElement): Promise<void> {
  if (!deps || !pc) return;
  const arm = (key: string): boolean => {
    const step = armClick(armed[key] ?? null, Date.now());
    if (step.act === "arm") { armed[key] = step.armedAt!; paintHelping(ov); return false; }
    delete armed[key];
    return true;
  };
  let call: Promise<ThisPcAnswer | LocalWorkAnswer | null> | null = null;
  let done = "";
  const x = t.closest<HTMLElement>("[data-help-stop]");
  if (x?.dataset.helpStop) {
    if (!arm(x.dataset.helpStop)) return;
    call = deps.thisPcAct("stop-task", { task: x.dataset.helpStop });
    done = "Stopped. The hub that started it was told.";
  } else if (t.closest("[data-help-stopall]")) {
    if (!arm("stop-all")) return;
    call = deps.thisPcAct("stop-all", { confirm: "stop all" });
    done = "All work here stopped. The hubs were told.";
  } else if (t.closest("[data-help-pause]")) {
    const paused = work?.paused === true;
    call = deps.thisPcAct(paused ? "resume" : "pause");
    done = paused ? "New work is welcome again." : "New work is paused. What runs keeps running.";
  } else if (t.closest("[data-help-onoff]")) {
    if (pc.state === "on") {
      if (!arm("off")) return;
      call = deps.thisPcAct("off");
      done = "Helping is off. No hub can start work here until you turn it back on.";
    } else {
      call = deps.thisPcAct("on");
      done = "Helping is on again.";
    }
  }
  if (!call) return;
  const err = $("[data-help-err]", ov);
  const r = await call.catch(() => null);
  if (!r || !r.ok) {
    if (err) { err.textContent = r ? r.error : "The engine did not answer."; err.hidden = false; }
  } else {
    if (err) err.hidden = true;
    showToast({ title: "This computer", desc: done });
  }
  await refreshThisPc(true);
}
