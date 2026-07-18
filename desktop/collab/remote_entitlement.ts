// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/collab/remote_entitlement.ts — P-REMOTE.6 (ADR-0227): the phone PWA's PURE, DOM-free unentitled path.
//
// Remote Access is a paid tier: a $9.99/mo Stripe subscription delivered as a Firebase custom claim
// (`premium`, or `admin` which rides free and implies premium). The relay is the AUTHORITATIVE gate — it
// verifies the claim (P-REMOTE.1) and refuses an unentitled socket with a 4403 close. This module is the
// CLIENT-side glue that turns that refusal into a "Subscribe" flow: detect the 4403, ask the private backend
// for a Stripe Checkout URL, and — after the webhook sets the claim — recognise the refreshed token so the
// phone can retry the connection.
//
// DESIGN: admission stays authoritative on the RELAY, never the client. We do NOT pre-gate on the decoded
// claim, because a self-hosted relay may admit by email allowlist WITHOUT any claim (relay_auth.ts
// admissionDecision) — pre-gating on claims would wrongly strand an allowlisted user on the Subscribe screen.
// So the flow is: try to connect; a 4403 close ⇒ Subscribe. The decoded claim is used only to know when a
// post-checkout REFRESHED token has actually gained the entitlement, so the retry isn't premature.
//
// FAIL-CLOSED: a malformed token decodes to null (no entitlement); a checkout with no token / non-2xx /
// malformed reply yields no URL. Absence of information is never treated as access.
//
// PURE + browser-safe: no DOM, no globals beyond `atob`/`fetch`/`JSON` (present in Bun, Electron, and the
// phone's WebKit), and `fetch` is injectable — so the whole decision + checkout path is testable headless.

import { RELAY_NOT_ENTITLED_REASON } from "./relay_client.ts";

/** The storefront / entitlement id for the hosted Remote Access subscription (ADR-0227). The backend's
 *  `createCheckout` callable is keyed to it (Stripe lookup_key LUCID-REMOTE-MONTHLY); the webhook sets the
 *  `premium` claim on payment. */
export const REMOTE_ACCESS_ID = "remote-access";

/** The subset of Firebase ID-token claims that decide remote admission. Everything is `unknown` because a
 *  token is UNTRUSTED input until the relay verifies it — we read it only to drive the UI optimistically. */
export interface RemoteClaims {
  premium?: unknown;
  admin?: unknown;
  email?: unknown;
  exp?: unknown;
}

/** The three states the phone's entry flow can be in. */
export type RemoteGate = "signin" | "connect" | "subscribe";

/** Decode a Firebase ID token's payload (the middle JWT segment) WITHOUT verifying the signature — the relay
 *  verifies cryptographically (P-REMOTE.1); this is a cosmetic client read to drive the retry-after-checkout
 *  UX. Fail-closed: a null/empty/malformed token (wrong segment count, bad base64url, non-object payload)
 *  returns null, treated everywhere as "no claims". */
export function decodeClaims(idToken: string | null | undefined): RemoteClaims | null {
  if (!idToken || typeof idToken !== "string") return null;
  const parts = idToken.split(".");
  const payload = parts.length === 3 ? parts[1] : undefined;
  if (!payload) return null;
  try {
    const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
    const json = atob(b64 + pad);
    const obj: unknown = JSON.parse(json);
    return obj && typeof obj === "object" ? (obj as RemoteClaims) : null;
  } catch {
    return null;
  }
}

/** True ONLY for a strict boolean-`true` premium or admin claim — mirrors the relay's admissionDecision
 *  (admin implies premium). A truthy-but-not-`true` value (e.g. the string "true", or 1) is refused, exactly
 *  as the relay refuses it, so the client never disagrees with the gate on a well-formed token. */
export function hasRemoteAccess(claims: RemoteClaims | null | undefined): boolean {
  return claims?.admin === true || claims?.premium === true;
}

/** Does this ID token already carry the remote-access entitlement? Used AFTER a checkout + forced token
 *  refresh to decide whether the claim has landed (retry the connection) or is still propagating (keep
 *  waiting for the webhook). Fail-closed on a malformed token. */
export function entitlementActive(idToken: string | null | undefined): boolean {
  return hasRemoteAccess(decodeClaims(idToken));
}

/** The authoritative "signed in but not entitled" signal: the guest ended because the relay refused the
 *  verified token with a 4403 (surfaced as {@link RELAY_NOT_ENTITLED_REASON}). Structural param so this stays
 *  dependency-free of the full GuestView. Only an ENDED view with that exact note counts — a live session, a
 *  different close reason, or a null note is not an entitlement refusal. */
export function isEntitlementDenied(view: { phase: string; note: string | null }): boolean {
  return view.phase === "ended" && view.note === RELAY_NOT_ENTITLED_REASON;
}

/** The pure entry decision. Not signed in ⇒ `signin`. The relay refused the token for no entitlement ⇒
 *  `subscribe`. Otherwise ⇒ `connect` (a claim-holder AND an allowlisted self-host user both just connect;
 *  the relay is the real gate, so the client attempts and lets a 4403 redirect to `subscribe`). */
export function remoteGate(signedIn: boolean, entitlementDenied: boolean): RemoteGate {
  if (!signedIn) return "signin";
  if (entitlementDenied) return "subscribe";
  return "connect";
}

export interface RemoteCheckoutOpts {
  /** The deployed Firebase functions base, e.g. https://us-central1-lucid-agent.cloudfunctions.net (public). */
  functionsBaseUrl: string;
  /** A fresh Firebase ID token for the callable's Authorization header. */
  token: string | null | undefined;
  /** Injectable for tests; defaults to the global fetch (present in WebKit / Bun / Electron). */
  fetchImpl?: typeof fetch;
  /** Overridable for tests; defaults to the Remote Access entitlement id. */
  packId?: string;
}

/** Ask the PRIVATE entitlement backend to open a Stripe Checkout session for Remote Access, over the same
 *  Firebase callable protocol the marketplace provider uses (POST { data }, Bearer token, { result } | {
 *  error }). Returns the hosted-checkout URL, or null FAIL-CLOSED on any of: no base URL, no token, non-2xx,
 *  a { error } reply, a missing/blank url, or a thrown fetch. The url is opened by the caller (the PWA). */
export async function createRemoteCheckout(opts: RemoteCheckoutOpts): Promise<string | null> {
  const { functionsBaseUrl, token } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const packId = opts.packId ?? REMOTE_ACCESS_ID;
  if (!functionsBaseUrl || !token) return null;
  try {
    const res = await fetchImpl(`${functionsBaseUrl.replace(/\/$/, "")}/createCheckout`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ data: { packId } }),
    });
    const json = (await res.json().catch(() => ({}))) as { result?: { url?: unknown }; error?: unknown };
    if (!res.ok || json?.error) return null;
    const url = json?.result?.url;
    return typeof url === "string" && url ? url : null;
  } catch {
    return null;
  }
}
