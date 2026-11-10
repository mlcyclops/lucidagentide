// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/lane_channel.test.ts - LH-03 (ADR-0544): a held lane's channel back to the engine. The engine accepts a
// lane's channel credential on the agent routes only, for that lane only, on any engine that registered the lane's
// key (the one that launched it, or a later one that reattached it from the record), and signs the replies; the
// lane's side trusts a reply only with that proof.

import { afterEach, describe, expect, test } from "bun:test";
import { apiAuthorized } from "./origin_guard.ts";
import { LaneChannels } from "./lane_channel.ts";
import { CHANNEL_ENV, CHANNEL_NONCE_HEADER, CHANNEL_PROOF_HEADER, ChannelProofError, channelCredential, engineFetch, mintChannelKey } from "../harness/omp/engine_channel.ts";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const AGENT_ROUTES = new Set(["/api/interject/pending", "/api/checkout/gate"]);
const auth = (path: string, channelAuthorized: boolean) => apiAuthorized({
  path, headerToken: null, queryToken: null, uiToken: "u".repeat(64), agentToken: "a".repeat(64),
  queryRoutes: AGENT_ROUTES, agentRoutes: AGENT_ROUTES, channelAuthorized,
});

/** Route the lane's fetch to `channels` as the engine would answer it, recording what reached the "engine". */
function engineAt(channels: LaneChannels, body: unknown): Request[] {
  const seen: Request[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url, init);
    seen.push(req);
    const lane = channels.laneOf(new URL(req.url), null);
    const res = lane ? new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }) : new Response("forbidden", { status: 403 });
    return channels.answer(req, res);
  }) as typeof globalThis.fetch;
  return seen;
}

describe("the engine side", () => {
  test("a channel credential opens the agent routes and nothing else", () => {
    expect(auth("/api/interject/pending", true)).toBe(true);
    expect(auth("/api/security/approve", true)).toBe(false);
    expect(auth("/api/interject/pending", false)).toBe(false);
  });

  test("a credential names one lane, and speaks only for that lane's target", () => {
    const channels = new LaneChannels();
    const a = mintChannelKey();
    const b = mintChannelKey();
    channels.register("lane-a", a);
    channels.register("lane-b", b);
    const url = (key: string, target?: string) => new URL(`http://127.0.0.1:5319/api/interject/pending?t=${channelCredential(key)}${target ? `&target=${target}` : ""}`);
    expect(channels.laneOf(url(a, "lane-a"), null)?.laneId).toBe("lane-a");
    expect(channels.laneOf(url(a), null)?.laneId).toBe("lane-a");
    expect(channels.laneOf(url(a, "lane-b"), null)).toBeNull(); // lane a cannot drain lane b's notes
    expect(channels.laneOf(new URL(`http://127.0.0.1:5319/x?t=${a}`), null)).toBeNull(); // the key itself is not the credential
    channels.forget("lane-a");
    expect(channels.laneOf(url(a, "lane-a"), null)).toBeNull();
  });

  test("a malformed key from a record gives the lane no channel at all", () => {
    const channels = new LaneChannels();
    channels.register("lane-a", "not-a-key");
    channels.register("lane-b", undefined);
    expect(channels.laneFor(channelCredential("0".repeat(64)))).toBeNull();
  });

  test("only a reply to a channel request is signed; the UI's replies pass through untouched", async () => {
    const channels = new LaneChannels();
    channels.register("lane-a", mintChannelKey());
    const res = await channels.answer(new Request("http://127.0.0.1:5319/api/usage", { headers: { [CHANNEL_NONCE_HEADER]: "1".repeat(32) } }), new Response("{}"));
    expect(res.headers.get(CHANNEL_PROOF_HEADER)).toBeNull();
  });
});

describe("the lane side", () => {
  test("a lane with no channel key fetches exactly as before", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => { urls.push(String(input)); return new Response("{}"); }) as typeof globalThis.fetch;
    await engineFetch("http://127.0.0.1:5319/api/interject/pending?t=tok", {}, {});
    expect(urls).toEqual(["http://127.0.0.1:5319/api/interject/pending?t=tok"]);
  });

  test("an engine that reattached the lane from its record answers it, and the reply verifies", async () => {
    const key = mintChannelKey();
    const later = new LaneChannels(); // a new engine: a new agent token, the lane's key from the record
    later.register("lane-a", key);
    const seen = engineAt(later, { ok: true, data: { notes: ["stop"] } });
    const res = await engineFetch("http://127.0.0.1:5319/api/interject/pending?t=dead-engine-token&target=lane-a", {}, { [CHANNEL_ENV]: key });
    expect(await res.json()).toEqual({ ok: true, data: { notes: ["stop"] } });
    expect(seen[0]!.url).not.toContain("dead-engine-token");
    expect(seen[0]!.url).not.toContain(key);
  });

  test("a squatter on the port cannot answer: no proof, a proof for another nonce, or another body all throw", async () => {
    const key = mintChannelKey();
    const env = { [CHANNEL_ENV]: key };
    const url = "http://127.0.0.1:5319/api/interject/pending?t=x&target=lane-a";
    globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true, data: { notes: ["forged"] } }))) as typeof globalThis.fetch;
    await expect(engineFetch(url, {}, env)).rejects.toBeInstanceOf(ChannelProofError);
    // A relay: the real engine's proof (for the squatter's own nonce) on a body of its choosing.
    const real = new LaneChannels();
    real.register("lane-a", key);
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const req = new Request(String(input), init);
      const signed = await real.answer(req, new Response(JSON.stringify({ ok: true, data: { notes: [] } })));
      return new Response(JSON.stringify({ ok: true, data: { notes: ["forged"] } }), { headers: signed.headers });
    }) as typeof globalThis.fetch;
    await expect(engineFetch(url, {}, env)).rejects.toBeInstanceOf(ChannelProofError);
    // An engine that never held this lane (it does not know the key) refuses, and its refusal does not verify either.
    engineAt(new LaneChannels(), {});
    await expect(engineFetch(url, {}, env)).rejects.toBeInstanceOf(ChannelProofError);
  });
});
