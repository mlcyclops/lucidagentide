// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_p_progress_2.ts
//
// P-PROGRESS.2 (ADR-0408): the activity window shows what matters and every worker says when it will be done.
//   [1] quick calls fold into one summary line; failed, repeated and empty calls are "processing";
//   [2] a call's doing line names its subject even when its arguments arrive as an object;
//   [3] a running worker always states an ETA, "ETA estimating" until history supports a number;
//   [4] the whole prompt's ETA is its slowest part, a floor while any part is unknown;
//   [5] each subagent run gets an ETA from finished runs, which are counted once and kept across sessions.
//
// Run: bun run harness/scripts/demo_p_progress_2.ts

import { foldSummary, QUICK_MS, stepFate, stepKey } from "../../desktop/renderer/tool_fold.ts";
import { describeTool } from "../../desktop/renderer/tool_describe.ts";
import { mergeRunSamples, runEta } from "../../desktop/renderer/subagent_filter.ts";
import { DurationHistory, ETA_ESTIMATING, estimateFromSamples, progressLine, progressView, wholeEtaPhrase } from "../../desktop/turn_progress.ts";
import { transcriptStartedAt } from "../../desktop/subagent_activity.ts";

const fail = (m: string): never => { console.error(`FAIL: ${m}`); process.exit(1); };
const ok = (cond: boolean, m: string) => { if (!cond) fail(m); console.log(`  ok  ${m}`); };

console.log("== #ADR-0408 P-PROGRESS.2: fold the noise, give every worker an ETA ==\n");

console.log("[1] the fold rule");
const good = { informative: true, redundant: false, ok: true };
ok(stepFate({ ...good, elapsedMs: QUICK_MS - 1 }) === "quick", "a call under 5 s is summarized");
ok(stepFate({ ...good, elapsedMs: QUICK_MS }) === "row", "a call of 5 s or more keeps its own row");
ok(stepFate({ ...good, ok: false, elapsedMs: 60_000 }) === "processing", "a crash is processing, whatever its length");
ok(stepFate({ ...good, redundant: true, elapsedMs: 60_000 }) === "processing", "a repeat of an earlier call is processing");
ok(stepFate({ ...good, informative: false, elapsedMs: 100 }) === "processing", "a call that says nothing is processing");
ok(stepKey("bash", "git  status") === stepKey("execute", "git status\n"), "a repeat is the same tool kind and arguments, whitespace aside");
const line = foldSummary(["read", "read", "grep", "bash"], 1);
ok(line === "Read 2 files, 1 search, ran 1 command, processing 1", `the fold line reads: ${line}`);

console.log("\n[2] the doing line");
const d = describeTool({ name: "read", input: JSON.stringify({ path: "desktop/turn_progress.ts" }, null, 2) });
ok(d.doing === "Reading desktop/turn_progress.ts" && d.informative, "an object argument names its path, not its brace");
ok(!describeTool({ name: "tool", title: "tool" }).informative, "a bare \"tool\" call is flagged as saying nothing");

console.log("\n[3] a running worker always states an ETA");
const now = 1_000_000;
const none = progressView({ busy: true, dead: false, startedAt: now - 9_000, lastActivityAt: now - 500, stepsDone: 2, stepsOpen: [], model: "m", history: new DurationHistory(), now });
ok(progressLine(none).endsWith(ETA_ESTIMATING), `no history: ${progressLine(none)}`);
const h = new DurationHistory();
for (const ms of [30_000, 30_000, 30_000, 30_000, 30_000]) h.addTurn("m", ms);
const some = progressView({ busy: true, dead: false, startedAt: now - 9_000, lastActivityAt: now - 500, stepsDone: 2, stepsOpen: [], model: "m", history: h, now });
ok(progressLine(some) === "9 s \u00b7 step 2 \u00b7 about 21 s left (est.)", `with history: ${progressLine(some)}`);

console.log("\n[4] the whole prompt");
const turn = estimateFromSamples(10_000, [40_000, 40_000], 2);
ok(wholeEtaPhrase(turn, [90_000]) === "about 1 m 30 s left (est.)", "a helper outlasting the turn sets the prompt's ETA");
ok(wholeEtaPhrase(turn, [90_000, null]) === "at least 1 m 30 s left (est.)", "an unknown helper makes it a floor");
ok(wholeEtaPhrase(estimateFromSamples(1, [], 2), [null]) === ETA_ESTIMATING, "nothing known: ETA estimating");

console.log("\n[5] subagent runs");
const start = Date.parse("2026-09-27T01:34:27.654Z");
ok(transcriptStartedAt(`{"type":"title"}\n{"type":"session","timestamp":"2026-09-27T01:34:27.654Z"}\n`) === start, "a run starts at its transcript's session header");
const finished = [{ name: "a", done: true, lastAt: start + 60_000, startedAt: start, endedAt: start + 60_000 }, { name: "b", done: true, lastAt: start + 80_000, startedAt: start, endedAt: start + 80_000 }];
const stored = mergeRunSamples([], finished);
ok(stored.length === 2 && mergeRunSamples(stored, finished) === stored, "finished runs are history once, however often they are polled");
const e = runEta({ name: "c", done: false, lastAt: start + 20_000, startedAt: start }, stored.map((s) => s.ms), start + 20_000);
ok(e.live && e.etaMs === 60_000 && e.label === "about 1 m left (est.)", `a live run: ${e.label}`);
ok(runEta({ name: "d", done: false, lastAt: start, startedAt: start }, [60_000], start + 1).label === ETA_ESTIMATING, "one finished run is not enough history: ETA estimating");

console.log("\nP-PROGRESS.2 demo: all checks passed.");
