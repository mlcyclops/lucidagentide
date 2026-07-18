// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/market_auth.test.ts — P-KGMARKET.4 part 2 (ADR-0206): the sign-in token store. Pins the
// deep-link parser, the signed-in/out/expired state, token expiry (fail-closed), persistence, and the dev
// stub sign-in. Storage + clock are injected so it is deterministic.

import { describe, expect, test } from "bun:test";
import { MarketAuth, parseAuthCallback, type AuthStorage } from "./market_auth.ts";

const NOW = 1_700_000_000_000; // fixed epoch ms
const mem = (): AuthStorage => { let v: string | null = null; return { get: () => v, set: (x) => { v = x; }, remove: () => { v = null; } }; };

describe("parseAuthCallback", () => {
  test("parses a valid lucid://auth deep link (token + email + exp)", () => {
    const r = parseAuthCallback("lucid://auth?token=abc.def&email=buyer%40x.com&exp=1700000900", NOW);
    expect(r).toEqual({ idToken: "abc.def", email: "buyer@x.com", expiresAt: 1700000900_000 });
  });
  test("defaults expiry to +1h when exp is absent", () => {
    expect(parseAuthCallback("lucid://auth?token=t", NOW)!.expiresAt).toBe(NOW + 3600_000);
  });
  test("captures the optional refresh token (P-REMOTE.2b)", () => {
    expect(parseAuthCallback("lucid://auth?token=t&refresh=r3fr3sh", NOW)!.refreshToken).toBe("r3fr3sh");
    expect(parseAuthCallback("lucid://auth?token=t", NOW)!.refreshToken).toBeUndefined();
  });
  test("rejects wrong scheme / wrong action / missing token", () => {
    expect(parseAuthCallback("https://auth?token=t", NOW)).toBeNull();
    expect(parseAuthCallback("lucid://open?token=t", NOW)).toBeNull();
    expect(parseAuthCallback("lucid://auth?email=x", NOW)).toBeNull();
    expect(parseAuthCallback("not a url", NOW)).toBeNull();
  });
});

describe("MarketAuth", () => {
  test("signed out by default; applyCallback signs in", async () => {
    const a = new MarketAuth(mem(), () => NOW);
    expect(a.getUser()).toEqual({ signedIn: false });
    expect(a.applyCallback("lucid://auth?token=tok&email=b%40x.com&exp=1700000900")).toBe(true);
    expect(a.getUser()).toEqual({ signedIn: true, email: "b@x.com" });
    expect(await a.getIdToken()).toBe("tok");
  });

  test("an invalid callback does not sign the user in", () => {
    const a = new MarketAuth(mem(), () => NOW);
    expect(a.applyCallback("lucid://nope")).toBe(false);
    expect(a.getUser().signedIn).toBe(false);
  });

  test("an expired token reads as signed out with no id token (fail-closed)", async () => {
    let clock = NOW;
    const a = new MarketAuth(mem(), () => clock);
    a.applyCallback("lucid://auth?token=tok&exp=1700000900"); // expires at 1700000900_000
    expect(a.getUser().signedIn).toBe(true);
    clock = 1700000900_000; // exactly at expiry → lapsed
    expect(a.getUser()).toEqual({ signedIn: false });
    expect(await a.getIdToken()).toBeNull();
  });

  test("token persists across instances (same storage)", async () => {
    const store = mem();
    new MarketAuth(store, () => NOW).applyCallback("lucid://auth?token=persisted&exp=1700000900");
    const b = new MarketAuth(store, () => NOW); // fresh instance, same storage
    expect(b.getUser().signedIn).toBe(true);
    expect(await b.getIdToken()).toBe("persisted");
  });

  test("signOut clears; signInStub mints a local dev token", async () => {
    const a = new MarketAuth(mem(), () => NOW);
    a.signInStub("dev@x.com", 3600);
    expect(a.getUser()).toEqual({ signedIn: true, email: "dev@x.com" });
    expect(await a.getIdToken()).toContain("stub-token");
    a.signOut();
    expect(a.getUser().signedIn).toBe(false);
    expect(await a.getIdToken()).toBeNull();
  });
});

