// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/remote_spokes_model.ts - P-IDE-SPOKES.1 (ADR-0487): remote spokes as the IDE sees them.
//
// Pure and DOM-free, so the engine (desktop/remote_spokes.ts) and the orbit share one model. The source of truth
// is the add-on hub (the remote-spokes server plugin, add-on ADR-A051): its /host/spokes summary carries the
// hub's certificate scopes and, per spoke, its own answers to `capabilities` and `status`. Everything a spoke
// wrote (task names, model ids, errors) is untrusted: it is validated and clipped here and only ever shown as text.
//
// What a hub may do is what its certificate's scopes allow (add-on ADR-A044): recall reads (status, journal,
// parked actions), drive starts, follows up, cancels and closes tasks and denies parked actions, approve signs an
// allow (and a signed deny). The spokes enforce the same scopes again; the IDE never offers what would be refused.

export const HUB_SCOPES = ["recall", "drive", "approve"] as const;
export type HubScope = (typeof HUB_SCOPES)[number];

/** The buttons a hub's certificate allows. `deny` is drive (unsigned) or approve (signed). */
export interface HubActions { recall: boolean; drive: boolean; approve: boolean; deny: boolean }

export function hubActions(scopes: readonly string[]): HubActions {
  const drive = scopes.includes("drive"), approve = scopes.includes("approve");
  return { recall: scopes.includes("recall"), drive, approve, deny: drive || approve };
}

/** The spoke's TaskState (add-on spoke.ts), with `closed` from add-on ADR-A047. Closed set. */
export const TASK_STATES = ["working", "awaiting_approval", "idle", "error", "stopped", "closed"] as const;
export type RemoteTaskState = (typeof TASK_STATES)[number];

export interface RemoteTaskView {
  id: string; name: string; state: RemoteTaskState; turns: number; updatedAt: number;
  awaiting?: string; reviewBranch?: string; interrupted?: number; shadow?: true;
}

/** checking: not asked yet. offline: no reply in time. approval: an action is parked on a human. busy: a task is
 *  working. error: a task failed, or the spoke refused this hub's status read. idle: online and free. */
export type RemoteSpokeState = "checking" | "offline" | "approval" | "busy" | "error" | "idle";

export interface RemoteSpokeView {
  node: string;
  label: string;
  state: RemoteSpokeState;
  /** From `capabilities`; null when the spoke did not answer it. */
  lanes: { live: number; max: number; free: number } | null;
  model: string | null;
  tasks: RemoteTaskView[];
  checkedAt: number | null;
  error?: string;
}

export type RemoteHubView =
  | { available: true; hub: { node: string; label: string; scopes: HubScope[] }; actions: HubActions; spokes: RemoteSpokeView[] }
  | { available: false; plugin: "missing" | "stopped" | "running"; reason: string };

export const NODE_RE = /^n_[0-9a-f]{32}$/;
export const TASK_RE = /^t_[0-9a-f]{16}$/;

const clip = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const count = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null);
const record = (v: unknown): Record<string, unknown> | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

function mapTask(raw: unknown): RemoteTaskView | null {
  const t = record(raw);
  if (!t || typeof t.id !== "string" || !TASK_RE.test(t.id)) return null;
  const state = TASK_STATES.find((s) => s === t.state);
  const name = clip(t.name, 48);
  const turns = count(t.turns), updatedAt = count(t.updatedAt);
  if (!state || !name || turns === null || updatedAt === null) return null;
  const out: RemoteTaskView = { id: t.id, name, state, turns, updatedAt };
  const awaiting = clip(t.awaiting, 64);
  if (awaiting) out.awaiting = awaiting;
  const branch = clip(t.reviewBranch, 128);
  if (branch) out.reviewBranch = branch;
  const interrupted = count(t.interrupted);
  if (interrupted !== null) out.interrupted = interrupted;
  if (t.shadow === true) out.shadow = true;
  return out;
}

/** The spoke's overall state from its reachability and tasks. Closed and stopped tasks hold no lane. */
export function spokeState(reachable: boolean | null, tasks: readonly RemoteTaskView[] | null): RemoteSpokeState {
  if (reachable === null) return "checking";
  if (!reachable) return "offline";
  if (!tasks) return "error";
  if (tasks.some((t) => t.state === "awaiting_approval")) return "approval";
  if (tasks.some((t) => t.state === "working")) return "busy";
  if (tasks.some((t) => t.state === "error")) return "error";
  return "idle";
}

/** One /host/spokes row as a view. A row whose node id is malformed is dropped (nothing could address it). */
export function mapSpokeRow(raw: unknown): RemoteSpokeView | null {
  const r = record(raw);
  if (!r || typeof r.node !== "string" || !NODE_RE.test(r.node)) return null;
  const reachable = typeof r.reachable === "boolean" ? r.reachable : null;
  const tasks = Array.isArray(r.tasks) ? r.tasks.map(mapTask).filter((t): t is RemoteTaskView => t !== null) : null;
  const caps = record(r.caps);
  const max = count(caps?.maxLanes), live = count(caps?.liveLanes), free = count(caps?.freeLanes);
  const view: RemoteSpokeView = {
    node: r.node,
    label: clip(r.label, 64) ?? r.node.slice(0, 12),
    state: spokeState(reachable, tasks),
    lanes: max !== null && live !== null && free !== null ? { live, max, free } : null,
    model: clip(record(caps?.models)?.default, 128),
    tasks: (tasks ?? []).sort((a, b) => b.updatedAt - a.updatedAt),
    checkedAt: count(r.checkedAt),
  };
  const error = clip(r.error, 300);
  if (error) view.error = error;
  return view;
}

