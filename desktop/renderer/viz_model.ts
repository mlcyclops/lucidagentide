// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/viz_model.ts - P-VIZ.1 (ADR-0622): the PURE state behind the Visualize view.
//
// Nodes are the hub (the Main session), every fleet lane of the current hub (an agent) and every subagent
// (a delegation from Main or from a lane). Each node carries an ESTIMATED token rate: streamed `token` and
// `thinking` text is counted as chars / 4 and folded into an exponential moving average over about a second.
// It is an estimate and every surface says "est. tok/s"; nothing here claims a measured rate. A subagent has
// no token stream at all, so its flow is driven by its run being live and its step cadence, and its hover
// says "live, N tools" instead of a made-up rate.
//
// Power-down events are distinct by cause: `tool-failed` (a tool call failed), `paused` (the turn was
// cancelled), `ended` (a turn finished, an agent stopped, a subagent run completed) and `killed` (an agent
// was removed or force-stopped, or died on an error). A bounded log of every event rides into a recording.
//
// DOM-free and IO-free: viz_view.ts feeds it (bus taps, fleet polls, subagent run polls), viz_scene.ts draws
// it, and viz_model.test.ts pins the rules headless.
//
// P-VIZ.4 (ADR-0625): a lane's `task` delegations arrive on its stream like Main's and hang off the lane.
// omp runs them in the BACKGROUND (the task call returns at once), so the task call's settle does not end
// them: the lane's own run poll (applyRuns with the lane as parent) does, or the lane stopping. Only a
// task call that FAILED ends its batch at once. Every node keeps `idleSince` (the office figure dozes off
// after a minute), and `teamOf` says how many of a node's team work while it does not (it supervises).

import { orbitSlots } from "./orbit_layout.ts";
import type { PerfTier } from "./perf_tier.ts";
import type { VizBusEvent, VizOrigin } from "./viz_bus.ts";

export const HUB_ID = "main";

/** P-VIZ.4 (ADR-0625): how the figures are drawn: the anime mini Lucids, or office workers at desks. */
export type VizStyle = "anime" | "professional";

export type VizKind = "hub" | "agent" | "subagent";

/** The closed set of personas a node can wear. Each has a color: P-VIZ.2 (ADR-0623) dresses that node's mini
 *  Lucid in it (viz_mini_look.lookFor) and picks his repertoire of activities from the persona. */
export type Persona = "lead" | "coder" | "tester" | "reviewer" | "researcher" | "planner" | "writer" | "guard" | "builder" | "scout";
export interface PersonaLook { label: string; color: string }

/** A categorical data-visualization palette, readable on both themes (the scene draws its own backdrop). */
export const PERSONAS: Record<Persona, PersonaLook> = {
  lead: { label: "Lead", color: "#b07cff" },
  coder: { label: "Coder", color: "#38bdf8" },
  tester: { label: "Tester", color: "#4ade80" },
  reviewer: { label: "Reviewer", color: "#fbbf24" },
  researcher: { label: "Researcher", color: "#2dd4bf" },
  planner: { label: "Planner", color: "#818cf8" },
  writer: { label: "Writer", color: "#f472b6" },
  guard: { label: "Guard", color: "#f87171" },
  builder: { label: "Builder", color: "#fb923c" },
  scout: { label: "Scout", color: "#a3e635" },
};

/** omp agent types (the `subagent` event's `agent`) that name a persona outright. */
const AGENT_TYPES: Record<string, Persona> = {
  explore: "scout", scout: "scout", quick_task: "scout",
  plan: "planner", planner: "planner", architect: "planner", designer: "planner",
  reviewer: "reviewer", review: "reviewer", critic: "reviewer",
  research: "researcher", researcher: "researcher", librarian: "researcher",
  tester: "tester", test: "tester", qa: "tester",
  docs: "writer", writer: "writer",
  "security-reviewer": "guard", security: "guard", auditor: "guard",
  build: "builder", builder: "builder", deploy: "builder",
};

/** Keyword rules over the name, assignment and title, in priority order (security before review, so a
 *  "security review" is a guard). Word-bounded so "latest" is not a test and "explanation" is not a plan. */
const KEYWORDS: readonly [RegExp, Persona][] = [
  [/\b(?:security|vuln\w*|audit\w*|threat\w*|cve|pentest|secrets?)\b/, "guard"],
  [/\b(?:tests?|testing|qa|e2e|coverage|verify|verification)\b/, "tester"],
  [/\b(?:review\w*|critique|lint\w*)\b/, "reviewer"],
  [/\b(?:research\w*|investigat\w*|explor\w*|survey|compare|analy\w*|study)\b/, "researcher"],
  [/\b(?:plan\w*|design\w*|architect\w*|roadmap|outline|spec)\b/, "planner"],
  [/\b(?:docs?|documentation|readme|changelog|write-?up|blog|explain\w*|explanations?)\b/, "writer"],
  [/\b(?:build\w*|deploy\w*|release\w*|ci|package\w*|bundle|compile\w*|install\w*)\b/, "builder"],
  [/\b(?:scout\w*|find|locate|grep|search\w*|map)\b/, "scout"],
];

/** The persona for a node: the hub leads; a known agent type wins; else the first keyword rule that matches
 *  the name, assignment or title; else a coder (an agent's default work is code). */
export function personaFor(input: { kind: VizKind; agentType?: string; text?: string }): Persona {
  if (input.kind === "hub") return "lead";
  const t = (input.agentType ?? "").trim().toLowerCase();
  const byType = t ? AGENT_TYPES[t] : undefined;
  if (byType) return byType;
  const text = (input.text ?? "").toLowerCase().replace(/[_]+/g, " ");
  for (const [re, p] of KEYWORDS) if (re.test(text)) return p;
  return "coder";
}

