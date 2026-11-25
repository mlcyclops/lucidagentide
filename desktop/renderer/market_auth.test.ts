// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/market_auth.test.ts - P-KGMARKET.4 part 2 (ADR-0206), P-MARKET.AUTH2 (ADR-0684): the store
// sign-in. Pins the deep-link parser, the signed-in/out state, silent renewal through the custody (an expired ID
// token with a refresh token never reads as signed out; offline keeps the user signed in; only a refused refresh
// token signs out), the one-time move of a legacy localStorage record into the custody, and the dev stub.
// Custody, fetch and clock are injected so it is deterministic.

import { describe, expect, test } from "bun:test";
import { renewRecord, type AuthView, type RenewReply, type TokenRecord } from "../market_token.ts";
import {
  engineCustody, MarketAuth, memoryAuthStorage, parseAuthCallback, RETRY_MS, storageCustody, type AuthCustody, type AuthStorage,
} from "./market_auth.ts";

const NOW = 1_700_000_000_000; // fixed epoch ms
const expSec = (deltaSec: number): number => Math.floor(NOW / 1000) + deltaSec;
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });
/** A securetoken stand-in: counts calls and answers with `reply` (a Response, or a thrown error for offline). */
function securetoken(reply: () => Response): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL | Request) => { calls.push(String(url)); return reply(); }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}
const offline = (): Response => { throw new TypeError("fetch failed"); };
const renewed = (): Response => json({ id_token: "renewed-id", refresh_token: "r1", expires_in: "3600" });
const refused = (code: string) => (): Response => json({ error: { code: 400, message: code, status: "INVALID_ARGUMENT" } }, 400);
const held = (slot: AuthStorage): TokenRecord | null => { const raw = slot.get(); return raw ? JSON.parse(raw) as TokenRecord : null; };

/** An auth over a slot custody whose clock and fetch the test drives. */
function setup(reply: () => Response = renewed, slot = memoryAuthStorage()) {
  let clock = NOW;
  const st = securetoken(reply);
  const auth = new MarketAuth(storageCustody(slot, { fetchImpl: st.fetchImpl, now: () => clock }), () => clock, { apiKey: "public-web-key" });
  return { auth, slot, calls: st.calls, tick: (ms: number) => { clock += ms; } };
}

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
  test("signed out by default; applyCallback signs in and hands the record to the custody", async () => {
    const { auth, slot } = setup();
    expect(auth.getUser()).toEqual({ signedIn: false });
    expect(auth.applyCallback("lucid://auth?token=tok&email=b%40x.com&exp=1700003600&refresh=r0")).toBe(true);
    expect(auth.getUser()).toEqual({ signedIn: true, email: "b@x.com" });
    expect(await auth.getIdToken()).toBe("tok");
    await auth.settled();
    expect(held(slot)?.refreshToken).toBe("r0");
  });

  test("an invalid callback does not sign the user in", () => {
    const { auth } = setup();
    expect(auth.applyCallback("lucid://nope")).toBe(false);
    expect(auth.getUser().signedIn).toBe(false);
  });

  test("an expired token WITHOUT a refresh token reads as signed out with no id token (fail-closed)", async () => {
    const { auth, tick, calls } = setup();
    auth.applyCallback(`lucid://auth?token=tok&exp=${expSec(900)}`);
    expect(auth.getUser().signedIn).toBe(true);
    tick(900_000); // exactly at expiry: lapsed
    expect(auth.getUser()).toEqual({ signedIn: false });
    expect(await auth.getIdToken()).toBeNull();
    expect(calls).toHaveLength(0);
  });

  test("the record survives a new instance over the same custody (a restart)", async () => {
    const slot = memoryAuthStorage();
    const a = setup(renewed, slot).auth;
    a.applyCallback(`lucid://auth?token=persisted&exp=${expSec(3600)}&refresh=r0`);
    await a.settled();
    const b = setup(renewed, slot).auth;
    await b.ready();
    expect(b.getUser().signedIn).toBe(true);
    expect(await b.getIdToken()).toBe("persisted");
  });

  test("signOut clears the custody; signInStub mints a local dev token", async () => {
    const { auth, slot } = setup();
    auth.signInStub("dev@x.com", 3600);
    expect(auth.getUser()).toEqual({ signedIn: true, email: "dev@x.com" });
    expect(await auth.getIdToken()).toContain("stub-token");
    auth.signOut();
    expect(auth.getUser().signedIn).toBe(false);
    expect(await auth.getIdToken()).toBeNull();
    await auth.settled();
    expect(slot.get()).toBeNull();
  });
});

