// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/remote_spokes_model.ts - P-IDE-SPOKES.1 (ADR-0506): remote spokes as the IDE sees them.
//
// Pure and DOM-free, so the engine (desktop/remote_spokes.ts) and the orbit share one model. The source of truth
// is the add-on hub (the remote-spokes server plugin, add-on ADR-A066): its /host/spokes summary carries the
// hub's certificate scopes and, per spoke, its own answers to `capabilities` and `status`. Everything a spoke
// wrote (task names, model ids, errors) is untrusted: it is validated and clipped here and only ever shown as text.
// ADR-0508 adds the hub's optional per-spoke facts (answer time, route, the spoke certificate's region and
// classification, the spoke's `models` answer) and the Start-a-task selector's order (`deployChoices`).
// ADR-0509 adds the spoke's machine (`host`) and lane policy from `capabilities`, the hub's `lastSeen`,
// `silentSince` and kept `alerts`, the `silent` state, the alert lines (`spokeAlerts`) and Resume for a task whose
// turn a restart interrupted (`RESUME_TEXT`, sent only on the human's click).
// ADR-0512 adds the hub's optional `deactivated` mark: a spoke its owner took offline on purpose (shipped, lent,
// unplugged) reads `deactivated`, in a dim tone, with no alert lines, and is never offered as a target.
//
// What a hub may do is what its certificate's scopes allow (add-on ADR-A059): recall reads (status, journal,
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

/** The spoke's TaskState (add-on spoke.ts), with `closed` from add-on ADR-A062. Closed set. */
export const TASK_STATES = ["working", "awaiting_approval", "idle", "error", "stopped", "closed"] as const;
export type RemoteTaskState = (typeof TASK_STATES)[number];

export interface RemoteTaskView {
  id: string; name: string; state: RemoteTaskState; turns: number; updatedAt: number;
  awaiting?: string; reviewBranch?: string; interrupted?: number; shadow?: true;
}

/** checking: not asked yet. offline: no reply in time. approval: an action is parked on a human. busy: a task is
 *  working. error: a task failed, or the spoke refused this hub's status read. idle: online and free. silent
 *  (ADR-0509): the hub reaches a relay but the spoke has not polled it for over 2 minutes, so it is probably down;
 *  this wins over every other state, since what the spoke said last is stale. deactivated (ADR-0512): the owner
 *  took the spoke offline on purpose and the hub neither asks nor alerts about it; this wins over silent too. */
export type RemoteSpokeState = "checking" | "offline" | "approval" | "busy" | "error" | "idle" | "silent" | "deactivated";

/** ADR-0512: the hub's planned-offline mark for a spoke (add-on `hub deactivate`), until `hub reactivate`. */
export interface RemoteDeactivatedView { since: number; reason: string }

/** ADR-0509: one GPU the spoke's machine reports, with its memory when the driver tells it. */
export interface RemoteGpuView { name: string; vramMiB: number | null }

/** ADR-0509: the machine a spoke runs on, from its `capabilities` answer (add-on spoke host report). */
export interface RemoteHostView {
  os: string | null; arch: string | null; cpus: number | null; memMiB: number | null; diskFreeMiB: number | null;
  gpus: RemoteGpuView[];
  /** The local model endpoint the spoke is configured with, and whether it answered the spoke's last check. */
  localModel: { host: string; reachable: boolean } | null;
}

/** ADR-0509: what bounds the spoke's lane count. Closed set. ADR-0510: `laptop`, a battery-capable machine whose
 *  owner's own apps keep their memory. */
export const LANE_LIMITS = ["engine", "memory", "cpu", "gpu", "target", "config", "laptop"] as const;
export type RemoteLaneLimit = (typeof LANE_LIMITS)[number];

/** ADR-0509: the spoke's lane count, sized to its machine and where it is deployed, and why. */
export interface RemoteLanePolicyView { max: number; limitedBy: RemoteLaneLimit; why: string | null }

/** ADR-0509: the alerts a spoke seals to its hubs (add-on spoke alert note). Closed set. ADR-0510: `crl-stale` (the
 *  spoke's revocation list is past its nextUpdate plus grace, so it refuses drive and approve) and `cert-expiring`
 *  (14 days or less left on the spoke's certificate). */