describe("MarketAuth.freshIdToken (P-REMOTE.2b refresh custody)", () => {
  const okFetch = (body: unknown, calls: { n: number }): typeof fetch =>
    (async () => { calls.n++; return new Response(JSON.stringify(body), { status: 200 }); }) as unknown as typeof fetch;

  test("returns the stored token WITHOUT a network call while comfortably valid", async () => {
    const a = new MarketAuth(mem(), () => NOW);
    a.applyCallback("lucid://auth?token=live&refresh=r&exp=1700003600"); // +1h, well beyond the 60s skew
    const calls = { n: 0 };
    expect(await a.freshIdToken({ apiKey: "k", fetchImpl: okFetch({}, calls) })).toBe("live");
    expect(calls.n).toBe(0);
  });

  test("exchanges the refresh token near expiry, returns + persists the new token", async () => {
    const store = mem();
    const a = new MarketAuth(store, () => NOW);
    a.applyCallback("lucid://auth?token=old&refresh=r0&exp=1700000030"); // expires in 30s < 60s skew
    const calls = { n: 0 };
    const fresh = await a.freshIdToken({ apiKey: "webkey", fetchImpl: okFetch({ id_token: "new", refresh_token: "r1", expires_in: "3600" }, calls) });
    expect(fresh).toBe("new");
    expect(calls.n).toBe(1);
    // persisted: a fresh instance now serves the renewed token + rolled refresh token
    const b = new MarketAuth(store, () => NOW);
    expect(await b.getIdToken()).toBe("new");
    expect(await b.freshIdToken({ apiKey: "webkey", fetchImpl: okFetch({ id_token: "newer" }, { n: 0 }) })).toBe("new"); // still valid → no exchange
  });

  test("fail-closed: no refresh token, non-2xx, a throw, and signed-out all yield null", async () => {
    const a = new MarketAuth(mem(), () => NOW);
    a.applyCallback("lucid://auth?token=old&exp=1700000030"); // near expiry, NO refresh token
    expect(await a.freshIdToken({ apiKey: "k", fetchImpl: okFetch({ id_token: "x" }, { n: 0 }) })).toBeNull();

    const b = new MarketAuth(mem(), () => NOW);
    b.applyCallback("lucid://auth?token=old&refresh=r&exp=1700000030");
    const bad = (async () => new Response("nope", { status: 400 })) as unknown as typeof fetch;
    expect(await b.freshIdToken({ apiKey: "k", fetchImpl: bad })).toBeNull();
    const boom = (async () => { throw new Error("network"); }) as unknown as typeof fetch;
    expect(await b.freshIdToken({ apiKey: "k", fetchImpl: boom })).toBeNull();

    const c = new MarketAuth(mem(), () => NOW); // signed out
    expect(await c.freshIdToken({ apiKey: "k" })).toBeNull();
  });
});

describe("drive.file token (P-REMOTE.10b)", () => {
  const okFetch = (body: unknown): typeof fetch =>
    (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
  const expSec = (deltaSec: number) => Math.floor(NOW / 1000) + deltaSec;

  test("parseAuthCallback reads drive_token + drive_exp", () => {
    const rec = parseAuthCallback(`lucid://auth?token=t&drive_token=ya29.x&drive_exp=${expSec(3600)}`, NOW)!;
    expect(rec.driveToken).toBe("ya29.x");
    expect(rec.driveExpiresAt).toBe(expSec(3600) * 1000);
  });

  test("drive_exp defaults +1h when the drive token has no exp; no drive token -> undefined", () => {
    expect(parseAuthCallback("lucid://auth?token=t&drive_token=ya29.x", NOW)!.driveExpiresAt).toBe(NOW + 3600_000);
    expect(parseAuthCallback("lucid://auth?token=t", NOW)!.driveToken).toBeUndefined();
  });

  test("freshDriveToken returns the token while valid, null once expired or absent", () => {
    const live = new MarketAuth(mem(), () => NOW);
    live.applyCallback(`lucid://auth?token=t&drive_token=ya29.x&drive_exp=${expSec(3600)}`);
    expect(live.freshDriveToken()).toBe("ya29.x");

    const dead = new MarketAuth(mem(), () => NOW);
    dead.applyCallback(`lucid://auth?token=t&drive_token=ya29.x&drive_exp=${expSec(-10)}`); // already expired
    expect(dead.freshDriveToken()).toBeNull();

    const none = new MarketAuth(mem(), () => NOW);
    none.applyCallback("lucid://auth?token=t");
    expect(none.freshDriveToken()).toBeNull();
  });

  test("the drive token is PRESERVED across an idToken refresh", async () => {
    const a = new MarketAuth(mem(), () => NOW);
    a.applyCallback(`lucid://auth?token=old&exp=${expSec(30)}&refresh=r0&drive_token=ya29.x&drive_exp=${expSec(3600)}`); // idToken near expiry, drive token fresh
    expect(await a.freshIdToken({ apiKey: "k", fetchImpl: okFetch({ id_token: "new", refresh_token: "r1", expires_in: "3600" }) })).toBe("new");
    expect(a.freshDriveToken()).toBe("ya29.x"); // survived the refresh re-save
  });
});