/** The tiny caption on a node's glass frame: at most `max` characters, ellipsized, one line. */
export function shortLabel(text: string, max = 18): string {
  const s = text.replace(/\s+/g, " ").trim();
  if (!s) return "";
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}\u2026`;
}

// ------------------------------------------------------------------------------------------- state

/** A node's lasting state (what the scene paints until something changes it). */
export type VizStatus = "idle" | "active" | "waiting" | "paused" | "ended" | "killed";
export type PowerKind = "tool-failed" | "paused" | "ended" | "killed";
export type VizAsk = "cancel" | "end" | "kill";

export interface VizNode {
  id: string;
  kind: VizKind;
  parent: string | null;
  name: string;
  /** The caption on the glass frame. */
  label: string;
  persona: Persona;
  model: string;
  status: VizStatus;
  /** The lane's own status word as last reported (agents only). */
  laneStatus: string | null;
  /** Estimated tokens per second: chars / 4 of streamed text, EMA over about RATE_TAU_MS. */
  rate: number;
  /** The slow trailing mean of `rate` that a surge is measured against. */
  mean: number;
  /** Estimated tokens counted since the last tick. */
  pending: number;
  totalTok: number;
  tools: number;
  toolFails: number;
  /** 0..1 pulse for nodes with no token stream (subagents, untapped agents); decays. */
  activity: number;
  /** When a token stream last fed this node (0 = never): makes `rate` meaningful. */
  tappedAt: number;
  lastAt: number;
  bornAt: number;
  endedAt: number | null;
  /** Removed from the fleet: kept only while its power-down plays, then dropped. */
  goneAt: number | null;
  /** What the user asked of it from the Visualize view, so the following status reads as that cause. */
  asked: VizAsk | null;
  surgeAt: number;
  agentType: string | null;
  assignment: string | null;
  runName: string | null;
  /** Subagents: the task call (toolCallId) that spawned this one, so a failed call ends its batch. */
  batch: string | null;
  /** Subagents: a run poll has reported this run, so the poll (not the parent's turn) decides its end. */
  polled: boolean;
  /** When the node last stopped working (null while it works). */
  idleSince: number | null;
  usage: { used: number; size: number; cost: number } | null;
  /** P-VIZ.7 (ADR-0641): git commit / push calls still running (call id -> opened at), and until when the commit
   *  animation holds after the last one settles (so a fast commit still reads). */
  commit: { open: Map<string, number>; holdUntil: number };
}

export type VizEvent =
  | { kind: "surge"; at: number; node: string; rate: number }
  | { kind: "power"; at: number; node: string; power: PowerKind; why: string }
  | { kind: "spawn"; at: number; node: string };

export interface VizState {
  nodes: Map<string, VizNode>;
  /** Bounded history of every event, newest last (a recording carries the slice it covers). */
  log: VizEvent[];
  /** Events the scene has not drawn yet (drained each frame). */
  fresh: VizEvent[];
  /** Which stream feeds each source right now (one per source; see `accepts`). */
  feeds: Map<string, { origin: VizOrigin; at: number }>;
  lastTick: number;
}

export const RATE_TAU_MS = 1000;
export const MEAN_TAU_MS = 8000;
export const ACTIVITY_TAU_MS = 3000;
/** A surge: the rate jumps above SURGE_K times its trailing mean (and at least SURGE_MIN), or past SURGE_FLOOR. */
export const SURGE_K = 2.2;
export const SURGE_MIN = 12;
export const SURGE_FLOOR = 140;
export const SURGE_COOLDOWN_MS = 1500;
/** A second stream for the same source is ignored while the first fed it within this window. */
export const FEED_HOLD_MS = 4000;
/** A rate is shown only while a stream fed the node this recently. */
export const TAPPED_MS = 30_000;
/** A subagent run whose last step is older than this reads as quiet, not working (the subagent card's line). */
export const RUN_QUIET_MS = 45_000;
/** Ended subagents stay visible this long (their power-down plays), then leave the scene. */
export const SUB_LINGER_MS = 60_000;
/** A removed agent stays this long for its power-down, then is dropped. */
export const GONE_MS = 4500;
/** A finished run older than this is history, not something to show on open. Shorter than SUB_LINGER_MS,
 *  so a run whose node already lingered and left is never resurrected by the next poll. */
export const RUN_RECENT_MS = 45_000;
/** A delegation whose runs never appeared ends quietly this long after its parent went idle. */
export const ORPHAN_MS = 60_000;
export const SUB_MAX_PER_PARENT = 12;
export const LOG_MAX = 400;
const FRESH_MAX = 200;

export function createVizState(now: number, hubModel = ""): VizState {
  const s: VizState = { nodes: new Map(), log: [], fresh: [], feeds: new Map(), lastTick: now };
  s.nodes.set(HUB_ID, newNode({ id: HUB_ID, kind: "hub", parent: null, name: "Main", label: "Main", persona: "lead", model: hubModel }, now));
  return s;
}

function newNode(p: { id: string; kind: VizKind; parent: string | null; name: string; label: string; persona: Persona; model: string }, now: number): VizNode {
  return {
    ...p, status: "idle", laneStatus: null, rate: 0, mean: 0, pending: 0, totalTok: 0, tools: 0, toolFails: 0, activity: 0,
    tappedAt: 0, lastAt: now, bornAt: now, endedAt: null, goneAt: null, asked: null, surgeAt: 0,
    agentType: null, assignment: null, runName: null, batch: null, polled: false, idleSince: now, usage: null,
    commit: { open: new Map(), holdUntil: 0 },
  };
}

// ---------------------------------------------------------------------------------------------- commits

/** P-VIZ.7 (ADR-0641): a tool call that commits or pushes: `git [opts] commit|push` in a shell command (options
 *  such as `-C <dir>` or `-c k=v` may sit between), or the commit namespace's `.commit("subject"` in eval code. */
export const COMMIT_CALL_RE = /\bgit(?:\s+-{1,2}[\w-]+(?:[= ](?:"[^"]*"|'[^']*'|\S+))?)*\s+(?:commit|push)\b|\.commit\(\s*["'`]/;
/** After the last commit call settles, the animation holds this long (a quick commit still reads). */
export const COMMIT_HOLD_MS = 3000;
/** A commit call that never reports back stops animating after this long. */
export const COMMIT_MAX_MS = 180_000;

function isCommitCall(e: Loose): boolean {
  for (const v of [e.input, e.detail, e.intent]) if (typeof v === "string" && COMMIT_CALL_RE.test(v)) return true;
  return false;
}