/** The plugin's /host/spokes answer as the IDE's view. `plugin` is the runtime's state for the hub plugin. */
export function mapHubSnapshot(raw: unknown): RemoteHubView {
  const r = record(raw);
  if (!r) return { available: false, plugin: "running", reason: "The Remote Spokes plugin sent an answer the IDE cannot read." };
  const hub = record(r.hub);
  if (!hub || typeof hub.node !== "string" || !NODE_RE.test(hub.node)) {
    const why = clip(r.error, 300);
    return { available: false, plugin: "running", reason: why ? `The Remote Spokes hub did not open: ${why}` : "This hub is not set up yet. Finish setup in the Remote Spokes panel." };
  }
  const granted: unknown[] = Array.isArray(hub.scopes) ? hub.scopes : [];
  const scopes = HUB_SCOPES.filter((s) => granted.includes(s));
  const spokes = Array.isArray(r.spokes) ? r.spokes.map(mapSpokeRow).filter((s): s is RemoteSpokeView => s !== null) : [];
  return { available: true, hub: { node: hub.node, label: clip(hub.label, 64) ?? hub.node.slice(0, 12), scopes }, actions: hubActions(scopes), spokes };
}

// ---------------------------------------------------------------------------------------- display rules

/** The orbit's color language for a remote spoke, on the existing state hues: red when it is stuck on a human
 *  or failed, amber when it might be stuck (the hub has not heard from it), cyan while it works, blue when it is
 *  online and ready. Only `approval` animates: it is the one that blocks on a human. */
export type RemoteTone = "approval" | "stuck" | "maybe" | "busy" | "ready" | "checking";
export const REMOTE_TONE: Readonly<Record<RemoteSpokeState, RemoteTone>> = {
  approval: "approval", error: "stuck", offline: "maybe", busy: "busy", idle: "ready", checking: "checking",
};

export const REMOTE_STATE_LABEL: Readonly<Record<RemoteSpokeState, string>> = {
  checking: "checking", offline: "offline", approval: "parked approval", busy: "online, busy", error: "online, error", idle: "online, idle",
};

/** The card's one-line glance: state, lanes, and how many tasks are open. */
export function remoteGlance(s: RemoteSpokeView): string {
  const lanes = s.lanes ? ` \u00b7 ${s.lanes.live}/${s.lanes.max} lanes` : "";
  const open = s.tasks.filter((t) => t.state === "working" || t.state === "awaiting_approval").length;
  return `${REMOTE_STATE_LABEL[s.state]}${lanes}${open ? ` \u00b7 ${open} open` : ""}`;
}

/** Which buttons a task row offers: what the certificate allows AND what the spoke would accept in this state
 *  (a follow-up waits for the turn to end; a closed or stopped task holds no lane to cancel or close). */
export function taskButtons(t: RemoteTaskView, a: HubActions): { recall: boolean; followup: boolean; cancel: boolean; close: boolean } {
  const live = t.state !== "closed" && t.state !== "stopped";
  return {
    recall: a.recall,
    followup: a.drive && (t.state === "idle" || t.state === "error"),
    cancel: a.drive && (t.state === "working" || t.state === "awaiting_approval"),
    close: a.drive && live,
  };
}

/** A parked action's buttons: an allow needs approve and an action the scanner passed; a deny needs drive or
 *  approve and is always offered then (refusing is safe). */
export function approvalButtons(v: RemoteApprovalView, a: HubActions): { approve: boolean; deny: boolean } {
  return { approve: a.approve && !v.quarantined, deny: a.deny };
}

/** The plugin panel's two-click rule (add-on ADR-A045), kept in the IDE for Approve and for Close: the first
 *  click arms for 8 seconds, a second click inside that window acts. Returns what this click does and the new
 *  armed time (null once it acted). */
export const ARM_MS = 8_000;
export function armClick(armedAt: number | null, now: number): { act: "arm" | "go"; armedAt: number | null } {
  return armedAt !== null && now - armedAt <= ARM_MS ? { act: "go", armedAt: null } : { act: "arm", armedAt: now };
}

// ------------------------------------------------------------------------------- engine reply shapes

/** One recalled journal entry after the engine's scan. `text` is "" when quarantined (the reason says why). */
export interface RecallEntryView {
  seq: number; ts: number; task: string; kind: string;
  trust: "untrusted" | "suspicious" | "quarantined";
  text: string;
  reason?: string;
}

/** `context`: every entry that passed, inside ONE UNTRUSTED_CONTENT envelope, the only form recalled text may
 *  take into a model's context. "" when nothing passed. `omitted`: older entries past the display cap. */
export type RecallView =
  | { ok: true; node: string; label: string; task?: string; entries: RecallEntryView[]; quarantined: number; omitted: number; context: string }
  | { ok: false; error: string };

/** A parked action on a remote spoke, scanned like recalled text. `quarantined`: the scanner flagged the action's
 *  text, so its input is withheld and only Deny is offered. */
export interface RemoteApprovalView {
  task: string; name: string;
  ask: { id: string; digest: string; kind: string; title: string; input: string; tier: string; reason: string; expiresAt: number };
  quarantined?: string;
}
export type RemoteApprovalsView = { ok: true; approvals: RemoteApprovalView[] } | { ok: false; error: string };

/** What an action route answers: the spoke's reply data, or the refusal in words. */
export type RemoteActionView = { ok: true; data: unknown } | { ok: false; error: string };
