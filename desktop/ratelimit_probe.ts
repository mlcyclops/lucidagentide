// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/ratelimit_probe.ts — P10.3: live rate-limit probe for API-KEY providers (ADR-0011).
//
// The user's OAuth 5-hour window has NO rate-limit header (already shown from omp's agent.db).
// For providers configured with an API KEY, the real remaining budget rides response rate-limit
// headers — Anthropic `anthropic-ratelimit-*`, OpenAI `x-ratelimit-*`. This makes ONE minimal
// request per keyed provider (OPT-IN: it costs a token or two), caches for 5 min, and surfaces
// "remaining / resets-at". Fails soft: any error → that provider is simply omitted. The pure
// header parsers below are unit-tested; the live fetch only wraps them.

import { load } from "./settings_store.ts";

export interface ProbedLimit {
  provider: string;
  label: string;
  used: number; // 0..1 (1 - remaining/limit), so it slots into the existing budget UI
  remaining: number;
  limit: number;
  resetsAt: number | null; // absolute epoch-ms, or null
}

// ── pure parsers (the verifiable core) ───────────────────────────────────────────
/** Anthropic resets are RFC3339 timestamps; tokens are the usually-binding axis. */
export function parseAnthropic(h: Headers): ProbedLimit | null {
  const limit = Number(h.get("anthropic-ratelimit-tokens-limit"));
  const remaining = Number(h.get("anthropic-ratelimit-tokens-remaining"));
  if (!Number.isFinite(limit) || !Number.isFinite(remaining) || limit <= 0) return null;
  const reset = h.get("anthropic-ratelimit-tokens-reset");
  const resetsAt = reset ? Date.parse(reset) || null : null;
  return { provider: "anthropic", label: "Anthropic API", limit, remaining, used: clamp01(1 - remaining / limit), resetsAt };
}

/** OpenAI resets are durations like "6m0s" / "1.5s" / "100ms" — converted to an absolute ms time. */
export function parseOpenAI(h: Headers, nowMs?: number): ProbedLimit | null {
  const limit = Number(h.get("x-ratelimit-limit-tokens"));
  const remaining = Number(h.get("x-ratelimit-remaining-tokens"));
  if (!Number.isFinite(limit) || !Number.isFinite(remaining) || limit <= 0) return null;
  return { provider: "openai", label: "OpenAI API", limit, remaining, used: clamp01(1 - remaining / limit), resetsAt: parseDuration(h.get("x-ratelimit-reset-tokens"), nowMs) };
}

/** Parse an OpenAI-style duration ("6m0s", "1.5s", "100ms", "1h2m") → absolute epoch-ms (or null). */
export function parseDuration(d: string | null, nowMs?: number): number | null {
  if (!d) return null;
  let ms = 0, matched = false;
  for (const m of d.matchAll(/([\d.]+)(ms|s|m|h|d)/g)) {
    matched = true;
    const v = Number(m[1]);
    ms += m[2] === "ms" ? v : m[2] === "s" ? v * 1e3 : m[2] === "m" ? v * 6e4 : m[2] === "h" ? v * 36e5 : v * 864e5;
  }
  return matched ? (nowMs ?? Date.now()) + ms : null;
}

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

// ── live probes (minimal request; reads headers regardless of body) ──────────────
const AV = "2023-06-01";
async function probeAnthropic(key: string): Promise<ProbedLimit | null> {
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": AV, "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 1, messages: [{ role: "user", content: "." }] }),
      signal: AbortSignal.timeout(8000),
    });
    return parseAnthropic(r.headers);
  } catch { return null; }
}
async function probeOpenAI(key: string): Promise<ProbedLimit | null> {
  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o-mini", max_tokens: 1, messages: [{ role: "user", content: "." }] }),
      signal: AbortSignal.timeout(8000),
    });
    return parseOpenAI(r.headers);
  } catch { return null; }
}

let cache: { at: number; data: ProbedLimit[] } | null = null;
const TTL = 5 * 60_000;

/** Probe each keyed provider (when the opt-in is on), cached for 5 min. [] when off/no keys. */
export async function probeRateLimits(force = false): Promise<ProbedLimit[]> {
  const s = load();
  if (!s.rateLimitProbe) { cache = null; return []; } // off → no live calls, ever
  if (!force && cache && Date.now() - cache.at < TTL) return cache.data;
  const keys = s.keys ?? {};
  const tasks: Promise<ProbedLimit | null>[] = [];
  if (keys.ANTHROPIC_API_KEY) tasks.push(probeAnthropic(keys.ANTHROPIC_API_KEY));
  if (keys.OPENAI_API_KEY) tasks.push(probeOpenAI(keys.OPENAI_API_KEY));
  const data = (await Promise.all(tasks)).filter((x): x is ProbedLimit => !!x);
  cache = { at: Date.now(), data };
  return data;
}
