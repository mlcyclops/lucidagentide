// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Herd (ADR-0497 as the add-on): the read-only mirror's request guards (Host, path, method, Origin,
// the runtime's host token) and its live feed (a state goes out when it changes, a new page gets one
// at once, the tick runs only while a page follows).

import { describe, expect, test } from "bun:test";
import type { MirrorState } from "../src/gui_mirror.ts";
import { FEED_HEARTBEAT_TICKS, FEED_SUBSCRIBERS_MAX, guardRequest, MIRROR_CSP, MirrorFeed, type MirrorSchedule, type RequestFacts } from "../src/gui_server.ts";

const PORT = 47123;
const TOKEN = "a".repeat(64);
const req = (over: Partial<RequestFacts> = {}): RequestFacts => ({ method: "GET", url: "/", host: `localhost:${PORT}`, origin: undefined, token: undefined, ...over });

describe("guardRequest", () => {
  test("only a loopback Host naming this port", () => {
    expect(guardRequest(req(), PORT, TOKEN)).toEqual({ ok: true, route: "page" });
    expect(guardRequest(req({ host: `127.0.0.1:${PORT}` }), PORT, TOKEN)).toEqual({ ok: true, route: "page" });
    for (const host of [undefined, "evil.example", `evil.example:${PORT}`, `localhost:${PORT + 1}`, "localhost", `[::1]:${PORT}`]) {
      expect(guardRequest(req({ host }), PORT, TOKEN)).toEqual({ ok: false, status: 403, error: "forbidden" });
    }
  });

  test("known paths only, in origin form; the query is ignored", () => {
    expect(guardRequest(req({ url: "/?x=1" }), PORT, TOKEN)).toEqual({ ok: true, route: "page" });
    expect(guardRequest(req({ url: "/mirror.js" }), PORT, TOKEN)).toEqual({ ok: true, route: "script" });
    expect(guardRequest(req({ url: "/api/mirror/events" }), PORT, TOKEN)).toEqual({ ok: true, route: "events" });
    for (const url of [undefined, "/cmd", "/attach", "//evil.example/", `http://localhost:${PORT}/`, "/mirror.js/", "/%2e%2e/x", "/constructor", "/toString"]) {
      expect(guardRequest(req({ url }), PORT, TOKEN)).toEqual({ ok: false, status: 404, error: "not_found" });
    }
  });

  test("GET only: nothing on this server changes anything", () => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH", "HEAD", undefined]) {
      expect(guardRequest(req({ method }), PORT, TOKEN)).toEqual({ ok: false, status: 405, error: "method_not_allowed" });
    }
  });

  test("the page routes take no Origin or their own; health and host routes take none", () => {
    for (const origin of [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`]) {
      expect(guardRequest(req({ url: "/api/mirror", origin }), PORT, TOKEN)).toEqual({ ok: true, route: "state" });
    }
    for (const origin of ["http://evil.example", `http://localhost:${PORT + 1}`, `https://localhost:${PORT}`, "null", ""]) {
      expect(guardRequest(req({ url: "/api/mirror/events", origin }), PORT, TOKEN)).toEqual({ ok: false, status: 403, error: "forbidden" });
    }
    expect(guardRequest(req({ url: "/healthz", origin: `http://localhost:${PORT}` }), PORT, TOKEN)).toEqual({ ok: false, status: 403, error: "forbidden" });
    expect(guardRequest(req({ url: "/host/mirror", origin: `http://localhost:${PORT}`, token: TOKEN }), PORT, TOKEN)).toEqual({ ok: false, status: 403, error: "forbidden" });
    expect(guardRequest(req({ url: "/healthz" }), PORT, TOKEN)).toEqual({ ok: true, route: "health" });
  });

  test("/host/* needs this launch's host token; without one the route is closed", () => {
    expect(guardRequest(req({ url: "/host/mirror", token: TOKEN }), PORT, TOKEN)).toEqual({ ok: true, route: "host-state" });
    for (const token of [undefined, "", "b".repeat(64), TOKEN.slice(1), `${TOKEN}a`, [TOKEN], [TOKEN, TOKEN]]) {
      expect(guardRequest(req({ url: "/host/mirror", token }), PORT, TOKEN)).toEqual({ ok: false, status: 403, error: "forbidden" });
    }
    expect(guardRequest(req({ url: "/host/mirror", token: "" }), PORT, null)).toEqual({ ok: false, status: 403, error: "forbidden" });
    expect(guardRequest(req({ url: "/host/mirror", token: "" }), PORT, "")).toEqual({ ok: false, status: 403, error: "forbidden" });
    // The page routes never need it, so the page never holds it.
    expect(guardRequest(req({ url: "/api/mirror" }), PORT, TOKEN)).toEqual({ ok: true, route: "state" });
  });

  test("the CSP allows nothing inline and nothing off this origin", () => {
    expect(MIRROR_CSP).toContain("default-src 'none'");
    expect(MIRROR_CSP).toContain("script-src 'self'");
    expect(MIRROR_CSP).toContain("style-src 'self'");
    expect(MIRROR_CSP).not.toContain("unsafe");
    expect(MIRROR_CSP).toContain("form-action 'none'");
  });
});