function commitSettled(n: VizNode, id: unknown, now: number): void {
  if (typeof id !== "string" || !n.commit.open.delete(id)) return;
  n.commit.holdUntil = Math.max(n.commit.holdUntil, now + COMMIT_HOLD_MS);
}

/** Every open commit call is over (the turn ended or died): hold, then stop. */
function commitsEnded(n: VizNode, now: number): void {
  if (!n.commit.open.size) return;
  n.commit.open.clear();
  n.commit.holdUntil = Math.max(n.commit.holdUntil, now + COMMIT_HOLD_MS);
}

/** Is the node committing right now (a commit or push call is running, or one just settled)? */
export function committing(n: VizNode, now: number): boolean {
  if (now < n.commit.holdUntil) return true;
  for (const at of n.commit.open.values()) if (now - at < COMMIT_MAX_MS) return true;
  return false;
}

/** chars / 4: the usual rough count for English text and code. An estimate, labeled as one everywhere. */
export function estTokens(text: string): number { return text.length / 4; }

function push(s: VizState, ev: VizEvent): void {
  s.log.push(ev);
  if (s.log.length > LOG_MAX) s.log.splice(0, s.log.length - LOG_MAX);
  s.fresh.push(ev);
  if (s.fresh.length > FRESH_MAX) s.fresh.splice(0, s.fresh.length - FRESH_MAX);
}

function power(s: VizState, n: VizNode, kind: PowerKind, now: number, why: string): void {
  push(s, { kind: "power", at: now, node: n.id, power: kind, why });
}

/** Take the events the scene has not drawn yet. */
export function drainEvents(s: VizState): VizEvent[] {
  const out = s.fresh;
  s.fresh = [];
  return out;
}

/** One stream per source: a second stream for the same lane (its grid card and the composer attached to it
 *  both carry its events) is ignored while the first fed it in the last FEED_HOLD_MS, so nothing counts twice. */
export function accepts(s: VizState, source: string, origin: VizOrigin, now: number): boolean {
  const f = s.feeds.get(source);
  if (f && f.origin !== origin && now - f.at < FEED_HOLD_MS) return false;
  s.feeds.set(source, { origin, at: now });
  return true;
}

/** The user asked something of a node from the view: the status that follows reads as that cause. */
export function markAsked(s: VizState, id: string, ask: VizAsk): void {
  const n = s.nodes.get(id);
  if (n) n.asked = ask;
}

/** Fresh activity on a node: it is alive and working (a respawned or resumed node leaves its power-down). */
function wake(n: VizNode, now: number): void {
  n.lastAt = now;
  if (n.goneAt !== null) return;
  if (n.status !== "active") { n.status = "active"; n.endedAt = null; }
}

type Loose = { type: string; text?: unknown; status?: unknown; ok?: unknown; name?: unknown; id?: unknown; agent?: unknown; title?: unknown; assignments?: unknown; names?: unknown; message?: unknown; used?: unknown; size?: unknown; cost?: unknown; detail?: unknown; turns?: unknown; input?: unknown; intent?: unknown };

/** Fold one tapped event in. Events for a source that is neither Main nor a known agent are dropped
 *  (another hub's lane, or a lane the fleet poll has not listed yet). True when the event was taken (not a
 *  duplicate from a second stream), so the view can keep the same one-stream record of the output. */
export function applyEvent(s: VizState, ev: VizBusEvent, now: number): boolean {
  const n = s.nodes.get(ev.source);
  if (!n || n.kind === "subagent" || n.goneAt !== null) return false;
  if (!accepts(s, ev.source, ev.origin, now)) return false;
  fold(s, n, ev.e as Loose, now);
  return true;
}

function fold(s: VizState, n: VizNode, e: Loose, now: number): void {
  switch (e.type) {
    case "token":
    case "thinking": {
      const t = typeof e.text === "string" ? estTokens(e.text) : 0;
      if (t <= 0) return;
      n.pending += t; n.totalTok += t; n.tappedAt = now;
      wake(n, now);
      return;
    }
    case "tool":
      // P-VIZ.7: a lane settles a call with its own tool event (done or failed); Main settles it with tool-meta.
      if (e.status === "done" || e.status === "failed") commitSettled(n, e.id, now);
      if (e.status === "failed") { toolFailed(s, n, now, typeof e.name === "string" ? e.name : "tool"); failBatch(s, n, e.id, now); return; }
      if (e.status === undefined || e.status === "open") {
        n.tools++; n.activity = 1; wake(n, now);
        if (isCommitCall(e)) n.commit.open.set(typeof e.id === "string" ? e.id : `commit-${now}`, now);
      }
      return;
    case "tool-meta":
      if (e.ok !== undefined) commitSettled(n, e.id, now);
      if (e.ok === false) { toolFailed(s, n, now, typeof e.name === "string" ? e.name : "tool"); failBatch(s, n, e.id, now); }
      return;
    case "subagent":
      addSubagents(s, n, e, now);
      return;
    case "status":
      if (typeof e.status === "string") applyLaneStatus(s, n, e.status, now);
      return;
    case "usage":
      if (typeof e.used === "number" && typeof e.size === "number") n.usage = { used: e.used, size: e.size, cost: typeof e.cost === "number" ? e.cost : 0 };
      return;
    case "done":
      turnEnd(s, n, now);
      return;
    case "error":
    case "no-response":
      die(s, n, now, typeof e.message === "string" && e.message ? e.message : "the turn failed");
      return;
    default:
      return;
  }
}

function toolFailed(s: VizState, n: VizNode, now: number, tool: string): void {
  n.toolFails++;
  n.lastAt = now;
  power(s, n, "tool-failed", now, `${tool} failed`);
}

function die(s: VizState, n: VizNode, now: number, why: string): void {
  commitsEnded(n, now);
  if (n.status === "killed") return;
  n.status = "killed"; n.endedAt = now; n.rate = 0; n.pending = 0; n.asked = null;
  power(s, n, "killed", now, why);
  endChildren(s, n, now, "its parent stopped");
}

/** A turn ended on `n`: a cancel the user asked for reads as paused, a natural end as a soft ended.
 *  Delegations that rode a LANE turn end with it (lanes have no run poll); Main's background runs are
 *  governed by the run poll instead. */
