// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/lane_channel.test.ts - LH-03 (ADR-0544 as amended by the 2026-11-12 review): a held lane's channel back
// to the engine. Every request carries a fresh nonce, its time and a MAC over the method, path and query, time and
// body under the lane's key; the engine refuses a replay, a stale time or any changed byte, opens the channel routes
// only (plus the ones listed as lane-safe), and only where every speaker the request names is that lane. Its reply
// carries a proof bound to that one request; the lane's side trusts a reply only with it.

import { afterEach, describe, expect, test } from "bun:test";
import { apiAuthorized } from "./origin_guard.ts";
import { answerChannel, CHANNEL_ROUTES, channelAdmits, LaneChannels } from "./lane_channel.ts";
import { CHANNEL_ENV, CHANNEL_MAC_HEADER, CHANNEL_NONCE_HEADER, CHANNEL_PROOF_HEADER, CHANNEL_TIME_HEADER, CHANNEL_WINDOW_MS, ChannelProofError, engineFetch, mintChannelKey } from "../harness/omp/engine_channel.ts";
import knowledgeExtension from "../harness/omp/knowledge_extension.ts";

const realFetch = globalThis.fetch;
const ENV_KEYS = [CHANNEL_ENV, "LUCID_KB_RETRIEVE_URL"] as const;
const inherited: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) inherited[k] = process.env[k];
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of ENV_KEYS) {
    const v = inherited[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const UI = "u".repeat(64);
const AGENT = "a".repeat(64);
const BASE = "http://127.0.0.1:5319";
// A slice of dev.ts AGENT_ROUTES, and the channel routes among them exactly as dev.ts derives CHANNEL_AUTH_ROUTES.
const AGENT_ROUTES: ReadonlySet<string> = new Set(["/api/interject/pending", "/api/checkout/gate", "/api/checkin", "/api/agent/beat", "/api/kb/retrieve", "/api/kg/recall", "/api/git/exec", "/api/sandbox/grant"]);
const CHANNEL_AUTH_ROUTES: ReadonlySet<string> = new Set(Object.keys(CHANNEL_ROUTES).filter((r) => AGENT_ROUTES.has(r)));

const requestOf = (input: string | URL | Request, init?: RequestInit): Request =>
  new Request(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url, init);

/** Route fetch to an engine holding `channels`: dev.ts's gate (authenticate, channelAdmits, apiAuthorized) in front
 *  of `handler`, and every reply to an authenticated request signed. Records what reached the "engine". */
function engineAt(channels: LaneChannels, handler: (req: Request) => Response, sessionOf: (laneId: string) => string | null = () => null): Request[] {
  const seen: Request[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = requestOf(input, init);
    seen.push(req);
    const url = new URL(req.url);
    const ch = await channels.authenticate(req, url);
    const authorized = apiAuthorized({
      path: url.pathname, headerToken: req.headers.get("x-lucid-token"), queryToken: url.searchParams.get("t"), uiToken: UI, agentToken: AGENT,
      queryRoutes: AGENT_ROUTES, agentRoutes: AGENT_ROUTES, channelAuthorized: ch !== null && channelAdmits(ch, url, sessionOf), channelRoutes: CHANNEL_AUTH_ROUTES,
    });
    const res = authorized ? handler(req) : new Response("forbidden", { status: 403 });
    return ch ? answerChannel(ch, res) : res;
  }) as typeof globalThis.fetch;
  return seen;
}

/** What a listener on the port records when the lane sends `url` + `init` (it cannot answer, so engineFetch throws). */
async function capture(key: string, url: string, init: RequestInit = {}): Promise<Request> {
  const got: Request[] = [];
  globalThis.fetch = (async (input: string | URL | Request, i?: RequestInit) => { got.push(requestOf(input, i)); return new Response("{}"); }) as typeof globalThis.fetch;
  await expect(engineFetch(url, init, { [CHANNEL_ENV]: key })).rejects.toBeInstanceOf(ChannelProofError);
  const req = got[0];
  if (!req) throw new Error("engineFetch sent nothing");
  return req;
}

const ok = (): Response => Response.json({ ok: true });

describe("the engine side", () => {
  test("a channel request opens the channel routes that are agent routes, and nothing else", () => {
    const auth = (path: string, channelAuthorized: boolean) => apiAuthorized({
      path, headerToken: null, queryToken: null, uiToken: UI, agentToken: AGENT,
      queryRoutes: AGENT_ROUTES, agentRoutes: AGENT_ROUTES, channelAuthorized, channelRoutes: CHANNEL_AUTH_ROUTES,
    });
    expect(auth("/api/interject/pending", true)).toBe(true);
    expect(auth("/api/kg/recall", true)).toBe(true); // listed as lane-safe
    expect(auth("/api/git/exec", true)).toBe(false); // an agent route, but not a lane's
    expect(auth("/api/sandbox/grant", true)).toBe(false);
    expect(auth("/api/security/approve", true)).toBe(false);
    expect(auth("/api/interject/pending", false)).toBe(false);
  });

  test("the lane's request authenticates once; a replay of it, or of a request older than the window, is refused", async () => {
    const key = mintChannelKey();
    const channels = new LaneChannels();
    channels.register("lane-a", key);
    const req = await capture(key, `${BASE}/api/kg/recall?t=dead`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "editor theme" }) });
    expect(req.url).not.toContain("t=dead");
    expect(req.url).not.toContain(key);
    const url = new URL(req.url);
    const late = await capture(key, `${BASE}/api/kg/recall`, { method: "POST", body: JSON.stringify({ query: "x" }) });
    expect(await channels.authenticate(late, new URL(late.url), Date.now() + CHANNEL_WINDOW_MS + 1_000)).toBeNull();
    expect((await channels.authenticate(req, url))?.laneId).toBe("lane-a");
    expect(await channels.authenticate(req, url)).toBeNull(); // the same bytes again: a replay
  });

  test("a captured request with another body, path, query or method is refused", async () => {
    const key = mintChannelKey();
    const channels = new LaneChannels();
    channels.register("lane-a", key);
    const body = JSON.stringify({ query: "editor theme" });
    const req = await capture(key, `${BASE}/api/kg/recall?k=5`, { method: "POST", headers: { "content-type": "application/json" }, body });
    const forged = async (url: string, method: string, b: string | null) =>
      channels.authenticate(new Request(url, { method, headers: req.headers, body: b }), new URL(url));
    expect(await forged(req.url, "POST", JSON.stringify({ query: "passwords" }))).toBeNull();
    expect(await forged(req.url.replace("/api/kg/recall", "/api/kg/retain"), "POST", body)).toBeNull();
    expect(await forged(req.url.replace("k=5", "k=20"), "POST", body)).toBeNull();
    expect(await forged(req.url, "PUT", body)).toBeNull();
    // A MAC for another lane's key names nobody here, and a request with no channel headers is no channel request.
    expect(await channels.authenticate(await capture(mintChannelKey(), `${BASE}/api/kg/recall`), new URL(`${BASE}/api/kg/recall`))).toBeNull();
    expect(await channels.authenticate(new Request(`${BASE}/api/kg/recall`, { headers: { [CHANNEL_NONCE_HEADER]: "1".repeat(32), [CHANNEL_TIME_HEADER]: String(Date.now()), [CHANNEL_MAC_HEADER]: "0".repeat(64) } }), new URL(`${BASE}/api/kg/recall`))).toBeNull();
    // The untouched request still goes through, once.
    expect((await forged(req.url, "POST", body))?.laneId).toBe("lane-a");
  });

  test("a lane speaks only for itself: another lane's target, from or session, or none at all, is refused", async () => {
    const a = mintChannelKey();
    const channels = new LaneChannels();
    channels.register("lane-a", a);
    channels.register("lane-b", mintChannelKey());
    engineAt(channels, ok, (laneId) => (laneId === "lane-a" ? "session-a" : "session-b"));
    const env = { [CHANNEL_ENV]: a };
    const status = async (path: string, init: RequestInit = {}) => (await engineFetch(`${BASE}${path}`, init, env)).status;
    const post = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(await status("/api/interject/pending?t=x&target=lane-a")).toBe(200);
    expect(await status("/api/interject/pending?t=x&target=lane-b")).toBe(403); // lane a cannot drain lane b's notes
    expect(await status("/api/interject/pending?t=x")).toBe(403); // a route that needs a target refuses none
    expect(await status("/api/checkout/gate?target=lane-b&command=git%20add%20-A")).toBe(403);
    expect(await status("/api/checkin", post({ from: "lane-a", to: "master", text: "hi" }))).toBe(200);
    expect(await status("/api/checkin", post({ from: "lane-b", to: "master", text: "hi" }))).toBe(403);
    expect(await status("/api/agent/beat", post({ session: "session-a" }))).toBe(200);
    expect(await status("/api/agent/beat", post({ session: "session-b" }))).toBe(403);
    // The git broker is no lane's route: refused for another lane's target, and for its own.
    expect(await status("/api/git/exec", post({ args: ["add", "-A"], cwd: "C:/work", target: "lane-b" }))).toBe(403);
    expect(await status("/api/git/exec", post({ args: ["status"], cwd: "C:/work", target: "lane-a" }))).toBe(403);
    expect(await status("/api/kg/recall?target=lane-b", post({ query: "x" }))).toBe(403); // a query target always names the lane
  });

  test("a malformed key from a record gives the lane no channel at all; knows() names the registered key only", async () => {
    const channels = new LaneChannels();
    channels.register("lane-a", "not-a-key");
    channels.register("lane-b", undefined);
    const key = mintChannelKey();
    expect(channels.knows("lane-a", key)).toBe(false);
    const req = await capture(key, `${BASE}/api/interject/pending?target=lane-a`);
    expect(await channels.authenticate(req, new URL(req.url))).toBeNull();
    channels.register("lane-c", key);
    expect(channels.knows("lane-c", key)).toBe(true);
    expect(channels.knows("lane-c", mintChannelKey())).toBe(false);
    channels.forget("lane-c");
    expect(channels.knows("lane-c", key)).toBe(false);
  });

  test("only a reply to an authenticated channel request is signed; the UI's replies pass through untouched", async () => {
    const channels = new LaneChannels();
    channels.register("lane-a", mintChannelKey());
    engineAt(channels, ok);
    const res = await fetch(`${BASE}/api/interject/pending?target=lane-a`, { headers: { "x-lucid-token": UI, [CHANNEL_NONCE_HEADER]: "1".repeat(32) } });
    expect(res.status).toBe(200);
    expect(res.headers.get(CHANNEL_PROOF_HEADER)).toBeNull();
  });
});

