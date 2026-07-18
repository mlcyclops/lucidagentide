// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/collab/remote_entitlement.test.ts — P-REMOTE.6 (ADR-0227): the phone's unentitled→Subscribe core.

import { describe, expect, it, mock } from "bun:test";
import {
  createRemoteCheckout,
  decodeClaims,
  entitlementActive,
  hasRemoteAccess,
  isEntitlementDenied,
  REMOTE_ACCESS_ID,
  remoteGate,
} from "./remote_entitlement.ts";
import { RELAY_NOT_ENTITLED_REASON } from "./relay_client.ts";

const b64url = (s: string): string =>
  btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
/** Build a fake (unsigned) Firebase-shaped JWT with the given payload — the module never verifies, it decodes. */
const jwt = (payload: unknown): string =>
  `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify(payload))}.sig`;

describe("decodeClaims", () => {
  it("decodes a well-formed token payload", () => {
    expect(decodeClaims(jwt({ premium: true, email: "a@b.io" }))).toEqual({ premium: true, email: "a@b.io" });
  });
  it("fail-closed on null / empty / non-string", () => {
    expect(decodeClaims(null)).toBeNull();
    expect(decodeClaims(undefined)).toBeNull();
    expect(decodeClaims("")).toBeNull();
  });
  it("fail-closed on the wrong segment count", () => {
    expect(decodeClaims("only.two")).toBeNull();
    expect(decodeClaims("a.b.c.d")).toBeNull();
  });
  it("fail-closed on bad base64 / non-JSON payload", () => {
    expect(decodeClaims("head.@@@bad@@@.sig")).toBeNull();
    expect(decodeClaims(`head.${b64url("not json")}.sig`)).toBeNull();
  });
  it("fail-closed when the payload is not an object", () => {
    expect(decodeClaims(`head.${b64url("5")}.sig`)).toBeNull();
    expect(decodeClaims(`head.${b64url("null")}.sig`)).toBeNull();
  });
});

describe("hasRemoteAccess (mirrors the relay's admin-implies-premium rule)", () => {
  it("admits strict-true premium or admin", () => {
    expect(hasRemoteAccess({ premium: true })).toBe(true);
    expect(hasRemoteAccess({ admin: true })).toBe(true);
    expect(hasRemoteAccess({ admin: true, premium: false })).toBe(true);
  });
  it("refuses no claim, truthy-but-not-true, and null", () => {
    expect(hasRemoteAccess({})).toBe(false);
    expect(hasRemoteAccess({ premium: "true" })).toBe(false);
    expect(hasRemoteAccess({ admin: 1 })).toBe(false);
    expect(hasRemoteAccess(null)).toBe(false);
    expect(hasRemoteAccess(undefined)).toBe(false);
  });
});

describe("entitlementActive (post-checkout token check)", () => {
  it("true only once the refreshed token carries the claim", () => {
    expect(entitlementActive(jwt({ premium: true }))).toBe(true);
    expect(entitlementActive(jwt({ admin: true }))).toBe(true);
  });
  it("false before the claim lands or on a malformed token", () => {
    expect(entitlementActive(jwt({}))).toBe(false);
    expect(entitlementActive(jwt({ premium: "true" }))).toBe(false);
    expect(entitlementActive("garbage")).toBe(false);
    expect(entitlementActive(null)).toBe(false);
  });
});

describe("isEntitlementDenied (the authoritative 4403 signal)", () => {
  it("true only for an ENDED view with the exact 4403 note", () => {
    expect(isEntitlementDenied({ phase: "ended", note: RELAY_NOT_ENTITLED_REASON })).toBe(true);
  });
  it("false for other close reasons, a live view, or a null note", () => {
    expect(isEntitlementDenied({ phase: "ended", note: "room closed" })).toBe(false);
    expect(isEntitlementDenied({ phase: "ended", note: "relay refused authentication (sign in again)" })).toBe(false);
    expect(isEntitlementDenied({ phase: "live", note: RELAY_NOT_ENTITLED_REASON })).toBe(false);
    expect(isEntitlementDenied({ phase: "ended", note: null })).toBe(false);
  });
});

describe("remoteGate", () => {
  it("signin when not signed in (regardless of denial)", () => {
    expect(remoteGate(false, false)).toBe("signin");
    expect(remoteGate(false, true)).toBe("signin");
  });
  it("subscribe when signed in and the relay refused for no entitlement", () => {
    expect(remoteGate(true, true)).toBe("subscribe");
  });
  it("connect when signed in and not (yet) denied — claim-holders AND allowlisted self-hosters both try", () => {
    expect(remoteGate(true, false)).toBe("connect");
  });
});

describe("createRemoteCheckout", () => {
  const OK_URL = "https://checkout.stripe.com/c/pay/cs_test_123";
  const okFetch = (url: string): Promise<Response> => {
    void url;
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ result: { url: OK_URL } }) } as Response);
  };

  it("returns the checkout URL and calls the callable with the token + packId", async () => {
    const spy = mock(okFetch);
    const url = await createRemoteCheckout({ functionsBaseUrl: "https://fns.example.com", token: "tok", fetchImpl: spy });
    expect(url).toBe(OK_URL);
    expect(spy).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe("https://fns.example.com/createCheckout");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(JSON.parse(String(init.body))).toEqual({ data: { packId: REMOTE_ACCESS_ID } });
  });

  it("trims a trailing slash on the base URL", async () => {
    const spy = mock(okFetch);
    await createRemoteCheckout({ functionsBaseUrl: "https://fns.example.com/", token: "tok", fetchImpl: spy });
    expect((spy.mock.calls[0] as [string, RequestInit])[0]).toBe("https://fns.example.com/createCheckout");
  });

  it("fail-closed on an { error } reply", async () => {
    const f = mock((): Promise<Response> => Promise.resolve({ ok: true, status: 200, json: async () => ({ error: { message: "nope" } }) } as Response));
    expect(await createRemoteCheckout({ functionsBaseUrl: "https://fns.example.com", token: "tok", fetchImpl: f })).toBeNull();
  });

  it("fail-closed on a non-2xx status", async () => {
    const f = mock((): Promise<Response> => Promise.resolve({ ok: false, status: 500, json: async () => ({ result: { url: OK_URL } }) } as Response));
    expect(await createRemoteCheckout({ functionsBaseUrl: "https://fns.example.com", token: "tok", fetchImpl: f })).toBeNull();
  });

  it("fail-closed on a missing/blank url", async () => {
    const f = mock((): Promise<Response> => Promise.resolve({ ok: true, status: 200, json: async () => ({ result: {} }) } as Response));
    expect(await createRemoteCheckout({ functionsBaseUrl: "https://fns.example.com", token: "tok", fetchImpl: f })).toBeNull();
  });

  it("fail-closed with NO network call when there is no token or no base URL", async () => {
    const f = mock(okFetch);
    expect(await createRemoteCheckout({ functionsBaseUrl: "https://fns.example.com", token: null, fetchImpl: f })).toBeNull();
    expect(await createRemoteCheckout({ functionsBaseUrl: "", token: "tok", fetchImpl: f })).toBeNull();
    expect(f).toHaveBeenCalledTimes(0);
  });

  it("fail-closed when fetch throws", async () => {
    const f = mock((): Promise<Response> => Promise.reject(new Error("network down")));
    expect(await createRemoteCheckout({ functionsBaseUrl: "https://fns.example.com", token: "tok", fetchImpl: f })).toBeNull();
  });
});