function turnEnd(s: VizState, n: VizNode, now: number): void {
  commitsEnded(n, now);
  if (n.asked === "cancel") {
    n.asked = null; n.status = "paused"; n.rate = 0;
    power(s, n, "paused", now, "turn stopped");
  } else if (n.status === "active" || n.status === "waiting") {
    n.status = "idle";
    power(s, n, "ended", now, "turn finished");
  }
  if (n.kind === "agent") endChildren(s, n, now, "the agent's turn ended", true);
}

/** End `parent`'s live subagents. `unpolledOnly`: a turn end leaves the runs a poll is tracking (omp runs
 *  delegations in the background, so they outlive the turn that spawned them; the poll ends them). */
function endChildren(s: VizState, parent: VizNode, now: number, why: string, unpolledOnly = false): void {
  for (const c of s.nodes.values()) {
    if (c.parent !== parent.id || c.kind !== "subagent" || c.status === "ended" || c.status === "killed") continue;
    if (unpolledOnly && c.polled) continue;
    c.status = "ended"; c.endedAt = now;
    power(s, c, "ended", now, why);
  }
}

/** A `task` call failed: the subagents it announced never ran (or died with it). */
function failBatch(s: VizState, parent: VizNode, id: unknown, now: number): void {
  if (typeof id !== "string" || !id) return;
  for (const c of s.nodes.values()) {
    if (c.parent !== parent.id || c.batch !== id || c.status === "ended" || c.status === "killed") continue;
    c.status = "killed"; c.endedAt = now;
    power(s, c, "killed", now, "the task call failed");
  }
}

/** A lane's status word, from its stream or the fleet poll. Transitions only: a repeat is a no-op. */
export function applyLaneStatus(s: VizState, n: VizNode, st: string, now: number): void {
  const prev = n.laneStatus;
  if (prev === st) return;
  n.laneStatus = st;
  switch (st) {
    case "starting":
    case "working":
      if (n.status === "killed" || n.status === "ended") n.asked = null; // a respawn starts clean
      wake(n, now);
      return;
    case "needs-approval":
    case "awaiting-input":
      n.status = "waiting"; n.endedAt = null;
      return;
    case "done":
      if (prev === null) { if (n.status !== "paused") n.status = "idle"; return; } // first sight: no transition
      turnEnd(s, n, now);
      return;
    case "stopped":
      if (prev === null) { n.status = "ended"; n.endedAt = now; return; }
      if (n.asked === "kill") { die(s, n, now, "force-stopped"); return; }
      if (n.status === "ended") return;
      n.status = "ended"; n.endedAt = now; n.rate = 0; n.asked = null;
      power(s, n, "ended", now, "agent stopped");
      endChildren(s, n, now, "its agent stopped");
      return;
    case "error":
      if (prev === null) { n.status = "killed"; n.endedAt = now; return; }
      die(s, n, now, "the agent hit an error");
      return;
    default:
      return;
  }
}

/** A delegation began on `parent`: one subagent node per assignment, named by the run name when the
 *  delegation carried names (the same stems the run poll reports). */
function addSubagents(s: VizState, parent: VizNode, e: Loose, now: number): void {
  const assignments = Array.isArray(e.assignments) ? e.assignments.filter((a): a is string => typeof a === "string") : [];
  const names = Array.isArray(e.names) ? e.names.filter((a): a is string => typeof a === "string") : [];
  const agent = typeof e.agent === "string" ? e.agent : "task";
  const title = typeof e.title === "string" ? e.title : "";
  const batch = typeof e.id === "string" ? e.id : String(now);
  const count = Math.max(1, assignments.length);
  let have = [...s.nodes.values()].filter((c) => c.parent === parent.id && c.kind === "subagent").length;
  wake(parent, now);
  for (let i = 0; i < count && have < SUB_MAX_PER_PARENT; i++) {
    const id = `sa:${parent.id}:${batch}:${i}`;
    if (s.nodes.has(id)) continue;
    const name = names[i] ?? `${agent} ${i + 1}`;
    const assignment = assignments[i] ?? title;
    const n = newNode({
      id, kind: "subagent", parent: parent.id, name,
      label: shortLabel(names[i] ?? assignment ?? name, 16) || shortLabel(name, 16),
      persona: personaFor({ kind: "subagent", agentType: agent, text: `${name} ${assignment} ${title}` }),
      model: "",
    }, now);
    n.agentType = agent; n.assignment = assignment || null; n.runName = names[i] ?? null; n.batch = typeof e.id === "string" && e.id ? e.id : null;
    n.status = "active"; n.activity = 1;
    s.nodes.set(id, n);
    have++;
    push(s, { kind: "spawn", at: now, node: id });
  }
}

// ----------------------------------------------------------------------------------- poll inputs

export interface VizLaneInput { id: string; name: string; model: string; status: string; usage?: { used: number; size: number; cost: number } }

/** The fleet poll (the current hub's lanes, in fleet order). New lanes join; a lane that left the list
 *  powers down (killed if the user force-removed it or it was mid-work, else ended) and is dropped once
 *  that has played. */
export function applyFleet(s: VizState, lanes: readonly VizLaneInput[], now: number, hubModel?: string): void {
  const hub = s.nodes.get(HUB_ID);
  if (hub && hubModel !== undefined) hub.model = hubModel;
  const seen = new Set<string>();
  for (const l of lanes) {
    seen.add(l.id);
    let n = s.nodes.get(l.id);
    if (!n) {
      n = newNode({ id: l.id, kind: "agent", parent: HUB_ID, name: l.name, label: shortLabel(l.name), persona: personaFor({ kind: "agent", text: l.name }), model: l.model }, now);
      s.nodes.set(l.id, n);
      push(s, { kind: "spawn", at: now, node: l.id });
    } else if (n.name !== l.name) {
      n.name = l.name; n.label = shortLabel(l.name); n.persona = personaFor({ kind: "agent", text: l.name });
    }
    n.model = l.model;
    if (l.usage) n.usage = l.usage;
    applyLaneStatus(s, n, l.status, now);
  }
  for (const n of s.nodes.values()) {
    if (n.kind !== "agent" || seen.has(n.id) || n.goneAt !== null) continue;
    const busy = n.status === "active" || n.status === "waiting";
    const kill = n.asked === "kill" || busy;
    if (kill && n.status !== "killed") power(s, n, "killed", now, n.asked === "kill" ? "removed" : "removed while working");
    else if (!kill && n.status !== "ended" && n.status !== "killed") power(s, n, "ended", now, "removed");
    n.status = kill ? "killed" : n.status === "killed" ? "killed" : "ended";
    n.goneAt = now; n.endedAt = now; n.rate = 0;
    endChildren(s, n, now, "its agent was removed");
  }
}

