// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Herd (ADR-0497 as the add-on, ADR-0535): the read-only GUI mirror on the runtime's PORT, beside
// /healthz (runtime_host.ts). Node APIs only: server.js runs under Electron's Node.
//
// Routes, all GET:
//   /healthz            the runtime's health check (runtime_host.ts answers it)
//   /                   the page; /mirror.js and /mirror.css its script and stylesheet (gui_page.ts)
//   /api/mirror         MirrorState as JSON
//   /api/mirror/events  MirrorState as Server-Sent Events, sent when it changes
//   /host/mirror        MirrorState for the engine, behind the runtime's host token (ADR-0506)
//
// Guards (guardRequest), in order: a loopback Host naming this port (DNS rebinding); a known path;
// GET only (nothing here changes anything); the Origin: none at all on /healthz and /host/*, and on
// the page routes none or this server's own (the IDE's Preview iframe loads the page from its own
// origin); /host/* needs LUCID_PLUGIN_HOST_TOKEN in x-lucid-host-token, compared in constant time.
// The page never receives that token. No CORS header is ever sent.
//
// The mirror reads instance main through what the Herd server already publishes: its layout file
// (written on every change) and `agent list` over its control plane. `agent list` is the only argv
// this module sends: no approval, no prompt, no layout change.

import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { callHub } from "../../../harness/launcher/hub_control.ts";
import { projectMirror, parseMirrorSpaces, type MirrorState } from "./gui_mirror.ts";
import { MIRROR_CSS, MIRROR_HTML, MIRROR_JS } from "./gui_page.ts";
import { connectInstance, instancePaths } from "./instance.ts";

export type RuntimeRoute = "health" | "page" | "script" | "style" | "state" | "events" | "host-state";

const ROUTES: Record<string, RuntimeRoute> = {
  "/healthz": "health",
  "/": "page",
  "/mirror.js": "script",
  "/mirror.css": "style",
  "/api/mirror": "state",
  "/api/mirror/events": "events",
  "/host/mirror": "host-state",
};

/** Routes a browser never calls: any Origin on them is refused. */
const NO_ORIGIN: Record<RuntimeRoute, boolean> = { health: true, "host-state": true, page: false, script: false, style: false, state: false, events: false };

/** What the guard reads of one request: the raw header values Node hands over. */
export interface RequestFacts {
  method: string | undefined;
  url: string | undefined;
  host: string | undefined;
  origin: string | undefined;
  token: string | string[] | undefined;
}

export type GuardVerdict = { ok: true; route: RuntimeRoute } | { ok: false; status: 403 | 404 | 405; error: "forbidden" | "not_found" | "method_not_allowed" };

/** Decide one request. Pure. `hostToken` is this launch's LUCID_PLUGIN_HOST_TOKEN, or null (then
 *  every /host/* request is refused). */
export function guardRequest(r: RequestFacts, port: number, hostToken: string | null): GuardVerdict {
  const own = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (r.host === undefined || !own.includes(r.host)) return { ok: false, status: 403, error: "forbidden" };
  // Origin-form only: an absolute or scheme-relative target never names a route here.
  const url = r.url ?? "";
  const path = url.startsWith("/") && !url.startsWith("//") ? url.split("?")[0]! : "";
  const route = Object.hasOwn(ROUTES, path) ? ROUTES[path] : undefined;
  if (route === undefined) return { ok: false, status: 404, error: "not_found" };
  if (r.method !== "GET") return { ok: false, status: 405, error: "method_not_allowed" };
  if (r.origin !== undefined && (NO_ORIGIN[route] || !own.some((h) => r.origin === `http://${h}`))) return { ok: false, status: 403, error: "forbidden" };
  if (route === "host-state") {
    const presented = Buffer.from(typeof r.token === "string" ? r.token : "");
    const expected = Buffer.from(hostToken ?? "");
    if (!hostToken || presented.length !== expected.length || !timingSafeEqual(presented, expected)) return { ok: false, status: 403, error: "forbidden" };
  }
  return { ok: true, route };
}

/** The page's CSP: same-origin script, style and fetch only, nothing inline, no forms, framable
 *  only by a loopback page (the IDE's Preview iframe), as the runtime's web-kind CSP is. */
export const MIRROR_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors http://localhost:* http://127.0.0.1:*",
].join("; ");

