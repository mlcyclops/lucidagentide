// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Herd (ADR-0541; P-HERD.7, ADR-0496): MACHINES. One Herd server attaches to its own engine (the
// default machine, `local`) and may hold more: each machine is another engine on THIS box, found in
// its own discovery folder (a second data root, the way a Fleet Profile instance gets one) and proven
// with the same nonce handshake as every engine (ADR-0419) BEFORE its UI token is used for anything.
// A discovery file whose engine fails the handshake is never sent a token.
//
//   hub-<instance>-machines.json   {v:1, machines:[{name, kind:"local", discoveryDir}]}   0600
//
// The file is untrusted input: every entry is validated and an off-shape one is dropped, never
// guessed. On the control plane a lane of machine b is `b/<laneId>`; the default machine's prefix is
// optional, so every script written before machines existed keeps working.
//
// Each machine reconnects on its own backoff: a machine that drops keeps its last lanes (shown
// dimmed, with their last status) and never touches the others. While a machine is not connected its
// engine record (and its token) is dropped, so the next attempt re-reads the discovery folder and
// re-runs the handshake: an engine that restarted on a new port with a new token is found again.
//
// Not here (ADR-0496): SSH machines (item 3) wait for the operator's go (ADR-0489 default e) and
// would add an SSH session and a forwarded listening port, so `machine add --ssh` is refused.
// `--profile` (item 4) needs Fleet Profiles (ADR-0272, design only): add the profile's discovery
// folder with `--dir` instead.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { listDiscoveries, verifyDiscovery, type EngineDiscovery } from "../../../desktop/engine_discovery.ts";
import { buildAgentRows } from "../../../harness/launcher/hub_agents_panel.ts";
import { createHubExecutor } from "../../../harness/launcher/hub_control.ts";
import { HubOpError, Spaces } from "../../../harness/launcher/hub_spaces.ts";
import { parseHubCommand, type HubOp } from "../../../harness/launcher/hub_tmux_verbs.ts";
import type { RailMachines } from "../../../harness/launcher/hub_tui.ts";

export const DEFAULT_MACHINE = "local";
/** Same rule as an instance name: lands in ids and file contents, never a path separator. */
export const MACHINE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const MAX_MACHINES = 16;
/** How often a connected machine's lanes are read. */
export const MACHINE_POLL_MS = 2000;
/** Retry delays after a failure, by attempt; the last one repeats. */
export const BACKOFF_MS: readonly number[] = [1000, 2000, 4000, 8000, 16_000, 30_000];
/** Failed attempts after a drop before the dot says "down" instead of "reconnecting" (it still retries). */
export const DOWN_AFTER = 5;

export interface MachineSpec { name: string; kind: "local"; discoveryDir: string }
export type MachineState = "connected" | "reconnecting" | "down";
/** A lane as the combined list carries it: the engine's record plus its machine and control-plane ref. */
export type MachineLane = Record<string, unknown> & { machine: string; ref: string };

const rec = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

// ---- the machine list (pure) ----------------------------------------------------------------------

export function machinesPath(data: string, instance: string): string {
  return join(data, `hub-${instance}-machines.json`);
}

/** A machine name, or HubOpError("bad_name"). `local` is the server's own engine, never added. */
export function machineName(raw: string | undefined): string {
  if (raw === undefined || !MACHINE_NAME_RE.test(raw)) throw new HubOpError("bad_name", "a machine name is 1-32 lowercase letters, digits, - or _, starting with a letter or digit");
  if (raw === DEFAULT_MACHINE) throw new HubOpError("bad_name", `"${DEFAULT_MACHINE}" is this hub's own engine`);
  return raw;
}

/** The saved list. Off-shape entries (bad name, the reserved name, a duplicate, a relative folder, an
 *  unknown kind such as ssh) are dropped; an unparseable file is an empty list. */
export function parseMachines(raw: string): MachineSpec[] {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return []; }
  const o = rec(parsed);
  if (o.v !== 1 || !Array.isArray(o.machines)) return [];
  const out: MachineSpec[] = [];
  for (const entry of o.machines) {
    if (out.length >= MAX_MACHINES) break;
    const m = rec(entry);
    if (m.kind !== "local" || typeof m.name !== "string" || typeof m.discoveryDir !== "string") continue;
    if (!MACHINE_NAME_RE.test(m.name) || m.name === DEFAULT_MACHINE || !isAbsolute(m.discoveryDir) || out.some((x) => x.name === m.name)) continue;
    out.push({ name: m.name, kind: "local", discoveryDir: m.discoveryDir });
  }
  return out;
}