export interface VizRunInput { name: string; done: boolean; lastAt: number; startedAt?: number; endedAt?: number; assignment: string; model: string | null; tools: number; steps: readonly { kind: string }[] }

/** The subagent run poll (/api/subagents: Main's runs; P-VIZ.4, with `?laneId=`: that lane's runs, `parent`
 *  the lane). A run joins the subagent node its delegation created under the same parent (by run name, else
 *  by assignment), or becomes a node of its own when it is live or finished recently. Step cadence drives
 *  the node's activity; `done` ends it. A polled node is the poll's to end, not its parent's turn's. */
export function applyRuns(s: VizState, runs: readonly VizRunInput[], now: number, parentId: string = HUB_ID): void {
  const parent = s.nodes.get(parentId);
  if (!parent || parent.kind === "subagent" || parent.goneAt !== null) return;
  const mine = (): VizNode[] => [...s.nodes.values()].filter((c) => c.kind === "subagent" && c.parent === parentId);
  for (const r of runs) {
    let n = mine().find((c) => c.runName === r.name);
    if (!n) n = mine().find((c) => c.runName === null && !!c.assignment && sameTask(c.assignment, r.assignment));
    if (!n) {
      const finishedAt = r.endedAt ?? r.lastAt;
      if (r.done && now - finishedAt > RUN_RECENT_MS) continue;
      if (mine().length >= SUB_MAX_PER_PARENT) continue;
      n = newNode({
        id: parentId === HUB_ID ? `run:${r.name}` : `run:${parentId}:${r.name}`, kind: "subagent", parent: parentId, name: r.name, label: shortLabel(r.name, 16),
        persona: personaFor({ kind: "subagent", text: `${r.name} ${r.assignment}` }), model: r.model ?? "",
      }, now);
      n.assignment = r.assignment || null;
      n.status = r.done ? "ended" : "active";
      if (r.done) n.endedAt = now;
      s.nodes.set(n.id, n);
      push(s, { kind: "spawn", at: now, node: n.id });
    }
    n.runName = r.name;
    n.polled = true;
    if (r.model) n.model = r.model;
    if (r.tools > n.tools || r.lastAt > n.lastAt) n.activity = 1; // a new step landed
    n.tools = Math.max(n.tools, r.tools);
    if (r.lastAt > 0) n.lastAt = Math.max(n.lastAt, r.lastAt);
    if (r.done) {
      if (n.status !== "ended" && n.status !== "killed") {
        n.status = "ended"; n.endedAt = now;
        power(s, n, "ended", now, "run finished");
      }
    } else {
      n.status = r.lastAt > 0 && now - r.lastAt >= RUN_QUIET_MS ? "idle" : "active";
      n.endedAt = null; // a run the parent's turn end gave up on is still running: it is back
    }
  }
}

function sameTask(a: string, b: string): boolean {
  const x = a.trim().slice(0, 60), y = b.trim().slice(0, 60);
  return !!x && !!y && (x.startsWith(y) || y.startsWith(x));
}

// --------------------------------------------------------------------------------------- the clock

/** Advance the clock: fold pending tokens into each rate, detect surges, decay pulses, retire nodes. */
export function tick(s: VizState, now: number): void {
  const dt = Math.min(1000, now - s.lastTick);
  if (dt <= 0) return;
  s.lastTick = now;
  const a = 1 - Math.exp(-dt / RATE_TAU_MS);
  const m = 1 - Math.exp(-dt / MEAN_TAU_MS);
  const decay = Math.exp(-dt / ACTIVITY_TAU_MS);
  for (const n of [...s.nodes.values()]) {
    const inst = n.pending / (dt / 1000);
    n.pending = 0;
    const before = n.rate;
    n.rate += a * (inst - n.rate);
    if (n.rate < 0.05) n.rate = 0;
    n.mean += m * (n.rate - n.mean);
    n.activity *= decay;
    if (n.activity < 0.01) n.activity = 0;
    const jump = (n.rate >= SURGE_MIN && n.rate > SURGE_K * Math.max(n.mean, 1)) || n.rate >= SURGE_FLOOR;
    if (jump && n.rate > before && now - n.surgeAt >= SURGE_COOLDOWN_MS) {
      n.surgeAt = now;
      push(s, { kind: "surge", at: now, node: n.id, rate: n.rate });
    }
    if (n.status === "active") n.idleSince = null;
    else n.idleSince ??= now;
    if (n.goneAt !== null && now - n.goneAt >= GONE_MS) { drop(s, n.id); continue; }
    if (n.kind !== "subagent") continue;
    if ((n.status === "ended" || n.status === "killed") && n.endedAt !== null && now - n.endedAt >= SUB_LINGER_MS) { drop(s, n.id); continue; }
    const parent = n.parent ? s.nodes.get(n.parent) : undefined;
    if (!parent) { drop(s, n.id); continue; }
    // A delegation no run poll ever confirmed ends a while after its parent went quiet.
    if (!n.polled && n.status === "active" && parent.status !== "active" && now - n.lastAt >= ORPHAN_MS) {
      n.status = "ended"; n.endedAt = now;
      power(s, n, "ended", now, "no run reported");
    }
  }
}

function drop(s: VizState, id: string): void {
  s.nodes.delete(id);
  s.feeds.delete(id);
  for (const c of [...s.nodes.values()]) if (c.parent === id) s.nodes.delete(c.id);
}

