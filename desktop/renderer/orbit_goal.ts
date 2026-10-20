// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/orbit_goal.ts - P-AOS.1 (ADR-0452): the fleet goal on the orbit, AOS-1 section 8.
//
// The standard asks a conforming dashboard for: the goal and its criteria progress, a live heartbeat
// (seq, age, liveness), the agent roster, and pause / resume / cancel. LUCID's version puts them where
// the fleet already lives: a Goal button in the orbit header (criteria count + a heartbeat dot), a
// progress ring around the hub that also takes the heartbeat's liveness color, stalled spokes marked on
// the ring, and the full goal in the orbit's side panel (set form, checklist, budget, heartbeat,
// roster, controls). Liveness is recomputed locally every second from the last beat's timestamp, so a
// frozen engine (whose poll never answers) still turns the dot late, then dead, on its own.
//
// P-AOS.2 (ADR-0453): the panel also holds the task board by status (section 8) and the add-task form.
// The form lives in its own host the poll never repaints, so a status change never wipes what you type.

import { aosLiveness, goalProgress, humanSeconds, isTerminalGoal, isTerminalTask, type AosAgentStatus, type AosLiveness, type AosTask, type AosTaskStatus } from "../aos.ts";
import type { AosControl, AosSnapshot, FleetGoalReply, LucidBridge } from "./bridge.ts";
import { esc } from "./format.ts";
import { icon } from "./icons.ts";

export interface OrbitGoalDeps {
  fleetGoal: LucidBridge["fleetGoal"];
  fleetGoalSet: LucidBridge["fleetGoalSet"];
  fleetGoalCriterion: LucidBridge["fleetGoalCriterion"];
  fleetGoalControl: LucidBridge["fleetGoalControl"];
  fleetTaskAdd: LucidBridge["fleetTaskAdd"];
  fleetTaskCheck: LucidBridge["fleetTaskCheck"];
  fleetTaskCancel: LucidBridge["fleetTaskCancel"];
}

let snap: AosSnapshot | null = null;

/** The last snapshot the engine answered with (null before the first answer). */
export function goalSnapshot(): AosSnapshot | null {
  return snap;
}

/** Fetch the goal snapshot. A failed read keeps the last one: its beat simply ages toward "dead". */
export async function refreshGoal(d: OrbitGoalDeps): Promise<AosSnapshot | null> {
  const s = await d.fleetGoal().catch(() => null);
  if (s) snap = s;
  return snap;
}

/** The heartbeat's liveness right now, from the last beat seen. Null before any answer. */
export function goalLiveness(now: number): AosLiveness | null {
  return snap ? aosLiveness(now - snap.heartbeat.ts, snap.heartbeat.intervalS) : null;
}

/** Lanes the heartbeat reaped as stalled (AOS-1 Reap). */
export function stalledLanes(): Set<string> {
  return new Set(snap?.agents.filter((a) => a.status === "stalled").map((a) => a.laneId) ?? []);
}

/** The header button's inner HTML: the criteria count when a goal is open, a heartbeat dot always
 *  ("unknown", neutral, until the engine first answers: no answer yet is not a dead engine). */
export function goalButtonHtml(now: number): string {
  const live = goalLiveness(now) ?? "unknown";
  const dot = `<i class="orbit-goal-dot" data-liveness="${live}"></i>`;
  if (!snap?.goal) return `${dot}${icon("checkBadge", 13)} Goal`;
  const p = goalProgress(snap);
  return `${dot}${icon("checkBadge", 13)} Goal <b class="orbit-ghost-n">${p.met}/${p.total}</b>`;
}

/** The header button's tooltip: what the goal and the heartbeat are doing, in words. */
export function goalButtonTip(now: number): string {
  const live = goalLiveness(now);
  const beat = snap && live ? `The engine's heartbeat #${snap.heartbeat.seq}, ${humanSeconds((now - snap.heartbeat.ts) / 1000)} ago, ${live}.` : "No heartbeat from the engine yet.";
  if (!snap?.goal) return `Fleet goal|No goal set. One standing goal with success criteria and a budget that every spoke works toward (AOS-1). ${beat}`;
  const g = snap.goal;
  return `Fleet goal|${g.title}. ${g.status}${g.blockedReason ? `: ${g.blockedReason}` : ""}. ${beat}`;
}

