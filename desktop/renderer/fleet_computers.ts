// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/fleet_computers.ts - P-FLEET-COMPUTERS.1 (ADR-0615): phase 3 of ADR-0575, the pure half.
//
// The Fleet window's Computers drawer, the "Where should it run?" choices of + New agent, the pasted connection card
// of + Add a computer, and the spoke side's "This computer is helping" view are all words over data the engine
// already has: the hub snapshot (mapHubSnapshot) for the computers this hub added, and the Remote Spokes plugin's
// This PC answers (/host/this-pc, /host/this-pc/tasks, add-on ADR-A109 and ADR-A110) for this computer's own work.
// Everything here is pure, so the words and their precedence are tested without a DOM.
//
// Words (ADR-0575): agent, board, computer. "Spoke" and "lane" do not appear in anything this module returns.
// Text a plugin or a spoke sent (labels, task names, hub names) is clipped here and only ever shown as text.

import {
  clockLabel, deactivatedLabel, type HubActions, type RemoteHubView, type RemoteSpokeView, NODE_RE, TASK_RE,
} from "./remote_spokes_model.ts";

const DAY_MS = 86_400_000;
/** A certificate this close to its end needs renewing now (the spoke's own cert-expiring alert uses 14 days too). */
export const RENEW_WITHIN_MS = 14 * DAY_MS;

export type ComputerTone = "ok" | "work" | "warn" | "bad" | "off";

/** One computer's state in words, for the Computers drawer. First match wins: a computer taken out of service, an
 *  expired certificate (it cannot work at all), asleep, offline, still checking, an agent there waiting for your OK,
 *  an error, a certificate to renew soon, then Busy (an agent is working; the room column says what is left) or
 *  Ready. */
export function computerState(s: RemoteSpokeView, now: number): { state: string; tone: ComputerTone } {
  if (s.deactivated) return { state: deactivatedLabel(s.deactivated), tone: "off" };
  if (s.certExpires !== null && s.certExpires <= now) return { state: "Needs renewal: its certificate expired", tone: "bad" };
  if (s.state === "silent" && s.silentSince !== null) return { state: `Asleep since ${clockLabel(s.silentSince, now)}`, tone: "warn" };
  if (s.state === "offline") return { state: "Offline", tone: "bad" };
  if (s.state === "checking") return { state: "Checking", tone: "off" };
  if (s.state === "approval") return { state: "Needs your OK", tone: "warn" };
  if (s.state === "error") return { state: "Has a problem", tone: "bad" };
  if (s.alerts.some((a) => a.kind === "crl-stale")) return { state: "Needs renewal: its revocation list is out of date", tone: "warn" };
  if (s.certExpires !== null ? s.certExpires - now <= RENEW_WITHIN_MS : s.alerts.some((a) => a.kind === "cert-expiring")) {
    const by = s.certExpires !== null ? new Date(s.certExpires).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : null;
    return { state: by ? `Needs renewal by ${by}` : "Needs renewal soon", tone: "warn" };
  }
  if (s.state === "busy") return { state: "Busy", tone: "work" };
  return { state: "Ready", tone: "ok" };
}

/** How much room a computer has: "1 of 2 free", "All 2 in use", or "" when it has not said. */
export function roomLabel(lanes: RemoteSpokeView["lanes"]): string {
  if (!lanes || lanes.max === 0) return "";
  return lanes.free === 0 ? `All ${lanes.max} in use` : `${lanes.free} of ${lanes.max} free`;
}

const OS_NAME: Readonly<Record<string, string>> = { linux: "Linux", darwin: "Mac", win32: "Windows" };

/** What kind of computer it is and where, from what it and its certificate say: "Linux, us-east". */
export function whatLabel(s: RemoteSpokeView): string {
  const os = s.host?.os ? (OS_NAME[s.host.os] ?? s.host.os) : "";
  return [os, s.region ?? ""].filter(Boolean).join(", ");
}

export interface ComputerRow {
  /** null for This PC. */
  node: string | null;
  name: string;
  what: string;
  room: string;
  state: string;
  tone: ComputerTone;
  /** The hub's or the computer's own words about a problem, when it gave any. */
  detail: string | null;
}

/** This PC first, then every computer this hub added, by name. `localRunning`: agents running on This PC now. A hub
 *  that is not available still lists This PC, and `note` says why the others are missing. */
export function computerRows(hub: RemoteHubView, localRunning: number, now: number): { rows: ComputerRow[]; note: string | null } {
  const self: ComputerRow = {
    node: null, name: "This PC", what: "your computer",
    room: localRunning === 0 ? "no agents running" : `${localRunning} ${localRunning === 1 ? "agent" : "agents"} running`,
    state: "Ready", tone: "ok", detail: null,
  };
  if (!hub.available) return { rows: [self], note: hub.reason };
  const others = [...hub.spokes]
    .sort((a, b) => a.label.localeCompare(b.label) || a.node.localeCompare(b.node))
    .map((s): ComputerRow => {
      const { state, tone } = computerState(s, now);
      // A computer out of service has no room to offer, whatever it last reported.
      return { node: s.node, name: s.label, what: whatLabel(s), room: s.deactivated ? "" : roomLabel(s.lanes), state, tone, detail: s.error ?? null };
    });
  return { rows: [self, ...others], note: null };
}

