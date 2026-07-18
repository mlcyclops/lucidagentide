// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/collab/relay_auth.test.ts — P-REMOTE.1 (ADR-0226/0227): the Firebase ID-token verifier, OFFLINE.
//
// A fake JWKS (locally-minted RSA keypair, injected fetch) drives the whole matrix — no network, no Google.
// The load-bearing property is invariant #3: EVERY failure to obtain a valid verdict refuses (4401/4403);
// there is no code path from a broken/unreachable/hostile input to an admission.

import { describe, expect, it } from "bun:test";
import { generateKeyPairSync, sign as signRsa } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { admissionDecision, authFromEnv, createFirebaseVerifier, decodeJwt } from "./relay_auth.ts";
import type { FirebaseVerifierConfig } from "./relay_auth.ts";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const { privateKey: rogueKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KID = "test-kid";
const PROJECT = "lucid-agent";
const NOW_MS = 1_800_000_000_000;
const NOW_S = NOW_MS / 1000;

const jwk = { ...(publicKey.export({ format: "jwk" }) as Record<string, string>), kid: KID, alg: "RS256", use: "sig" };

function mint(
  overrides: Record<string, unknown> = {},
  opts: { kid?: string; alg?: string; key?: KeyObject } = {},
): string {
  const payload = {
    aud: PROJECT,
    iss: `https://securetoken.google.com/${PROJECT}`,
    sub: "uid-1",
    email: "user@gmail.com",
    email_verified: true,
    iat: NOW_S - 60,
    exp: NOW_S + 3600,
    firebase: { sign_in_provider: "google.com" },
    ...overrides,
  };
  const header = { alg: opts.alg ?? "RS256", kid: opts.kid ?? KID, typ: "JWT" };
  const signedInput = `${Buffer.from(JSON.stringify(header)).toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
  const sig = signRsa("sha256", Buffer.from(signedInput), opts.key ?? privateKey);
  return `${signedInput}.${sig.toString("base64url")}`;
}

let jwksFetches = 0;
const fakeJwksFetch = (async () =>
  new Response(JSON.stringify({ keys: [jwk] }), {
    status: 200,
    headers: { "cache-control": "public, max-age=3600" },
  })) as unknown as typeof fetch;

function verifier(extra: Partial<FirebaseVerifierConfig> = {}) {
  return createFirebaseVerifier({
    projectId: PROJECT,
    jwksUrl: "https://fake.jwks.local/keys",
    fetchImpl: (async (...args: Parameters<typeof fetch>) => {
      jwksFetches++;
      return (extra.fetchImpl ?? fakeJwksFetch)(...args);
    }) as typeof fetch,
    now: () => NOW_MS,
    ...extra,
    ...(extra.fetchImpl ? { fetchImpl: extra.fetchImpl } : {}),
  });
}

describe("relay_auth: Firebase ID-token verification (offline fake JWKS)", () => {
  it("admits a premium-claim token", async () => {
    const v = await verifier()(mint({ premium: true }));
    expect(v).toEqual({ ok: true, uid: "uid-1", email: "user@gmail.com", premium: true, admin: false });
  });

  it("admits an admin-claim token (admin implies premium — the host rides free)", async () => {
    const v = await verifier()(mint({ admin: true }));
    expect(v).toEqual({ ok: true, uid: "uid-1", email: "user@gmail.com", premium: true, admin: true });
  });

  it("admits an allowlisted email without any claim (self-host mode)", async () => {
    const v = await verifier({ allowedEmails: ["  User@GMail.com "] })(mint());
    expect(v.ok).toBe(true);
  });

  it("refuses a verified sign-in with no claim and no allowlist entry — 4403, not 4401", async () => {
    const v = await verifier()(mint());
    expect(v).toMatchObject({ ok: false, code: 4403 });
  });

  it("refuses an expired token", async () => {
    const v = await verifier()(mint({ exp: NOW_S - 3600 }));
    expect(v).toMatchObject({ ok: false, code: 4401, reason: "token expired" });
  });

  it("refuses a future-issued token", async () => {
    const v = await verifier()(mint({ iat: NOW_S + 3600 }));
    expect(v).toMatchObject({ ok: false, code: 4401 });
  });

  it("refuses a wrong audience", async () => {
    const v = await verifier()(mint({ aud: "some-other-project", premium: true }));
    expect(v).toMatchObject({ ok: false, code: 4401, reason: "aud mismatch" });
  });

  it("refuses a wrong issuer", async () => {
    const v = await verifier()(mint({ iss: "https://securetoken.google.com/evil", premium: true }));
    expect(v).toMatchObject({ ok: false, code: 4401, reason: "iss mismatch" });
  });

  it("refuses an unverified email", async () => {
    const v = await verifier()(mint({ email_verified: false, premium: true }));
    expect(v).toMatchObject({ ok: false, code: 4401 });
  });

  it("refuses a non-Google sign-in provider (the Google-OAuth-only rule, ADR-0227)", async () => {
    const v = await verifier()(mint({ firebase: { sign_in_provider: "password" }, premium: true }));
    expect(v).toMatchObject({ ok: false, code: 4401 });
  });

  it("refuses a signature from the wrong key", async () => {
    const v = await verifier()(mint({ premium: true }, { key: rogueKey }));
    expect(v).toMatchObject({ ok: false, code: 4401, reason: "bad signature" });
  });

  it("refuses a token whose payload was swapped after signing", async () => {
    const good = mint({ premium: false });
    const [h, , s] = good.split(".");
    const forged = `${h}.${Buffer.from(JSON.stringify({
      aud: PROJECT, iss: `https://securetoken.google.com/${PROJECT}`, sub: "uid-1",
      email: "user@gmail.com", email_verified: true, iat: NOW_S - 60, exp: NOW_S + 3600,
      firebase: { sign_in_provider: "google.com" }, premium: true,
    })).toString("base64url")}.${s}`;
    const v = await verifier()(forged);
    expect(v).toMatchObject({ ok: false, code: 4401, reason: "bad signature" });
  });

  it("refuses non-RS256 algorithms outright (alg-confusion)", async () => {
    const v = await verifier()(mint({ premium: true }, { alg: "HS256" }));
    expect(v).toMatchObject({ ok: false, code: 4401 });
  });

  it("refuses an unknown signing kid", async () => {
    const v = await verifier()(mint({ premium: true }, { kid: "not-in-the-set" }));
    expect(v).toMatchObject({ ok: false, code: 4401, reason: "unknown signing key" });
  });

  it("refuses garbage tokens", async () => {
    const v = await verifier()("not-a-jwt");
    expect(v).toMatchObject({ ok: false, code: 4401 });
    expect(decodeJwt("a.b")).toBeNull();
  });

  it("FAILS CLOSED when the JWKS endpoint is unreachable — never a pass (invariant #3)", async () => {
    const dead = (async () => { throw new Error("connect ECONNREFUSED"); }) as unknown as typeof fetch;
    const v = await verifier({ fetchImpl: dead })(mint({ premium: true }));
    expect(v).toMatchObject({ ok: false, code: 4401 });
    const err500 = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const v2 = await verifier({ fetchImpl: err500 })(mint({ premium: true }));
    expect(v2).toMatchObject({ ok: false, code: 4401 });
  });

  it("caches the JWKS across verifications (Cache-Control max-age honored)", async () => {
    jwksFetches = 0;
    const verify = verifier();
    await verify(mint({ premium: true }));
    await verify(mint({ premium: true, sub: "uid-2" }));
    expect(jwksFetches).toBe(1);
  });
});

describe("relay_auth: pure admission decision", () => {
  const base = { sub: "u", email: "A@B.com", email_verified: true };
  it("no subject → 4401; claims and allowlist admit; otherwise 4403", () => {
    expect(admissionDecision({ ...base, sub: "" }, [])).toMatchObject({ ok: false, code: 4401 });
    expect(admissionDecision({ ...base, premium: true }, [])).toMatchObject({ ok: true, premium: true, admin: false });
    expect(admissionDecision({ ...base, admin: true }, [])).toMatchObject({ ok: true, premium: true, admin: true });
    expect(admissionDecision(base, ["a@b.com"])).toMatchObject({ ok: true, email: "a@b.com" });
    expect(admissionDecision(base, [])).toMatchObject({ ok: false, code: 4403 });
    // truthy-but-not-true claim values never admit (a string "true" from a mangled backend is refused)
    expect(admissionDecision({ ...base, premium: "true" }, [])).toMatchObject({ ok: false, code: 4403 });
  });
});

describe("relay_auth: authFromEnv (the standalone broker's config seam)", () => {
  it("defaults to anonymous mode", () => {
    const { auth, summary } = authFromEnv({});
    expect(auth).toBeUndefined();
    expect(summary).toContain("anonymous");
  });

  it("fails LOUD on firebase mode without a project id — never an open relay", () => {
    expect(() => authFromEnv({ RELAY_AUTH: "firebase" })).toThrow(/RELAY_FIREBASE_PROJECT/);
  });

  it("rejects unknown modes", () => {
    expect(() => authFromEnv({ RELAY_AUTH: "iap" })).toThrow(/firebase.*off/);
  });

  it("builds the gate with allowlist + deadline from env", () => {
    const { auth, summary } = authFromEnv({
      RELAY_AUTH: "Firebase",
      RELAY_FIREBASE_PROJECT: "lucid-agent",
      RELAY_ALLOWED_EMAILS: "Nicholas.Chadwick.CTR@gmail.com, second@x.io,",
      RELAY_AUTH_DEADLINE_MS: "2500",
    });
    expect(auth).toBeDefined();
    expect(auth!.deadlineMs).toBe(2500);
    expect(typeof auth!.verify).toBe("function");
    expect(summary).toContain("lucid-agent");
    expect(summary).toContain("2 allowlisted emails");
  });
});