export function loadMachines(path: string): MachineSpec[] {
  try { return parseMachines(readFileSync(path, "utf8")); } catch { return []; }
}

/** tmp + rename, 0600. */
export function saveMachines(path: string, list: readonly MachineSpec[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ v: 1, machines: list }) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

/** The list with one more local machine, or a refusal naming why. */
export function addMachine(list: readonly MachineSpec[], name: string, discoveryDir: string): MachineSpec[] {
  const n = machineName(name);
  if (!isAbsolute(discoveryDir)) throw new HubOpError("usage", "machine add <name> --dir <absolute path of that engine's discovery folder>");
  if (list.some((m) => m.name === n)) throw new HubOpError("exists", `machine "${n}" is already in this hub`);
  if (list.length >= MAX_MACHINES) throw new HubOpError("refused", `a hub holds at most ${MAX_MACHINES} machines`);
  return [...list, { name: n, kind: "local", discoveryDir }];
}

export function removeMachine(list: readonly MachineSpec[], name: string): MachineSpec[] {
  if (!list.some((m) => m.name === name)) throw new HubOpError("not_found", `no machine "${name}"`);
  return list.filter((m) => m.name !== name);
}

// ---- lane refs (pure) -----------------------------------------------------------------------------

/** `b/lane_3` on a hub that knows machine b is (b, lane_3); `local/lane_3` is the default machine;
 *  anything else (no slash, an unknown prefix) is the default machine with the ref untouched. */
export function splitLaneRef(ref: string, machines: readonly string[]): { machine: string; lane: string } {
  const slash = ref.indexOf("/");
  if (slash > 0) {
    const m = ref.slice(0, slash);
    if (m === DEFAULT_MACHINE || machines.includes(m)) return { machine: m, lane: ref.slice(slash + 1) };
  }
  return { machine: DEFAULT_MACHINE, lane: ref };
}

/** The control-plane id of a lane: plain on the default machine, `<machine>/<id>` elsewhere. */
export function laneRef(machine: string, id: string): string {
  return machine === DEFAULT_MACHINE ? id : `${machine}/${id}`;
}

const AGENT_VERBS = ["list", "spawn", "prompt", "status", "read", "cancel", "priority"];

/** Which machine an `agent ...` argv is for, with the machine prefix (or `--machine`) taken off the
 *  op the core parser builds. `machine` null = `agent list` across every machine. Null for any argv
 *  that is not one of these agent verbs (other owners, or the core parser, answer those). */
export function routeAgentArgv(argv: readonly string[], machines: readonly string[]): { machine: string | null; op: HubOp } | null {
  if (argv[0] !== "agent" || !AGENT_VERBS.includes(argv[1] ?? "")) return null;
  const rest = [...argv];
  let named: string | undefined;
  const at = rest.indexOf("--machine", 2);
  if (at >= 0) {
    if (argv[1] !== "spawn" && argv[1] !== "list") throw new HubOpError("usage", "--machine goes with `agent spawn` or `agent list`; other agent verbs take <machine>/<lane>");
    named = rest[at + 1];
    if (named === undefined) throw new HubOpError("usage", "--machine <name>");
    if (named !== DEFAULT_MACHINE && !machines.includes(named)) throw new HubOpError("not_found", `no machine "${named}"`);
    rest.splice(at, 2);
  }
  const op = parseHubCommand(rest);
  if (op.op === "agent.list") return { machine: named ?? null, op };
  if (op.op === "agent.spawn") return { machine: named ?? DEFAULT_MACHINE, op };
  if (!("lane" in op) || op.lane === undefined) return null;
  const { machine, lane } = splitLaneRef(op.lane, machines);
  if (op.op === "agent.priority" && machine !== DEFAULT_MACHINE) throw new HubOpError("usage", "priority is display order in this hub's agents panel and applies to this machine's lanes only");
  return { machine, op: { ...op, lane } };
}

// ---- one machine's connection (pure) --------------------------------------------------------------

export interface MachineConn {
  state: MachineState;
  /** Failed attempts since the last success. */
  attempt: number;
  /** The last lanes read; kept, dimmed, while the machine is not connected. */
  lanes: Record<string, unknown>[];
  error: string;
  /** The VERIFIED engine; null whenever the machine is not connected (its token is dropped with it). */
  engine: EngineDiscovery | null;
  everConnected: boolean;
}

export const freshConn = (): MachineConn => ({ state: "down", attempt: 0, lanes: [], error: "", engine: null, everConnected: false });

export function connOk(engine: EngineDiscovery, lanes: Record<string, unknown>[]): MachineConn {
  return { state: "connected", attempt: 0, lanes, error: "", engine, everConnected: true };
}

