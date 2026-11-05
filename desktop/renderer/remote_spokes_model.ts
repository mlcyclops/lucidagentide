// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/remote_spokes_model.ts - P-IDE-SPOKES.1 (ADR-0487): remote spokes as the IDE sees them.
//
// Pure and DOM-free, so the engine (desktop/remote_spokes.ts) and the orbit share one model. The source of truth
// is the add-on hub (the remote-spokes server plugin, add-on ADR-A051): its /host/spokes summary carries the
// hub's certificate scopes and, per spoke, its own answers to `capabilities` and `status`. Everything a spoke
// wrote (task names, model ids, errors) is untrusted: it is validated and clipped here and only ever shown as text.
// ADR-0489 adds the hub's optional per-spoke facts (answer time, route, the spoke certificate's region and
// classification, the spoke's `models` answer) and the Start-a-task selector's order (`deployChoices`).
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

/** A signed-in frontier provider on a spoke and the model ids it offers there (ADR-0489). */
export interface RemoteFrontierView { provider: string; name: string; account: string | null; models: string[] }

/** What a spoke can run: the default new tasks use, its local models, and its signed-in frontier providers. From
 *  the spoke's `models` answer when the hub has one, else from `capabilities` (provider names, no model lists). */
export interface RemoteModelsView { default: string | null; local: string[]; frontier: RemoteFrontierView[] }

/** How the hub's request reached the spoke: the spoke's own LAN mailbox, or a shared relay. */
export type RemoteVia = "lan" | "relay";

/** The classification a spoke certificate may carry (add-on certificate format). Closed set. */
export const CLASSIFICATIONS = ["private", "shareable", "cui"] as const;
export type RemoteClassification = (typeof CLASSIFICATIONS)[number];