/** Paint the hub ring: criteria progress, goal status and heartbeat liveness, as data the CSS reads. */
export function paintHubGoal(hub: HTMLElement, now: number): void {
  const live = goalLiveness(now) ?? "unknown";
  if (hub.dataset.liveness !== live) hub.dataset.liveness = live;
  const g = snap?.goal ?? null;
  hub.classList.toggle("has-goal", !!g);
  const status = g?.status ?? "";
  if ((hub.dataset.goal ?? "") !== status) hub.dataset.goal = status;
  const pct = g && snap ? goalProgress(snap).pct : 0;
  const v = String(pct);
  if (hub.style.getPropertyValue("--goal-pct") !== v) hub.style.setProperty("--goal-pct", v);
}

const AGENT_WORD: Record<AosAgentStatus, string> = { idle: "idle", running: "running", errored: "errored", stalled: "stalled" };

/** The side panel body. No open goal: the set form. Otherwise the goal itself. */
export function goalPanelHtml(now: number, closeBtn: string): string {
  const head = `<div class="orbit-panel-h">${icon("checkBadge", 14)}<b>Fleet goal</b><span>AOS-1</span>${closeBtn}</div>`;
  const live = goalLiveness(now);
  const hb = snap?.heartbeat;
  const beat = hb && live
    ? `<div class="orbit-goal-beat" data-liveness="${live}"><i class="orbit-goal-dot" data-liveness="${live}"></i><span data-goal-beat>${beatLine(now)}</span></div>`
    : `<div class="orbit-goal-beat" data-liveness="unknown"><i class="orbit-goal-dot" data-liveness="unknown"></i><span data-goal-beat>Waiting for the engine's first heartbeat.</span></div>`;
  // Before the engine first answers, offer nothing to fill in: a goal may already exist.
  if (!snap) return `${head}${beat}<p class="orbit-goal-lede">Reading the fleet goal from the engine\u2026</p>`;
  const g = snap.goal;
  if (!g) {
    return `${head}${beat}
      <p class="orbit-goal-lede">One standing goal every spoke works toward. You verify each criterion; the heartbeat watches the budget and marks spokes that went silent mid-turn as stalled.</p>
      <label class="orbit-spawn-l">goal<input type="text" data-goal-title maxlength="200" placeholder="what the fleet is trying to get done"></label>
      <label class="orbit-spawn-l">success criteria <i>one per line</i><textarea data-goal-criteria rows="4" placeholder="Every test passes on CI&#10;The release notes name each change"></textarea></label>
      <div class="orbit-goal-caps">
        <label class="orbit-spawn-l">spend cap (USD)<input type="number" data-goal-usd min="0.01" step="0.5" value="20"></label>
        <label class="orbit-spawn-l">time cap (hours)<input type="number" data-goal-hours min="0.1" step="0.5" value="8"></label>
      </div>
      <div class="orbit-spawn-row"><button class="btn-mini orbit-btn orbit-spawn-go" data-goal-start>${icon("bolt", 13)} Start goal</button></div>
      <small class="orbit-ghost-err" data-goal-err></small>`;
  }
  const p = goalProgress(snap);
  const terminal = isTerminalGoal(g.status);
  const paused = snap.heartbeat.status === "paused";
  const crit = g.criteria.map((c) => `<label class="orbit-goal-crit${c.met ? " met" : ""}" title="${esc(c.text)}"><input type="checkbox" data-goal-crit="${esc(c.id)}"${c.met ? " checked" : ""}${terminal ? " disabled" : ""}><span>${esc(c.text)}</span></label>`).join("");
  const roster = snap.agents.length
    ? snap.agents.map((a) => `<div class="orbit-goal-agent" data-agent="${a.status}" title="${esc(a.name)}"><i></i><b>${esc(a.name)}</b><small>${AGENT_WORD[a.status]}</small></div>`).join("")
    : `<div class="orbit-ghosts-empty">No spokes yet. Spokes you spawn work toward this goal.</div>`;
  const controls = terminal
    ? `<button class="btn-mini orbit-btn" data-goal-control="dismiss">${icon("close", 12)} Dismiss</button>`
    : `${paused
        ? `<button class="btn-mini orbit-btn" data-goal-control="resume">${icon("bolt", 12)} Resume</button>`
        : `<button class="btn-mini orbit-btn" data-goal-control="pause">${icon("minus", 12)} Pause</button>`}
       <button class="btn-mini orbit-btn orbit-deny" data-goal-control="cancel" data-tip="Cancel the goal|Ends it for good (AOS-1 terminal state). Spokes keep running; only the goal stops.">${icon("stopBadge", 12)} Cancel goal</button>`;
  return `${head}${beat}
    <div class="orbit-goal-title" data-goal-status="${g.status}"><b title="${esc(g.title)}">${esc(g.title)}</b><span class="orbit-goal-pill">${esc(paused && !terminal ? "paused" : g.status)}</span></div>
    ${g.blockedReason ? `<p class="orbit-goal-why">Blocked, ${esc(g.blockedReason)}. Tick the criteria that are done, or cancel and set a new goal with a larger budget.</p>` : ""}
    <div class="orbit-goal-bar" style="--goal-pct:${p.pct}"><i></i></div>
    <div class="orbit-goal-sub">${p.met} of ${p.total} criteria met</div>
    <div class="orbit-goal-list">${crit}</div>
    <div class="orbit-goal-budget"><span>spend</span><b>${esc(p.spend)}</b><span>time</span><b>${esc(p.time)}</b></div>
    <div class="orbit-panel-h orbit-goal-h2">${icon("share", 13)}<b>Spokes</b><span>${snap.agents.length}</span></div>
    <div class="orbit-goal-roster">${roster}</div>
    ${taskBoardHtml(g.tasks)}
    <div class="orbit-spawn-row orbit-goal-ctl">${controls}</div>
    <small class="orbit-ghost-err" data-goal-err></small>`;
}