export function connFail(c: MachineConn, error: string): MachineConn {
  const attempt = c.attempt + 1;
  return { state: c.everConnected && attempt < DOWN_AFTER ? "reconnecting" : "down", attempt, lanes: c.lanes, error, engine: null, everConnected: c.everConnected };
}

/** The delay before the next step: the poll interval while connected, else the backoff for the
 *  attempts so far. */
export function nextDelay(c: MachineConn): number {
  return c.state === "connected" ? MACHINE_POLL_MS : BACKOFF_MS[Math.min(Math.max(0, c.attempt - 1), BACKOFF_MS.length - 1)]!;
}

/** The newest discovery file in `dir` whose engine answers the nonce handshake. The handshake asks
 *  /api/health for the nonce only; no token goes to a port that has not proven itself. Files in a
 *  machine's folder belong to that engine: they are never pruned from here. */
export async function findVerifiedEngine(dir: string, fetchImpl: typeof fetch = fetch): Promise<EngineDiscovery | null> {
  for (const { discovery } of listDiscoveries(dir)) if (await verifyDiscovery(discovery, fetchImpl)) return discovery;
  return null;
}

// ---- the set the server holds ---------------------------------------------------------------------

export interface MachineSetDeps {
  find?: (dir: string) => Promise<EngineDiscovery | null>;
  fetchImpl?: typeof fetch;
  /** Run `fn` after `ms`; returns a cancel. Default setTimeout. */
  schedule?: (fn: () => void, ms: number) => () => void;
  /** Something a rail or a list shows changed. */
  onChange?: () => void;
  /** Adds the ADR-0494 attention field to a lane record (identity when unset). */
  annotate?: (lane: Record<string, unknown>) => Record<string, unknown>;
}

export interface MachineView { name: string; kind: "local"; discoveryDir: string | null; state: MachineState; lanes: number; attempt: number; error: string; port: number | null }

export class MachineSet {
  readonly #path: string | null;
  readonly #local: EngineDiscovery;
  readonly #find: (dir: string) => Promise<EngineDiscovery | null>;
  readonly #fetch: typeof fetch;
  readonly #schedule: (fn: () => void, ms: number) => () => void;
  readonly #onChange: () => void;
  readonly #annotate: (lane: Record<string, unknown>) => Record<string, unknown>;
  #specs: MachineSpec[];
  readonly #conns = new Map<string, MachineConn>();
  readonly #timers = new Map<string, () => void>();
  /** Per machine: the core agent verbs aimed at its verified engine, and the token they carry. */
  readonly #execs = new Map<string, { token: string; exec: (op: HubOp) => Promise<unknown> }>();
  #localLanes: Record<string, unknown>[] = [];
  #running = false;

