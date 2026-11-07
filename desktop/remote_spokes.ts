// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/remote_spokes.ts - P-IDE-SPOKES.1 (ADR-0506): remote spokes in the IDE, engine side.
//
// The add-on hub runs inside the IDE as the `remote-spokes` server plugin (ADR-0462). The engine reaches its
// /host/* routes with the per-launch token the plugin runtime minted for it (PluginRuntime.hostEndpoint); the
// renderer never sees that token and never talks to the plugin. Every /api/remote-spokes/* route lands here:
//
//   GET  /api/remote-spokes             the hub, its scopes and every spoke (orbit, hub picker)
//   POST /api/remote-spokes/recall      {node, task?}            recall scope
//   GET  /api/remote-spokes/approvals   ?node=                   recall scope
//   POST /api/remote-spokes/decide      {node, task, ask, digest, allow, password?}   allow: approve; deny: drive or
//                                       approve; password: a `password` hub's presence password, on an allow only
//   POST /api/remote-spokes/submit      {node, text, name?, model?}   drive; model (ADR-0511): one the spoke
//                                       reports; the spoke and its engine check it again
//   POST /api/remote-spokes/followup    {node, task, text}       drive
//   POST /api/remote-spokes/cancel      {node, task}             drive
//   POST /api/remote-spokes/close       {node, task}             drive
//
// Scopes come from the hub's certificate as the plugin reports it, re-read on every action, so a button the
// renderer still shows after a scope change is refused here. The spokes check them a third time. ADR-0512: every
// action and read for a spoke the hub marks deactivated is refused here, before anything reaches the plugin.
//
// Recalled journal text and parked actions are untrusted model output from another machine (invariant 5). Every
// entry passes the fail-closed scan (scanAndDecide: scanner dead == quarantined) before it leaves this module;
// a quarantined entry's text is withheld, never shown, and recorded as a block. What passes is returned with its
// embedded delimiters neutralized, and as ONE UNTRUSTED_CONTENT envelope (`context`), the only form in which
// recalled text may reach a model. A parked action the scanner flags offers Deny only: its allow is refused here.

import type { GateDecision } from "../harness/security/gate.ts";
import { UNTRUSTED_END, UNTRUSTED_START } from "../harness/prompt/assembler.ts";
import { neutralizeDelimiters } from "../harness/omp/mcp_result_gate.ts";
import {
  deactivatedLabel, mapHubSnapshot, MODEL_ID_RE, NODE_RE, TASK_RE,
  type RecallEntryView, type RecallView, type RemoteActionView, type RemoteApprovalView, type RemoteApprovalsView, type RemoteHubView,
} from "./renderer/remote_spokes_model.ts";

export const REMOTE_SPOKES_PLUGIN = "remote-spokes";

/** The most recent entries a recall returns; older ones are counted in `omitted`. */
export const MAX_RECALL_ENTRIES = 200;
const MAX_TEXT = 32_000;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,47}$/;
/** A decision may wait on the hub's user-presence gesture (ADR-0507) before it is signed. */
const DECIDE_TIMEOUT_MS = 180_000;
const RECALL_TIMEOUT_MS = 180_000;
const ACTION_TIMEOUT_MS = 90_000;
const SUMMARY_TIMEOUT_MS = 10_000;

export interface RemoteSpokesDeps {
  /** PluginRuntime.hostEndpoint(REMOTE_SPOKES_PLUGIN): null unless the plugin is running. */
  endpoint(): { url: string; token: string } | null;
  /** Whether the hub plugin is installed at all (to say "install" rather than "start"). */
  installed(): boolean;
  /** scanAndDecide with the strict default policy; a dead scanner returns a blocking decision. */
  scan(text: string): Promise<GateDecision>;
  /** The security log's recordBlock, for every quarantined entry or action. */
  record(b: { tool: string; severity?: string; findings?: string; reason: string }): void;
  fetch?: typeof fetch;
}

type PluginReply = { ok: true; status: number; data: unknown } | { ok: false; error: string };