/** The heartbeat line, refreshed every second while the panel is open. */
export function beatLine(now: number): string {
  const live = goalLiveness(now);
  if (!snap || !live) return "Waiting for the engine's first heartbeat.";
  const hb = snap.heartbeat;
  const age = humanSeconds((now - hb.ts) / 1000);
  const state = hb.status === "paused" ? ", paused" : hb.status === "stopped" ? ", stopped" : "";
  return `Heartbeat #${hb.seq} ${age} ago, every ${hb.intervalS} s: ${live}${state}`;
}

/** A panel click aimed at the goal. Returns true when it was one; `repaint` redraws the panel. */
export function onGoalPanelClick(t: HTMLElement, box: HTMLElement, d: OrbitGoalDeps, repaint: () => void): boolean {
  const start = t.closest("[data-goal-start]") as HTMLButtonElement | null;
  if (start) { void submitGoal(box, d, start, repaint); return true; }
  const ctl = t.closest("[data-goal-control]") as HTMLButtonElement | null;
  if (ctl) { void apply(box, ctl, () => d.fleetGoalControl(ctl.dataset.goalControl as AosControl), repaint); return true; }
  const add = t.closest("[data-task-add]") as HTMLButtonElement | null;
  if (add) { void submitTask(box, d, add, repaint); return true; }
  const tick = t.closest("[data-task-pass]") as HTMLButtonElement | null;
  if (tick) { const [taskId, checkId] = (tick.dataset.taskPass ?? "").split("/"); void apply(box, tick, () => d.fleetTaskCheck(taskId ?? "", checkId ?? "", tick.dataset.pass === "1"), repaint); return true; }
  const cancel = t.closest("[data-task-cancel]") as HTMLButtonElement | null;
  if (cancel) { void apply(box, cancel, () => d.fleetTaskCancel(cancel.dataset.taskCancel ?? ""), repaint); return true; }
  const crit = t.closest("[data-goal-crit]") as HTMLInputElement | null;
  if (crit) { void apply(box, crit, () => d.fleetGoalCriterion(crit.dataset.goalCrit ?? "", crit.checked), repaint); return true; }
  return false;
}