  /** `path` null keeps the list in memory only (tests). */
  constructor(path: string | null, local: EngineDiscovery, deps: MachineSetDeps = {}) {
    this.#path = path;
    this.#local = local;
    this.#fetch = deps.fetchImpl ?? fetch;
    this.#find = deps.find ?? ((dir) => findVerifiedEngine(dir, this.#fetch));
    this.#schedule = deps.schedule ?? ((fn, ms) => {
      const t = setTimeout(fn, ms);
      return () => clearTimeout(t);
    });
    this.#onChange = deps.onChange ?? (() => {});
    this.#annotate = deps.annotate ?? ((l) => l);
    this.#specs = path ? loadMachines(path) : [];
    for (const s of this.#specs) this.#conns.set(s.name, freshConn());
  }

  /** Begin connecting every machine, each on its own clock. */
  start(): void {
    this.#running = true;
    for (const s of this.#specs) void this.tick(s.name);
  }

  stop(): void {
    this.#running = false;
    for (const cancel of this.#timers.values()) cancel();
    this.#timers.clear();
  }

  /** The default machine's lanes, from the hub's own poll. */
  setLocalLanes(lanes: Record<string, unknown>[]): void {
    this.#localLanes = lanes;
  }

  names(): string[] {
    return [DEFAULT_MACHINE, ...this.#specs.map((s) => s.name)];
  }

  specs(): readonly MachineSpec[] {
    return this.#specs;
  }

  state(name: string): MachineState {
    if (name === DEFAULT_MACHINE) return "connected";
    return this.#conns.get(name)?.state ?? "down";
  }

  /** The engine to call for machine `name`, or null while it is not connected. */
  engine(name: string): { base: string; token: string } | null {
    const e = name === DEFAULT_MACHINE ? this.#local : this.#conns.get(name)?.engine;
    return e ? { base: `http://127.0.0.1:${e.port}`, token: e.token } : null;
  }

  /** Every lane of every machine: the default machine's first, then each machine's in list order. A
   *  machine that is not connected contributes its last lanes with `stale: true`. */
  lanes(): MachineLane[] {
    const out: MachineLane[] = this.#localLanes.map((l) => ({ ...l, machine: DEFAULT_MACHINE, ref: str(l.id) }));
    for (const s of this.#specs) {
      const c = this.#conns.get(s.name);
      if (!c) continue;
      for (const l of c.lanes) out.push({ ...l, machine: s.name, ref: laneRef(s.name, str(l.id)), ...(c.state === "connected" ? {} : { stale: true }) });
    }
    return out;
  }

  /** The rail's machine groups (hub_tui RailMachines): null while this hub has only its own engine,
   *  so the rail stays exactly as the classic one. Row ids are control-plane refs. */
  railGroups(): RailMachines | null {
    if (this.#specs.length === 0) return null;
    return {
      local: DEFAULT_MACHINE,
      groups: this.#specs.map((s) => {
        const c = this.#conns.get(s.name) ?? freshConn();
        return { name: s.name, state: c.state, rows: buildAgentRows(c.lanes, {}, {}).map((r) => ({ ...r, id: laneRef(s.name, r.id) })) };
      }),
    };
  }

  list(): MachineView[] {
    return [
      { name: DEFAULT_MACHINE, kind: "local", discoveryDir: null, state: "connected", lanes: this.#localLanes.length, attempt: 0, error: "", port: this.#local.port },
      ...this.#specs.map((s) => {
        const c = this.#conns.get(s.name) ?? freshConn();
        return { name: s.name, kind: s.kind, discoveryDir: s.discoveryDir, state: c.state, lanes: c.lanes.length, attempt: c.attempt, error: c.error, port: c.engine?.port ?? null };
      }),
    ];
  }

  add(name: string, discoveryDir: string): MachineSpec {
    this.#specs = addMachine(this.#specs, name, discoveryDir);
    if (this.#path) saveMachines(this.#path, this.#specs);
    const spec = this.#specs.at(-1)!;
    this.#conns.set(spec.name, freshConn());
    if (this.#running) void this.tick(spec.name);
    this.#onChange();
    return spec;
  }

  remove(name: string): void {
    this.#specs = removeMachine(this.#specs, name);
    if (this.#path) saveMachines(this.#path, this.#specs);
    this.#timers.get(name)?.();
    this.#timers.delete(name);
    this.#conns.delete(name);
    this.#execs.delete(name);
    this.#onChange();
  }

  /** One step for machine `name`: find and verify its engine when it has none, then read its lanes;
   *  a failure drops the engine (and its token) and schedules the retry on that machine's backoff. */
  async tick(name: string): Promise<void> {
    const spec = this.#specs.find((s) => s.name === name);
    const before = this.#conns.get(name);
    if (!spec || !before) return;
    let next: MachineConn;
    try {
      const engine = before.engine ?? (await this.#find(spec.discoveryDir));
      if (!engine) throw new Error(`no engine in ${spec.discoveryDir} answered the handshake`);
      next = connOk(engine, await this.#status(engine));
    } catch (e) {
      next = connFail(before, e instanceof Error ? e.message : String(e));
    }
    if (this.#conns.get(name) !== before) return; // removed (or re-added) while this step ran
    this.#conns.set(name, next);
    if (before.state !== next.state || next.state === "connected") this.#onChange();
    if (!this.#running) return;
    this.#timers.set(name, this.#schedule(() => void this.tick(name), nextDelay(next)));
  }

  async #status(e: EngineDiscovery): Promise<Record<string, unknown>[]> {
    const res = await this.#fetch(`http://127.0.0.1:${e.port}/api/fleet/status`, { headers: { "x-lucid-token": e.token }, signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`/api/fleet/status -> ${res.status}`);
    const body = rec(await res.json());
    const lanes = rec(body.data ?? body).lanes;
    return Array.isArray(lanes) ? lanes.map(rec) : [];
  }

  /** The core agent verbs aimed at machine `name`'s verified engine. */
  #exec(name: string): (op: HubOp) => Promise<unknown> {
    const c = this.#conns.get(name);
    if (!c) throw new HubOpError("not_found", `no machine "${name}"`);
    const e = c.engine;
    if (!e) throw new HubOpError("machine_down", `machine "${name}" is ${c.state}${c.error ? `: ${c.error}` : ""}`);
    const cached = this.#execs.get(name);
    if (cached?.token === e.token) return cached.exec;
    // First use, or a reconnect brought a new token: the old executor goes with the old engine.
    const exec = createHubExecutor({
      spaces: new Spaces(),
      engine: { base: `http://127.0.0.1:${e.port}`, token: e.token, port: e.port, version: e.version, flavor: e.flavor },
      isDeck: () => false,
      paneText: () => { throw new HubOpError("usage", "panes belong to this hub, not to a machine"); },
      refresh: async () => {},
      changed: () => {},
      setAgentPriority: () => { throw new HubOpError("usage", "priority applies to this machine's lanes only"); },
    });
    this.#execs.set(name, { token: e.token, exec });
    return exec;
  }

  /** Answer an `agent ...` argv across machines, or undefined when it is not one of the routed verbs.
   *  `local` is the hub's own executor (the classic agent verbs, unchanged for unprefixed refs). */
  command(argv: readonly string[], local: (op: HubOp) => Promise<unknown>): Promise<unknown> | undefined {
    const r = routeAgentArgv(argv, this.names());
    if (!r) return undefined;
    if (r.machine === null) return this.#listAll(local);
    if (r.op.op === "agent.list") return this.#listOne(r.machine, local);
    if (r.machine === DEFAULT_MACHINE) {
      return local(r.op).then((res) => (r.op.op === "agent.status" ? this.#annotate({ ...rec(res), machine: DEFAULT_MACHINE }) : res));
    }
    const machine = r.machine;
    return this.#exec(machine)(r.op).then((res) => this.#tag(machine, r.op, res));
  }

  /** A remote machine's answer with its lane ids as control-plane refs. */
  #tag(machine: string, op: HubOp, res: unknown): unknown {
    const o = rec(res);
    const ref = (v: unknown) => laneRef(machine, str(v));
    switch (op.op) {
      case "agent.status": return this.#annotate({ ...o, machine, id: ref(o.id) });
      case "agent.spawn": return { ...o, lane: { ...rec(o.lane), machine, id: ref(rec(o.lane).id) } };
      case "agent.prompt":
      case "agent.read":
      case "agent.cancel": return { ...o, machine, lane: ref(o.lane) };
      default: return res;
    }
  }

  async #listOne(machine: string, local: (op: HubOp) => Promise<unknown>): Promise<unknown[]> {
    if (machine === DEFAULT_MACHINE) {
      const lanes = await local({ op: "agent.list" });
      return (Array.isArray(lanes) ? lanes : []).map((l) => this.#annotate({ ...rec(l), machine: DEFAULT_MACHINE }));
    }
    const c = this.#conns.get(machine);
    if (!c) throw new HubOpError("not_found", `no machine "${machine}"`);
    let lanes = c.lanes;
    let stale = c.state !== "connected";
    if (!stale) {
      try {
        const fresh = await this.#exec(machine)({ op: "agent.list" });
        lanes = Array.isArray(fresh) ? fresh.map(rec) : [];
      } catch { stale = true; }
    }
    return lanes.map((l) => this.#annotate({ ...l, machine, id: laneRef(machine, str(l.id)), ...(stale ? { stale: true } : {}) }));
  }

  /** `agent list`: the default machine's lanes, then each machine's, every row naming its machine. */
  async #listAll(local: (op: HubOp) => Promise<unknown>): Promise<unknown[]> {
    const parts = await Promise.all(this.names().map((m) => this.#listOne(m, local)));
    return parts.flat();
  }

  /** `machine list | add <name> --dir <path> | remove <name>`. */
  machineCommand(argv: readonly string[]): unknown {
    const [, sub, ...rest] = argv;
    if (sub === "list" && rest.length === 0) return this.list();
    if (sub === "add") {
      const [name, flag, value, ...extra] = rest;
      if (flag === "--ssh") throw new HubOpError("not_supported", "SSH machines (ADR-0496 item 3) wait for the operator's go; add an engine on this box with --dir");
      if (flag === "--profile") throw new HubOpError("not_supported", "Fleet Profiles (ADR-0272) are not built yet; add that profile's discovery folder with --dir");
      if (flag !== "--dir" || value === undefined || extra.length) throw new HubOpError("usage", "machine add <name> --dir <absolute path of that engine's discovery folder>");
      const spec = this.add(name ?? "", value);
      return { added: spec.name, discoveryDir: spec.discoveryDir, state: this.state(spec.name) };
    }
    if (sub === "remove" && rest.length === 1) {
      this.remove(rest[0]!);
      return { removed: rest[0] };
    }
    throw new HubOpError("usage", "machine list | machine add <name> --dir <path> | machine remove <name>");
  }
}
