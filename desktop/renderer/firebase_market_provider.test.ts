// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/firebase_market_provider.test.ts — P-KGMARKET.3 (ADR-0206). Pins the provider's contract
// with a mocked fetch + injected auth: it calls the right callable with the ID token; a signed-out user (no
// token) short-circuits to null WITHOUT a network call; a callable error resolves to null (the decision core
// re-checks fail-closed); and registerFirebaseMarketProvider only registers when configured.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeFirebaseMarketProvider, registerFirebaseMarketProvider } from "./firebase_market_provider.ts";
import { getMarketProvider, nullProvider, registerMarketProvider } from "./market_gate.ts";
import type { AuthState } from "../../harness/market/entitlement.ts";

const BASE = "https://us-central1-lucid-agent.cloudfunctions.net";
type Call = { url: string; auth: string | null; body: unknown };
let calls: Call[] = [];
let reply: (name: string) => { ok: boolean; body: unknown } = () => ({ ok: true, body: { result: null } });
const realFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const name = String(url).split("/").pop()!;
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({ url: String(url), auth: headers.authorization ?? null, body: JSON.parse(String(init.body)) });
    const r = reply(name);
    return { ok: r.ok, status: r.ok ? 200 : 400, json: async () => r.body } as Response;
  }) as unknown as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; registerMarketProvider(null); });

const signedIn = (over: Partial<{ user: AuthState; token: string | null }> = {}) => makeFirebaseMarketProvider({
  functionsBaseUrl: BASE,
  auth: { getUser: () => over.user ?? { signedIn: true, email: "buyer@example.com" }, getIdToken: async () => (over.token === undefined ? "id-tok-123" : over.token) },
});

describe("makeFirebaseMarketProvider", () => {
  test("configured; auth() reflects the injected user", async () => {
    const p = signedIn();
    expect(p.configured()).toBe(true);
    expect(await p.auth()).toEqual({ signedIn: true, email: "buyer@example.com" });
  });

  test("entitlement() calls getEntitlement with the bearer token + packId", async () => {
    reply = () => ({ ok: true, body: { result: { packId: "p1", state: "active", method: "card" } } });
    const ent = await signedIn().entitlement("p1");
    expect(ent).toEqual({ packId: "p1", state: "active", method: "card" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BASE}/getEntitlement`);
    expect(calls[0]!.auth).toBe("Bearer id-tok-123");
    expect(calls[0]!.body).toEqual({ data: { packId: "p1" } });
  });

  test("checkoutUrl() and downloadUrl() return the callable's url", async () => {
    reply = (n) => ({ ok: true, body: { result: { url: `https://x/${n}` } } });
    const p = signedIn();
    expect(await p.checkoutUrl("p1", "one-time")).toBe("https://x/createCheckout");
    expect(await p.downloadUrl("p1")).toBe("https://x/getPackDownload");
  });

  test("a signed-out user (no token) short-circuits to null with NO network call", async () => {
    const p = signedIn({ user: { signedIn: false }, token: null });
    expect(await p.entitlement("p1")).toBeNull();
    expect(await p.checkoutUrl("p1", "one-time")).toBeNull();
    expect(await p.downloadUrl("p1")).toBeNull();
    expect(calls).toHaveLength(0);
  });

  test("a callable error resolves to null (fail-safe; the decision core re-checks fail-closed)", async () => {
    reply = () => ({ ok: false, body: { error: { message: "permission-denied" } } });
    const p = signedIn();
    expect(await p.entitlement("p1")).toBeNull();
    expect(await p.downloadUrl("p1")).toBeNull();
  });
});

describe("registerFirebaseMarketProvider", () => {
  test("registers when configured; is a no-op (stays fail-closed) otherwise", () => {
    expect(getMarketProvider()).toBe(nullProvider);
    expect(registerFirebaseMarketProvider(null)).toBe(false);
    expect(registerFirebaseMarketProvider({ functionsBaseUrl: "", auth: { getUser: () => ({ signedIn: false }), getIdToken: async () => null } })).toBe(false);
    expect(getMarketProvider()).toBe(nullProvider);

    expect(registerFirebaseMarketProvider({ functionsBaseUrl: BASE, auth: { getUser: () => ({ signedIn: false }), getIdToken: async () => null } })).toBe(true);
    expect(getMarketProvider().configured()).toBe(true);
  });
});
