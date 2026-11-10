// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Herd (ADR-0541; P-HERD.4, ADR-0493): WAITS, a blocked refusal and an event stream on the control
// plane, so an orchestrating agent scripts the fleet without polling. The verbs, answered by the
// Herd server over /cmd only (never the `:` prompt):
//
//   agent wait <lane> [--until <status>]... [--timeout <ms>]
//       until the lane reaches one of the statuses (default done, awaiting-input, needs-approval,
//       error, stopped); a lane already there returns at once. No timeout waits forever.
//       -> { lane, name, status, elapsedMs, turns }
//   agent prompt [--wait] [--until <status>]... [--timeout <ms>] <lane> <text...>
//       (the flags may also follow the lane) submit and wait in ONE request, so there is no race
//       between a prompt and a wait. The wait arms on the turn starting (`working`), so the status
//       the lane rested in before the prompt never ends it. Refused `agent_blocked` WITHOUT sending
//       anything when an ask is open on the lane (needs-approval: a human's question is not
//       answered by a script; read it with `agent read` and tell the human). No event from the lane
//       within 5 s is `agent_prompt_stalled`; the turn, if it started, keeps running.
//   agent spawn [spawn flags] --wait [--timeout <ms>]
//       returns once the lane leaves `starting` (ready for a prompt) or fails.
//   agent events [--lane <lane>] [--since <cursor>]
//       NDJSON transitions { ts, lane, name, from, to, cursor } until the client closes (events.ts).
//   pane wait-output <pane> (--match <text> | --regex <pattern>) [--timeout <ms>]
//       on a DECK pane, over the same rendering `pane read` returns, re-checked each time the hub
//       redraws (its poll and the engine's pushes), never on a timer. -> { pane, line, elapsedMs }
//   notify <title...> [--body <text>] [--lane <lane>]       (attention.ts; one per lane per 10 s)
//
// Failure codes beside the classic ones: agent_blocked, agent_prompt_stalled, agent_not_running (the
// lane left the fleet), timeout, not_deck, not_local, rate_limited. Nothing here answers an ask,
// approves, dismisses, sets auto-approve or touches the whitelist (ADR-0436): prompt and spawn go
// through the same executor `lucid herd agent prompt|spawn` uses, and `agent_blocked` is all a script
// learns about an ask: that it exists.

import { HubOpError } from "../../../harness/launcher/hub_spaces.ts";
import { hasOpenAsk, type HerdAttention } from "./attention.ts";
import { DEFAULT_MACHINE } from "./engines.ts";
import { errorBody, isRecord, ndjsonResponse, type LaneFeed, type LaneTransition, type Timers } from "./events.ts";

/** The LaneStatus vocabulary (desktop/fleet_lanes.ts), closed. */
export const LANE_STATUSES = ["starting", "working", "needs-approval", "awaiting-input", "done", "error", "stopped"] as const;
export const DEFAULT_UNTIL: readonly string[] = ["done", "awaiting-input", "needs-approval", "error", "stopped"];
/** `agent prompt --wait`: no event from the lane within this long is agent_prompt_stalled. */
export const STALL_MS = 5000;
const MAX_TIMEOUT_MS = 2_147_483_647; // what a timer can hold
const MAX_PATTERN = 500;
const READ_WIDTH = 200;
const READ_LINES = 400;

export type HerdVerb =
  | { verb: "agent.wait"; lane: string; until: string[]; timeoutMs: number | null }
  | { verb: "agent.prompt.wait"; lane: string; text: string; until: string[]; timeoutMs: number | null }
  | { verb: "agent.spawn.wait"; spawn: string[]; timeoutMs: number | null }
  | { verb: "agent.events"; lane: string | null; since: string | null }
  | { verb: "pane.wait-output"; pane: string; match: { text: string } | { regex: string }; timeoutMs: number | null }
  | { verb: "notify"; title: string; body: string; lane: string | null }
  | { verb: "next" };

const usage = (msg: string): HubOpError => new HubOpError("usage", msg);

function timeoutOf(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  if (!/^\d{1,10}$/.test(raw) || Number(raw) < 1) throw usage("--timeout takes whole milliseconds (1 or more)");
  return Math.min(MAX_TIMEOUT_MS, Number(raw));
}

function untilOf(raw: readonly string[], dflt: readonly string[]): string[] {
  if (raw.length === 0) return [...dflt];
  const out = raw.flatMap((r) => r.split(",")).map((s) => s.trim()).filter(Boolean);
  for (const s of out) {
    if (!LANE_STATUSES.some((x) => x === s)) throw usage(`--until takes a lane status (${LANE_STATUSES.join(", ")}), not "${s}"`);
  }
  return [...new Set(out)];
}

