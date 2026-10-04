// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-TUI.3 (ADR-0431): the hub CONTROL PLANE - what lets an agent drive `lucid hub` the way the herdr
// CLI drives herdr. A loopback HTTP server inside the hub process, found through the same discovery +
// nonce handshake house pattern as the engine (ADR-0419, desktop/engine_discovery.ts):
//
//   hub-discovery-<pid>.json  {v,pid,port,nonce,token}, 0600, tmp+rename, removed on exit, in
//                             LUCID_DATA_ROOT or ~/.omp (same-user trust boundary as omp's vault).
//   GET  /health              {ok,service,nonce}. A client demands the FILE's nonce back before it
//                             sends the token anywhere: a stale file, a recycled port or a squatter
//                             fails the handshake and never sees the token (fail-closed).
//   POST /cmd                 {argv:[...]} + x-lucid-hub-token. argv goes through the ONE parser
//                             (hub_tmux_verbs.ts) and the ONE executor below.
//
// Security posture: the control plane scans nothing and releases nothing. Agent ops are a FIXED
// allowlist of engine fleet routes (list/spawn/prompt/status/read/cancel), called with the engine UI
// token the hub already holds; prompt text rides /api/fleet/prompt untouched, so the in-omp gate scans
// it exactly as it scans a typed prompt. There is no generic engine proxy and no op reaching
// /api/security/approve, /api/fleet/answer, the whitelist or the egress posture: those stay human-only
// keys in the TUI. send-keys types into an AGENT pane's composer only; it never reaches the keymap.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { healthVerdict } from "../../desktop/port_guard.ts";
import { HubOpError, layoutOf, type PaneDeck, type Spaces } from "./hub_spaces.ts";
import { parseHubCommand, type HubOp } from "./hub_tmux_verbs.ts";

export interface HubDiscovery { v: 1; pid: number; port: number; nonce: string; token: string }

const rec = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const FILE_RE = /^hub-discovery-\d+\.json$/;

export function hubDiscoveryPath(dir: string, pid: number): string {
  return join(dir, `hub-discovery-${pid}.json`);
}

/** Parse + validate one file. Anything off-shape is null - a client never acts on a guess. */
export function parseHubDiscovery(raw: string): HubDiscovery | null {
  let d: Record<string, unknown>;
  try { d = JSON.parse(raw); } catch { return null; }
  if (typeof d !== "object" || d === null || d.v !== 1) return null;
  if (typeof d.pid !== "number" || !Number.isInteger(d.pid) || d.pid <= 0) return null;
  if (typeof d.port !== "number" || !Number.isInteger(d.port) || d.port <= 0 || d.port > 65535) return null;
  if (typeof d.nonce !== "string" || !d.nonce || typeof d.token !== "string" || !d.token) return null;
  return { v: 1, pid: d.pid, port: d.port, nonce: d.nonce, token: d.token };
}

/** Every parseable hub discovery file in `dir`, newest first. */
export function listHubDiscoveries(dir: string): HubDiscovery[] {
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  const found: { d: HubDiscovery; at: number }[] = [];
  for (const n of names.filter((x) => FILE_RE.test(x))) {
    try {
      const d = parseHubDiscovery(readFileSync(join(dir, n), "utf8"));
      if (d) found.push({ d, at: statSync(join(dir, n)).mtimeMs });
    } catch { /* vanished or unreadable: not a hub */ }
  }
  return found.sort((a, b) => b.at - a.at).map((x) => x.d);
}

/** The newest hub that wins the nonce handshake, or null. The token is sent nowhere until it wins. */
export async function connectHub(dir: string, fetchImpl: typeof fetch = fetch): Promise<HubDiscovery | null> {
  for (const d of listHubDiscoveries(dir)) {
    try {
      const res = await fetchImpl(`http://127.0.0.1:${d.port}/health`, { signal: AbortSignal.timeout(2000) });
      if (healthVerdict(d.nonce, res.ok, await res.json()) === "ours") return d;
    } catch { /* dead or foreign: try the next file */ }
  }
  return null;
}

export interface HubReply { status: number; body: Record<string, unknown> }

