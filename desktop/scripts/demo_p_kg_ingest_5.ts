// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_kg_ingest_5.ts
//
// Increment P-KG-INGEST.5 - the ingest can no longer hang, and Stop always works (ADR-0264).
//
// Reported symptom: "Importing chat history" sat at 0/500 messages, 0 facts, and pressing Stop stuck on
// "Stopping...". Root cause: ACPClient.request() had NO timeout and never rejected when the omp child
// died, so the very first `initialize` / `session/new` of the util connection stayed pending forever. The
// import awaited it before message 1, and cancel was only observed at conversation boundaries, so the
// abort was never seen. This demo proves the four properties that make that state impossible:
//
//   1. a mute agent times out (bounded request)
//   2. a dead agent rejects every in-flight request (drained on exit)
//   3. cancel is observed per MESSAGE and reaches the extractor (Stop interrupts, not waits)
//   4. a wedged job still reaches a terminal state, releasing single-flight for a retry
//
// Plus the UI half: a silent run renders as a STALL, not as a healthy-looking bar.

import { ACPClient } from "../acp.ts";
import { __resetImportJob, cancelImport, importJobStatus, startImport } from "../import_job.ts";
import { formatImportLine, STALL_MS } from "../renderer/import_progress.ts";
import { importConversations } from "../../harness/personal/importer.ts";
import { PersonalStore } from "../../harness/personal/store.ts";
import { randomKey } from "../../harness/personal/crypto.ts";
import type { ScannerClient } from "../../harness/security/scanner_client.ts";
import type { ImportResult } from "../personal.ts";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync, rmSync } from "node:fs";

const fail = (msg: string): never => { console.error(`FAIL: ${msg}`); process.exit(1); };
const ok = (msg: string): void => console.log(`   ${msg} \u2713`);

console.log("== #ADR-0264 the ingest cannot hang, and Stop always stops ==");

// ── 1. a spawned-but-mute agent must not wait forever ────────────────────────────
const mute = new ACPClient(process.execPath, ["-e", "process.stdin.resume(); setTimeout(() => {}, 60000);"], process.cwd());
mute.start();
let timedOut = false;
try { await mute.request("initialize", { protocolVersion: 1 }, { timeoutMs: 300 }); }
catch (e) { timedOut = /timed out/i.test(String(e)); }
if (!timedOut) fail("a mute agent must reject on the request timeout");
mute.stop();
ok("mute agent: initialize REJECTS on its bound (this exact call is what froze the import at 0/500)");

// ── 2. a dying agent must reject everything in flight ────────────────────────────
const dies = new ACPClient(process.execPath, ["-e", "process.stdin.on('data', () => process.exit(7));"], process.cwd());
dies.start();
const inflight = [
  dies.request("initialize", {}).then(() => "resolved", (e) => String(e)),
  dies.request("session/new", {}).then(() => "resolved", (e) => String(e)),
];
const outcomes = await Promise.all(inflight);
if (!outcomes.every((o) => /exited/i.test(o))) fail(`a dead agent must reject in-flight requests, got ${outcomes.join(" | ")}`);
if (!dies.isDead) fail("the client must know its child is gone");
ok("dead agent: BOTH in-flight requests reject (pending drained on exit, never left dangling)");

// ── 3. Stop is observed per message and reaches the extractor ────────────────────
const dbPath = join(tmpdir(), `lucid-demo-ingest5-${process.pid}.enc`);
const store = PersonalStore.createWithKey(dbPath, randomKey());
const cleanScanner = { scan: async () => ({ findings: [] }) } as unknown as ScannerClient;
const convos = [{ title: "One long conversation", messages: [
  { role: "user" as const, text: "I prefer Rust" },
  { role: "user" as const, text: "I use vim" },
  { role: "user" as const, text: "I like Postgres" },
] }];
const ac = new AbortController();
const extracted: string[] = [];
let signalReachedExtractor = false;
const summary = await importConversations(store, cleanScanner, convos, {
  vendor: "openai", scope: "work", extractorKind: "model",
  signal: ac.signal,
  extract: ({ user, signal }) => {
    extracted.push(user);
    signalReachedExtractor = signal === ac.signal;
    ac.abort(); // Stop pressed while the FIRST message is being extracted
    return [];
  },
});
try { if (existsSync(dbPath)) rmSync(dbPath); } catch { /* ignore */ }
if (extracted.length !== 1) fail(`abort must stop mid-conversation, but ${extracted.length} messages were extracted`);
if (!summary.cancelled) fail("the summary must report the run as cancelled");
if (summary.blocked !== 0) fail("a cancelled message must not be miscounted as a gate block");
ok("Stop mid-conversation: messages 2 and 3 never run (was: cancel only seen at conversation boundaries)");
if (!signalReachedExtractor) fail("the extractor must receive the abort signal");
ok("the same signal reaches the extractor, so an in-flight model call is interrupted, not awaited");

// ── 4. a wedged job still terminates, so the user can retry ──────────────────────
__resetImportJob();
const wedgedRun = (): Promise<ImportResult> => new Promise(() => {}); // ignores its signal entirely
const first = startImport({ run: wedgedRun });
if (!first.ok) fail("the first import should start");
const blocked = startImport({ run: async () => ({ ok: true }) });
if (blocked.ok) fail("single-flight must refuse a second concurrent import");
ok("single-flight holds while an import is genuinely running");

cancelImport(first.jobId);
const stopping = importJobStatus(first.jobId);
if (!stopping?.cancelRequestedAt) fail("Stop must record that cancellation was requested");
if (stopping.state !== "running") fail("the job should still be unwinding right after Stop");
ok('first Stop: job marked "Stopping", giving the run a grace period to unwind cleanly');

cancelImport(first.jobId); // the run is wedged and ignores the abort: force it
const stopped = importJobStatus(first.jobId);
if (stopped?.state !== "cancelled") fail("a second Stop must force the job to a terminal state");
ok("second Stop: FORCE-cancelled (a wedged run can never trap the UI on \"Stopping...\" forever)");

const retry = startImport({ run: async () => ({ ok: true, learned: 0 }) });
if (!retry.ok) fail("a new import must be allowed after a force-cancel");
ok("single-flight released: the user can start a new import without restarting the app");
__resetImportJob();

// ── 5. the pill tells the truth about a silent run ───────────────────────────────
const now = Date.now();
const healthy = formatImportLine({ state: "running", messages: 4, totalMessages: 500, learned: 2, blocked: 0, updatedAt: now, now });
if (healthy.stalled) fail("a run that just ticked is not stalled");
if (healthy.line !== "4/500 messages \u00b7 2 facts") fail(`unexpected healthy line: ${healthy.line}`);
ok(`healthy run renders the live countdown: "${healthy.line}"`);

const silent = formatImportLine({ state: "running", messages: 0, totalMessages: 500, learned: 0, blocked: 0, updatedAt: now - STALL_MS, now });
if (!silent.stalled) fail("a run silent past STALL_MS must be reported as stalled");
if (silent.done) fail("a stalled run is still cancellable, not terminal");
ok(`silent run is CALLED OUT instead of faking progress: "${silent.line}"`);

const unwinding = formatImportLine({ state: "running", messages: 2, totalMessages: 10, learned: 1, blocked: 0, updatedAt: now, cancelRequestedAt: now, now });
if (!unwinding.line.startsWith("Stopping")) fail("a cancel-requested run must show that it is stopping");
ok(`Stop pressed: "${unwinding.line}"`);

console.log("demo-P-KG-INGEST.5 OK");
process.exit(0);