interface Scanned { valued: Record<string, string[]>; bare: Record<string, true>; pos: string[] }

/** Flags anywhere; `valued` ones take the next word (and may repeat). Any other dash word is a
 *  usage error, so a typo never becomes a positional. */
function scan(args: readonly string[], valued: readonly string[], bare: readonly string[]): Scanned {
  const out: Scanned = { valued: {}, bare: {}, pos: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (valued.includes(a)) {
      const v = args[++i];
      if (v === undefined) throw usage(`${a} needs a value`);
      (out.valued[a] ??= []).push(v);
    } else if (bare.includes(a)) out.bare[a] = true;
    else if (a.startsWith("-") && a.length > 1) throw usage(`unknown flag ${a}`);
    else out.pos.push(a);
  }
  return out;
}

const PROMPT_VALUED = ["--until", "--timeout"];

/** `agent prompt` flags: the ones before the lane, then the ones right after it; the rest is text. */
function promptVerb(args: readonly string[]): HerdVerb | null {
  const flags: Scanned = { valued: {}, bare: {}, pos: [] };
  let i = 0;
  const take = (): void => {
    while (i < args.length) {
      const a = args[i]!;
      if (a === "--wait") { flags.bare[a] = true; i++; }
      else if (PROMPT_VALUED.includes(a)) {
        const v = args[i + 1];
        if (v === undefined) throw usage(`${a} needs a value`);
        (flags.valued[a] ??= []).push(v);
        i += 2;
      } else return;
    }
  };
  take();
  const lane = args[i++];
  take();
  if (!flags.bare["--wait"]) {
    if (Object.keys(flags.valued).length) throw usage("--until and --timeout belong to `agent prompt --wait`");
    return null; // a plain prompt: the classic verb
  }
  const text = args.slice(i).join(" ").trim();
  if (!lane || !text) throw usage("agent prompt --wait [--until <status>]... [--timeout <ms>] <lane> <text...>");
  return { verb: "agent.prompt.wait", lane, text, until: untilOf(flags.valued["--until"] ?? [], DEFAULT_UNTIL), timeoutMs: timeoutOf(flags.valued["--timeout"]?.at(-1)) };
}

/** The Herd-only verbs, or null for argv the classic grammar owns. Never executes anything. */
export function parseHerdVerb(argv: readonly string[]): HerdVerb | null {
  const [verb, sub, ...rest] = argv;
  if (verb === "next" && sub === undefined) return { verb: "next" };
  if (verb === "notify") {
    const s = scan(argv.slice(1), ["--body", "--lane"], []);
    const title = s.pos.join(" ").trim();
    if (!title) throw usage("notify <title...> [--body <text>] [--lane <lane>]");
    return { verb: "notify", title, body: s.valued["--body"]?.at(-1) ?? "", lane: s.valued["--lane"]?.at(-1) ?? null };
  }
  if (verb === "pane" && sub === "wait-output") {
    const s = scan(rest, ["--match", "--regex", "--timeout"], []);
    const text = s.valued["--match"]?.at(-1);
    const regex = s.valued["--regex"]?.at(-1);
    if (s.pos.length !== 1 || (text === undefined) === (regex === undefined)) throw usage("pane wait-output <pane> (--match <text> | --regex <pattern>) [--timeout <ms>]");
    if (text === "") throw usage("--match needs some text");
    if (regex !== undefined) {
      if (regex.length > MAX_PATTERN) throw usage(`--regex is at most ${MAX_PATTERN} characters`);
      try { new RegExp(regex); } catch (e) { throw usage(`--regex: ${e instanceof Error ? e.message : String(e)}`); }
    }
    return { verb: "pane.wait-output", pane: s.pos[0]!, match: text !== undefined ? { text } : { regex: regex! }, timeoutMs: timeoutOf(s.valued["--timeout"]?.at(-1)) };
  }
  if (verb !== "agent") return null;
  if (sub === "wait") {
    const s = scan(rest, PROMPT_VALUED, []);
    if (s.pos.length !== 1) throw usage("agent wait <lane> [--until <status>]... [--timeout <ms>]");
    return { verb: "agent.wait", lane: s.pos[0]!, until: untilOf(s.valued["--until"] ?? [], DEFAULT_UNTIL), timeoutMs: timeoutOf(s.valued["--timeout"]?.at(-1)) };
  }
  if (sub === "events") {
    const s = scan(rest, ["--lane", "--since"], []);
    if (s.pos.length) throw usage("agent events [--lane <lane>] [--since <cursor>]");
    return { verb: "agent.events", lane: s.valued["--lane"]?.at(-1) ?? null, since: s.valued["--since"]?.at(-1) ?? null };
  }
  if (sub === "prompt") return promptVerb(rest);
  if (sub === "spawn" && rest.includes("--wait")) {
    // The spawn flags themselves stay the classic grammar's (and any host's) to judge.
    const spawn: string[] = [];
    let timeout: string | undefined;
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i]!;
      if (a === "--wait") continue;
      if (a === "--timeout") {
        timeout = rest[++i];
        if (timeout === undefined) throw usage("--timeout needs a value");
        continue;
      }
      spawn.push(a);
    }
    return { verb: "agent.spawn.wait", spawn, timeoutMs: timeoutOf(timeout) };
  }
  return null;
}