export const ALERT_KINDS = ["engine-restarted", "agent-restarted", "crashed", "turn-interrupted", "crl-stale", "cert-expiring"] as const;
export type RemoteAlertKind = (typeof ALERT_KINDS)[number];

export interface RemoteAlertView { kind: RemoteAlertKind; at: number; detail: string; tasks: { id: string; name: string }[] }

/** A signed-in frontier provider on a spoke and the model ids it offers there (ADR-0508). */
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
  /** ADR-0508: the round trip of the hub's last `capabilities` request, including the spoke's mailbox poll. */
  latencyMs: number | null;
  via: RemoteVia | null;
  /** ADR-0508: from the spoke certificate the hub holds (root- or delegate-signed), not from the spoke. */
  region: string | null;
  classification: RemoteClassification | null;
  certExpires: number | null;
  engineVersion: string | null;
  models: RemoteModelsView;
  /** ADR-0509: from `capabilities`; null when the spoke did not report its machine (an older spoke). */
  host: RemoteHostView | null;
  lanePolicy: RemoteLanePolicyView | null;
  /** ADR-0509: from the hub. The spoke's newest relay poll, and since when it has been silent (set only while the
   *  hub reaches a relay and the spoke has neither polled it nor answered the hub for over 2 minutes). */
  lastSeen: number | null;
  silentSince: number | null;
  /** ADR-0509: the alerts the hub kept for this spoke, newest first (at most ALERTS_MAX). */
  alerts: RemoteAlertView[];
  /** ADR-0512: from the hub; null unless the owner deactivated this spoke (and always null from an older plugin). */
  deactivated: RemoteDeactivatedView | null;
  error?: string;
}

/** How the hub proves user presence on approve (ADR-0507, add-on ADR-A067): `password` asks for the hub's password
 *  on Approve only while the hub has not unlocked it (plugin ADR-A105 remembers it for a window; `presenceUnlocked`);
 *  when asked, the orbit takes it and the engine passes it through once; the platform kinds ask
 *  on the hub machine itself; `none` approves without evidence. null: not set up, or not reported. */
export const HUB_PRESENCE = ["password", "windows-hello", "macos-secure-enclave", "none"] as const;
export type HubPresence = (typeof HUB_PRESENCE)[number];

export type RemoteHubView =
  | { available: true; hub: { node: string; label: string; scopes: HubScope[]; presence: HubPresence | null; presenceUnlocked: boolean }; actions: HubActions; spokes: RemoteSpokeView[] }
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

// ------------------------------------------------------------------ models, route, certificate (ADR-0508)

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

// ------------------------------------------------------------- host, lane policy, alerts (ADR-0509)

/** A spoke's machine may list several GPUs; the IDE keeps this many. */
const GPU_MAX = 8;
/** The hub keeps the newest 20 alerts per spoke; the IDE never shows more. */
export const ALERTS_MAX = 20;
/** The tasks one alert may name. */
const ALERT_TASKS_MAX = 8;

/** The machine facts from `capabilities.host`; null when the spoke did not send a host record. Each malformed
 *  fact reads as unknown on its own; a GPU without a name is dropped. */
function mapHost(v: unknown): RemoteHostView | null {
  const h = record(v);
  if (!h) return null;
  const gpus = Array.isArray(h.gpus) ? h.gpus.map((g) => {
    const r = record(g);
    const name = clip(r?.name, 64);
    return name ? { name, vramMiB: count(r?.vramMiB) } : null;
  }).filter((g): g is RemoteGpuView => g !== null).slice(0, GPU_MAX) : [];
  const lm = record(h.localModel);
  const lmHost = clip(lm?.host, 128);
  const cpus = count(h.cpus);
  return {
    os: clip(h.os, 32), arch: clip(h.arch, 16), cpus: cpus === 0 ? null : cpus, memMiB: count(h.memMiB), diskFreeMiB: count(h.diskFreeMiB), gpus,
    localModel: lmHost && typeof lm?.reachable === "boolean" ? { host: lmHost, reachable: lm.reachable } : null,
  };
}