/** One "Where should it run?" button. `key` is "local" or the computer's node id. */
export interface PlaceChoice { key: string; name: string; sub: string; enabled: boolean; why: string | null }

/** Why an agent cannot start on this computer now, or null when it can. The hub's certificate first (nothing can
 *  start without drive), then what the computer said. A computer that did not report its room is offered: it
 *  decides, and its refusal is shown as it gives it. */
export function placeBlock(s: RemoteSpokeView, a: HubActions, now: number): string | null {
  if (!a.drive) return "This hub can watch this computer but not start work on it.";
  if (s.certExpires !== null && s.certExpires <= now) return "Its certificate expired: renew it before it can take work.";
  if (s.state === "silent" && s.silentSince !== null) return `Asleep since ${clockLabel(s.silentSince, now)}.`;
  if (s.state === "checking") return "Still checking it.";
  if (s.state === "offline") return s.error ? `Offline: ${s.error.slice(0, 120)}` : "Offline.";
  if (s.lanes && s.lanes.free === 0) return `All ${s.lanes.max} agents there are busy: stop one there to make room.`;
  return null;
}

/** This PC, then every computer this hub added that is in service: those that can take an agent now first, then by
 *  name. Deactivated computers are not offered at all (ADR-0512). */
export function placeChoices(hub: RemoteHubView, now: number): PlaceChoice[] {
  const self: PlaceChoice = { key: "local", name: "This PC", sub: "your computer", enabled: true, why: null };
  if (!hub.available) return [self];
  const others = hub.spokes
    .filter((s) => !s.deactivated)
    .map((s): PlaceChoice => {
      const why = placeBlock(s, hub.actions, now);
      const room = s.lanes ? `${s.lanes.free} free` : "";
      const sub = why ? "can't now" : [room, whatLabel(s)].filter(Boolean).join(" \u00b7 ") || "ready";
      return { key: s.node, name: s.label, sub, enabled: why === null, why };
    })
    .sort((x, y) => Number(y.enabled) - Number(x.enabled) || x.name.localeCompare(y.name));
  return [self, ...others];
}

/** P-FLEET-UNLOCK.1 (ADR-0616): the Fleet header's approvals lock, or null when it has no place there: only a hub that
 *  approves with a typed presence password (add-on ADR-A105) and whose certificate may approve at all. */
export function approvalsLock(hub: RemoteHubView | null): "locked" | "unlocked" | null {
  if (!hub?.available || hub.hub.presence !== "password" || !hub.actions.approve) return null;
  return hub.hub.presenceUnlocked ? "unlocked" : "locked";
}

/** A pasted connection card (or a spoke certificate) is at most this long; a card is one line of a few KB. */
export const CARD_MAX = 16_384;
export const CARD_PREFIX = "lucid-spoke-card:";

/** What the person pasted into + Add a computer, checked before it goes to the hub: a connection card (one line) or a
 *  spoke certificate. The hub plugin checks the signature and everything else; this only catches the wrong thing
 *  pasted, in words that say what to copy instead. */
export function parseCard(text: string): { ok: true; cert: string } | { ok: false; error: string } {
  const t = text.trim();
  if (!t) return { ok: false, error: "Paste the connection card from the other computer first." };
  if (t.length > CARD_MAX) return { ok: false, error: "That is far longer than a connection card. Copy only the card line from the other computer." };
  if (t.startsWith(CARD_PREFIX)) {
    return /\s/.test(t) ? { ok: false, error: "A connection card is one line. Copy the whole line again, without anything before or after it." } : { ok: true, cert: t };
  }
  if (t.includes("-----BEGIN")) return { ok: true, cert: t };
  return { ok: false, error: `That is not a connection card. On the other computer, copy the whole line that starts with ${CARD_PREFIX} and paste it here.` };
}

// --------------------------------------------------------------------------------------------- the spoke side

/** This computer's helper as the plugin reports it (add-on ThisPc). `not-set-up`: it helps no hub. */
export type ThisPcState = "not-set-up" | "waiting-for-certificate" | "on" | "off";
const THIS_PC_STATES: readonly ThisPcState[] = ["not-set-up", "waiting-for-certificate", "on", "off"];

export interface ThisPcView { supported: boolean; state: ThisPcState; label: string | null; running: boolean }

const rec = (v: unknown): Record<string, unknown> | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const clip = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const ms = (v: unknown): number => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0);

/** The plugin's This PC answer, or null when it is not one. Only what the view shows is kept. */
export function mapThisPc(raw: unknown): ThisPcView | null {
  const r = rec(raw);
  const state = THIS_PC_STATES.find((s) => s === r?.state);
  if (!r || !state) return null;
  return { supported: r.supported === true, state, label: clip(r.label, 64), running: r.running === true };
}