/** Send one command. Resolves with the HTTP status and the JSON body; never throws on a 4xx. */
export async function callHub(d: HubDiscovery, argv: readonly string[]): Promise<HubReply> {
  const res = await fetch(`http://127.0.0.1:${d.port}/cmd`, {
    method: "POST",
    headers: { "x-lucid-hub-token": d.token, "content-type": "application/json" },
    body: JSON.stringify({ argv }),
    signal: AbortSignal.timeout(90_000), // agent spawn boots an omp child
  });
  return { status: res.status, body: ((await res.json().catch(() => null)) ?? { error: "bad_reply" }) as Record<string, unknown> };
}

const STATUS_BY_CODE: Record<string, number> = { usage: 400, bad_request: 400, bad_name: 400, not_found: 404, engine: 502 };

export interface HubControl { discovery: HubDiscovery; path: string; stop(): void }

/** Boot the control server on an ephemeral loopback port and publish its discovery file. */
export function startHubControl(opts: { dir: string; exec: (op: HubOp) => Promise<unknown>; pid?: number }): HubControl {
  const nonce = randomBytes(16).toString("hex");
  const token = randomBytes(32).toString("hex");
  const tokenBuf = Buffer.from(token);
  const reply = (status: number, body: unknown) => Response.json(body, { status });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    maxRequestBodySize: 1 << 20,
    async fetch(req) {
      // DNS-rebinding and browser guards: only a loopback Host, and no browser Origin at all.
      const host = req.headers.get("host");
      if ((host !== `127.0.0.1:${server.port}` && host !== `localhost:${server.port}`) || req.headers.has("origin")) return reply(403, { error: "forbidden" });
      const { pathname } = new URL(req.url);
      if (pathname === "/health" && req.method === "GET") return reply(200, { ok: true, service: "lucid-hub", nonce });
      if (pathname !== "/cmd" || req.method !== "POST") return reply(404, { error: "not_found" });
      const presented = Buffer.from(req.headers.get("x-lucid-hub-token") ?? "");
      if (presented.length !== tokenBuf.length || !timingSafeEqual(presented, tokenBuf)) return reply(403, { error: "forbidden" });
      let argv: unknown;
      try { argv = rec(await req.json()).argv; } catch { return reply(400, { error: "bad_request", message: "body must be JSON {argv:[...]}" }); }
      if (!Array.isArray(argv) || argv.length === 0 || argv.length > 64 || !argv.every((a) => typeof a === "string" && a.length <= 100_000)) {
        return reply(400, { error: "bad_request", message: "argv must be 1-64 strings" });
      }
      try {
        return reply(200, { ok: true, data: (await opts.exec(parseHubCommand(argv))) ?? null });
      } catch (e) {
        if (e instanceof HubOpError) return reply(STATUS_BY_CODE[e.code] ?? 409, { error: e.code, message: e.message });
        return reply(500, { error: "internal", message: e instanceof Error ? e.message : String(e) });
      }
    },
  });
  const discovery: HubDiscovery = { v: 1, pid: opts.pid ?? process.pid, port: server.port!, nonce, token };
  const path = hubDiscoveryPath(opts.dir, discovery.pid);
  mkdirSync(opts.dir, { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(discovery) + "\n", { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
  return {
    discovery,
    path,
    stop() {
      server.stop(true);
      try { rmSync(path, { force: true }); } catch { /* a leftover file fails the handshake anyway */ }
    },
  };
}

// ---- the executor: one per hub, shared by the control server and the TUI's `:` prompt ------------

export interface HubHost {
  readonly spaces: Spaces;
  readonly engine: { base: string; token: string; port: number; version: string; flavor: string };
  isDeck(deck: string): boolean;
  /** The pane as the hub renders it, ANSI stripped, frame removed. */
  paneText(paneId: string | undefined, width: number, lines: number): { id: string; title: string; lines: string[] };
  /** Re-poll the engine (an agent pane just appeared and needs its transcript and watch stream). */
  refresh(): Promise<void>;
  /** Something changed: redraw. */
  changed(): void;
}

const SUBMIT_KEYS = ["Enter", "C-m", "KPEnter"];

export function createHubExecutor(host: HubHost): (op: HubOp) => Promise<unknown> {
  const { spaces } = host;
  const drafts = new Map<string, string>(); // send-keys text typed into an agent pane, not yet submitted

  async function engine(path: string, body?: Record<string, unknown>): Promise<unknown> {
    const headers: Record<string, string> = { "x-lucid-token": host.engine.token };
    const init: RequestInit = body === undefined
      ? { headers, signal: AbortSignal.timeout(10_000) }
      : { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) };
    let res: Response;
    try { res = await fetch(`${host.engine.base}${path}`, init); } catch (e) { throw new HubOpError("engine", `${path}: ${e instanceof Error ? e.message : String(e)}`); }
    const j = rec(await res.json().catch(() => null));
    if (!res.ok || j.ok === false) throw new HubOpError("engine", `${path} -> ${res.status}${typeof j.error === "string" ? `: ${j.error}` : ""}`);
    return j.data ?? j;
  }

  async function lane(ref: string): Promise<Record<string, unknown>> {
    const lanes = (rec(await engine("/api/fleet/status")).lanes ?? []) as unknown[];
    const l = lanes.map(rec).find((x) => x.id === ref) ?? lanes.map(rec).find((x) => x.name === ref);
    if (!l) throw new HubOpError("not_found", `no agent "${ref}"`);
    return l;
  }

  /** Start a turn through the engine's own route and return once the engine has ACCEPTED or REFUSED it.
   *  Dropping the stream after the first event is safe: the engine's connection owns only its observer,
   *  never the turn (desktop/chat_stream.ts), so the turn runs on and `agent read` follows it. */
  async function prompt(laneId: string, text: string): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await fetch(`${host.engine.base}/api/fleet/prompt`, {
        method: "POST",
        headers: { "x-lucid-token": host.engine.token, "content-type": "application/json" },
        body: JSON.stringify({ laneId, text }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) { throw new HubOpError("engine", `/api/fleet/prompt: ${e instanceof Error ? e.message : String(e)}`); }
    if (!res.ok || !res.body) throw new HubOpError("engine", `/api/fleet/prompt -> ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let first: Record<string, unknown> | null = null;
    try {
      while (!first) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        for (let nl = buf.indexOf("\n"); nl >= 0 && !first; nl = buf.indexOf("\n")) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          let e: Record<string, unknown> = {};
          try { e = rec(JSON.parse(line)); } catch { /* not an event */ }
          if (e.type && e.type !== "ping") first = e;
        }
      }
    } catch {
      throw new HubOpError("engine", "the engine did not answer the prompt within 30s - check `agent status`");
    } finally {
      void reader.cancel().catch(() => {});
    }
    if (!first) throw new HubOpError("engine", "the engine closed the prompt stream without an answer");
    if (first.type === "error") throw new HubOpError("refused", String(first.message ?? "the engine refused the prompt"));
    return { lane: laneId, accepted: true, event: first };
  }

  const space = (id: string) => spaces.list().find((s) => s.id === id);
  const tab = (id: string) => spaces.tabList().find((t) => t.id === id);

  async function run(op: HubOp): Promise<unknown> {
    switch (op.op) {
      case "status":
        return {
          hub: { pid: process.pid },
          engine: { port: host.engine.port, version: host.engine.version, flavor: host.engine.flavor },
          active: spaces.active,
          tab: spaces.tab.id,
          focused: spaces.pane().leaf.id,
          spaces: spaces.list(),
        };
      case "space.list": return spaces.list();
      case "space.create": return space(spaces.create(op.name).id);
      case "space.rename": return space(spaces.rename(op.target, op.name).id);
      case "space.close": { const s = spaces.close(op.target); return { closed: s.id, active: spaces.active }; }
      case "space.focus": return space(spaces.focus(op.target).id);
      case "tab.list": return spaces.tabList(op.all ? undefined : op.space);
      case "tab.create": return tab(spaces.createTab(op.space, op.name).id);
      case "tab.rename": return tab(spaces.renameTab(op.target, op.name).id);
      case "tab.close": { const t = spaces.closeTab(op.target); return { closed: t.id, tab: spaces.current.activeTab }; }
      case "tab.focus": return tab(spaces.focusTab(op.target).id);
      case "pane.list": return spaces.paneList(op.all ? {} : op.tab !== undefined ? { tab: op.tab } : { space: op.space });
      case "pane.split": {
        const leaf = spaces.split(op.target, op.dir);
        return { pane: leaf.id, layout: layoutOf(spaces.pane(leaf.id).tab.tree) };
      }
      case "pane.close": {
        const { tab: home } = spaces.pane(op.target); // the tab object outlives the pane; its tree is replaced in place
        const leaf = spaces.closePane(op.target);
        return { closed: leaf.id, layout: layoutOf(home.tree) };
      }
      case "pane.focus": return { focused: spaces.focusPane(op.target).id, active: spaces.active, tab: spaces.tab.id };
      case "pane.zoom": { const zoomed = spaces.zoom(op.target); return { pane: spaces.pane().leaf.id, zoomed }; }
      case "pane.swap": spaces.swap(op.source, op.target); return { layout: layoutOf(spaces.pane(op.source).tab.tree) };
      case "pane.resize": return { pane: spaces.pane(op.target).leaf.id, ratio: spaces.resize(op.target, op.dir, op.n) };
      case "pane.rebind": {
        if (op.deck === "agent") {
          if (!op.lane) throw new HubOpError("usage", "pane rebind <pane> agent <lane>");
          const l = await lane(op.lane);
          const leaf = spaces.rebind(op.target, "agent", { id: String(l.id), name: String(l.name ?? l.id) });
          await host.refresh();
          return leaf;
        }
        if (!host.isDeck(op.deck)) throw new HubOpError("not_found", `no deck "${op.deck}"`);
        return spaces.rebind(op.target, op.deck as PaneDeck);
      }
      case "pane.read": return host.paneText(op.target, op.width, op.lines);
      case "pane.keys": {
        const { leaf } = spaces.pane(op.target);
        if (leaf.deck !== "agent" || !leaf.lane) throw new HubOpError("not_agent", "send-keys types into an AGENT pane's composer only; the hub keymap is not scriptable");
        let draft = drafts.get(leaf.id) ?? "";
        const sent: string[] = [];
        for (const k of op.keys) {
          if (SUBMIT_KEYS.includes(k)) {
            if (draft.trim()) { await prompt(leaf.lane, draft.trim()); sent.push(draft.trim()); }
            draft = "";
          } else if (k === "C-c") { await engine("/api/fleet/cancel", { laneId: leaf.lane }); draft = ""; }
          else if (k === "Escape") draft = "";
          else if (k === "BSpace") draft = draft.slice(0, -1);
          else if (k === "Space") draft += " ";
          else draft += k;
        }
        drafts.set(leaf.id, draft);
        return { pane: leaf.id, lane: leaf.lane, sent, draft };
      }
      case "agent.list": return (rec(await engine("/api/fleet/status")).lanes ?? []) as unknown[];
      case "agent.status": return lane(op.lane);
      case "agent.spawn": {
        // A lane needs a real folder: the one asked for, else the engine's CURRENT workspace, never a guess.
        const cwd = op.cwd ?? String(rec(await engine("/api/workspace")).current ?? "");
        const reply = rec(await engine("/api/fleet/spawn", { cwd, ...(op.name ? { name: op.name } : {}), ...(op.model ? { model: op.model } : {}), ...(op.session ? { sessionId: op.session } : {}) }));
        if (reply.ok === false || !rec(reply.lane).id) throw new HubOpError("refused", String(reply.reason ?? reply.error ?? "the engine refused the spawn"));
        return { lane: reply.lane };
      }
      case "agent.prompt": return prompt(String((await lane(op.lane)).id), op.text);
      case "agent.read": {
        const l = await lane(op.lane);
        const turns = (rec(await engine(`/api/fleet/transcript?laneId=${encodeURIComponent(String(l.id))}`)).turns ?? []) as unknown[];
        return { lane: l.id, status: l.status, turns: turns.slice(-op.turns) };
      }
      case "agent.cancel": {
        const l = await lane(op.lane);
        return { lane: l.id, result: await engine("/api/fleet/cancel", { laneId: l.id }) };
      }
    }
  }

  return async (op) => {
    try { return await run(op); } finally { host.changed(); }
  };
}