describe("the lane side", () => {
  test("a lane with no channel key fetches exactly as before", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => { urls.push(String(input)); return new Response("{}"); }) as typeof globalThis.fetch;
    await engineFetch(`${BASE}/api/interject/pending?t=tok`, {}, {});
    expect(urls).toEqual([`${BASE}/api/interject/pending?t=tok`]);
  });

  test("an engine that reattached the lane from its record answers it, and the reply verifies", async () => {
    const key = mintChannelKey();
    const later = new LaneChannels(); // a new engine: a new agent token, the lane's key from the record
    later.register("lane-a", key);
    const seen = engineAt(later, () => Response.json({ ok: true, data: { notes: ["stop"] } }));
    const res = await engineFetch(`${BASE}/api/interject/pending?t=dead-engine-token&target=lane-a`, {}, { [CHANNEL_ENV]: key });
    expect(await res.json()).toEqual({ ok: true, data: { notes: ["stop"] } });
    expect(seen[0]!.url).not.toContain("dead-engine-token");
    expect(seen[0]!.url).not.toContain(key);
  });

  test("a held lane's non-channel tool call still works after a reattach (new engine, same channel key)", async () => {
    const key = mintChannelKey();
    const later = new LaneChannels();
    later.register("lane-a", key);
    const wrapped = "UNTRUSTED_CONTENT_START\n[1] (compiled:page:onboarding) Onboarding\nStep one...\nUNTRUSTED_CONTENT_END";
    const seen = engineAt(later, () => Response.json({ data: { items: [{}], wrapped } }));
    process.env[CHANNEL_ENV] = key;
    process.env.LUCID_KB_RETRIEVE_URL = `${BASE}/api/kb/retrieve?t=dead-engine-token`; // the URL the dead engine handed over
    const tools: { name: string; execute: (...args: unknown[]) => Promise<unknown> }[] = [];
    const id = (x: unknown): unknown => x;
    knowledgeExtension({ typebox: { Type: { Object: id, String: id, Optional: id, Number: id, Array: id } }, registerTool: (t: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => { tools.push(t); } });
    const search = tools.find((t) => t.name === "knowledge_search");
    if (!search) throw new Error("knowledge_search did not register");
    const out = JSON.stringify(await search.execute("call-1", { query: "onboarding" }));
    expect(out).toContain("Onboarding");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).not.toContain("dead-engine-token");
  });

  test("a squatter on the port cannot answer: no proof, a proof for another request, or another body all throw", async () => {
    const key = mintChannelKey();
    const env = { [CHANNEL_ENV]: key };
    const url = `${BASE}/api/interject/pending?t=x&target=lane-a`;
    globalThis.fetch = (async () => Response.json({ ok: true, data: { notes: ["forged"] } })) as typeof globalThis.fetch;
    await expect(engineFetch(url, {}, env)).rejects.toBeInstanceOf(ChannelProofError);
    // A relay: the real engine's proof for the squatter's copy of this request, on a body of the squatter's choosing.
    const real = new LaneChannels();
    real.register("lane-a", key);
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const req = requestOf(input, init);
      const ch = await real.authenticate(req, new URL(req.url));
      if (!ch) throw new Error("the relayed request did not authenticate");
      const signed = await answerChannel(ch, Response.json({ ok: true, data: { notes: [] } }));
      return Response.json({ ok: true, data: { notes: ["forged"] } }, { headers: signed.headers });
    }) as typeof globalThis.fetch;
    await expect(engineFetch(url, {}, env)).rejects.toBeInstanceOf(ChannelProofError);
    // A swap: a reply the real engine signed for an earlier request, handed back (same body, same status, same
    // proof) as the answer to a later one; and the same reply with its status changed.
    const kept: Response[] = [];
    engineAt(real, () => Response.json({ ok: true, data: { notes: ["stop"] } }));
    const wrapFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const res = await wrapFetch(input, init);
      kept.push(res.clone());
      return res;
    }) as typeof globalThis.fetch;
    expect((await engineFetch(url, {}, env)).status).toBe(200);
    const earlier = kept[0]!;
    globalThis.fetch = (async () => earlier.clone()) as typeof globalThis.fetch;
    await expect(engineFetch(url, {}, env)).rejects.toBeInstanceOf(ChannelProofError);
    globalThis.fetch = (async () => new Response(await earlier.clone().arrayBuffer(), { status: 403, headers: earlier.headers })) as typeof globalThis.fetch;
    await expect(engineFetch(url, {}, env)).rejects.toBeInstanceOf(ChannelProofError);
    // An engine that never held this lane (it does not know the key) refuses, and its refusal does not verify either.
    engineAt(new LaneChannels(), ok);
    await expect(engineFetch(url, {}, env)).rejects.toBeInstanceOf(ChannelProofError);
  });
});