// ---- the wait state machine ----------------------------------------------------------------------

export type WaitEnd =
  | { end: "reached"; status: string }
  | { end: "gone" }
  | { end: "timeout" }
  | { end: "stalled" }
  | { end: "left" };

/** One transition through a wait. Unarmed (a prompt's wait) it arms on `working`, the turn
 *  starting; armed, an `until` status ends it; a lane leaving the fleet (to = null) always does. */
export function waitStep(until: readonly string[], armed: boolean, to: string | null): { armed: boolean; end: WaitEnd | null } {
  if (to === null) return { armed, end: { end: "gone" } };
  const now = armed || to === "working";
  return { armed: now, end: now && until.includes(to) ? { end: "reached", status: to } : null };
}

/** What a wait reads from the feed. */
export type WaitFeed = Pick<LaneFeed, "status" | "subscribe" | "onActivity">;

export interface WaitOptions {
  until: readonly string[];
  /** false = a prompt's wait: arm on the turn starting. */
  armed: boolean;
  timeoutMs: number | null;
  /** No event at all from the lane within this long ends the wait `stalled` (null = never). */
  stallMs: number | null;
  timers: Timers;
  signal?: AbortSignal;
}

/** Follow one lane until the wait ends. Subscribes at once (before the caller submits anything), so
 *  no transition between a prompt and its wait is lost. `cancel` ends it `left`. */
export function waitLane(feed: WaitFeed, lane: string, o: WaitOptions): { result: Promise<WaitEnd>; cancel(): void } {
  const { promise, resolve } = Promise.withResolvers<WaitEnd>();
  const cleanups: (() => void)[] = [];
  let settled = false;
  let armed = o.armed;
  const finish = (end: WaitEnd): void => {
    if (settled) return;
    settled = true;
    for (const c of cleanups.splice(0)) c();
    resolve(end);
  };
  const cur = feed.status(lane);
  if (cur === undefined) finish({ end: "gone" });
  else if (armed && cur.status !== null && o.until.includes(cur.status)) finish({ end: "reached", status: cur.status });
  if (!settled) {
    let stopStall = (): void => {};
    cleanups.push(feed.subscribe(lane, (t: LaneTransition) => {
      stopStall();
      const step = waitStep(o.until, armed, t.to);
      armed = step.armed;
      if (step.end) finish(step.end);
    }));
    if (o.stallMs !== null) {
      stopStall = o.timers.after(o.stallMs, () => finish({ end: "stalled" }));
      cleanups.push(stopStall, feed.onActivity(lane, () => stopStall()));
    }
    if (o.timeoutMs !== null) cleanups.push(o.timers.after(o.timeoutMs, () => finish({ end: "timeout" })));
    if (o.signal) {
      const onAbort = (): void => finish({ end: "left" });
      if (o.signal.aborted) finish({ end: "left" });
      else {
        o.signal.addEventListener("abort", onAbort, { once: true });
        cleanups.push(() => o.signal?.removeEventListener("abort", onAbort));
      }
    }
  }
  return { result: promise, cancel: () => finish({ end: "left" }) };
}

// ---- the server's verbs --------------------------------------------------------------------------

export interface WaitsHost {
  feed: LaneFeed;
  attention: HerdAttention;
  /** argv the way /cmd runs it without this module: the Herd server's own commands, then the hub
   *  parser and executor. Prompt, spawn and status go through here, never around it. */
  run(argv: readonly string[]): Promise<unknown>;
  /** A pane's deck (throws HubOpError not_found). */
  paneDeck(ref: string): string;
  /** The pane as `pane read` renders it. */
  paneLines(ref: string, width: number, lines: number): string[];
  /** The hub asked for a redraw (data or layout changed). Returns the unsubscribe. */
  onChange(fn: () => void): () => void;
  timers: Timers;
  now(): number;
}

