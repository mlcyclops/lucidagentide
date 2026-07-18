// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/collab/relay_auth.ts — P-REMOTE.1 (ADR-0226/0227): the relay's OPTIONAL Firebase identity gate.
//
// When the relay runs as a HOSTED rendezvous (Cloud Run, ADR-0226), admission is gated on a verified Google
// sign-in: the client's FIRST frame after the WS upgrade is `{"t":"auth","token":"<Firebase ID token>"}`
// (NEVER a query param — URLs land in request logs, and a logged bearer token is a credential leak,
// ADR-0227). This module verifies that token with ZERO npm dependencies (ADR-0195's property): plain
// `fetch` for Google's securetoken JWKS + WebCrypto RS256 for the signature.
//
// Verification (all fail CLOSED → 4401):
//   - well-formed RS256 JWT, known `kid` in the JWKS,
//   - signature valid over header.payload,
//   - `exp`/`iat` within clock skew, `aud` = the Firebase project id,
//     `iss` = https://securetoken.google.com/<project>,
//   - `email_verified === true` and `firebase.sign_in_provider === "google.com"`
//     (the "Google OAuth only" rule, enforced cryptographically — ADR-0227).
// Admission (verified but not entitled → 4403):
//   - `admin: true` custom claim (the host account, rides free), OR
//   - `premium: true` custom claim (the paid tier, set by the entitlement backend), OR
//   - email ∈ the env allowlist (self-host / bootstrap mode — a personal relay never needs the paid backend).
//
// The verdict carries identity (uid/email) for the metadata-only admin plane (P-REMOTE.7); the relay itself
// never logs identities (counts only).

export type AuthVerdict =
  | { ok: true; uid: string; email: string; premium: boolean; admin: boolean }
  | { ok: false; code: 4401 | 4403; reason: string };

/** The shape relay_server.ts consumes — an injected verifier, mirroring the `authorizeBind` seam. */
export interface RelayAuthGate {
  verify: (token: string) => Promise<AuthVerdict>;
  /** ms an opened socket may sit unauthenticated before it is reaped with 4401. Default 5000. */
  deadlineMs?: number;
  /** Max rooms a single uid may HOST concurrently. Default 4. */
  maxRoomsPerUser?: number;
  /** Max successful authentications per uid per minute (reconnect storms / token replay floods). Default 30. */
  maxConnectsPerMinute?: number;
  /** P-REMOTE.2: ms a dropped host's room (with live guests) is held for the SAME uid to re-claim before
   *  guests are kicked — makes the Cloud Run 60-min reconnect invisible to guests. 0 disables. Default 30000. */
  reclaimGraceMs?: number;
}

export interface FirebaseVerifierConfig {
  /** The Firebase project id — checked as `aud` and inside `iss`. */
  projectId: string;
  /** Lowercased emails admitted WITHOUT a premium/admin claim (self-host allowlist mode). */
  allowedEmails?: string[];
  /** Override the JWKS endpoint (tests / air-gapped mirrors). Default: Google's securetoken JWK set. */
  jwksUrl?: string;
  /** Injected fetch (tests). Default: global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected clock, ms epoch (tests). Default: Date.now. */
  now?: () => number;
  /** JWKS cache TTL fallback when the response carries no usable Cache-Control. Default 1h. */
  jwksTtlMs?: number;
  /** Allowed clock skew in seconds for exp/iat. Default 60. */
  clockSkewSec?: number;
}

const GOOGLE_SECURETOKEN_JWKS =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

/** Minimal JWK shape (an RSA public key from Google's securetoken set). Structural — this tsconfig's libs
 *  don't expose the DOM `JsonWebKey` global. */
export interface RelayJwk {
  kid?: string;
  kty?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
}

interface JwtParts {
  header: { alg?: string; kid?: string };
  payload: Record<string, unknown>;
  signedInput: Uint8Array<ArrayBuffer>;
  signature: Uint8Array<ArrayBuffer>;
}

/** Decode without trusting: structure only. Returns null on any malformation. */
export function decodeJwt(token: string): JwtParts | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8"));
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
    if (typeof header !== "object" || header === null) return null;
    if (typeof payload !== "object" || payload === null) return null;
    return {
      header,
      payload,
      signedInput: Uint8Array.from(new TextEncoder().encode(`${parts[0]}.${parts[1]}`)),
      signature: Uint8Array.from(Buffer.from(parts[2]!, "base64url")),
    };
  } catch {
    return null;
  }
}

/** PURE admission decision over a VERIFIED payload — separately testable (ADR-0227). */
export function admissionDecision(
  payload: Record<string, unknown>,
  allowedEmails: readonly string[],
): AuthVerdict {
  const uid = typeof payload.sub === "string" && payload.sub ? payload.sub : null;
  const email = typeof payload.email === "string" ? payload.email.toLowerCase() : "";
  if (!uid) return { ok: false, code: 4401, reason: "token has no subject" };
  const admin = payload.admin === true;
  const premium = payload.premium === true;
  if (admin || premium || (email && allowedEmails.includes(email))) {
    return { ok: true, uid, email, premium: premium || admin, admin };
  }
  return { ok: false, code: 4403, reason: "signed in but not entitled (no premium/admin claim, not allowlisted)" };
}