export type LocalTaskState = "working" | "awaiting_approval" | "idle" | "error";
const LOCAL_STATES: readonly LocalTaskState[] = ["working", "awaiting_approval", "idle", "error"];

export interface LocalTaskView {
  id: string; name: string; hub: string; state: LocalTaskState;
  stateText: string; waitingOn: string | null; queuedNotes: number; stopping: boolean; updatedAt: number;
}
export interface LocalEndedView { id: string; name: string; hub: string; state: "closed" | "stopped"; updatedAt: number }
export interface LocalWorkView { paused: boolean; since: number; tasks: LocalTaskView[]; ended: LocalEndedView[] }

/** The most finished tasks the spoke side lists (the add-on keeps 20 from the last 14 days, ADR-A108). */
export const ENDED_MAX = 20;

function localTask(raw: unknown): LocalTaskView | null {
  const r = rec(raw);
  const state = LOCAL_STATES.find((s) => s === r?.state);
  if (!r || !state || typeof r.id !== "string" || !TASK_RE.test(r.id)) return null;
  const queued = typeof r.queuedNotes === "number" && Number.isSafeInteger(r.queuedNotes) && r.queuedNotes > 0 ? r.queuedNotes : 0;
  return {
    id: r.id, name: clip(r.name, 64) ?? r.id, hub: clip(r.hub, 64) ?? "a hub", state,
    stateText: clip(r.stateText, 200) ?? "", waitingOn: clip(r.waitingOn, 200), queuedNotes: queued,
    stopping: r.stopping === true, updatedAt: ms(r.updatedAt),
  };
}

function endedTask(raw: unknown): LocalEndedView | null {
  const r = rec(raw);
  if (!r || typeof r.id !== "string" || !TASK_RE.test(r.id)) return null;
  if (r.state !== "closed" && r.state !== "stopped") return null;
  return { id: r.id, name: clip(r.name, 64) ?? r.id, hub: clip(r.hub, 64) ?? "a hub", state: r.state, updatedAt: ms(r.updatedAt) };
}

/** The plugin's LocalWork answer, validated. Malformed rows are dropped; newest first. `ended` is empty from a plugin
 *  older than 0.10.3. */
export function mapLocalWork(raw: unknown): LocalWorkView {
  const r = rec(raw);
  const list = <T>(v: unknown, f: (x: unknown) => T | null): T[] => (Array.isArray(v) ? v.map(f).filter((x): x is T => x !== null) : []);
  const byNew = (a: { updatedAt: number }, b: { updatedAt: number }): number => b.updatedAt - a.updatedAt;
  return {
    paused: r?.paused === true,
    since: ms(r?.since),
    tasks: list(r?.tasks, localTask).sort(byNew),
    ended: list(r?.ended, endedTask).sort(byNew).slice(0, ENDED_MAX),
  };
}

/** The spoke side's heading: who this computer helps (as far as its tasks say: open ones first, then finished ones),
 *  or that it helps nobody right now. */
export function helpingTitle(pc: ThisPcView, work: LocalWorkView): string {
  if (pc.state === "off") return "Helping is off on this computer";
  if (pc.state !== "on") return "This computer is not helping a hub";
  const hubs = [...new Set([...work.tasks.map((t) => t.hub), ...work.ended.map((t) => t.hub)])];
  if (hubs.length === 0) return "This computer is ready to help";
  if (hubs.length === 1) return `This computer is helping ${hubs[0]}`;
  if (hubs.length === 2) return `This computer is helping ${hubs[0]} and ${hubs[1]}`;
  return `This computer is helping ${hubs[0]}, ${hubs[1]} and ${hubs.length - 2} more`;
}

/** One task running here, in words for the person at this computer. The person at the hub decides its asks. */
export function localTaskWords(t: LocalTaskView): string {
  if (t.stopping) return "Stopping";
  if (t.state === "working") return t.queuedNotes > 0 ? `Working, ${t.queuedNotes} ${t.queuedNotes === 1 ? "note" : "notes"} waiting` : "Working";
  if (t.state === "awaiting_approval") return "Waiting for an OK from the person at the hub";
  if (t.state === "error") return "Stopped with an error";
  return "Waiting for the hub";
}

/** Whether the This PC section belongs in the Fleet window at all: only once this computer helps a hub (on or off). */
export function showsHelping(pc: ThisPcView | null): boolean {
  return pc !== null && pc.supported && (pc.state === "on" || pc.state === "off");
}

/** What the engine's This PC routes answer (ADR-0615). A refusal is the plugin's words, or the engine's when the
 *  plugin is missing, stopped, or older than these routes. */
export type ThisPcAnswer = { ok: true; thisPc: ThisPcView | null } | { ok: false; error: string };
export type LocalWorkAnswer = { ok: true; work: LocalWorkView } | { ok: false; error: string };
export type AddComputerAnswer = { ok: true; node: string } | { ok: false; error: string };

/** A node id the engine may forward for a pasted card's answer (the plugin's `{node, mailbox}`), or null. */
export function addedNode(data: unknown): string | null {
  const n = rec(data)?.node;
  return typeof n === "string" && NODE_RE.test(n) ? n : null;
}
