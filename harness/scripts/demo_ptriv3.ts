// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_ptriv3.ts
//
// P-TRIV.3 (ADR-0176): bank expansion + the executive INTEL WIRE. Proves:
//   [1] the working banks hit their new floors - developer/security/manager at 100 questions each,
//       executive at 50 seeded - all shape-valid, duplicate-free across EVERY bank;
//   [2] RSS/Atom parsing + sanitation: CDATA, entities, hostile markup neutralized to text, stub
//       titles dropped, per-feed caps enforced;
//   [3] the FAIL-CLOSED batch scan: scanner findings OR a dead/throwing scanner drop the whole
//       refresh (questions-only), and the block is recorded - never "safe by default";
//   [4] fail-QUIET fetching: a dead feed is audited and skipped; ALL dead ⇒ empty wire, no throw;
//   [5] the per-fetch first-party egress audit: one event per reach-out, HOST only, never the URL;
//   [6] the renderer line: a hostile headline renders as escaped TEXT with no answer pills; then a
//       LIVE fetch through the REAL feeds + REAL scanner (informational: offline ⇒ empty is the
//       designed air-gap behavior, so it cannot fail the demo).
//
// Run with: bun run harness/scripts/demo_ptriv3.ts

import type { GateDecision } from "../../harness/security/gate.ts";
import { _resetIntelCacheForTest, intelNews, parseRssTitles, stopIntelScanner } from "../../desktop/intel_news.ts";
import { isTriviaQuestion } from "../../desktop/renderer/trivia.ts";
import { TRIVIA_BANK } from "../../desktop/renderer/trivia_bank.ts";
import { TRIVIA_EXEC_BANK, TRIVIA_MANAGER_BANK, TRIVIA_SECURITY_BANK } from "../../desktop/renderer/trivia_roles.ts";
import { newsLineHtml } from "../../desktop/renderer/trivia_news.ts";

function fail(m: string): never { stopIntelScanner(); console.error(`FAIL: ${m}`); process.exit(1); }
function ok(m: string): void { console.log(`  PASS  ${m}`); }

console.log("P-TRIV.3 demo - 100-question banks + the executive INTEL WIRE\n");

// [1] bank floors + global duplicate-freedom
{
  const banks: [string, readonly { q: string }[], number][] = [
    ["developer", TRIVIA_BANK, 100], ["security", TRIVIA_SECURITY_BANK, 100],
    ["manager", TRIVIA_MANAGER_BANK, 100], ["executive", TRIVIA_EXEC_BANK, 50],
  ];
  for (const [name, bank, floor] of banks) {
    if (bank.length < floor) fail(`${name} bank below its floor: ${bank.length} < ${floor}`);
    for (const e of bank) if (!isTriviaQuestion(e)) fail(`${name} bank has an invalid entry`);
  }
  const all = banks.flatMap(([, b]) => b.map((e) => e.q));
  if (new Set(all).size !== all.length) fail("a prompt appears twice across the banks");
  ok(`banks: developer ${TRIVIA_BANK.length}, security ${TRIVIA_SECURITY_BANK.length}, manager ${TRIVIA_MANAGER_BANK.length}, executive ${TRIVIA_EXEC_BANK.length} - all valid, zero duplicates anywhere`);
}

// [2] parse + sanitize
const RSS = `<rss><channel>
  <item><title><![CDATA[Army awards $1.2B C2 contract &amp; options]]></title></item>
  <item><title><script>alert(1)</script>DIB cyber rule <b>lands</b></title></item>
  <item><title>ok</title></item>
</channel></rss>`;
{
  const items = parseRssTitles(RSS, "Fixture", "fixture.example", Date.now());
  if (items.length !== 2) fail(`expected 2 parsed titles, got ${items.length}`);
  if (items[0]!.title !== "Army awards $1.2B C2 contract & options") fail(`CDATA/entity title wrong: ${items[0]!.title}`);
  if (items[1]!.title.includes("<")) fail("markup survived sanitation");
  const flood = `<rss>${Array.from({ length: 40 }, (_, i) => `<item><title>Flood headline number ${i}</title></item>`).join("")}</rss>`;
  if (parseRssTitles(flood, "F", "h", 0).length > 8) fail("per-feed cap not enforced");
  ok("parse/sanitize: CDATA + entities decoded, hostile markup neutralized to text, stubs dropped, flood capped");
}