/** Headers on every mirror response. */
export const MIRROR_HEADERS: Record<string, string> = {
  "content-security-policy": MIRROR_CSP,
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
  "cross-origin-resource-policy": "same-origin",
};

/** The static bytes per route. */
export const MIRROR_ASSETS: Record<"page" | "script" | "style", { type: string; body: string }> = {
  page: { type: "text/html; charset=utf-8", body: MIRROR_HTML },
  script: { type: "text/javascript; charset=utf-8", body: MIRROR_JS },
  style: { type: "text/css; charset=utf-8", body: MIRROR_CSS },
};

/** Instance `instance` as the mirror shows it: down when it does not answer its handshake; else its
 *  layout file and its `agent list` (null lanes when the hub could not list them). */
export async function readMirror(data: string, instance: string): Promise<MirrorState> {
  const hub = await connectInstance(data, instance);
  if (!hub) return projectMirror({ instance, up: false, layout: null, lanes: null });
  let raw: string | null = null;
  try { raw = readFileSync(instancePaths(data, instance).spaces, "utf8"); } catch { /* no layout yet */ }
  const reply = await callHub(hub, ["agent", "list"]).catch(() => null);
  const listed: unknown = reply?.status === 200 ? reply.body.data : null;
  const lanes: readonly unknown[] | null = Array.isArray(listed) ? listed : null;
  return projectMirror({ instance, up: true, layout: raw === null ? null : parseMirrorSpaces(raw), lanes });
}

/** One live page: where the feed writes Server-Sent Events. */
export interface MirrorSink { send(chunk: string): void }

/** Starts the feed's tick; returns the stop. */
export type MirrorSchedule = (tick: () => void) => () => void;

export const FEED_TICK_MS = 2_000;
export const FEED_SUBSCRIBERS_MAX = 8;
/** A comment line every this many quiet ticks keeps idle connections open. */
export const FEED_HEARTBEAT_TICKS = 10;

const everyTick: MirrorSchedule = (tick) => {
  const t = setInterval(tick, FEED_TICK_MS);
  t.unref();
  return () => clearInterval(t);
};

/** The live updates: reads the mirror on a tick only while a page is subscribed. A new page gets the
 *  state of the next read whatever it is; every page gets a state that differs from the last one
 *  sent. One read at a time: a tick during a read joins it. */
export class MirrorFeed {
  readonly #sinks = new Set<MirrorSink>();
  /** Pages that have not had a state yet. */
  readonly #fresh = new Set<MirrorSink>();
  #stop: (() => void) | null = null;
  #last = "";
  #quiet = 0;
  #inflight: Promise<void> | null = null;

  constructor(private readonly read: () => Promise<MirrorState>, private readonly schedule: MirrorSchedule = everyTick) {}

  /** Add a page and read for it at once. Null when FEED_SUBSCRIBERS_MAX pages already follow, else
   *  the unsubscribe; the last one out stops the tick. */
  subscribe(sink: MirrorSink): (() => void) | null {
    if (this.#sinks.size >= FEED_SUBSCRIBERS_MAX) return null;
    this.#sinks.add(sink);
    this.#fresh.add(sink);
    this.#stop ??= this.schedule(() => void this.tick());
    void this.tick();
    return () => {
      this.#sinks.delete(sink);
      this.#fresh.delete(sink);
      if (this.#sinks.size === 0 && this.#stop) { this.#stop(); this.#stop = null; this.#last = ""; this.#quiet = 0; }
    };
  }

  /** One read (or the one in flight). A page that subscribed during a read gets its own next read. */
  tick(): Promise<void> {
    if (this.#sinks.size === 0) return Promise.resolve();
    this.#inflight ??= this.#run().finally(() => {
      this.#inflight = null;
      if (this.#fresh.size > 0) void this.tick();
    });
    return this.#inflight;
  }

  async #run(): Promise<void> {
    const fresh = [...this.#fresh];
    this.#fresh.clear();
    let body: string;
    try { body = JSON.stringify(await this.read()); } catch {
      this.#last = ""; // whatever the next read finds goes to every page
      return;
    }
    const changed = body !== this.#last;
    this.#last = body;
    if (changed) this.#quiet = 0;
    const ping = !changed && fresh.length === 0 && ++this.#quiet % FEED_HEARTBEAT_TICKS === 0;
    for (const s of this.#sinks) {
      if (changed || fresh.includes(s)) s.send(`data: ${body}\n\n`);
      else if (ping) s.send(": ping\n\n");
    }
  }
}
