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

import { aosLiveness, goalProgress, humanSeconds, isTerminalGoal, type AosAgentStatus, type AosLiveness } from "../aos.ts";
import type { AosControl, AosSnapshot, FleetGoalReply, LucidBridge } from "./bridge.ts";
import { esc } from "./format.ts";
import { icon } from "./icons.ts";

export interface OrbitGoalDeps {
  fleetGoal: LucidBridge["fleetGoal"];
  fleetGoalSet: LucidBridge["fleetGoalSet"];
  fleetGoalCriterion: LucidBridge["fleetGoalCriterion"];
  fleetGoalControl: LucidBridge["fleetGoalControl"];
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
  const g = snap?.goal ?? null;
  if (!g || !snap) {
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