/** Is a token stream feeding this node (so its rate means something)? */
export function isTapped(n: VizNode, now: number): boolean { return n.tappedAt > 0 && now - n.tappedAt < TAPPED_MS; }

/** Whole seconds since the node last worked (0 while it works). */
export function idleSeconds(n: VizNode, now: number): number {
  return n.idleSince === null ? 0 : Math.max(0, Math.floor((now - n.idleSince) / 1000));
}

export interface VizTeam { agents: number; subagents: number }

/** Who in `id`'s team is working right now: for the hub every agent and subagent (Main is the boss of the
 *  whole board), for an agent its own subagents. A node not working while its team works supervises. */
export function teamOf(s: VizState, id: string): VizTeam {
  const t: VizTeam = { agents: 0, subagents: 0 };
  const hub = id === HUB_ID;
  for (const c of s.nodes.values()) {
    if (c.id === id || c.kind === "hub" || c.status !== "active" || c.goneAt !== null) continue;
    if (!hub && c.parent !== id) continue;
    if (c.kind === "agent") t.agents++; else t.subagents++;
  }
  return t;
}

// ------------------------------------------------------------------------------------ derived views

export interface VizEdge {
  /** The child (the producer); particles flow from it to its parent. */
  from: string;
  to: string;
  /** 0..1 particle density and brightness. */
  intensity: number;
  /** The child's est. tok/s when it is tapped, else null (the edge has no honest rate). */
  rate: number | null;
  frozen: boolean;
  dead: boolean;
}

/** 0..1 from an est. tok/s on a log scale (1 tok/s is a trickle, 200 is a firehose). */
export function rateIntensity(rate: number): number {
  if (rate <= 0) return 0;
  return Math.min(1, Math.log1p(rate) / Math.log1p(200));
}

/** How hard a node's flow runs: its est. rate when tapped, else its step pulse (subagents), else a trickle
 *  for an agent that the fleet says is working but whose stream nothing here watches. */
export function nodeIntensity(n: VizNode, now: number): number {
  if (n.status === "paused" || n.status === "ended" || n.status === "killed") return 0;
  if (n.kind === "subagent") return n.status === "active" ? 0.18 + 0.55 * n.activity : 0.05 * n.activity;
  const r = rateIntensity(n.rate);
  if (isTapped(n, now)) return Math.max(r, 0.08 * n.activity);
  return n.status === "active" ? 0.12 + 0.3 * n.activity : 0;
}

export function edgesOf(s: VizState, now: number): VizEdge[] {
  const out: VizEdge[] = [];
  for (const n of s.nodes.values()) {
    if (!n.parent || !s.nodes.has(n.parent)) continue;
    out.push({
      from: n.id, to: n.parent, intensity: nodeIntensity(n, now),
      rate: n.kind !== "subagent" && isTapped(n, now) ? n.rate : null,
      frozen: n.status === "paused", dead: n.status === "killed" || n.goneAt !== null,
    });
  }
  return out;
}

export interface VizCensus { agents: number; subagents: number; tokps: number; tapped: number }

/** The header census: agents on the fleet, live subagents, and the sum of the tapped est. rates. */
export function census(s: VizState, now: number): VizCensus {
  let agents = 0, subagents = 0, tokps = 0, tapped = 0;
  for (const n of s.nodes.values()) {
    if (n.kind === "agent" && n.goneAt === null) agents++;
    if (n.kind === "subagent" && n.status !== "ended" && n.status !== "killed") subagents++;
    if (n.kind !== "subagent" && isTapped(n, now)) { tokps += n.rate; tapped++; }
  }
  return { agents, subagents, tokps, tapped };
}

export function fmtRate(rate: number): string {
  if (rate <= 0) return "0 est. tok/s";
  if (rate < 1) return "<1 est. tok/s";
  return `${rate < 10 ? rate.toFixed(1) : Math.round(rate)} est. tok/s`;
}

function fmtCount(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(Math.round(n));
}

const STATUS_WORDS: Record<VizStatus, string> = {
  idle: "idle", active: "working", waiting: "waiting on you", paused: "paused (turn stopped)", ended: "ended", killed: "stopped on an error or killed",
};

/** "supervising 2 agents and 1 subagent" (empty when nobody in the team works). */
export function superviseText(t: VizTeam): string {
  const part = (k: number, w: string): string => (k ? `${k} ${w}${k === 1 ? "" : "s"}` : "");
  const parts = [part(t.agents, "agent"), part(t.subagents, "subagent")].filter(Boolean);
  return parts.length ? `supervising ${parts.join(" and ")}` : "";
}

/** The hover card for a node: a title and short lines, honest about what is measured and what is not.
 *  `team` (teamOf): a node that is not working while its team works reads as supervising them. */
export function describeNode(n: VizNode, now: number, team?: VizTeam): { title: string; lines: string[] } {
  const kind = n.kind === "hub" ? "Main session" : n.kind === "agent" ? "Agent" : "Subagent";
  const lines: string[] = [`${PERSONAS[n.persona].label} \u00b7 ${kind}`];
  if (n.kind === "subagent") {
    const tools = `${n.tools} tool${n.tools === 1 ? "" : "s"}`;
    lines.push(n.status === "ended" ? `ended, ${tools}` : n.status === "killed" ? `stopped, ${tools}` : n.status === "active" ? `live, ${tools}` : `quiet, ${tools}`);
    if (n.assignment) lines.push(shortLabel(n.assignment, 80));
  } else {
    const word = STATUS_WORDS[n.status];
    const boss = n.status === "idle" && team ? superviseText(team) : "";
    lines.push(boss || (n.kind === "agent" && n.laneStatus && n.laneStatus !== word ? `${word} (${n.laneStatus})` : word));
    if (isTapped(n, now)) lines.push(fmtRate(n.rate));
    else if (n.status === "active") lines.push(n.kind === "hub" ? "working, no tokens streamed yet" : "working, token stream not tapped");
    if (n.totalTok > 0) lines.push(`~${fmtCount(n.totalTok)} est. tokens seen, ${n.tools} tool${n.tools === 1 ? "" : "s"}`);
    if (n.usage && n.usage.size > 0) lines.push(`context ${Math.round((n.usage.used / n.usage.size) * 100)}% full`);
  }
  if (n.toolFails > 0) lines.push(`${n.toolFails} failed tool call${n.toolFails === 1 ? "" : "s"}`);
  if (n.model) lines.push(n.model);
  return { title: n.name, lines };
}

