// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_perf_4.ts
//
// Increment P-PERF.4 — incremental session index + tail-first transcripts + AC-only prefetch
// (ADR-0131). The sidebar polls the session list; every poll used to re-read and re-parse EVERY
// session .jsonl (megabytes of sync I/O with a long history), and a resume shipped the WHOLE
// transcript. Now a poll re-parses only what changed, a resume loads a bounded tail with an honest
// "last N of M" total, and the transcript prefetch warm runs ONLY on AC power.

import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveTier } from "../renderer/perf_tier.ts";
import { __resetSessionIndex, __sessionIndexStats, listSessions, sessionMessages } from "../sessions.ts";

const fail = (msg: string): never => { console.error(`FAIL: ${msg}`); process.exit(1); };
const ok = (msg: string): void => console.log(`   ${msg} ✓`);

console.log("== #ADR-0131 session I/O: parse once, page the tail, prefetch only on AC ==");

// a workspace with 30 sessions of 20 messages each
const CWD = "/demo/repo";
const ln = (o: unknown): string => JSON.stringify(o);
const root = mkdtempSync(join(tmpdir(), "lucid-perf4-")); // atomic, random name (js/insecure-temporary-file)
const dir = join(root, "enc");
mkdirSync(dir, { recursive: true });
for (let s = 0; s < 30; s++) {
  const lines = [ln({ type: "session", id: `s${s}`, cwd: CWD })];
  for (let m = 0; m < 10; m++) {
    lines.push(ln({ type: "message", message: { role: "user", content: [{ type: "text", text: `s${s} q${m}` }] } }));
    lines.push(ln({ type: "message", message: { role: "assistant", usage: { input: 1, output: 1 }, model: "anthropic/m", content: [{ type: "text", text: `s${s} a${m}` }] } }));
  }
  writeFileSync(join(dir, `s${s}.jsonl`), lines.join("\n"));
}

try {
  // 1) cold scan parses everything ONCE…
  __resetSessionIndex();
  const first = listSessions(CWD, root);
  if (first.sessions.length !== 30) fail(`expected 30 sessions, got ${first.sessions.length}`);
  if (__sessionIndexStats().parses !== 30) fail("cold scan should parse all 30 files");
  ok("cold scan: 30 files parsed once, 30 sessions listed");

  // 2) …and the poll that used to re-read megabytes now re-parses NOTHING
  for (let i = 0; i < 10; i++) listSessions(CWD, root);
  if (__sessionIndexStats().parses !== 30) fail("10 warm polls must add ZERO re-parses");
  ok("10 sidebar polls later: still 30 parses total — warm polls are stat()-only");

  // 3) an appended turn (append-only .jsonl growth) re-parses only ITS file, and the result reflects it
  appendFileSync(join(dir, "s7.jsonl"), "\n" + ln({ type: "message", message: { role: "assistant", usage: { input: 1, output: 1 }, model: "anthropic/m", content: [{ type: "text", text: "new turn" }] } }));
  const after = listSessions(CWD, root);
  if (__sessionIndexStats().parses !== 31) fail("one changed file must cost exactly one re-parse");
  if (after.sessions.find((s) => s.id === "s7")!.turns !== 11) fail("the re-parse must be reflected (not stale)");
  ok("one new chat turn: exactly 1 re-parse (s7), fresh turn count shown — never stale, never wasteful");

  // 4) tail-first resume: bounded payload + the honest total
  const page = sessionMessages("s3", 6, root);
  if (page.total !== 20 || page.messages.length !== 6) fail("expected the last 6 of 20");
  if (page.messages[5]!.text !== "s3 a9") fail("the tail must end at the newest message");
  ok(`resume pages the TAIL: last ${page.messages.length} of ${page.total} (UI shows the truncation note); limit 0 still returns all`);

  // 5) the prefetch warm is AC-only: the SAME gate the renderer uses (perf tier must be `full`)
  const onBattery = resolveTier("auto", { onBattery: true, batteryLevel: 0.5, cores: 16, reducedMotion: false });
  const onAc = resolveTier("auto", { onBattery: false, batteryLevel: null, cores: 16, reducedMotion: false });
  if (onBattery === "full") fail("on battery the tier must not be full");
  if (onAc !== "full") fail("on AC the tier must be full");
  ok(`prefetch gate: tier on AC = "${onAc}" (warm runs at idle) · on battery = "${onBattery}" (warm skipped — prefetch is anti-battery)`);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("demo-P-PERF.4 OK");
process.exit(0);
