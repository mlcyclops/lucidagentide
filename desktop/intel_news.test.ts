// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/intel_news.test.ts — P-TRIV.3 (ADR-0176): the executive INTEL WIRE feed.
//
// Pins: RSS/Atom parsing (CDATA, entities, hostile markup, ages, per-feed cap), headline
// sanitation, source interleaving, the FAIL-CLOSED batch scan (findings or a dead/throwing scanner
// drop the whole refresh), fail-QUIET fetching (one dead feed never kills the wire; all dead ⇒
// empty, no throw), the per-fetch egress audit events (host-only, ok/failed), and the TTL cache.
// All I/O seams injected - no network, no scanner sidecar, no OCSF sink is touched here.

import { describe, expect, test } from "bun:test";
import type { GateDecision } from "../harness/security/gate.ts";
import {
  INTEL_TTL_MS, _resetIntelCacheForTest, intelNews, interleaveBySource, parseRssTitles, sanitizeHeadline,
} from "./intel_news.ts";

const RSS = `<?xml version="1.0"?><rss><channel>
  <item><title><![CDATA[Army awards $1.2B C2 contract &amp; options]]></title><pubDate>${new Date(1_000_000_000_000 - 30 * 60_000).toUTCString()}</pubDate></item>
  <item><title>Pentagon &lt;b&gt;accelerates&lt;/b&gt; CJADC2 rollout</title></item>
  <item><title><script>alert(1)</script>DIB cyber rule <b>lands</b></title></item>
  <item><title>tiny</title></item>
</channel></rss>`;

const ATOM = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
  <entry><title type="html">NGA seeks commercial GEOINT surge</title><updated>${new Date(1_000_000_000_000 - 3 * 60 * 60_000).toISOString()}</updated></entry>