// ------------------------------------------------------------------------------ an agent's output

/** P-VIZ.4 (ADR-0625): the recent output the node panel shows for an agent, folded from the same lane events
 *  the grid card renders (a watch's history seed, then the live stream). Bounded: OUT_TURNS settled turns and
 *  OUT_CHARS of each turn's text, the newest kept. */
export interface VizTurn { role: "user" | "assistant"; text: string }
export interface VizOutput { turns: VizTurn[]; live: string; seeded: boolean }
export const OUT_TURNS = 6;
export const OUT_CHARS = 4000;

export function createOutput(): VizOutput { return { turns: [], live: "", seeded: false }; }

const tail = (text: string): string => (text.length > OUT_CHARS ? text.slice(text.length - OUT_CHARS) : text);

function settle(o: VizOutput, turn: VizTurn): void {
  o.turns.push({ role: turn.role, text: tail(turn.text) });
  if (o.turns.length > OUT_TURNS) o.turns.splice(0, o.turns.length - OUT_TURNS);
}

/** Fold one lane event (or a prompt the user sent from the panel, `{ type: "user", text }`) into `o`. */
export function foldOutput(o: VizOutput, ev: { readonly type: string; readonly [k: string]: unknown }): void {
  const e = ev as Loose; // a lane event: every field read below is narrowed first
  switch (e.type) {
    case "watch-seed":
      if (!Array.isArray(e.turns)) return;
      o.turns = [];
      for (const t of e.turns as unknown[]) {
        if (!t || typeof t !== "object" || !("role" in t) || !("text" in t)) continue;
        if ((t.role === "user" || t.role === "assistant") && typeof t.text === "string") settle(o, { role: t.role, text: t.text });
      }
      o.live = ""; o.seeded = true;
      return;
    case "user":
      if (typeof e.text !== "string" || !e.text.trim()) return;
      if (o.live.trim()) settle(o, { role: "assistant", text: o.live });
      o.live = "";
      settle(o, { role: "user", text: e.text });
      return;
    case "token":
      if (typeof e.text === "string") o.live = tail(o.live + e.text);
      return;
    case "tool": {
      if (e.status !== undefined && e.status !== "open") return; // a settle repaints nothing here
      const line = typeof e.detail === "string" && e.detail ? e.detail : typeof e.name === "string" ? e.name : "tool";
      o.live = tail(`${o.live}${o.live && !o.live.endsWith("\n") ? "\n" : ""}> ${line.slice(0, 160)}\n`);
      return;
    }
    case "done":
      if (o.live.trim()) settle(o, { role: "assistant", text: o.live });
      o.live = "";
      return;
    case "error":
      settle(o, { role: "assistant", text: `${o.live}${o.live ? "\n" : ""}Error: ${typeof e.message === "string" ? e.message : "the turn failed"}` });
      o.live = "";
      return;
    default:
      return;
  }
}

// ------------------------------------------------------------------------------------------ layout

export type VizLayout = "orbit" | "constellation";
export type Vec3 = [number, number, number];

/** Orbit-stage pixels per world unit: the orbit's 1600 x 1000 stage becomes a ring about 10 x 6 units. */
// 70 px per unit spreads the orbit wide enough that a mini Lucid's glass cube (1.5 units) never overlaps
// its neighbor from the default camera; Main's helpers ring the hub outside its own frame.
const STAGE_W = 1600, STAGE_H = 1000, PX_PER_UNIT = 70;
const SPHERE_R = 5.6;

/** The glass cube's side before the kind's scale (viz_scene draws it; the figure is about 1 unit tall). */
export const CUBE = 1.5;
export const KIND_SCALE: Record<VizKind, number> = { hub: 1.35, agent: 1, subagent: 0.58 };
/** Half a cube's side for a kind. */
export function cubeHalf(kind: VizKind): number { return (CUBE * KIND_SCALE[kind]) / 2; }

// P-VIZ.5 (ADR-0630): subagents keep their distance. Every subagent sits at least SUB_CLEAR times the two
// cubes' combined half-sizes from its siblings and its parent (so 1.45 x 0.87 = 1.26 units between two
// subagents, 1.72 to an agent, 2.10 to Main), with rings that grow with the helper count instead of packing.
const SUB_CLEAR = 1.45;
/** The smallest rings: a lane's helpers, Main's helpers (its ring and sphere), a lane's sphere in 3D. */
const SUB_RING_AGENT = 2.4, SUB_RING_HUB = 3.6, SUB_SPHERE = 2.1;
/** A lane's helpers fan this far apart (radians) on the arc facing away from the hub, up to SUB_FAN_MAX. */
const SUB_FAN_STEP = 0.8, SUB_FAN_MAX = Math.PI * 1.4;
/** Orbit helpers alternate between two heights this far apart: more than a helper cube (0.87) plus a gap. */
const SUB_RISE = 1.1;

/** The ring radius around a parent: at least `floor`, clear of the parent's cube, and wide enough that two
 *  helpers `step` radians apart on it are SUB_CLEAR apart (chord = 2 r sin(step / 2)). */
function subRing(parent: VizKind, floor: number, step: number): number {
  const sib = SUB_CLEAR * 2 * cubeHalf("subagent");
  const chord = step > 0 ? sib / (2 * Math.sin(Math.min(Math.PI, step) / 2)) : 0;
  return Math.max(floor, SUB_CLEAR * (cubeHalf(parent) + cubeHalf("subagent")), chord);
}

/** Where every node sits. Orbit: the hub at the center and the agents on the orbit's own ellipse
 *  (orbitSlots, in the XZ plane, so the 2D top-down view IS the orbit map), subagents on small rings around
 *  their parent. Constellation: the agents spread over a sphere, subagents on small spheres around theirs.
 *  Deterministic: same nodes in the same order, same positions. */
