// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/collab/relay_token_cache.ts — P-REMOTE.2c (ADR-0226/0227): the backend's relay-auth token cache.
//
// The host CollabSocket lives in the dev.ts BACKEND, but the Firebase ID token lives in the RENDERER
// (market_auth). This is the tiny bridge: the renderer PUSHes a fresh token (POST /api/collab/token) and the
// backend caches it here; the host (and the desktop's own watch guest) read it through `makeTransport`'s
// `authToken`. PURE + injectable clock so it is fully testable.
//
// FAIL-CLOSED by construction: `get()` returns null once the token is within `skewMs` of expiry (or absent),
// and CollabSocket maps a null token to an ANONYMOUS connect — which a GATED relay refuses (4401), never a
// silent unauthenticated session. A non-gated relay ignores the (absent) token, so the default path is
// unchanged. The renderer re-pushes before expiry to keep the hourly reconnect authenticated.

export interface RelayTokenCacheOptions {
  /** Injected clock, ms epoch. Default Date.now. */
  now?: () => number;
  /** Treat the token as expired this many ms early, so a reconnect never presents an about-to-die token. */
  skewMs?: number;
}

export class RelayTokenCache {
  #token: string | null = null;
  #expiresAt = 0;
  readonly #now: () => number;
  readonly #skewMs: number;

  constructor(opts: RelayTokenCacheOptions = {}) {
    this.#now = opts.now ?? Date.now;
    this.#skewMs = opts.skewMs ?? 60_000;
  }

  /** Store the latest pushed token + its epoch-ms expiry. An empty token or a non-finite/past expiry clears. */
  set(token: string, expiresAt: number): void {
    if (!token || !Number.isFinite(expiresAt) || expiresAt <= this.#now()) { this.clear(); return; }
    this.#token = token;
    this.#expiresAt = expiresAt;
  }

  clear(): void {
    this.#token = null;
    this.#expiresAt = 0;
  }

  /** The cached token while it has more than `skewMs` left, else null (→ anonymous connect, fail-closed). */
  get(): string | null {
    if (!this.#token) return null;
    if (this.#expiresAt - this.#skewMs <= this.#now()) return null;
    return this.#token;
  }

  /** Whether a usable token is currently cached (for status/diagnostics; never exposes the token itself). */
  get present(): boolean {
    return this.get() !== null;
  }
}