</feed>`;

const PASS: GateDecision = { block: false, reason: "clean", trustLabel: "trusted", findings: [], failClosed: false };
const BLOCK: GateDecision = { block: true, reason: "bidi found", trustLabel: "quarantined", findings: [], failClosed: false };

describe("sanitizeHeadline", () => {
  test("decodes entities, strips tags, collapses whitespace", () => {
    expect(sanitizeHeadline("A &amp; B &lt;wins&gt;   deal")).toBe('A & B <wins> deal');
    expect(sanitizeHeadline("<em>Big</em>\n\tnews &#8211; today")).toBe("Big news – today");
  });
  test("single-pass decode: '&#38;lt;' yields the TEXT '&lt;', never a second decode to '<'", () => {
    // The js/double-escaping trap: sequential decode passes would turn &#38;lt;script&#38;gt;
    // into literal <script> AFTER the tag-strip already ran. One pass keeps it inert text.
    expect(sanitizeHeadline("Deal news &#38;lt;script&#38;gt; today")).toBe("Deal news &lt;script&gt; today");
    expect(sanitizeHeadline("A &amp;amp; B headline")).toBe("A &amp; B headline");
  });
  test("clamps long titles and rejects stubs", () => {
    const long = sanitizeHeadline(`headline ${"x".repeat(400)}`)!;
    expect(long.length).toBeLessThanOrEqual(180);
    expect(sanitizeHeadline("  hi  ")).toBeNull();
    expect(sanitizeHeadline("")).toBeNull();
  });
});

describe("parseRssTitles", () => {
  test("parses RSS: CDATA, entities, hostile markup neutralized to text, stubs dropped", () => {
    const items = parseRssTitles(RSS, "Test Feed", "example.com", 1_000_000_000_000);
    expect(items.map((i) => i.title)).toEqual([
      "Army awards $1.2B C2 contract & options",
      "Pentagon <b>accelerates</b> CJADC2 rollout",
      "alert(1) DIB cyber rule lands",
    ]);
    expect(items[0]!.ageMin).toBe(30);
    expect(items[1]!.ageMin).toBeNull();
    expect(items[0]!.source).toBe("Test Feed");
    expect(items[0]!.host).toBe("example.com");
  });
  test("parses Atom entries with updated dates", () => {
    const items = parseRssTitles(ATOM, "Atom Feed", "a.example", 1_000_000_000_000);
    expect(items.length).toBe(1);
    expect(items[0]!.ageMin).toBe(180);
  });
  test("caps items per feed so one source cannot flood the wire", () => {
    const many = `<rss>${Array.from({ length: 30 }, (_, i) => `<item><title>Headline number ${i} today</title></item>`).join("")}</rss>`;
    expect(parseRssTitles(many, "S", "h", 0).length).toBeLessThanOrEqual(8);
  });
});

test("interleaveBySource round-robins the voices", () => {
  const it = (source: string, n: number) => ({ title: `${source} story ${n} headline`, source, host: "h", ageMin: null });
  const mixed = interleaveBySource([it("A", 1), it("A", 2), it("B", 1), it("B", 2)]);
  expect(mixed.map((i) => i.source)).toEqual(["A", "B", "A", "B"]);
});

describe("intelNews (injected seams)", () => {
  const feeds = [
    { name: "Feed One", url: "https://one.example/feed" },
    { name: "Feed Two", url: "https://two.example/feed" },
  ];
  const okFetcher = async (url: string) => (url.includes("one.example") ? RSS : ATOM);

  test("happy path: items from both feeds, one egress event per fetch (host-only, ok)", async () => {
    _resetIntelCacheForTest();
    const events: { reason: string }[] = [];
    const v = await intelNews(true, { fetcher: okFetcher, decide: async () => PASS, emit: (e) => events.push(e), record: () => { }, feeds });
    expect(v.items.length).toBe(4);
    expect(events.length).toBe(2);
    expect(events.map((e) => e.reason).join("|")).toContain("one.example (ok)");
    for (const e of events) expect(e.reason).not.toContain("https://"); // host only, never the URL
  });

  test("one dead feed fails quiet (audited as failed); all dead ⇒ empty, never a throw", async () => {
    _resetIntelCacheForTest();
    const events: { reason: string }[] = [];
    const v = await intelNews(true, {
      fetcher: async (url) => { if (url.includes("two")) throw new Error("offline"); return RSS; },
      decide: async () => PASS, emit: (e) => events.push(e), record: () => { }, feeds,
    });
    expect(v.items.length).toBe(3);
    expect(events.some((e) => e.reason.includes("two.example (failed)"))).toBe(true);
    _resetIntelCacheForTest();
    const empty = await intelNews(true, { fetcher: async () => { throw new Error("air-gapped"); }, decide: async () => PASS, emit: () => { }, record: () => { }, feeds });
    expect(empty.items).toEqual([]);
  });

  test("FAIL-CLOSED: scanner findings drop the whole batch and record the block", async () => {
    _resetIntelCacheForTest();
    let recorded = "";
    const v = await intelNews(true, { fetcher: okFetcher, decide: async () => BLOCK, emit: () => { }, record: (b) => { recorded = b.reason; }, feeds });
    expect(v.items).toEqual([]);
    expect(recorded).toContain("bidi found");
  });

  test("FAIL-CLOSED: a THROWING scanner also drops the batch (never treated as safe)", async () => {
    _resetIntelCacheForTest();
    let recorded = "";
    const v = await intelNews(true, { fetcher: okFetcher, decide: async () => { throw new Error("sidecar dead"); }, emit: () => { }, record: (b) => { recorded = b.reason; }, feeds });
    expect(v.items).toEqual([]);
    expect(recorded).toContain("sidecar dead");
  });

  test("cache: within the TTL the wire is served without refetching; force bypasses", async () => {
    _resetIntelCacheForTest();
    let fetches = 0;
    const deps = { fetcher: async (u: string) => { fetches++; return okFetcher(u); }, decide: async () => PASS, emit: () => { }, record: () => { }, feeds };
    let t = 1_000_000_000_000;
    await intelNews(true, { ...deps, now: () => t });
    expect(fetches).toBe(2);
    t += INTEL_TTL_MS - 1000;
    await intelNews(false, { ...deps, now: () => t });
    expect(fetches).toBe(2); // served from cache
    await intelNews(true, { ...deps, now: () => t });
    expect(fetches).toBe(4); // force refetches
  });
});
