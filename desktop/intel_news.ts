// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/intel_news.ts — P-TRIV.3 (ADR-0176): the executive INTEL WIRE feed.
//
// Curated Intelligence/Defense-sector RSS feeds → sanitized, SCANNED headlines that the executive
// Trivia Wire interleaves between questions. Security posture, in order of the invariants it leans on:
//   - Remote text is UNTRUSTED CONTENT. Every refresh batch runs through the SAME fail-closed scan
//     gate the skill importer uses (scanAndDecide → the Python sidecar; invariant #2 - never
//     reimplement the scanner in TS). Scanner dead / findings present ⇒ the WHOLE batch is dropped
//     and the block is recorded - never "safe by default" (invariant #3).
//   - Headlines render in the ticker as esc()'d text only (trivia_news.ts), never markdown, and
//     NEVER flow into any prompt - strictly off the prompt path (invariants #4/#5/#6 untouched).
//   - Each ACTUAL feed fetch emits a P-REPORT.10-style first-party egress SecurityEvent into the
//     OCSF/SIEM stream: category "egress", host only, credential-free, metadata-only.
//   - Product behavior is fail-QUIET: air-gapped / offline / all feeds down ⇒ empty list and the
//     game simply plays questions. Fail-closed guards the CONTENT, fail-quiet guards the fun.
//
// Parse + sanitize are PURE (fixture-tested); fetch / scan / emit are injectable seams.

import { DEFAULT_POLICY, type GateDecision, scanAndDecide } from "../harness/security/gate.ts";
import { ScannerClient } from "../harness/security/scanner_client.ts";
import { emitSecurityEvent, type SecurityEventInput } from "./audit_export.ts";
import { recordBlock } from "./security_log.ts";

export interface IntelNewsItem {
  title: string;
  source: string;   // feed display name, first-party curated
  host: string;     // feed host (for the audit trail + tooltip), never the full URL
  ageMin: number | null; // minutes since pubDate when parseable
}
export interface IntelNewsView { items: IntelNewsItem[]; fetchedAt: number; stale: boolean }

/** Curated defense/intel trade press. First-party allowlist - the ONLY hosts this module ever
 *  contacts; there is deliberately no user-configurable URL surface in this increment. */
export const INTEL_FEEDS: readonly { name: string; url: string }[] = [
  { name: "Breaking Defense", url: "https://breakingdefense.com/feed/" },
  { name: "Defense One", url: "https://www.defenseone.com/rss/all/" },
  { name: "DefenseScoop", url: "https://defensescoop.com/feed/" },
  { name: "GovCon Wire", url: "https://www.govconwire.com/feed/" },
  { name: "ExecutiveGov", url: "https://executivegov.com/feed/" },
  { name: "Federal News Network (Defense)", url: "https://federalnewsnetwork.com/category/defense-main/feed/" },
];

const TITLE_MAX = 180;
const PER_FEED_CAP = 8;
const FETCH_TIMEOUT_MS = 6000;
export const INTEL_TTL_MS = 20 * 60 * 1000;

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", "#39": "'", nbsp: " " };
/** ONE-pass entity decode: a single alternation over the ORIGINAL text, so produced characters are
 *  never re-scanned - "&#38;lt;" decodes to the literal text "&lt;", never onward to "<" (that
 *  second decode is the js/double-escaping trap CodeQL rightly flags). */
function decodeEntitiesOnce(s: string): string {
  return s.replace(/&(?:#(\d+)|#x([0-9a-f]+)|amp|lt|gt|quot|apos|#39|nbsp);/gi, (m, dec, hex) => {
    if (dec) return String.fromCodePoint(Math.min(0x10ffff, Number(dec) || 32));
    if (hex) return String.fromCodePoint(Math.min(0x10ffff, parseInt(hex, 16) || 32));
    return NAMED_ENTITIES[m.slice(1, -1).toLowerCase()] ?? m;
  });
}

/** PURE: tag-strip, entity-decode (single pass), whitespace-collapse and clamp one raw RSS title.
 *  Returns null for anything too short to be a headline. This is COSMETIC normalization only -
 *  the security judgment (bidi smuggling, zero-width tricks) belongs to the real scanner, and the
 *  renderer esc()'s every character regardless, so even a decoded "<" is inert in the ticker. */
export function sanitizeHeadline(raw: string): string | null {
  let t = decodeEntitiesOnce(raw
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]*>/g, " "))
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (t.length > TITLE_MAX) t = `${t.slice(0, TITLE_MAX - 1).trimEnd()}…`;
  return t.length >= 8 ? t : null;
}

/** PURE: pull the item titles (+ ages) out of one RSS/Atom document. Tolerates CDATA, entities and
 *  attribute-carrying tags; caps items per feed so one chatty source cannot flood the wire. */