async function submitGoal(box: HTMLElement, d: OrbitGoalDeps, btn: HTMLButtonElement, repaint: () => void): Promise<void> {
  const val = (sel: string): string => (box.querySelector(sel) as HTMLInputElement | HTMLTextAreaElement | null)?.value ?? "";
  const input = {
    title: val("[data-goal-title]"),
    criteria: val("[data-goal-criteria]").split("\n"),
    maxUsd: Number(val("[data-goal-usd]")),
    maxHours: Number(val("[data-goal-hours]")),
  };
  await apply(box, btn, () => d.fleetGoalSet(input), repaint);
}

/** Send one change; on success adopt the engine's snapshot and repaint, else say why under the form. */
async function apply(box: HTMLElement, el: HTMLButtonElement | HTMLInputElement, call: () => Promise<FleetGoalReply | null>, repaint: () => void): Promise<void> {
  el.disabled = true;
  const r = await call().catch(() => null);
  el.disabled = false;
  if (r?.ok) { snap = r.data; repaint(); return; }
  const err = box.querySelector("[data-goal-err]") as HTMLElement | null;
  if (err) err.textContent = r ? r.error : "The engine did not answer.";
  if (el instanceof HTMLInputElement && el.type === "checkbox") el.checked = !el.checked; // the toggle did not land
}

// ------------------------------------------------------------------------- P-AOS.2: the task board

/** Board order: what needs a person first, then what is moving, then what is waiting, then the past. */
const BOARD: readonly AosTaskStatus[] = ["needs_review", "running", "ready", "pending", "failed", "done", "cancelled"];
const STATUS_WORD: Record<AosTaskStatus, string> = { pending: "waiting on a dependency", ready: "ready", running: "running", needs_review: "needs your review", done: "done", failed: "failed", cancelled: "cancelled" };

function laneName(id: string): string {
  return snap?.agents.find((a) => a.laneId === id)?.name ?? "a spoke that is gone";
}

function taskRowHtml(t: AosTask): string {
  const phase = t.status === "running" ? (t.turn === "verify" ? "verifying" : "working") : STATUS_WORD[t.status];
  const checks = t.acceptance.map((c) => {
    const state = c.passed === true ? "pass" : c.passed === false ? "fail" : "open";
    const ask = c.kind === "human" && t.status === "needs_review" && c.passed !== true
      ? `<span class="orbit-task-ask"><button class="btn-mini orbit-btn orbit-allow" data-task-pass="${esc(t.id)}/${esc(c.id)}" data-pass="1">${icon("check", 11)} Passes</button><button class="btn-mini orbit-btn orbit-deny" data-task-pass="${esc(t.id)}/${esc(c.id)}" data-pass="0">${icon("close", 11)} Reject</button></span>`
      : "";
    return `<div class="orbit-task-check" data-check="${state}"><i></i><div class="orbit-task-check-body"><span>${c.kind === "command" ? `<code>${esc(c.text)}</code>` : esc(c.text)}</span>${c.detail ? `<small>${esc(c.detail)}</small>` : ""}${ask}</div></div>`;
  }).join("");
  const failure = t.lastFailure && !isTerminalTask(t.status) ? `<p class="orbit-task-why">Retrying: ${esc(t.lastFailure)}</p>` : t.lastFailure && t.status !== "done" ? `<p class="orbit-task-why">${esc(t.lastFailure)}</p>` : "";
  const result = t.result ? `<details class="orbit-task-result"><summary>Result</summary><p>${esc(t.result)}</p></details>` : "";
  const cancel = isTerminalTask(t.status) ? "" : `<button class="orbit-ghost-x" data-task-cancel="${esc(t.id)}" data-tip="Cancel task|Stops dispatching it. A turn already running finishes; its outcome is ignored.">${icon("close", 11)}</button>`;
  return `<div class="orbit-task" data-task-status="${t.status}">
      <div class="orbit-task-head"><i></i><b title="${esc(t.title)}">${esc(t.id)} ${esc(t.title)}</b><span class="orbit-task-chip">${esc(laneName(t.assignee))}</span><span class="orbit-task-chip">${t.attempts}/${t.maxAttempts}</span>${cancel}</div>
      <div class="orbit-task-sub">${esc(phase)}${t.dependsOn.length ? ` \u00b7 after ${esc(t.dependsOn.join(", "))}` : ""}</div>
      ${failure}<div class="orbit-task-checks">${checks}</div>${result}
    </div>`;
}