const state = (agents: number): MirrorState => ({ v: 1, instance: "main", up: true, focusedTab: null, spaces: [], counts: { agents, needsYou: 0, unseen: 0 } });

/** A feed over a settable state and a manual schedule. */
function rig() {
  let current = state(1);
  let fail = false;
  const sched = { starts: 0, stops: 0 };
  const schedule: MirrorSchedule = () => { sched.starts++; return () => { sched.stops++; }; };
  const feed = new MirrorFeed(async () => { if (fail) throw new Error("hub gone"); return current; }, schedule);
  const sink = () => { const got: string[] = []; return { got, send: (c: string) => { got.push(c); } }; };
  return { feed, sched, sink, set: (s: MirrorState) => { current = s; }, failing: (f: boolean) => { fail = f; } };
}
const data = (s: MirrorState) => `data: ${JSON.stringify(s)}\n\n`;

describe("MirrorFeed", () => {
  test("a new page gets the state at once; an unchanged state is not sent again", async () => {
    const r = rig();
    const a = r.sink();
    r.feed.subscribe(a);
    await r.feed.tick();
    expect(a.got).toEqual([data(state(1))]);
    expect(r.sched.starts).toBe(1);
    await r.feed.tick();
    expect(a.got).toHaveLength(1);
  });

  test("a change goes to every page; a second page gets the current state on its own", async () => {
    const r = rig();
    const a = r.sink(), b = r.sink();
    r.feed.subscribe(a);
    await r.feed.tick();
    r.feed.subscribe(b);
    await r.feed.tick();
    expect(a.got).toEqual([data(state(1))]);
    expect(b.got).toEqual([data(state(1))]);
    r.set(state(2));
    await r.feed.tick();
    expect(a.got.at(-1)).toBe(data(state(2)));
    expect(b.got.at(-1)).toBe(data(state(2)));
    expect(r.sched.starts).toBe(1); // one tick for every page
  });

  test("quiet ticks send a heartbeat now and then", async () => {
    const r = rig();
    const a = r.sink();
    r.feed.subscribe(a);
    await r.feed.tick();
    for (let i = 0; i < FEED_HEARTBEAT_TICKS; i++) await r.feed.tick();
    expect(a.got.slice(1)).toEqual([": ping\n\n"]);
  });

  test("a failed read sends nothing; the next good read goes to every page", async () => {
    const r = rig();
    const a = r.sink();
    r.feed.subscribe(a);
    await r.feed.tick();
    r.failing(true);
    await r.feed.tick();
    expect(a.got).toHaveLength(1);
    r.failing(false);
    await r.feed.tick();
    expect(a.got).toEqual([data(state(1)), data(state(1))]);
  });

  test("the last page out stops the tick; a later page starts it again", async () => {
    const r = rig();
    const off = r.feed.subscribe(r.sink());
    await r.feed.tick();
    off?.();
    expect(r.sched.stops).toBe(1);
    const late = r.sink();
    r.feed.subscribe(late);
    await r.feed.tick();
    expect(r.sched.starts).toBe(2);
    expect(late.got).toEqual([data(state(1))]);
  });

  test("at most FEED_SUBSCRIBERS_MAX pages follow", async () => {
    const r = rig();
    for (let i = 0; i < FEED_SUBSCRIBERS_MAX; i++) expect(r.feed.subscribe(r.sink())).not.toBeNull();
    expect(r.feed.subscribe(r.sink())).toBeNull();
    await r.feed.tick();
  });
});