export function parseRssTitles(xml: string, source: string, host: string, now: number): IntelNewsItem[] {
  const out: IntelNewsItem[] = [];
  const items = xml.match(/<(?:item|entry)[\s>][\s\S]*?<\/(?:item|entry)>/gi) ?? [];
  for (const block of items) {
    if (out.length >= PER_FEED_CAP) break;
    const tm = block.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (!tm) continue;
    const title = sanitizeHeadline(tm[1] ?? "");
    if (!title) continue;
    const dm = block.match(/<(?:pubDate|published|updated)[^>]*>([\s\S]*?)<\/(?:pubDate|published|updated)>/i);
    let ageMin: number | null = null;
    if (dm) {
      const t = Date.parse(sanitizeHeadline(dm[1] ?? "") ?? "");
      if (Number.isFinite(t) && t <= now) ageMin = Math.floor((now - t) / 60_000);
    }
    out.push({ title, source, host, ageMin });
  }
  return out;
}

/** Round-robin the freshest few from each source so the wire alternates voices. */
export function interleaveBySource(items: IntelNewsItem[]): IntelNewsItem[] {
  const bySource = new Map<string, IntelNewsItem[]>();
  for (const it of items) { const a = bySource.get(it.source) ?? []; a.push(it); bySource.set(it.source, a); }
  const lists = [...bySource.values()];
  const out: IntelNewsItem[] = [];
  for (let i = 0; lists.some((l) => i < l.length); i++) for (const l of lists) { const it = l[i]; if (it) out.push(it); }
  return out;
}

let scanner: ScannerClient | null = null;
function getScanner(): ScannerClient {
  if (!scanner) { scanner = new ScannerClient(); scanner.start(); }
  return scanner;
}
/** Stop the intel wire's scan sidecar (demo/test teardown). */
export function stopIntelScanner(): void { try { scanner?.stop(); } catch { /* ignore */ } scanner = null; }

const hostOf = (url: string): string => { try { return new URL(url).host; } catch { return "(bad url)"; } };

async function defaultFetcher(url: string): Promise<string> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { accept: "application/rss+xml, application/atom+xml, text/xml, */*" } });
    if (!res.ok) throw new Error(`http ${res.status}`);
    return await res.text();
  } finally { clearTimeout(timer); }
}

export interface IntelNewsDeps {
  fetcher?: (url: string) => Promise<string>;
  decide?: (content: string) => Promise<GateDecision>;
  emit?: (e: SecurityEventInput) => void;
  record?: (b: { tool: string; severity?: string; findings?: string; reason: string }) => void;
  feeds?: readonly { name: string; url: string }[];
  now?: () => number;
}

let cache: { at: number; items: IntelNewsItem[] } | null = null;
/** Test/demo hook: forget the module-level cache. */
export function _resetIntelCacheForTest(): void { cache = null; }

/** Fetch + sanitize + SCAN the wire. Cached for INTEL_TTL_MS; `force` refreshes now. */
export async function intelNews(force = false, deps: IntelNewsDeps = {}): Promise<IntelNewsView> {
  const now = deps.now ?? Date.now;
  if (!force && cache && now() - cache.at < INTEL_TTL_MS) return { items: cache.items, fetchedAt: cache.at, stale: false };
  const fetcher = deps.fetcher ?? defaultFetcher;
  const decide = deps.decide ?? ((content: string) => scanAndDecide(getScanner(), content, DEFAULT_POLICY));
  const emit = deps.emit ?? emitSecurityEvent;
  const record = deps.record ?? recordBlock;
  const feeds = deps.feeds ?? INTEL_FEEDS;

  const settled = await Promise.allSettled(feeds.map(async (f) => {
    const host = hostOf(f.url);
    try {
      const xml = await fetcher(f.url);
      emit({ category: "egress", type: "intel_news_fetch", decision: "allow", severity: "info", tool: "intel-news", reason: `trivia intel wire: fetch ${host} (ok)` });
      return parseRssTitles(xml, f.name, host, now());
    } catch {
      // A failed reach-out was still a reach-out - audit it, then fail quiet for this feed.
      emit({ category: "egress", type: "intel_news_fetch", decision: "allow", severity: "info", tool: "intel-news", reason: `trivia intel wire: fetch ${host} (failed)` });
      return [] as IntelNewsItem[];
    }
  }));
  const fetchedItems = settled.flatMap((s) => (s.status === "fulfilled" ? s.value : []));

  let items: IntelNewsItem[] = [];
  if (fetchedItems.length > 0) {
    // ONE fail-closed scan over the whole batch: remote headlines are untrusted content, and a
    // finding (or a dead scanner) drops the ENTIRE refresh - questions-only beats poisoned pixels.
    // scanAndDecide already fail-closes internally; the catch covers an injected decide that throws.
    const decision = await decide(fetchedItems.map((i) => i.title).join("\n"))
      .catch((e): GateDecision => ({ block: true, reason: `scan failed: ${String(e)}`, trustLabel: "quarantined", findings: [], failClosed: true }));
    if (decision.block) {
      record({ tool: "intel-news", severity: decision.failClosed ? "medium" : "high", findings: JSON.stringify(decision.findings?.slice(0, 8) ?? []), reason: `intel wire batch dropped: ${decision.reason}` });
    } else {
      items = interleaveBySource(fetchedItems);
    }
  }
  cache = { at: now(), items };
  return { items, fetchedAt: cache.at, stale: false };
}