/** The task board (AOS-1 section 8), grouped by status. */
export function taskBoardHtml(tasks: readonly AosTask[]): string {
  const head = `<div class="orbit-panel-h orbit-goal-h2">${icon("checkBadge", 13)}<b>Tasks</b><span>${tasks.filter((t) => t.status === "done").length}/${tasks.length} done</span></div>`;
  if (!tasks.length) return `${head}<div class="orbit-ghosts-empty">No tasks yet. Give a spoke a task below: what to do, what to deliver, and how you will know it is right.</div>`;
  return head + BOARD.map((st) => tasks.filter((t) => t.status === st).map(taskRowHtml).join("")).join("");
}

/** The add-task form, painted once per goal into a host the poll never repaints. */
export function taskFormHtml(): string {
  const g = snap?.goal;
  if (!g || isTerminalGoal(g.status)) return "";
  const lanes = snap?.agents ?? [];
  const spokes = lanes.length
    ? lanes.map((a) => `<option value="${esc(a.laneId)}">${esc(a.name)}</option>`).join("")
    : `<option value="">spawn a spoke first</option>`;
  const deps = g.tasks.filter((t) => t.status !== "failed" && t.status !== "cancelled")
    .map((t) => `<label class="orbit-task-dep" title="${esc(t.title)}"><input type="checkbox" data-task-dep value="${esc(t.id)}"><span>${esc(t.id)} ${esc(t.title)}</span></label>`).join("");
  return `<details class="orbit-spawn-more orbit-task-new">
      <summary>Add a task</summary>
      <label class="orbit-spawn-l">task<input type="text" data-task-title maxlength="200" placeholder="a short name for the work"></label>
      <label class="orbit-spawn-l">spoke<select data-task-assignee>${spokes}</select></label>
      <label class="orbit-spawn-l">instructions<textarea data-task-prompt rows="4" placeholder="what the spoke should do"></textarea></label>
      <label class="orbit-spawn-l">deliver<input type="text" data-task-contract maxlength="1000" placeholder="what it must hand back, e.g. a passing PR branch"></label>
      <label class="orbit-spawn-l">acceptance checks <i>one per line; "$ " runs a command</i><textarea data-task-checks rows="3" placeholder="$ bun test desktop/timeline.test.ts&#10;The dock shows rows within a few seconds"></textarea></label>
      ${deps ? `<div class="orbit-spawn-l">runs after<div class="orbit-task-deps">${deps}</div></div>` : ""}
      <div class="orbit-spawn-row"><button class="btn-mini orbit-btn orbit-spawn-go" data-task-add>${icon("bolt", 13)} Add task</button></div>
      <small class="orbit-ghost-err" data-task-err></small>
    </details>`;
}

async function submitTask(box: HTMLElement, d: OrbitGoalDeps, btn: HTMLButtonElement, repaint: () => void): Promise<void> {
  const form = btn.closest(".orbit-task-new") as HTMLElement | null;
  if (!form) return;
  const val = (sel: string): string => (form.querySelector(sel) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null)?.value ?? "";
  const input = {
    title: val("[data-task-title]"),
    assignee: val("[data-task-assignee]"),
    prompt: val("[data-task-prompt]"),
    outputContract: val("[data-task-contract]"),
    checks: val("[data-task-checks]").split("\n"),
    dependsOn: [...form.querySelectorAll<HTMLInputElement>("[data-task-dep]:checked")].map((c) => c.value),
  };
  btn.disabled = true;
  const r = await d.fleetTaskAdd(input).catch(() => null);
  btn.disabled = false;
  const err = form.querySelector("[data-task-err]") as HTMLElement | null;
  if (!r?.ok) { if (err) err.textContent = r ? r.error : "The engine did not answer."; return; }
  snap = r.data;
  // A fresh form for the next task (its dependency list now includes this one).
  const host = form.parentElement;
  if (host) { host.innerHTML = taskFormHtml(); (host.querySelector(".orbit-task-new") as HTMLDetailsElement | null)?.setAttribute("open", ""); }
  repaint();
}