/** `capabilities.lanePolicy`: a positive max and a known limit, or nothing. */
function mapLanePolicy(v: unknown): RemoteLanePolicyView | null {
  const p = record(v);
  const max = count(p?.max);
  const limitedBy = LANE_LIMITS.find((l) => l === p?.limitedBy);
  if (!max || !limitedBy) return null;
  return { max, limitedBy, why: clip(p?.why, 200) };
}

/** The hub's alert list: known kinds with a time, newest first, at most ALERTS_MAX. Named tasks must carry a
 *  well-formed id; their names are clipped like task names. */
function mapAlerts(v: unknown): RemoteAlertView[] {
  if (!Array.isArray(v)) return [];
  const out: RemoteAlertView[] = [];
  for (const raw of v) {
    const a = record(raw);
    const kind = ALERT_KINDS.find((k) => k === a?.kind);
    const at = count(a?.at);
    if (!a || !kind || at === null) continue;
    const tasks = Array.isArray(a.tasks) ? a.tasks.map((t) => {
      const r = record(t);
      const name = clip(r?.name, 48);
      return typeof r?.id === "string" && TASK_RE.test(r.id) && name ? { id: r.id, name } : null;
    }).filter((t): t is { id: string; name: string } => t !== null).slice(0, ALERT_TASKS_MAX) : [];
    out.push({ kind, at, detail: clip(a.detail, 300) ?? "", tasks });
  }
  return out.sort((x, y) => y.at - x.at).slice(0, ALERTS_MAX);
}

/** The spoke's overall state from its reachability and tasks. Closed and stopped tasks hold no lane. ADR-0509: a
 *  spoke the hub reports silent is `silent` whatever it said last. ADR-0512: a deactivated spoke is `deactivated`
 *  whatever else the row says. */
export function spokeState(reachable: boolean | null, tasks: readonly RemoteTaskView[] | null, silentSince: number | null = null, deactivated = false): RemoteSpokeState {
  if (deactivated) return "deactivated";
  if (silentSince !== null) return "silent";
  if (reachable === null) return "checking";
  if (!reachable) return "offline";
  if (!tasks) return "error";
  if (tasks.some((t) => t.state === "awaiting_approval")) return "approval";
  if (tasks.some((t) => t.state === "working")) return "busy";
  if (tasks.some((t) => t.state === "error")) return "error";
  return "idle";
}

/** ADR-0512: the hub's `deactivated` mark, or null. The reason is the owner's text, clipped to 200 characters. */
function mapDeactivated(v: unknown): RemoteDeactivatedView | null {
  const d = record(v);
  const since = count(d?.since);
  return since ? { since, reason: clip(d?.reason, 200) ?? "no reason given" } : null;
}

