// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/origin_guard.ts — H1/H2 (ADR-0022): local control-plane request guard.
//
// The desktop data plane (desktop/dev.ts) and the read-only web dashboard
// (tools/web/server.ts) listen on a FIXED loopback port and handle secrets:
// they set provider API keys, unlock the encrypted personal/CUI stores with a
// passphrase, clone repos, and browse the filesystem — all without per-request
// auth. Binding to 127.0.0.1 (H1) keeps the LAN out, but a web page the user
// happens to visit still runs on their machine and can reach loopback. This
// guard is the second half of the defense:
//
//   - Host allowlist  → defeats DNS rebinding. A rebound request carries the
//     attacker's Host (e.g. evil.example:PORT), never localhost / 127.0.0.1.
//   - Origin allowlist on state-changing methods → blocks drive-by cross-site
//     POSTs; the browser always stamps a foreign Origin on those.
//   - JSON content-type on state-changing methods → blocks <form>/simple-request
//     CSRF, which cannot set application/json without a preflight we never grant.
//
// Pure + side-effect free so it is unit-tested directly, no socket required.

export interface ReqShape {
  method: string;
  host: string | null; // Host header
  origin: string | null; // Origin header (browsers stamp it on all cross-origin + all POST)
  contentType: string | null; // Content-Type header
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Host/Origin authorities we accept for a loopback server on `port`. */
function localAuthorities(port: number): Set<string> {
  return new Set(["localhost", "127.0.0.1", "[::1]"].map((h) => `${h}:${port}`));
}

/** True iff the Host header names this loopback server (defeats DNS rebinding). */
export function hostAllowed(host: string | null, port: number): boolean {
  if (!host) return false; // HTTP/1.1 requires Host; a missing one is treated as hostile
  return localAuthorities(port).has(host.toLowerCase());
}

/**
 * The single front gate for both local servers. Reject anything a malicious web
 * page or a DNS-rebinding attack against the fixed local port could forge.
 */
export function isAllowedRequest(r: ReqShape, port: number): boolean {
  // EVERY request (GET included) must target a loopback Host — this is what
  // defeats DNS rebinding, where the socket is loopback but the Host is foreign.
  if (!hostAllowed(r.host, port)) return false;
  if (SAFE_METHODS.has(r.method.toUpperCase())) return true;

  // State-changing methods: require a same-origin Origin (when the client sends
  // one) AND a JSON body. A null Origin is allowed for local non-browser tools
  // (curl, scripts) — they are already past the loopback Host gate and a browser
  // attack always carries a non-null, foreign Origin.
  const authorities = localAuthorities(port);
  let originOk = !r.origin;
  if (r.origin) {
    try { originOk = authorities.has(new URL(r.origin).host.toLowerCase()); } catch { originOk = false; }
  }
  const jsonBody = (r.contentType ?? "").toLowerCase().includes("application/json");
  return originOk && jsonBody;
}

/** Convenience: extract the guard-relevant headers from a Request. */
export function reqShape(req: Request): ReqShape {
  return {
    method: req.method,
    host: req.headers.get("host"),
    origin: req.headers.get("origin"),
    contentType: req.headers.get("content-type"),
  };
}

// ── Per-launch capability token (ADR-0024) ───────────────────────────────────
// A 4th, transport-independent layer: dev.ts mints a random token at boot and
// injects it into the served HTML, which only a same-origin document can read
// (SOP blocks a cross-origin page from reading the response body). The renderer
// echoes it back as `x-lucid-token` on every sensitive /api call. This holds even
// if the Host/Origin checks ever had a gap, and even against a same-origin-looking
// request that never loaded our HTML (it can't know the token).
//
// Constant-time-ish compare: the length check leaks only the (fixed, public) token
// length; the byte loop does not early-exit on the first mismatch.
export function tokenValid(provided: string | null, expected: string): boolean {
  if (!expected) return false; // no token configured → fail closed, never wave through
  if (!provided || provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}