const PASS_D: GateDecision = { block: false, reason: "clean", trustLabel: "trusted", findings: [], failClosed: false };
const feeds = [{ name: "One", url: "https://one.example/feed" }, { name: "Two", url: "https://two.example/feed" }];

// [3] fail-closed scan
{
  _resetIntelCacheForTest();
  let recorded = "";
  const blocked = await intelNews(true, {
    fetcher: async () => RSS,
    decide: async () => ({ block: true, reason: "bidi override found", trustLabel: "quarantined", findings: [], failClosed: false }),
    emit: () => { }, record: (b) => { recorded = b.reason; }, feeds,
  });
  if (blocked.items.length !== 0) fail("scanner findings did NOT drop the batch");
  if (!recorded.includes("bidi override")) fail("block was not recorded");
  _resetIntelCacheForTest();
  const dead = await intelNews(true, { fetcher: async () => RSS, decide: async () => { throw new Error("sidecar dead"); }, emit: () => { }, record: () => { }, feeds });
  if (dead.items.length !== 0) fail("a DEAD scanner must drop the batch (invariant #3)");
  ok("fail-closed: findings drop the whole refresh (recorded); a dead scanner drops it too - never 'safe'");
}

// [4]+[5] fail-quiet fetching + host-only egress audit
{
  _resetIntelCacheForTest();
  const events: string[] = [];
  const v = await intelNews(true, {
    fetcher: async (u) => { if (u.includes("two")) throw new Error("offline"); return RSS; },
    decide: async () => PASS_D, emit: (e) => events.push(e.reason ?? ""), record: () => { }, feeds,
  });
  if (v.items.length !== 2) fail("a dead feed killed the wire (must fail quiet)");
  if (events.length !== 2) fail(`expected 2 egress events, got ${events.length}`);
  if (!events.some((r) => r.includes("one.example (ok)")) || !events.some((r) => r.includes("two.example (failed)"))) fail("egress events missing ok/failed hosts");
  if (events.some((r) => r.includes("https://"))) fail("an egress event leaked a full URL (must be host-only)");
  _resetIntelCacheForTest();
  const empty = await intelNews(true, { fetcher: async () => { throw new Error("air-gapped"); }, decide: async () => PASS_D, emit: () => { }, record: () => { }, feeds });
  if (empty.items.length !== 0) fail("air-gapped run must yield an empty wire");
  ok("fail-quiet + audit: dead feed skipped, every reach-out audited host-only, air-gap ⇒ empty wire, no throw");
}

// [6] renderer line escaping + live reach-out (informational)
{
  const html = newsLineHtml({ title: `<img src=x onerror=alert(1)> M&A wave hits the DIB`, source: "Fixture", host: "fixture.example", ageMin: 12 });
  if (html.includes("<img")) fail("hostile headline leaked markup into the ticker line");
  if (html.includes("data-tch")) fail("a news line must not be answerable");
  ok("renderer: hostile headline renders as escaped text, INTEL line carries no answer pills");

  _resetIntelCacheForTest();
  const live = await intelNews(true).catch(() => null); // REAL feeds + REAL scanner; offline ⇒ [] by design
  const first = live?.items[0];
  console.log(`  info  LIVE wire: ${live ? `${live.items.length} scanned headline(s)` : "unavailable"}${first ? ` - e.g. "${first.title.slice(0, 70)}" (${first.source})` : ""}`);
}

stopIntelScanner();
console.log("\nP-TRIV.3 demo: ALL GREEN - 100-question banks and a scanned, audited INTEL WIRE.");