describe("silent renewal (ADR-0684)", () => {
  test("a live token is served WITHOUT a network call while outside the 5-minute window", async () => {
    const { auth, calls } = setup();
    auth.applyCallback(`lucid://auth?token=live&refresh=r&exp=${expSec(3600)}`);
    expect(await auth.getIdToken()).toBe("live");
    expect(calls).toHaveLength(0);
  });

  test("an EXPIRED id token with a refresh token stays signed in and renews silently; the custody keeps the new one", async () => {
    const { auth, slot, calls, tick } = setup();
    auth.applyCallback(`lucid://auth?token=old&email=b%40x.com&refresh=r0&exp=${expSec(60)}`);
    tick(2 * 3600_000); // two hours later: the 1h ID token is long gone
    expect(auth.getUser()).toEqual({ signedIn: true, email: "b@x.com" }); // never a signed-out moment
    expect(await auth.getIdToken()).toBe("renewed-id");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toStartWith("https://securetoken.googleapis.com/v1/token?key=public-web-key");
    expect(held(slot)).toMatchObject({ idToken: "renewed-id", refreshToken: "r1", email: "b@x.com" });
    expect(auth.currentExpiresAt()).toBe(NOW + 2 * 3600_000 + 3600_000);
  });

  test("renews inside the last 5 minutes, and concurrent callers share ONE exchange", async () => {
    const { auth, calls } = setup();
    auth.applyCallback(`lucid://auth?token=old&refresh=r0&exp=${expSec(240)}`); // 4 min left
    const all = await Promise.all([auth.getIdToken(), auth.getIdToken(), auth.getIdToken(), auth.keepFresh()]);
    expect(all.slice(0, 3)).toEqual(["renewed-id", "renewed-id", "renewed-id"]);
    expect(calls).toHaveLength(1);
  });

  test("OFFLINE: the user stays signed in, the call gets null, and the custody is asked again only after RETRY_MS", async () => {
    let reply: () => Response = offline;
    const { auth, slot, calls, tick } = setup(() => reply());
    auth.applyCallback(`lucid://auth?token=old&email=b%40x.com&refresh=r0&exp=${expSec(60)}`);
    tick(3600_000);
    expect(await auth.getIdToken()).toBeNull();
    expect(auth.getUser()).toEqual({ signedIn: true, email: "b@x.com" });
    expect(held(slot)?.refreshToken).toBe("r0"); // kept
    expect(await auth.getIdToken()).toBeNull();
    expect(calls).toHaveLength(1); // backing off
    reply = renewed; // back online
    tick(RETRY_MS);
    expect(await auth.getIdToken()).toBe("renewed-id");
    expect(calls).toHaveLength(2);
  });

  test("a 5xx or a key problem is not a sign-out either", async () => {
    for (const reply of [() => json({}, 503), refused("API_KEY_INVALID"), () => new Response("not json", { status: 200 })]) {
      const { auth, tick } = setup(reply);
      auth.applyCallback(`lucid://auth?token=old&refresh=r0&exp=${expSec(60)}`);
      tick(3600_000);
      expect(await auth.getIdToken()).toBeNull();
      expect(auth.getUser().signedIn).toBe(true);
    }
  });

  test("INVALID_REFRESH_TOKEN / TOKEN_EXPIRED / USER_DISABLED sign the user out and clear the custody", async () => {
    for (const code of ["INVALID_REFRESH_TOKEN", "TOKEN_EXPIRED", "USER_DISABLED"]) {
      const { auth, slot, tick } = setup(refused(code));
      auth.applyCallback(`lucid://auth?token=old&refresh=revoked&exp=${expSec(60)}`);
      tick(3600_000);
      expect(await auth.getIdToken()).toBeNull();
      expect(auth.getUser()).toEqual({ signedIn: false });
      expect(slot.get()).toBeNull();
    }
  });

  test("a sign-in that lands during a renewal is not overwritten by it", async () => {
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const custody: AuthCustody = {
      load: async () => null, put: async () => {}, clear: async () => {},
      renew: async (): Promise<RenewReply> => { entered.resolve(); await gate; return { status: "signed-out", view: null }; },
    };
    let clock = NOW;
    const auth = new MarketAuth(custody, () => clock);
    auth.applyCallback(`lucid://auth?token=old&refresh=r0&exp=${expSec(60)}`);
    clock += 3600_000;
    const pending = auth.getIdToken();
    await entered.promise; // the renewal is out at the custody
    auth.applyCallback(`lucid://auth?token=fresh&refresh=r9&exp=${expSec(2 * 3600)}`);
    release();
    await pending;
    expect(auth.getUser().signedIn).toBe(true);
    expect(await auth.getIdToken()).toBe("fresh");
  });
});