export interface RemoteSpokeView {
  node: string;
  label: string;
  state: RemoteSpokeState;
  /** From `capabilities`; null when the spoke did not answer it. */
  lanes: { live: number; max: number; free: number } | null;
  tasks: RemoteTaskView[];
  checkedAt: number | null;
  /** ADR-0489: the round trip of the hub's last `capabilities` request, including the spoke's mailbox poll. */
  latencyMs: number | null;
  via: RemoteVia | null;
  /** ADR-0489: from the spoke certificate the hub holds (root- or delegate-signed), not from the spoke. */
  region: string | null;
  classification: RemoteClassification | null;
  certExpires: number | null;
  engineVersion: string | null;
  models: RemoteModelsView;
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

// ------------------------------------------------------------------ models, route, certificate (ADR-0489)

/** A model or provider id as the IDE accepts it from a spoke; anything else is dropped, never shown. */
export const MODEL_ID_RE = /^[A-Za-z0-9._:@/-]{1,128}$/;
/** A spoke may list hundreds of models; the IDE keeps this many per list. */
export const MODEL_LIST_MAX = 200;
const PROVIDER_MAX = 32;

function modelIds(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const ids = v.filter((m): m is string => typeof m === "string" && MODEL_ID_RE.test(m));
  return [...new Set(ids)].slice(0, MODEL_LIST_MAX);
}

/** Local models: a plain id list (`capabilities`), or `{ <provider>: ids }` (the `models` op), flattened to
 *  `provider/id` unless the id already names its provider. */
function localModels(v: unknown): string[] {
  if (Array.isArray(v)) return modelIds(v);
  const byProvider = record(v);
  if (!byProvider) return [];
  const ids = Object.entries(byProvider)
    .filter(([provider]) => MODEL_ID_RE.test(provider))
    .flatMap(([provider, list]) => modelIds(list).map((m) => (m.startsWith(`${provider}/`) ? m : `${provider}/${m}`)));
  return modelIds(ids);
}

/** One signed-in provider: a `models` op provider record (only when `signedIn` is true), or a bare provider id
 *  from `capabilities.models.signedIn` (no account, no model list). */
function frontierRow(raw: unknown): RemoteFrontierView | null {
  if (typeof raw === "string") return MODEL_ID_RE.test(raw) ? { provider: raw, name: raw, account: null, models: [] } : null;
  const p = record(raw);
  if (!p || p.signedIn !== true || typeof p.provider !== "string" || !MODEL_ID_RE.test(p.provider)) return null;
  const accounts = Array.isArray(p.accounts) ? p.accounts.map((a) => clip(record(a)?.label, 64)).filter((l): l is string => l !== null) : [];
  return { provider: p.provider, name: clip(p.name, 64) ?? p.provider, account: accounts.length ? accounts.join(", ").slice(0, 160) : null, models: modelIds(p.models) };
}

function frontierRows(v: unknown): RemoteFrontierView[] {
  if (!Array.isArray(v)) return [];
  return v.map(frontierRow).filter((f): f is RemoteFrontierView => f !== null).slice(0, PROVIDER_MAX);
}

/** The spoke's models: its `models` answer when the hub has one, else what `capabilities` says. The default
 *  prefers `capabilities`, the fresher of the two (the `models` answer is refreshed at most every 5 minutes). */
function mapModels(capsModels: Record<string, unknown> | null, answer: Record<string, unknown> | null): RemoteModelsView {
  const fromCaps = clip(capsModels?.default, 128);
  const fromAnswer = clip(answer?.default, 128);
  const def = [fromCaps, fromAnswer].find((m): m is string => m !== null && MODEL_ID_RE.test(m)) ?? null;
  if (!answer) return { default: def, local: localModels(capsModels?.local), frontier: frontierRows(capsModels?.signedIn) };
  return { default: def, local: localModels(answer.local), frontier: frontierRows(answer.providers) };
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
  // ADR-0489: optional fields a newer hub plugin adds; an older one omits them and each reads as unknown.
  const viaKind = record(r.via)?.kind;
  const cert = record(r.cert);
  const view: RemoteSpokeView = {
    node: r.node,
    label: clip(r.label, 64) ?? r.node.slice(0, 12),
    state: spokeState(reachable, tasks),
    lanes: max !== null && live !== null && free !== null ? { live, max, free } : null,
    tasks: (tasks ?? []).sort((a, b) => b.updatedAt - a.updatedAt),
    checkedAt: count(r.checkedAt),
    latencyMs: count(r.latencyMs),
    via: viaKind === "lan" || viaKind === "relay" ? viaKind : null,
    region: clip(cert?.region, 48),
    classification: CLASSIFICATIONS.find((c) => c === cert?.classification) ?? null,
    certExpires: count(cert?.expires),
    engineVersion: clip(caps?.engineVersion, 32),
    models: mapModels(record(caps?.models), record(r.models)),
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

export const VIA_LABEL: Readonly<Record<RemoteVia, string>> = { lan: "LAN", relay: "relay" };

/** Seconds with one decimal under 10 s, whole seconds above (the mailbox poll makes finer digits noise). */
function seconds(ms: number): string {
  return ms < 10_000 ? (ms / 1000).toFixed(1) : String(Math.round(ms / 1000));
}

/** ADR-0489: the hub's last round trip to the spoke. It includes the spoke's mailbox poll (about 2 s), so it
 *  reads as how fast the spoke answers, never as a network ping. */
export function latencyLabel(ms: number | null): string {
  return ms === null ? "answer time not measured yet" : `answers in ${seconds(ms)} s`;
}

/** The card's one-line glance: state, lanes, how fast it answers and over which route, and how many tasks are
 *  open. */
export function remoteGlance(s: RemoteSpokeView): string {
  const lanes = s.lanes ? ` \u00b7 ${s.lanes.live}/${s.lanes.max} lanes` : "";
  const answers = s.latencyMs !== null ? ` \u00b7 ${seconds(s.latencyMs)} s${s.via ? ` ${VIA_LABEL[s.via]}` : ""}` : "";
  const open = s.tasks.filter((t) => t.state === "working" || t.state === "awaiting_approval").length;
  return `${REMOTE_STATE_LABEL[s.state]}${lanes}${answers}${open ? ` \u00b7 ${open} open` : ""}`;
}

/** How many distinct models the spoke reports: the default, its local models and every signed-in provider's. */
export function modelCount(s: RemoteSpokeView): number {
  const all = new Set([...s.models.local, ...s.models.frontier.flatMap((f) => f.models)]);
  if (s.models.default) all.add(s.models.default);
  return all.size;
}

/** One row of the Start-a-task selector: the spoke, whether a task can start there now, and why not. */
export interface DeployChoice { spoke: RemoteSpokeView; eligible: boolean; why: string | null }

/** Why a task cannot start on this spoke now, or null when it can. The hub's scopes first (nothing can start
 *  without drive), then what the spoke said. A spoke that did not report lanes is offered: it decides. */
function deployBlock(s: RemoteSpokeView, a: HubActions): string | null {
  if (!a.drive) return "this hub cannot start tasks (no drive scope)";
  if (s.state === "checking") return "still checking";
  // An offline row the hub could say more about (a revoked certificate, a refusal) gives that reason: "offline"
  // alone would suggest waiting, when the spoke will never answer this hub again.
  if (s.state === "offline") return s.error ? `offline: ${s.error.slice(0, 120)}` : "offline";
  if (s.lanes && s.lanes.free === 0) return "no free lane: close an idle task on it to free one";
  return null;
}

/** ADR-0489: every spoke as a selector row, eligible first, then fastest answer (unmeasured last), then label. */
export function deployChoices(spokes: readonly RemoteSpokeView[], a: HubActions): DeployChoice[] {
  return spokes
    .map((spoke) => { const why = deployBlock(spoke, a); return { spoke, eligible: why === null, why }; })
    .sort((x, y) => Number(y.eligible) - Number(x.eligible)
      || (x.spoke.latencyMs ?? Number.POSITIVE_INFINITY) - (y.spoke.latencyMs ?? Number.POSITIVE_INFINITY)
      || x.spoke.label.localeCompare(y.spoke.label));
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
