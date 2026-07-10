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