describe("the legacy localStorage record moves into the custody once (ADR-0684)", () => {
  const legacyRec = (): string => JSON.stringify({ idToken: "legacy-id", email: "b@x.com", expiresAt: NOW - 60_000, refreshToken: "legacy-r" });

  test("an empty custody takes it and the localStorage copy is deleted", async () => {
    const legacy = memoryAuthStorage();
    legacy.set(legacyRec());
    const slot = memoryAuthStorage();
    const auth = new MarketAuth(storageCustody(slot), () => NOW, { legacy });
    await auth.ready();
    expect(auth.getUser()).toEqual({ signedIn: true, email: "b@x.com" }); // expired ID token, but renewable
    expect(held(slot)?.refreshToken).toBe("legacy-r");
    expect(legacy.get()).toBeNull();
  });

  test("a custody that already holds a sign-in wins; the localStorage copy is still deleted", async () => {
    const legacy = memoryAuthStorage();
    legacy.set(legacyRec());
    const slot = memoryAuthStorage();
    slot.set(JSON.stringify({ idToken: "engine-id", email: "e@x.com", expiresAt: NOW + 3600_000, refreshToken: "engine-r" }));
    const auth = new MarketAuth(storageCustody(slot), () => NOW, { legacy });
    await auth.ready();
    expect(auth.getUser().email).toBe("e@x.com");
    expect(legacy.get()).toBeNull();
  });

  test("an unreachable custody: the legacy record serves this session and is kept for the next launch", async () => {
    const legacy = memoryAuthStorage();
    legacy.set(legacyRec());
    const down: AuthCustody = {
      load: async () => { throw new Error("engine down"); }, put: async () => { throw new Error("engine down"); },
      clear: async () => {}, renew: async () => ({ status: "unavailable", view: null }),
    };
    const auth = new MarketAuth(down, () => NOW, { legacy });
    await auth.ready();
    expect(auth.getUser().signedIn).toBe(true);
    expect(legacy.get()).not.toBeNull();
  });
});

describe("engineCustody", () => {
  const view: AuthView = { idToken: "id", email: "b@x.com", expiresAt: NOW + 3600_000, renewable: true };

  test("maps the bridge's answers; a silent engine reads as unreachable or unavailable, never as signed out", async () => {
    const put: TokenRecord[] = [];
    const up = engineCustody({
      marketAuthGet: async () => ({ view }), marketAuthPut: async (r) => { put.push(r); return true; },
      marketAuthClear: async () => true, marketAuthRenew: async () => ({ status: "ok", view }),
    });
    expect(await up.load()).toEqual(view);
    await up.put({ idToken: "x", expiresAt: NOW });
    expect(put).toHaveLength(1);
    expect(await up.renew({ apiKey: "k", skewMs: 1 })).toEqual({ status: "ok", view });

    const silent = engineCustody({
      marketAuthGet: async () => null, marketAuthPut: async () => false, marketAuthClear: async () => false, marketAuthRenew: async () => null,
    });
    await expect(silent.load()).rejects.toThrow();
    await expect(silent.put({ idToken: "x", expiresAt: NOW })).rejects.toThrow();
    expect(await silent.renew({ apiKey: "k", skewMs: 1 })).toEqual({ status: "unavailable", view: null });
  });
});

describe("renewRecord (shared with the engine custody)", () => {
  const rec: TokenRecord = { idToken: "old", expiresAt: NOW - 1, refreshToken: "r0", driveToken: "ya29.x", driveExpiresAt: NOW + 3600_000 };

  test("no API key cannot renew (unavailable), and makes no call", async () => {
    const st = securetoken(renewed);
    expect((await renewRecord(rec, { apiKey: "", fetchImpl: st.fetchImpl, now: NOW })).status).toBe("unavailable");
    expect(st.calls).toHaveLength(0);
  });

  test("USER_NOT_FOUND with a suffix is definitive; the drive token is carried over a renewal", async () => {
    expect((await renewRecord(rec, { apiKey: "k", fetchImpl: securetoken(refused("USER_NOT_FOUND : gone")).fetchImpl, now: NOW })).status).toBe("signed-out");
    const ok = await renewRecord(rec, { apiKey: "k", fetchImpl: securetoken(renewed).fetchImpl, now: NOW });
    expect(ok.status === "ok" && ok.rec.driveToken).toBe("ya29.x");
  });
});

describe("drive.file token (P-REMOTE.10b)", () => {
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
    const live = setup().auth;
    live.applyCallback(`lucid://auth?token=t&drive_token=ya29.x&drive_exp=${expSec(3600)}`);
    expect(live.freshDriveToken()).toBe("ya29.x");
    const dead = setup().auth;
    dead.applyCallback(`lucid://auth?token=t&drive_token=ya29.x&drive_exp=${expSec(-10)}`);
    expect(dead.freshDriveToken()).toBeNull();
    const none = setup().auth;
    none.applyCallback("lucid://auth?token=t");
    expect(none.freshDriveToken()).toBeNull();
  });

  test("the drive token is PRESERVED across an idToken renewal", async () => {
    const { auth } = setup();
    auth.applyCallback(`lucid://auth?token=old&exp=${expSec(30)}&refresh=r0&drive_token=ya29.x&drive_exp=${expSec(3600)}`);
    expect(await auth.getIdToken()).toBe("renewed-id");
    expect(auth.freshDriveToken()).toBe("ya29.x");
  });
});