/** Build the real verifier. JWKS is fetched lazily + cached; every failure path is a 4401, never a pass. */
export function createFirebaseVerifier(cfg: FirebaseVerifierConfig): (token: string) => Promise<AuthVerdict> {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const now = cfg.now ?? Date.now;
  const jwksUrl = cfg.jwksUrl ?? GOOGLE_SECURETOKEN_JWKS;
  const ttlFallback = cfg.jwksTtlMs ?? 60 * 60 * 1000;
  const skewMs = (cfg.clockSkewSec ?? 60) * 1000;
  const allowed = (cfg.allowedEmails ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean);
  const expectedIss = `https://securetoken.google.com/${cfg.projectId}`;

  let cache: { keys: Map<string, RelayJwk>; expiresAt: number; fetchedAt: number } | null = null;
  const MIN_REFETCH_MS = 60 * 1000; // an unknown kid can't hammer the JWKS endpoint

  async function jwks(kid: string): Promise<RelayJwk | null> {
    const t = now();
    if (cache && (cache.keys.has(kid) || t < cache.fetchedAt + MIN_REFETCH_MS) && t < cache.expiresAt) {
      return cache.keys.get(kid) ?? null;
    }
    const res = await fetchImpl(jwksUrl);
    if (!res.ok) throw new Error(`jwks fetch failed: ${res.status}`);
    const body = (await res.json()) as { keys?: RelayJwk[] };
    const keys = new Map<string, RelayJwk>();
    for (const k of body.keys ?? []) if (typeof k.kid === "string") keys.set(k.kid, k);
    const maxAge = /max-age=(\d+)/.exec(res.headers.get("cache-control") ?? "");
    const ttl = maxAge ? Number(maxAge[1]) * 1000 : ttlFallback;
    cache = { keys, expiresAt: t + ttl, fetchedAt: t };
    return keys.get(kid) ?? null;
  }

  return async function verify(token: string): Promise<AuthVerdict> {
    const refuse = (reason: string): AuthVerdict => ({ ok: false, code: 4401, reason });
    try {
      const jwt = decodeJwt(token);
      if (!jwt) return refuse("malformed token");
      if (jwt.header.alg !== "RS256") return refuse(`alg must be RS256, got ${String(jwt.header.alg)}`);
      if (typeof jwt.header.kid !== "string" || !jwt.header.kid) return refuse("token has no kid");

      const p = jwt.payload;
      const t = now();
      const expMs = typeof p.exp === "number" ? p.exp * 1000 : 0;
      const iatMs = typeof p.iat === "number" ? p.iat * 1000 : Number.POSITIVE_INFINITY;
      if (expMs + skewMs <= t) return refuse("token expired");
      if (iatMs - skewMs > t) return refuse("token issued in the future");
      if (p.aud !== cfg.projectId) return refuse("aud mismatch");
      if (p.iss !== expectedIss) return refuse("iss mismatch");
      if (p.email_verified !== true) return refuse("email not verified");
      const provider = (p.firebase as { sign_in_provider?: unknown } | undefined)?.sign_in_provider;
      if (provider !== "google.com") return refuse("only Google sign-in is accepted");

      const jwk = await jwks(jwt.header.kid);
      if (!jwk) return refuse("unknown signing key");
      const key = await crypto.subtle.importKey(
        "jwk",
        jwk,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      );
      const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, jwt.signature, jwt.signedInput);
      if (!valid) return refuse("bad signature");

      return admissionDecision(p, allowed);
    } catch (e) {
      // ANY failure to obtain a valid verdict is a refusal — never a pass (CLAUDE.md invariant #3).
      return refuse(`verification unavailable: ${String((e as Error)?.message ?? e)}`);
    }
  };
}

/**
 * Parse the standalone broker's auth env (tools/relay/serve.ts). Fail-LOUD on a half-configured gate:
 * `RELAY_AUTH=firebase` without a project id is a config error, not an open relay.
 *
 *   RELAY_AUTH=firebase|off        (default off — anonymous mode, byte-identical to pre-P-REMOTE behavior)
 *   RELAY_FIREBASE_PROJECT=<id>    (required in firebase mode; checked as aud/iss)
 *   RELAY_ALLOWED_EMAILS=a@b,c@d   (optional; admitted without a premium/admin claim)
 *   RELAY_JWKS_URL=<url>           (optional; tests / mirrors)
 *   RELAY_AUTH_DEADLINE_MS=5000    (optional)
 */
export function authFromEnv(
  env: Record<string, string | undefined>,
): { auth?: RelayAuthGate; summary: string } {
  const mode = (env.RELAY_AUTH ?? "off").trim().toLowerCase();
  if (mode === "off" || mode === "") {
    return { summary: "auth: anonymous (set RELAY_AUTH=firebase to require Google sign-in)" };
  }
  if (mode !== "firebase") throw new Error(`RELAY_AUTH must be "firebase" or "off", got "${mode}"`);
  const projectId = env.RELAY_FIREBASE_PROJECT?.trim();
  if (!projectId) throw new Error("RELAY_AUTH=firebase requires RELAY_FIREBASE_PROJECT");
  const allowedEmails = (env.RELAY_ALLOWED_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  const deadline = Number(env.RELAY_AUTH_DEADLINE_MS);
  const auth: RelayAuthGate = {
    verify: createFirebaseVerifier({ projectId, allowedEmails, jwksUrl: env.RELAY_JWKS_URL?.trim() || undefined }),
    ...(Number.isFinite(deadline) && deadline > 0 ? { deadlineMs: deadline } : {}),
  };
  return {
    auth,
    summary: `auth: firebase (project ${projectId}, ${allowedEmails.length} allowlisted email${allowedEmails.length === 1 ? "" : "s"})`,
  };
}