/** One /host/spokes row as a view. A row whose node id is malformed is dropped (nothing could address it). */
export function mapSpokeRow(raw: unknown): RemoteSpokeView | null {
  const r = record(raw);
  if (!r || typeof r.node !== "string" || !NODE_RE.test(r.node)) return null;
  const reachable = typeof r.reachable === "boolean" ? r.reachable : null;
  const tasks = Array.isArray(r.tasks) ? r.tasks.map(mapTask).filter((t): t is RemoteTaskView => t !== null) : null;
  const caps = record(r.caps);
  const max = count(caps?.maxLanes), live = count(caps?.liveLanes), free = count(caps?.freeLanes);
  // ADR-0508: optional fields a newer hub plugin adds; an older one omits them and each reads as unknown.
  const viaKind = record(r.via)?.kind;
  const cert = record(r.cert);
  // ADR-0509: likewise optional; an older plugin or spoke omits them. A zero time is no time.
  // ADR-0512: likewise optional. A mark without a positive `since` is no mark; a deactivated spoke is never silent.
  const deactivated = mapDeactivated(r.deactivated);
  const silentSince = deactivated ? null : count(r.silentSince) || null;
  const view: RemoteSpokeView = {
    node: r.node,
    label: clip(r.label, 64) ?? r.node.slice(0, 12),
    state: spokeState(reachable, tasks, silentSince, deactivated !== null),
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
    host: mapHost(caps?.host),
    lanePolicy: mapLanePolicy(caps?.lanePolicy),
    lastSeen: count(r.lastSeen),
    silentSince,
    alerts: mapAlerts(r.alerts),
    deactivated,
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
  const presence = HUB_PRESENCE.find((k) => k === hub.presence) ?? null;
  return { available: true, hub: { node: hub.node, label: clip(hub.label, 64) ?? hub.node.slice(0, 12), scopes, presence, presenceUnlocked: hub.presenceUnlocked === true }, actions: hubActions(scopes), spokes };
}

// ---------------------------------------------------------------------------------------- display rules

/** The orbit's color language for a remote spoke, on the existing state hues: red when it is stuck on a human
 *  or failed, amber when it might be stuck (the hub has not heard from it), cyan while it works, blue when it is
 *  online and ready. Only `approval` animates: it is the one that blocks on a human. ADR-0512: `off`, the dimmest,
 *  for a spoke its owner deactivated: gray and faded, never red or amber, never animated. */
export type RemoteTone = "approval" | "stuck" | "maybe" | "busy" | "ready" | "checking" | "off";
export const REMOTE_TONE: Readonly<Record<RemoteSpokeState, RemoteTone>> = {
  approval: "approval", error: "stuck", offline: "maybe", busy: "busy", idle: "ready", checking: "checking",
  // ADR-0509: red, not amber. Offline may be this hub's own network; silent means the relay has not heard from
  // the spoke either, so it is most likely down.
  silent: "stuck",
  // ADR-0512: planned, so nothing to worry about.
  deactivated: "off",
};

export const REMOTE_STATE_LABEL: Readonly<Record<RemoteSpokeState, string>> = {
  checking: "checking", offline: "offline", approval: "parked approval", busy: "online, busy", error: "online, error", idle: "online, idle", silent: "silent",
  deactivated: "deactivated",
};

/** ADR-0512: a deactivated spoke in words, "Deactivated since 2026-11-05: <the owner's reason>" (local date). The
 *  orbit and the engine's refusals say it the same way. */
export function deactivatedLabel(d: RemoteDeactivatedView): string {
  const t = new Date(d.since);
  const day = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
  return `Deactivated since ${day}: ${d.reason}`;
}

/** ADR-0512: what the hub may do with this spoke. A deactivated spoke is offered nothing (no task, follow-up,
 *  recall, approve or deny): nothing reaches it until it is reactivated. Otherwise the certificate's scopes. */
export function spokeActions(s: RemoteSpokeView, a: HubActions): HubActions {
  return s.deactivated ? { recall: false, drive: false, approve: false, deny: false } : a;
}

/** P-RS-VIEW.1 (ADR-0539): whether a remote spoke is on the Fleet Orbit. The orbit shows work, so a spoke is there
 *  only while it holds a task (working, parked on an approval, failed, or waiting for a follow-up); closed and
 *  stopped tasks hold no lane. An idle machine, an offline one with nothing on it and a deactivated one live only
 *  in the Remote spokes view. A silent spoke that still holds a task stays: the work on it is what went quiet. */
export function onOrbit(s: RemoteSpokeView): boolean {
  return !s.deactivated && s.tasks.some((t) => t.state !== "closed" && t.state !== "stopped");
}

/** P-RS-LANES.1 (ADR-0551): the remote hub's numbers, one definition for the Fleet pill, the Hubs badge, the rail
 *  badge, the hub summary and the Remote spokes view, so no two of them can disagree. spokes: every spoke the hub
 *  holds, deactivated ones included. working: holding a task (onOrbit). waiting: parked on a human (state
 *  `approval`), with or without a task listed; a deactivated spoke never waits. alerts: the alert lines not
 *  dismissed yet (dismissals live in the renderer, so the caller counts them). */
export interface RemoteTotals { spokes: number; working: number; waiting: number; alerts: number }

export function remoteTotals(list: readonly RemoteSpokeView[], alerts: number): RemoteTotals {
  let working = 0;
  let waiting = 0;
  for (const s of list) {
    if (onOrbit(s)) working++;
    if (!s.deactivated && s.state === "approval") waiting++;
  }
  return { spokes: list.length, working, waiting, alerts };
}

/** P-RS-LANES.1 (ADR-0551): one remote lane in the Fleet grid. `key` is stable across polls (the node and task ids
 *  are NODE_RE and TASK_RE checked); `task` is null only for a spoke parked on a human with no open task listed, so
 *  its parked actions stay reachable. `state` is the lane's own: its task's (spokeState of that one task) while the
 *  spoke answers, else the spoke's (silent, offline, checking say more than a stale task state). */
export interface RemoteLane { key: string; spoke: RemoteSpokeView; task: RemoteTaskView | null; state: RemoteSpokeState }

/** P-RS-LANES.1 (ADR-0551): the Fleet grid's Remote section: one lane per open task (closed and stopped tasks hold
 *  no lane, as onOrbit says), spokes grouped by their label, a waiting spoke with no open task as one lane of its
 *  own. A deactivated spoke has none (ADR-0512): nothing can be sent to it. */
export function remoteLanes(list: readonly RemoteSpokeView[]): RemoteLane[] {
  const out: RemoteLane[] = [];
  const spokes = list.filter((s) => !s.deactivated).sort((a, b) => a.label.localeCompare(b.label) || a.node.localeCompare(b.node));
  for (const s of spokes) {
    const answers = s.state === "approval" || s.state === "busy" || s.state === "error" || s.state === "idle";
    const open = s.tasks.filter((t) => t.state !== "closed" && t.state !== "stopped");
    for (const t of open) out.push({ key: `rs:${s.node}:${t.id}`, spoke: s, task: t, state: answers ? spokeState(true, [t]) : s.state });
    if (open.length === 0 && s.state === "approval") out.push({ key: `rs:${s.node}:`, spoke: s, task: null, state: s.state });
  }
  return out;
}

/** ADR-0509: a time of day ("14:05"), with the date in front when it is not today. Local time. */
export function clockLabel(ms: number, now: number): string {
  const d = new Date(ms);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return d.toDateString() === new Date(now).toDateString() ? hm : `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${hm}`;
}

/** The state as words. ADR-0509: a silent spoke says since when ("silent since 14:05"), never "idle". ADR-0512: a
 *  deactivated one says since when and why. */
export function stateLabel(s: RemoteSpokeView, now: number): string {
  if (s.state === "deactivated" && s.deactivated) return deactivatedLabel(s.deactivated);
  return s.state === "silent" && s.silentSince !== null ? `silent since ${clockLabel(s.silentSince, now)}` : REMOTE_STATE_LABEL[s.state];
}

/** ADR-0509: memory and disk sizes as the IDE shows them: MiB under 1 GiB, else GiB to one decimal. */
export function mibLabel(mib: number): string {
  return mib < 1024 ? `${mib} MiB` : `${Number((mib / 1024).toFixed(1))} GiB`;
}

/** ADR-0509: the machine facts that matter when picking a spoke: cores, memory, each GPU and its memory. "" when
 *  the spoke reported none of them. */
export function hostLabel(h: RemoteHostView | null): string {
  if (!h) return "";
  const parts = [
    h.cpus !== null ? `${h.cpus} ${h.cpus === 1 ? "CPU" : "CPUs"}` : "",
    h.memMiB !== null ? `${mibLabel(h.memMiB)} memory` : "",
    ...h.gpus.map((g) => (g.vramMiB !== null ? `${g.name} ${mibLabel(g.vramMiB)}` : g.name)),
  ];
  return parts.filter(Boolean).join(" \u00b7 ");
}

export const LANE_LIMIT_LABEL: Readonly<Record<RemoteLaneLimit, string>> = {
  engine: "the engine", memory: "memory", cpu: "CPU", gpu: "GPU", target: "where it is deployed", config: "its configuration", laptop: "a laptop",
};

/** ADR-0509: the spoke's lane policy in words: "up to 4 lanes, limited by memory: <the spoke's why>". */
export function lanePolicyLabel(p: RemoteLanePolicyView): string {
  return `up to ${p.max} ${p.max === 1 ? "lane" : "lanes"}, limited by ${LANE_LIMIT_LABEL[p.limitedBy]}${p.why ? `: ${p.why}` : ""}`;
}

/** ADR-0509: one line of the IDE's alert list: a spoke that went silent, or an alert its hub kept. `key` is stable
 *  across polls, so a dismissal sticks. */
export interface RemoteAlertItem { key: string; node: string; label: string; kind: RemoteAlertKind | "silent"; at: number; text: string; tasks: { id: string; name: string }[] }

const ALERT_LABEL: Readonly<Record<RemoteAlertKind, string>> = {
  "engine-restarted": "engine restarted", "agent-restarted": "spoke agent restarted", crashed: "crashed", "turn-interrupted": "turn interrupted",
  "crl-stale": "revocation list out of date", "cert-expiring": "certificate expiring",
};

/** What the owner does about an alert, when there is one thing to do (ADR-0510 for the CRL and the certificate). */
const ALERT_ACTION: Readonly<Partial<Record<RemoteAlertKind, string>>> = {
  "turn-interrupted": "Resume it from the spoke's panel",
  "crl-stale": "Publish a fresh one from the root (root crl-refresh); until then the spoke refuses drive and approve",
  "cert-expiring": "Renew it (root renew, then hub renew-spoke)",
};

/** ADR-0509: a spoke's alert lines, newest first: its silence (when the hub reports one), then every kept alert.
 *  An interrupted turn names its tasks and says where to resume them; nothing is ever re-run on its own. A stale
 *  revocation list and an expiring certificate say what to run (ADR-0510). A deactivated spoke has none (ADR-0512):
 *  its quiet is planned, and nothing it kept from before is news until it is reactivated. */
export function spokeAlerts(s: RemoteSpokeView, now: number): RemoteAlertItem[] {
  if (s.deactivated) return [];
  const out: RemoteAlertItem[] = [];
  if (s.silentSince !== null) {
    const min = Math.max(2, Math.floor((now - s.silentSince) / 60_000));
    out.push({ key: `${s.node}|silent|${s.silentSince}`, node: s.node, label: s.label, kind: "silent", at: s.silentSince, tasks: [],
      text: `silent since ${clockLabel(s.silentSince, now)}: no word from it for ${min} min while its relay answers` });
  }
  for (const a of s.alerts) {
    const names = a.tasks.length ? ` (${a.tasks.map((t) => t.name).join(", ")})` : "";
    const action = ALERT_ACTION[a.kind];
    const resume = action ? `. ${action}` : "";
    out.push({ key: `${s.node}|${a.kind}|${a.at}`, node: s.node, label: s.label, kind: a.kind, at: a.at, tasks: a.tasks,
      text: `${ALERT_LABEL[a.kind]} at ${clockLabel(a.at, now)}${names}${a.detail ? `: ${a.detail.replace(/\.+$/, "")}` : ""}${resume}` });
  }
  return out;
}

export const VIA_LABEL: Readonly<Record<RemoteVia, string>> = { lan: "LAN", relay: "relay" };

/** Seconds with one decimal under 10 s, whole seconds above (the mailbox poll makes finer digits noise). */
function seconds(ms: number): string {
  return ms < 10_000 ? (ms / 1000).toFixed(1) : String(Math.round(ms / 1000));
}

/** ADR-0508: the hub's last round trip to the spoke. It includes the spoke's mailbox poll (about 2 s), so it
 *  reads as how fast the spoke answers, never as a network ping. */
export function latencyLabel(ms: number | null): string {
  return ms === null ? "answer time not measured yet" : `answers in ${seconds(ms)} s`;
}

/** The card's one-line glance: state, lanes, how fast it answers and over which route, and how many tasks are
 *  open. `now` only matters for a silent spoke's "silent since". ADR-0512: a deactivated spoke shows only that:
 *  its last lanes and answer time are stale. */
export function remoteGlance(s: RemoteSpokeView, now = Date.now()): string {
  if (s.deactivated) return stateLabel(s, now);
  const lanes = s.lanes ? ` \u00b7 ${s.lanes.live}/${s.lanes.max} lanes` : "";
  const answers = s.latencyMs !== null ? ` \u00b7 ${seconds(s.latencyMs)} s${s.via ? ` ${VIA_LABEL[s.via]}` : ""}` : "";
  const open = s.tasks.filter((t) => t.state === "working" || t.state === "awaiting_approval").length;
  return `${stateLabel(s, now)}${lanes}${answers}${open ? ` \u00b7 ${open} open` : ""}`;
}

/** How many distinct models the spoke reports: the default, its local models and every signed-in provider's. */
export function modelCount(s: RemoteSpokeView): number {
  const all = new Set([...s.models.local, ...s.models.frontier.flatMap((f) => f.models)]);
  if (s.models.default) all.add(s.models.default);
  return all.size;
}

/** ADR-0511: the models a task on this spoke may name, as "provider/id": its local models, then each signed-in
 *  provider's (a provider lists bare ids). The default is left out: a task that names no model runs on it, so the
 *  selector offers it first as "no model". A provider id with no model list offers nothing to pick. */
export function taskModelChoices(s: RemoteSpokeView): string[] {
  const frontier = s.models.frontier.flatMap((f) => f.models.map((m) => (m.startsWith(`${f.provider}/`) ? m : `${f.provider}/${m}`)));
  return [...new Set([...s.models.local, ...frontier])].filter((m) => m !== s.models.default && MODEL_ID_RE.test(m));
}

/** One row of the Start-a-task selector: the spoke, whether a task can start there now, and why not. */
export interface DeployChoice { spoke: RemoteSpokeView; eligible: boolean; why: string | null }

/** Why a task cannot start on this spoke now, or null when it can. The hub's scopes first (nothing can start
 *  without drive), then what the spoke said. A spoke that did not report lanes is offered: it decides. */
function deployBlock(s: RemoteSpokeView, a: HubActions): string | null {
  if (!a.drive) return "this hub cannot start tasks (no drive scope)";
  if (s.state === "silent") return "silent: it has not polled its relay for over 2 minutes";
  if (s.state === "checking") return "still checking";
  // An offline row the hub could say more about (a revoked certificate, a refusal) gives that reason: "offline"
  // alone would suggest waiting, when the spoke will never answer this hub again.
  if (s.state === "offline") return s.error ? `offline: ${s.error.slice(0, 120)}` : "offline";
  if (s.lanes && s.lanes.free === 0) return "no free lane: close an idle task on it to free one";
  return null;
}

/** ADR-0508: every spoke as a selector row, eligible first, then fastest answer (unmeasured last), then label.
 *  ADR-0512: a deactivated spoke is no row at all: it is not a target, not even a grayed-out one. */
export function deployChoices(spokes: readonly RemoteSpokeView[], a: HubActions): DeployChoice[] {
  return spokes
    .filter((spoke) => !spoke.deactivated)
    .map((spoke) => { const why = deployBlock(spoke, a); return { spoke, eligible: why === null, why }; })
    .sort((x, y) => Number(y.eligible) - Number(x.eligible)
      || (x.spoke.latencyMs ?? Number.POSITIVE_INFINITY) - (y.spoke.latencyMs ?? Number.POSITIVE_INFINITY)
      || x.spoke.label.localeCompare(y.spoke.label));
}

/** Which buttons a task row offers: what the certificate allows AND what the spoke would accept in this state
 *  (a follow-up waits for the turn to end; a closed or stopped task holds no lane to cancel or close). ADR-0509:
 *  a task whose turn a restart cut off offers Resume, a follow-up with RESUME_TEXT; a new turn clears the mark. */
export function taskButtons(t: RemoteTaskView, a: HubActions): { recall: boolean; followup: boolean; cancel: boolean; close: boolean; resume: boolean } {
  const live = t.state !== "closed" && t.state !== "stopped";
  const followup = a.drive && (t.state === "idle" || t.state === "error");
  return {
    recall: a.recall,
    followup,
    cancel: a.drive && (t.state === "working" || t.state === "awaiting_approval"),
    close: a.drive && live,
    resume: followup && t.interrupted !== undefined,
  };
}

/** ADR-0509: the one follow-up Resume sends. The human clicks it (twice); an interrupted turn is never re-run on
 *  its own, and the model is told to check what already happened before it repeats anything. */
export const RESUME_TEXT = "Continue this task. The previous turn was interrupted when the spoke restarted: check what was already done before you repeat anything.";

/** A parked action's buttons: an allow needs approve and an action the scanner passed; a deny needs drive or
 *  approve and is always offered then (refusing is safe). */
export function approvalButtons(v: RemoteApprovalView, a: HubActions): { approve: boolean; deny: boolean } {
  return { approve: a.approve && !v.quarantined, deny: a.deny };
}

/** The plugin panel's two-click rule (add-on ADR-A060), kept in the IDE for Approve, Close and Resume: the first
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
