// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/swr_cache.ts - P-PERF.1 (ADR-0084): a tiny localStorage-backed stale-while-revalidate
// cache so a RETURNING user gets instant UI. On open we paint the cached value immediately, then fetch
// fresh in the background and update only if it changed. Persisted across reloads/restarts.
//
// SCOPE / privacy: only data that is ALREADY plaintext on disk is cached here - the session list and chat
// transcripts (omp persists those as ~/.omp/.../*.jsonl). The encrypted Knowledge-graph store is NEVER
// cached to disk (that would defeat its at-rest encryption); it stays in-memory only.

export interface KVStore { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }

let mem: KVStore | null = null;
const memStore = (): KVStore => {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v); }, removeItem: (k) => { m.delete(k); } };
};
/** localStorage when available (renderer), else a process-stable in-memory store (tests/SSR). */
function store(): KVStore {
  try { if (typeof localStorage !== "undefined") return localStorage as unknown as KVStore; } catch { /* sandboxed */ }
  return (mem ??= memStore());
}

export function cacheGet<T>(key: string): T | null {
  try { const raw = store().getItem(key); return raw ? (JSON.parse(raw) as T) : null; } catch { return null; }
}
export function cacheSet(key: string, value: unknown): void {
  try { store().setItem(key, JSON.stringify(value)); } catch { /* quota exceeded / unserializable - caching is best-effort */ }
}

// ── session list ────────────────────────────────────────────────────────────
const SESSIONS_KEY = "lucid.sessions";
export function cachedSessions<T>(): T | null { return cacheGet<T>(SESSIONS_KEY); }
export function setCachedSessions(data: unknown): void { cacheSet(SESSIONS_KEY, data); }

// ── per-session transcripts (LRU, capped so localStorage can't grow unbounded) ──
export interface CachedMsg { role: string; text: string }
interface TranscriptEntry { m: CachedMsg[]; at: number }
const TRANSCRIPTS_KEY = "lucid.transcripts";
const MAX_TRANSCRIPTS = 15;       // keep the most-recently-opened N sessions
const MAX_MSGS = 400;             // and cap each transcript's length (very long chats stay snappy)

export function cachedTranscript(id: string): CachedMsg[] | null {
  const all = cacheGet<Record<string, TranscriptEntry>>(TRANSCRIPTS_KEY) ?? {};
  return all[id]?.m ?? null;
}
/** Store a transcript and evict the oldest beyond the cap (LRU by `now`). `now` is passed in so the
 *  eviction order is deterministic + testable. */
export function setCachedTranscript(id: string, msgs: CachedMsg[], now: number): void {
  const all = cacheGet<Record<string, TranscriptEntry>>(TRANSCRIPTS_KEY) ?? {};
  all[id] = { m: msgs.slice(-MAX_MSGS), at: now };
  const ids = Object.keys(all);
  if (ids.length > MAX_TRANSCRIPTS) {
    ids.sort((a, b) => all[a]!.at - all[b]!.at); // oldest first
    for (const old of ids.slice(0, ids.length - MAX_TRANSCRIPTS)) delete all[old];
  }
  cacheSet(TRANSCRIPTS_KEY, all);
}

/** A cheap signature so a cache-hit doesn't re-render the thread when the fresh fetch is identical
 *  (avoids a flicker). Length + per-message text lengths is enough to detect a real change. */
export function transcriptSig(msgs: CachedMsg[]): string {
  return `${msgs.length}:${msgs.map((m) => `${m.role[0] ?? "?"}${m.text.length}`).join(",")}`;
}

// -- discovered skills list (P-SKILL.6, ADR-0243) --
// The /api/skills directory scan (names/descriptions/roots/trust labels) is metadata ALREADY plaintext on disk
// (the .md skill files + the governance state), so caching it for an instant Skills-panel paint is safe at rest
// exactly like the session list + transcripts above. SWR: painted immediately on open, revalidated right after.
const SKILLS_KEY = "lucid.skills";
export function cachedSkills<T>(): T | null { return cacheGet<T>(SKILLS_KEY); }
export function setCachedSkills(data: unknown): void { cacheSet(SKILLS_KEY, data); }

// -- Session Share dock snapshot (P-SHARE.2, ADR-0234) --
const SHARE_SNAPSHOT_KEY = "lucid.shareDock.snapshot";
/** The secret-free Share-dock snapshot (see share_dock.ts `redactShareSnapshot`) painted INSTANTLY on open so
 *  a cold-boot dock is never a blank "Loading". revalidates right after. Never holds an invite link / room id /
 *  TURN credential, so it is safe at rest exactly like the session list + transcripts above. */
export function cachedShareSnapshot<T>(): T | null { return cacheGet<T>(SHARE_SNAPSHOT_KEY); }
export function setCachedShareSnapshot(data: unknown): void { cacheSet(SHARE_SNAPSHOT_KEY, data); }

// Test-only: reset the in-memory fallback store between cases.
export function __resetCache(): void { mem = null; }