interface ResolvedLane { id: string; name: string; status: string | null; lane: Record<string, unknown> }

/** The answer to argv this module owns: a streamed Response, a plain value, or undefined (not ours;
 *  `next` too, which the server's `commands` answer for /cmd and the `:` prompt alike). */
export function herdWaitCommands(host: WaitsHost): (argv: readonly string[]) => Promise<unknown> | undefined {
  const { feed, timers } = host;

  async function resolve(ref: string): Promise<ResolvedLane> {
    const l = await host.run(["agent", "status", ref]);
    if (!isRecord(l) || typeof l.id !== "string" || !l.id) throw new HubOpError("not_found", `no agent "${ref}"`);
    if (typeof l.machine === "string" && l.machine !== DEFAULT_MACHINE) {
      throw new HubOpError("not_local", "waits and events follow the lanes of this server's own engine");
    }
    const name = typeof l.name === "string" && l.name ? l.name : l.id;
    const status = typeof l.status === "string" && l.status ? l.status : null;
    feed.track(l.id, name, status);
    return { id: l.id, name, status, lane: l };
  }

  /** A reached wait as the verbs report it, with the turn count read once at the end. */
  async function reached(l: ResolvedLane, end: WaitEnd, t0: number, what: string, timeoutMs: number | null): Promise<Record<string, unknown>> {
    if (end.end === "gone") throw new HubOpError("agent_not_running", `agent "${l.name}" left the fleet`);
    if (end.end === "timeout") throw new HubOpError("timeout", `agent "${l.name}" did not reach ${what} within ${timeoutMs}ms (it is ${feed.status(l.id)?.status ?? "unknown"})`);
    if (end.end === "stalled") throw new HubOpError("agent_prompt_stalled", `agent "${l.name}" showed no event within ${STALL_MS / 1000}s; the turn, if it started, keeps running (check \`agent status\`)`);
    if (end.end === "left") throw new HubOpError("left", "the client left");
    let turns: unknown = l.lane.turns ?? null;
    try {
      const now = await host.run(["agent", "status", l.id]);
      if (isRecord(now)) turns = now.turns ?? turns;
    } catch { /* the lane may be gone right after; the status reached stands */ }
    return { lane: l.id, name: l.name, status: end.status, elapsedMs: host.now() - t0, turns };
  }

  const result = (write: (line: string) => void, data: unknown): void => write(JSON.stringify({ ok: true, data }));

  function wait(v: Extract<HerdVerb, { verb: "agent.wait" }>): Promise<Response> {
    return resolve(v.lane).then((l) => ndjsonResponse(async (write, signal) => {
      const t0 = host.now();
      const w = waitLane(feed, l.id, { until: v.until, armed: true, timeoutMs: v.timeoutMs, stallMs: null, timers, signal });
      result(write, await reached(l, await w.result, t0, v.until.join("|"), v.timeoutMs));
    }, timers));
  }

  async function prompt(v: Extract<HerdVerb, { verb: "agent.prompt.wait" }>): Promise<Response> {
    const l = await resolve(v.lane);
    if (hasOpenAsk(l.lane)) {
      throw new HubOpError("agent_blocked", `agent "${l.name}" is waiting on a human (${l.status ?? "an ask"}); nothing was sent. Read the ask with \`agent read ${l.name}\` and tell the human.`);
    }
    return ndjsonResponse(async (write, signal) => {
      const t0 = host.now();
      const w = waitLane(feed, l.id, { until: v.until, armed: false, timeoutMs: v.timeoutMs, stallMs: STALL_MS, timers, signal });
      const sent = host.run(["agent", "prompt", l.id, v.text]);
      // A refused prompt ends the call with the engine's refusal; a prompt still in flight when the
      // wait ends (stalled, timeout) keeps going on its own.
      const refused = new Promise<WaitEnd>((_, fail) => { sent.catch(fail); });
      let end: WaitEnd;
      try { end = await Promise.race([w.result, refused]); } finally { w.cancel(); }
      result(write, await reached(l, end, t0, v.until.join("|"), v.timeoutMs));
    }, timers);
  }

  function spawn(v: Extract<HerdVerb, { verb: "agent.spawn.wait" }>): Response {
    return ndjsonResponse(async (write, signal) => {
      const t0 = host.now();
      const reply = await host.run(["agent", "spawn", ...v.spawn]);
      const lane = isRecord(reply) && isRecord(reply.lane) ? reply.lane : null;
      if (!lane || typeof lane.id !== "string" || !lane.id) throw new HubOpError("engine", "the spawn reply named no lane");
      if (typeof lane.machine === "string" && lane.machine !== DEFAULT_MACHINE) {
        throw new HubOpError("not_local", `spawned on machine "${lane.machine}"; --wait follows the lanes of this server's own engine`);
      }
      const name = typeof lane.name === "string" && lane.name ? lane.name : lane.id;
      const status = typeof lane.status === "string" && lane.status ? lane.status : null;
      feed.track(lane.id, name, status);
      const l: ResolvedLane = { id: lane.id, name, status, lane };
      const ready = LANE_STATUSES.filter((s) => s !== "starting");
      const w = waitLane(feed, l.id, { until: ready, armed: true, timeoutMs: v.timeoutMs, stallMs: null, timers, signal });
      result(write, await reached(l, await w.result, t0, "ready", v.timeoutMs));
    }, timers);
  }

  async function events(v: Extract<HerdVerb, { verb: "agent.events" }>): Promise<Response> {
    const lane = v.lane === null ? null : (await resolve(v.lane)).id;
    const replay = v.since === null ? [] : feed.since(v.since, lane);
    return ndjsonResponse((write, signal) => {
      for (const t of replay) write(JSON.stringify(t));
      return new Promise<void>((done) => {
        const off = feed.subscribe(lane, (t) => write(JSON.stringify(t)));
        signal.addEventListener("abort", () => { off(); done(); }, { once: true });
      });
    }, timers);
  }

  function waitOutput(v: Extract<HerdVerb, { verb: "pane.wait-output" }>): Response {
    if (host.paneDeck(v.pane) === "agent") throw new HubOpError("not_deck", "pane wait-output watches a deck pane; follow an agent with `agent wait`");
    const re = "regex" in v.match ? new RegExp(v.match.regex) : null;
    const text = "text" in v.match ? v.match.text : "";
    return ndjsonResponse(async (write, signal) => {
      const t0 = host.now();
      const { promise, resolve: settle, reject } = Promise.withResolvers<string | null>();
      const cleanups: (() => void)[] = [];
      let settled = false;
      const finish = (line: string | null, err?: unknown): void => {
        if (settled) return;
        settled = true;
        for (const c of cleanups.splice(0)) c();
        if (err === undefined) settle(line);
        else reject(err);
      };
      const check = (): void => {
        if (settled) return;
        try {
          const hit = host.paneLines(v.pane, READ_WIDTH, READ_LINES).find((line) => (re ? re.test(line) : line.includes(text)));
          if (hit !== undefined) finish(hit);
        } catch (e) { finish(null, e); } // the pane closed under the wait
      };
      cleanups.push(host.onChange(check));
      if (v.timeoutMs !== null) cleanups.push(timers.after(v.timeoutMs, () => finish(null)));
      const onAbort = (): void => finish(null, new HubOpError("left", "the client left"));
      signal.addEventListener("abort", onAbort, { once: true });
      cleanups.push(() => signal.removeEventListener("abort", onAbort));
      check();
      const line = await promise;
      if (line === null) throw new HubOpError("timeout", `pane ${v.pane} showed no matching line within ${v.timeoutMs}ms`);
      result(write, { pane: v.pane, line, elapsedMs: host.now() - t0 });
    }, timers);
  }

  return (argv) => {
    const v = parseHerdVerb(argv);
    if (v === null || v.verb === "next") return undefined;
    switch (v.verb) {
      case "agent.wait": return wait(v);
      case "agent.prompt.wait": return prompt(v);
      case "agent.spawn.wait": return Promise.resolve(spawn(v));
      case "agent.events": return events(v);
      case "pane.wait-output": return Promise.resolve().then(() => waitOutput(v));
      case "notify": return Promise.resolve().then(() => host.attention.notify(v));
    }
  };
}

export type FinalReply = { ok: true; data: unknown } | { ok: false; body: Record<string, unknown> };

/** Client side: the final line of a streamed reply as `lucid herd` reports it. A blank or
 *  unparsable last line (the server went away mid-wait) is `hub_lost`. */
export function finalReply(last: string | null): FinalReply {
  let j: unknown = null;
  try { j = last === null ? null : JSON.parse(last); } catch { /* below */ }
  if (isRecord(j) && j.ok === true) return { ok: true, data: j.data ?? null };
  if (isRecord(j) && typeof j.error === "string") return { ok: false, body: j };
  return { ok: false, body: errorBody(new HubOpError("hub_lost", "the Herd server closed the reply before it finished")) };
}
