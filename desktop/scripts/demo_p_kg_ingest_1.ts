// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_kg_ingest_1.ts
//
// Increment P-KG-INGEST.1a — non-blocking background ingest with live progress + cancel (issue #110,
// ADR-0076). The ~25-minute import used to freeze the app with no status. Three proofs:
//   A. IMPORTER: emits a per-message progress countdown, and a cancel stops early while KEEPING the facts
//      learned so far (fail-safe — no torn write).
//   B. JOB: startImport returns a jobId immediately (the request never blocks), refuses a second
//      concurrent import, and a cancel marks the job cancelled.
//   C. FORMAT: the pure status-pill line the UI renders.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PersonalStore } from "../../harness/personal/store.ts";
import { randomKey } from "../../harness/personal/crypto.ts";
import { parseExport } from "../../harness/personal/import_adapters.ts";
import { importConversations } from "../../harness/personal/importer.ts";
import type { ScannerClient } from "../../harness/security/scanner_client.ts";
import { __resetImportJob, cancelImport, importJobStatus, startImport } from "../import_job.ts";
import { formatImportLine } from "../renderer/import_progress.ts";

const fail = (msg: string): never => { console.error(`FAIL: ${msg}`); process.exit(1); };
const ok = (msg: string): void => console.log(`   ${msg} ✓`);
const settle = () => new Promise((r) => setTimeout(r, 10));
const cleanScanner = ({ scan: async () => ({ findings: [] }) }) as unknown as ScannerClient;

// a tiny 2-conversation ChatGPT-shaped export
const convo = (id: string, text: string) => ({
  title: id,
  mapping: {
    root: { id: "root", message: null, parent: null, children: ["u"] },
    u: { id: "u", message: { author: { role: "user" }, create_time: 1, content: { content_type: "text", parts: [text] } }, parent: "root", children: [] },
  },
});

// ── A. importer: progress + fail-safe cancel ─────────────────────────────────
console.log("== [1/3] #110 importer emits progress + cancels fail-safe ==");
const dir = mkdtempSync(join(tmpdir(), "demo-ingest-"));
try {
  const conversations = parseExport([convo("c1", "I prefer Rust and I use vim"), convo("c2", "I deploy with Kubernetes")]).conversations;

  const store1 = PersonalStore.createWithKey(join(dir, "a.enc"), randomKey());
  const ticks: number[] = [];
  await importConversations(store1, cleanScanner, conversations, { vendor: "openai", scope: "personal", onProgress: (t) => ticks.push(t.messages) });
  if (ticks[0] !== 0) fail("first tick should be 0 (UI renders immediately)");
  if (Math.max(...ticks) !== 2) fail(`progress should climb to 2 messages, got ${Math.max(...ticks)}`);
  ok(`progress ticks emitted 0…${Math.max(...ticks)} (live countdown)`);

  const store2 = PersonalStore.createWithKey(join(dir, "b.enc"), randomKey());
  const ac = new AbortController();
  const sum = await importConversations(store2, cleanScanner, conversations, {
    vendor: "openai", scope: "personal", signal: ac.signal,
    onProgress: (t) => { if (t.conversations === 1) ac.abort(); }, // cancel after conversation 1
  });
  if (!sum.cancelled) fail("summary should be marked cancelled");
  if (sum.learned <= 0) fail("cancel must KEEP facts learned before the stop");
  if (store2.graph().facts.length !== sum.learned) fail("partial facts must be persisted (no torn write)");
  ok(`cancel stopped early, kept ${sum.learned} fact(s), store consistent (fail-safe)`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// ── B. job registry: non-blocking + single-flight + cancel ───────────────────
console.log("== [2/3] #110 background job: immediate return, single-flight, cancel ==");
__resetImportJob();
let finish!: (v: unknown) => void;
const started = startImport({ vendor: "openai", run: (onTick, signal) => new Promise((res) => { finish = res; onTick({ conversations: 0, totalConversations: 1, messages: 0, totalMessages: 3, learned: 0, blocked: 0 }); signal.addEventListener("abort", () => res({ ok: true, cancelled: true, learned: 1 })); }) });
if (!started.ok) fail("first start should succeed");
const jobId = (started as { jobId: string }).jobId;
if (importJobStatus(jobId)?.state !== "running") fail("job should be running immediately (request returned without waiting)");
ok("startImport returned a jobId immediately — the request does not block");

const second = startImport({ run: async () => ({ ok: true }) });
if (second.ok) fail("a second concurrent import must be refused");
ok("a second concurrent import is refused (no two writers on the encrypted store)");

if (!cancelImport(jobId).ok) fail("cancel should succeed");
await settle();
if (importJobStatus(jobId)?.state !== "cancelled") fail("job should be cancelled after abort");
ok("cancel aborts the run; job marked cancelled (partial facts kept)");

// ── C. the status line the pill shows ────────────────────────────────────────
console.log("== [3/3] #110 progress pill line ==");
const running = formatImportLine({ state: "running", messages: 3, totalMessages: 10, learned: 5, blocked: 1 });
if (running.pct !== 30 || running.done || !running.line.includes("3/10")) fail(`running line wrong: ${JSON.stringify(running)}`);
const done = formatImportLine({ state: "done", messages: 10, totalMessages: 10, learned: 7, blocked: 0 });
if (done.pct !== 100 || !done.done) fail("done should be 100% + final");
ok(`pill shows "${running.line}" → "${done.line}"`);

console.log("demo-P-KG-INGEST.1 OK");
process.exit(0);