export function layoutPositions(nodes: readonly { id: string; kind: VizKind; parent: string | null }[], layout: VizLayout): Map<string, Vec3> {
  const pos = new Map<string, Vec3>();
  const hub = nodes.find((n) => n.kind === "hub");
  if (hub) pos.set(hub.id, [0, 0, 0]);
  const agents = nodes.filter((n) => n.kind === "agent");
  if (layout === "orbit") {
    const slots = orbitSlots(agents.length, STAGE_W, STAGE_H);
    agents.forEach((a, i) => { const s = slots[i]; pos.set(a.id, s ? [s.x / PX_PER_UNIT, 0, s.y / PX_PER_UNIT] : [0, 0, 0]); });
  } else {
    const pts = fibonacciSphere(agents.length);
    agents.forEach((a, i) => { const p = pts[i]!; pos.set(a.id, [p[0] * SPHERE_R, p[1] * SPHERE_R * 0.8, p[2] * SPHERE_R]); });
  }
  const byParent = new Map<string, { id: string }[]>();
  for (const n of nodes) {
    if (n.kind !== "subagent" || !n.parent) continue;
    const list = byParent.get(n.parent) ?? [];
    list.push(n);
    byParent.set(n.parent, list);
  }
  for (const [parentId, kids] of byParent) {
    const c = pos.get(parentId);
    if (!c) continue;
    const aroundHub = parentId === hub?.id;
    const parentKind: VizKind = aroundHub ? "hub" : "agent";
    const n = kids.length;
    if (layout === "orbit") {
      // Main's helpers ring the hub; a lane's helpers fan out on the arc facing away from the hub, so they
      // never sit on the lane's own line to Main.
      const base = aroundHub ? -Math.PI / 2 : Math.atan2(c[2], c[0]);
      const step = n < 2 ? 0 : aroundHub ? (Math.PI * 2) / n : Math.min(SUB_FAN_MAX, SUB_FAN_STEP * (n - 1)) / (n - 1);
      const r = subRing(parentKind, aroundHub ? SUB_RING_HUB : SUB_RING_AGENT, step);
      // P-VIZ.6: every other helper rides SUB_RISE higher. From the usual low 3D camera the fan's depth is
      // foreshortened, so neighbours on one height overlapped on screen even with clear 3D gaps; the 2D view
      // looks straight down and ignores the height, so its spacing is unchanged.
      kids.forEach((k, i) => {
        const ang = aroundHub ? base + i * step : base + (i - (n - 1) / 2) * step;
        pos.set(k.id, [c[0] + Math.cos(ang) * r, c[1] + 0.35 + (i % 2) * SUB_RISE, c[2] + Math.sin(ang) * r]);
      });
    } else {
      const pts = fibonacciSphere(n);
      // the sphere is scaled until its closest pair of helpers is SUB_CLEAR apart
      let near = Infinity;
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
        near = Math.min(near, Math.hypot(pts[i]![0] - pts[j]![0], pts[i]![1] - pts[j]![1], pts[i]![2] - pts[j]![2]));
      }
      const sib = SUB_CLEAR * 2 * cubeHalf("subagent");
      const rr = Math.max(subRing(parentKind, aroundHub ? SUB_RING_HUB : SUB_SPHERE, 0), Number.isFinite(near) ? sib / near : 0);
      kids.forEach((k, i) => { const p = pts[i]!; pos.set(k.id, [c[0] + p[0] * rr, c[1] + p[1] * rr, c[2] + p[2] * rr]); });
    }
  }
  return pos;
}

/** `n` points spread evenly over the unit sphere (golden-angle spiral). One point sits at the front. */
export function fibonacciSphere(n: number): Vec3[] {
  if (n <= 0) return [];
  if (n === 1) return [[0, 0, 1]];
  const out: Vec3[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const t = golden * i;
    out.push([Math.cos(t) * r, y, Math.sin(t) * r]);
  }
  return out;
}

// ------------------------------------------------------------------------------------ perf budgets

export interface VizTierOpts {
  /** Flow particles drawn at most at once. */
  particles: number;
  /** Effect particles (sparks, embers, sprays, bolt glow) at most at once. */
  fx: number;
  fps: number;
  dprCap: number;
  antialias: boolean;
  bloom: boolean;
  /** Lightning detail: 0 none (a flash only), 1 a single jagged bolt, 2 a bolt with branches. */
  lightning: 0 | 1 | 2;
  /** Any automatic motion (bobbing, flowing particles, shakes). Off under prefers-reduced-motion. */
  motion: boolean;
  /** How detailed each mini Lucid figure is built (P-VIZ.2): the tier itself. */
  detail: PerfTier;
}

/** The perf tier (perf_tier.ts, the same Auto / Full / Reduced / Minimal the Knowledge Graph uses) decides
 *  the budgets; prefers-reduced-motion removes all automatic motion and leaves effects as color changes. */
export function vizTierOpts(tier: PerfTier, reducedMotion: boolean): VizTierOpts {
  const base: VizTierOpts = tier === "full"
    ? { particles: 6000, fx: 1600, fps: 60, dprCap: 1.5, antialias: true, bloom: true, lightning: 2, motion: true, detail: "full" }
    : tier === "reduced"
      ? { particles: 2500, fx: 600, fps: 30, dprCap: 1.25, antialias: false, bloom: false, lightning: 1, motion: true, detail: "reduced" }
      : { particles: 600, fx: 150, fps: 20, dprCap: 1, antialias: false, bloom: false, lightning: 0, motion: true, detail: "minimal" };
  return reducedMotion ? { ...base, particles: 0, fx: 0, lightning: 0, motion: false } : base;
}

/** The idle cadence: nothing flows and no effect plays, so a gentle bob at this rate is plenty. */
export const IDLE_FPS = 15;
/** A recording is captured at this rate (canvas.captureStream), so frames must come at least this often. */
export const RECORD_FPS = 30;

/** Milliseconds between frames, or null to draw only on change (reduced motion, nothing recording). */
export function frameInterval(o: VizTierOpts, busy: boolean, recording: boolean): number | null {
  if (recording) return 1000 / Math.max(o.fps, RECORD_FPS);
  if (!o.motion) return null;
  return 1000 / (busy ? o.fps : Math.min(o.fps, IDLE_FPS));
}