async function callPlugin(deps: RemoteSpokesDeps, method: "GET" | "POST", path: string, body: Record<string, unknown> | undefined, timeoutMs: number): Promise<PluginReply> {
  const ep = deps.endpoint();
  if (!ep) return { ok: false, error: deps.installed() ? "The Remote Spokes plugin is not running." : "The Remote Spokes plugin is not installed." };
  try {
    const res = await (deps.fetch ?? fetch)(`${ep.url}${path}`, {
      method,
      headers: { "x-lucid-host-token": ep.token, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data: unknown = await res.json().catch(() => null);
    return { ok: true, status: res.status, data };
  } catch (e) {
    return { ok: false, error: `The Remote Spokes plugin did not answer: ${(e as Error).message}` };
  }
}

/** The plugin's error text from a non-2xx reply. */
function pluginError(r: { status: number; data: unknown }): string {
  return field(asRecord(r.data), "error", 500) || `the Remote Spokes plugin answered ${r.status}`;
}

/** The hub as the IDE shows it. Never throws: every failure is an unavailable view with the reason. */
export async function loadHub(deps: RemoteSpokesDeps): Promise<RemoteHubView> {
  if (!deps.endpoint()) {
    return deps.installed()
      ? { available: false, plugin: "stopped", reason: "The Remote Spokes plugin is not running. Start it to see your remote spokes here." }
      : { available: false, plugin: "missing", reason: "Install the Remote Spokes plugin to see remote spokes here." };
  }
  const r = await callPlugin(deps, "GET", "/host/spokes", undefined, SUMMARY_TIMEOUT_MS);
  if (!r.ok) return { available: false, plugin: "running", reason: r.error };
  if (r.status !== 200) return { available: false, plugin: "running", reason: pluginError(r) };
  return mapHubSnapshot(r.data);
}

/** ADR-0514 (add-on RS-IDE-01, ADR-A074): the hub panel's address for a plugin tab. The plugin's page carries no
 *  secret; the engine asks the plugin (host token) for a one-time bootstrap secret and puts it in the URL fragment,
 *  which the page trades once for its session cookie and token. `ideOrigin` is the IDE window that frames the
 *  panel; the plugin allows no other frame-ancestor. */
export async function remoteSpokesPanelUrl(deps: RemoteSpokesDeps, ideOrigin: string): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const ep = deps.endpoint();
  if (!ep) return { ok: false, error: deps.installed() ? "The Remote Spokes plugin is not running." : "The Remote Spokes plugin is not installed." };
  const r = await callPlugin(deps, "POST", "/host/panel/bootstrap", { origin: ideOrigin }, SUMMARY_TIMEOUT_MS);
  if (!r.ok) return r;
  if (r.status !== 200) return { ok: false, error: pluginError(r) };
  const secret = asRecord(r.data)?.secret;
  if (typeof secret !== "string" || !/^[0-9a-f]{64}$/.test(secret)) return { ok: false, error: "The Remote Spokes plugin did not give a panel secret; update the plugin." };
  return { ok: true, url: `${ep.url}/#bootstrap=${secret}` };
}

/** A plain JSON object from the plugin, or null. */
function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** A string field, clipped; "" when absent or not a string. */
function field(o: Record<string, unknown> | null, k: string, max: number): string {
  const v = o?.[k];
  return typeof v === "string" ? v.slice(0, max) : "";
}

/** Header fields of the envelope are ours, built from validated ids and a sanitized label, never from free text. */
const safeAttr = (s: string): string => s.replace(/[^A-Za-z0-9 ._:@/-]/g, "_").slice(0, 64);

/** Scan every recalled entry and build the views and the one delimited envelope. Pure apart from `scan`/`record`.
 *  A malformed entry is quarantined like a flagged one: what cannot be read cannot be judged safe. A quarantined
 *  entry keeps only its number and time; its kind, task and text are withheld (they were scanned together). */
export async function gateRecall(
  raw: unknown, meta: { node: string; label: string; task?: string }, deps: Pick<RemoteSpokesDeps, "scan" | "record">,
): Promise<Extract<RecallView, { ok: true }>> {
  const all: unknown[] = Array.isArray(raw) ? raw : [];
  const omitted = Math.max(0, all.length - MAX_RECALL_ENTRIES);
  const entries: RecallEntryView[] = [];
  for (const item of all.slice(omitted)) {
    const e = asRecord(item);
    const seq = typeof e?.seq === "number" && Number.isSafeInteger(e.seq) ? e.seq : -1;
    const ts = typeof e?.ts === "number" && Number.isSafeInteger(e.ts) ? e.ts : 0;
    const task = field(e, "task", 32) || "-";
    const kind = field(e, "kind", 48) || "?";
    const data = asRecord(e?.data);
    if (seq < 0 || !data) {
      entries.push({ seq, ts, task: "-", kind: "withheld", trust: "quarantined", text: "", reason: "malformed journal entry" });
      continue;
    }
    // A turn is the model's own words; any other entry is its data as JSON (titles, reasons and inputs in it are
    // spoke-written too). The kind and task travel with it, so they are scanned with it.
    const text = kind === "task.turn" && typeof data.text === "string" ? data.text : JSON.stringify(data);
    const d = await deps.scan(`${kind}\n${task}\n${text}`);
    if (d.block) {
      entries.push({ seq, ts, task: "-", kind: "withheld", trust: "quarantined", text: "", reason: d.reason });
      deps.record({ tool: "remote_spoke_recall", severity: d.failClosed ? "high" : "critical", findings: d.findings.map((f) => f.type).join(",") || (d.failClosed ? "scanner-unavailable" : ""), reason: `recall from ${meta.label} entry ${seq} quarantined: ${d.reason}` });
      continue;
    }
    entries.push({ seq, ts, task: neutralizeDelimiters(task), kind: neutralizeDelimiters(kind), trust: d.trustLabel === "suspicious" ? "suspicious" : "untrusted", text: neutralizeDelimiters(text) });
  }
  const passed = entries.filter((e) => e.trust !== "quarantined");
  const trust = passed.some((e) => e.trust === "suspicious") ? "suspicious" : "untrusted";
  const context = passed.length === 0 ? "" : [
    UNTRUSTED_START,
    `[remote-spoke label="${safeAttr(meta.label)}" node="${meta.node}"${meta.task ? ` task="${meta.task}"` : ""} trust="${trust}"]`,
    ...passed.map((e) => `[entry seq=${e.seq} kind="${safeAttr(e.kind)}" task="${safeAttr(e.task)}" trust="${e.trust}"]\n${e.text}`),
    UNTRUSTED_END,
  ].join("\n");
  return { ok: true, node: meta.node, label: meta.label, ...(meta.task ? { task: meta.task } : {}), entries, quarantined: entries.length - passed.length, omitted, context };
}

/** Parked actions, scanned: a flagged action keeps its id and digest (Deny still works) and loses its text. */
export async function gateApprovals(raw: unknown, label: string, deps: Pick<RemoteSpokesDeps, "scan" | "record">): Promise<RemoteApprovalView[]> {
  const out: RemoteApprovalView[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const a = asRecord(item);
    const ask = asRecord(a?.ask);
    const task = field(a, "task", 32), id = field(ask, "id", 128), digest = field(ask, "digest", 64);
    if (!TASK_RE.test(task) || !id || !/^[0-9a-f]{64}$/.test(digest)) continue;
    const view: RemoteApprovalView = {
      task, name: field(a, "name", 48),
      ask: {
        id, digest, kind: field(ask, "kind", 64), title: field(ask, "title", 500), input: field(ask, "input", 8_000), tier: field(ask, "tier", 32), reason: field(ask, "reason", 500),
        expiresAt: typeof ask?.expiresAt === "number" && Number.isSafeInteger(ask.expiresAt) ? ask.expiresAt : 0,
      },
    };
    const d = await deps.scan(`${view.name}\n${view.ask.kind}\n${view.ask.title}\n${view.ask.input}\n${view.ask.reason}`);
    if (d.block) {
      view.quarantined = d.reason;
      view.ask = { ...view.ask, title: "", input: "", reason: "" };
      deps.record({ tool: "remote_spoke_approval", severity: "critical", findings: d.findings.map((f) => f.type).join(",") || "scanner-unavailable", reason: `parked action on ${label} (task ${task}) quarantined: ${d.reason}` });
    }
    out.push(view);
  }
  return out;
}

// --------------------------------------------------------------------------------------------- routes

const reply = (data: unknown): Response => Response.json({ ok: true, data });
const refuse = (error: string): Response => reply({ ok: false, error });

/** A JSON object body with exactly the allowed keys (strings or booleans as listed), or null. */
async function strictBody(req: Request, allowed: Record<string, "string" | "boolean">, required: readonly string[]): Promise<Record<string, string | boolean> | null> {
  let b: unknown;
  try { b = await req.json(); } catch { return null; }
  if (!b || typeof b !== "object" || Array.isArray(b)) return null;
  const out: Record<string, string | boolean> = {};
  for (const [k, v] of Object.entries(b)) {
    if (!(k in allowed) || typeof v !== allowed[k]) return null;
    out[k] = v as string | boolean;
  }
  return required.every((k) => k in out) ? out : null;
}

/** `decision`: an allow needs approve (it is signed), a deny needs drive or approve (refusing is always safe). */
const ACTION_BODIES: Record<string, { allowed: Record<string, "string" | "boolean">; required: string[]; scope: "recall" | "drive" | "decision" }> = {
  recall: { allowed: { node: "string", task: "string" }, required: ["node"], scope: "recall" },
  submit: { allowed: { node: "string", text: "string", name: "string", model: "string" }, required: ["node", "text"], scope: "drive" },
  followup: { allowed: { node: "string", task: "string", text: "string" }, required: ["node", "task", "text"], scope: "drive" },
  cancel: { allowed: { node: "string", task: "string" }, required: ["node", "task"], scope: "drive" },
  close: { allowed: { node: "string", task: "string" }, required: ["node", "task"], scope: "drive" },
  decide: { allowed: { node: "string", task: "string", ask: "string", digest: "string", allow: "boolean", password: "string" }, required: ["node", "task", "ask", "digest", "allow"], scope: "decision" },
};
/** The longest presence password the hub accepts (add-on presence.ts). */
const MAX_PASSWORD = 1024;

/** The spoke's parked actions through the plugin, scanned; a string is the refusal. */
async function readApprovals(deps: RemoteSpokesDeps, node: string, label: string): Promise<RemoteApprovalView[] | string> {
  const r = await callPlugin(deps, "GET", `/host/spokes/${node}/approvals`, undefined, ACTION_TIMEOUT_MS);
  if (!r.ok) return r.error;
  if (r.status !== 200) return pluginError(r);
  return gateApprovals(asRecord(r.data)?.approvals, label, deps);
}

/** The one entry point for /api/remote-spokes and /api/remote-spokes/*. The UI token already opened it. */
export async function handleRemoteSpokes(req: Request, path: string, deps: RemoteSpokesDeps): Promise<Response> {
  if (path === "/api/remote-spokes") return req.method === "GET" ? reply(await loadHub(deps)) : new Response("method not allowed", { status: 405 });
  const op = path.slice("/api/remote-spokes/".length);

  if (op === "approvals") {
    if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
    const node = new URL(req.url).searchParams.get("node") ?? "";
    const hub = await loadHub(deps);
    const gate = checkHub(hub, node, "recall");
    if (gate) return refuse(gate);
    const list = await readApprovals(deps, node, labelOf(hub, node));
    if (typeof list === "string") return refuse(list);
    const out: RemoteApprovalsView = { ok: true, approvals: list };
    return reply(out);
  }

  const spec = ACTION_BODIES[op];
  if (!spec) return new Response("not found", { status: 404 });
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  const b = await strictBody(req, spec.allowed, spec.required);
  if (!b) return refuse("malformed request");
  const node = String(b.node);
  const task = typeof b.task === "string" ? b.task : undefined;
  if (task !== undefined && !TASK_RE.test(task)) return refuse("malformed task id");
  if (typeof b.text === "string" && (!b.text.trim() || b.text.length > MAX_TEXT)) return refuse(`text must be 1 to ${MAX_TEXT} characters`);
  if (typeof b.name === "string" && !NAME_RE.test(b.name)) return refuse("name must be 1 to 48 letters, digits, spaces, dot, dash or underscore");
  if (typeof b.model === "string" && !MODEL_ID_RE.test(b.model)) return refuse("malformed model id");

  const hub = await loadHub(deps);
  // A decision's scope depends on its direction: an allow is signed (approve); a deny is safe for drive too.
  const scope = spec.scope === "decision" ? (b.allow === true ? "approve" : "deny") : spec.scope;
  const gate = checkHub(hub, node, scope);
  if (gate) return refuse(gate);
  const label = labelOf(hub, node);
  // ADR-0507 amendment: a `password` hub signs an allow only with its presence password, typed for this one
  // approval. It goes to the plugin once and nowhere else (never stored, logged, echoed or put in model context);
  // a deny, or an allow on a hub of another kind, never carries it.
  const needsPassword = op === "decide" && b.allow === true && hub.available && hub.hub.presence === "password";
  const password = needsPassword && typeof b.password === "string" && b.password ? b.password : undefined;
  if (needsPassword && !password) return refuse("this hub approves with its presence password: type it to sign the approval");
  if (password && password.length > MAX_PASSWORD) return refuse(`the presence password is at most ${MAX_PASSWORD} characters`);

  if (op === "recall") {
    const r = await callPlugin(deps, "POST", `/host/spokes/${node}/recall`, task ? { task } : {}, RECALL_TIMEOUT_MS);
    if (!r.ok) return refuse(r.error);
    if (r.status !== 200) return refuse(pluginError(r));
    return reply(await gateRecall(asRecord(r.data)?.entries, { node, label, ...(task ? { task } : {}) }, deps));
  }

  if (op === "decide" && b.allow === true) {
    // Re-read and re-scan the parked action: an allow is signed only for an action the scanner passed and the
    // human saw. The plugin then re-reads it once more and checks the digest before it signs.
    const list = await readApprovals(deps, node, label);
    if (typeof list === "string") return refuse(list);
    const item = list.find((a) => a.task === task && a.ask.id === b.ask);
    if (!item) return refuse("that action is no longer waiting");
    if (item.ask.digest !== b.digest) return refuse("the waiting action changed since it was shown; refresh and look again");
    if (item.quarantined) return refuse(`the scanner flagged this action, so it can only be denied: ${item.quarantined}`);
  }

  const forward: Record<string, unknown> = { ...b };
  delete forward.node;
  delete forward.password;
  if (password !== undefined) forward.password = password;
  const r = await callPlugin(deps, "POST", `/host/spokes/${node}/${op}`, forward, op === "decide" ? DECIDE_TIMEOUT_MS : ACTION_TIMEOUT_MS);
  if (!r.ok) return refuse(r.error);
  if (r.status !== 200) return refuse(pluginError(r));
  const out: RemoteActionView = { ok: true, data: r.data };
  return reply(out);
}

/** Why this hub may not act on `node` with `scope`, or null when it may. ADR-0512: nothing at all goes to a spoke the
 *  hub marks deactivated (it is unplugged or elsewhere on purpose), recall and deny included. */
function checkHub(hub: RemoteHubView, node: string, scope: "recall" | "drive" | "approve" | "deny"): string | null {
  if (!hub.available) return hub.reason;
  const spoke = NODE_RE.test(node) ? hub.spokes.find((s) => s.node === node) : undefined;
  if (!spoke) return "this hub does not know that spoke";
  if (spoke.deactivated) return `${spoke.label}: ${deactivatedLabel(spoke.deactivated)}. Nothing is sent to a deactivated spoke; reactivate it on the hub first (hub reactivate --spoke ${node})`;
  if (!hub.actions[scope]) return scope === "deny" ? "this hub's certificate carries neither the drive nor the approve scope" : `this hub's certificate does not carry the ${scope} scope`;
  return null;
}

function labelOf(hub: RemoteHubView, node: string): string {
  return (hub.available ? hub.spokes.find((s) => s.node === node)?.label : undefined) ?? node.slice(0, 12);
}
