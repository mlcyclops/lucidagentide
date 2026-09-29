// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_p_progress_3.ts
//
// P-PROGRESS.3 (ADR-0412): the beta.10 quiet footer stays the default for everyone; the P-PROGRESS.1 detail
// (progress line, liveness, folder queue) and the experimental time estimate come back as opt-ins.
// Proven headless against the real seams:
//   [1] the defaults: quiet (one line), no estimate, and both choices persist;
//   [2] estimate off: the progress line, the tool-row / subagent / HUD ETA and the folder queue carry no number;
//   [3] estimate on: a number appears once history supports one, labelled as an estimate, and the
//       "ETA estimating" placeholder the operator objected to never reaches the user;
//   [4] the progress ring (on by default): the arc is the percent, empty without history, red when dead.
// (The orbit glance takes the same switch; orbit_layout.test.ts covers it. It is not imported here because it
// pulls the DOM-typed bridge into the root, DOM-free typecheck.)
//
// Run: bun run harness/scripts/demo_p_progress_3.ts

import { agedProgress, DurationHistory, ETA_ESTIMATING, estimateFromSamples, etaPhrase, progressLine, progressView, wholeEtaPhrase, withoutEstimate } from "../../desktop/turn_progress.ts";
import * as prefs from "../../desktop/renderer/status_prefs.ts";

const fail = (m: string): never => { console.error(`FAIL: ${m}`); process.exit(1); };
const ok = (cond: boolean, m: string) => { if (!cond) fail(m); console.log(`  ok  ${m}`); };

// The renderer's localStorage, in memory: the prefs module reads it lazily, on first use.
const store = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  },
});

console.log("== #ADR-0412 P-PROGRESS.3: quiet by default; detail and the estimate are opt-in ==\n");

console.log("[1] the defaults");
ok(prefs.statusDetail() === "line", "a fresh install keeps the quiet one-line footer");
ok(prefs.statusEta() === false, "the experimental time estimate is off until the user turns it on");
prefs.setStatusDetail("full"); prefs.setStatusEta(true);
ok(store.get("lucid.status-detail") === "full" && store.get("lucid.status-eta") === "1", "both choices persist in localStorage");
prefs.setStatusDetail("line"); prefs.setStatusEta(false);

console.log("\n[2] estimate off: no number anywhere");
const now = 1_000_000;
const h = new DurationHistory();
for (const ms of [20_000, 40_000, 60_000, 80_000, 100_000]) h.addTurn("m", ms);
const p = progressView({ busy: true, dead: false, startedAt: now - 30_000, lastActivityAt: now - 1_000, stepsDone: 2, stepsOpen: [], model: "m", history: h, now });
const off = withoutEstimate(agedProgress(p, 2_000));
ok(progressLine(off, false) === "32 s \u00b7 step 2", `the progress line reads: ${progressLine(off, false)}`);
ok(off.estimate.percent === null, "no percent, so the bar runs indeterminate");
ok(prefs.shownEta(etaPhrase(p.estimate), false) === "", "the HUD, tool-row and subagent ETA spans stay empty");

console.log("\n[3] estimate on: a number or nothing");
const on = agedProgress(p, 2_000);
ok(progressLine(on, true) === "32 s \u00b7 step 2 \u00b7 about 48 s left (est.)", `the progress line reads: ${progressLine(on, true)}`);
ok(prefs.shownEta(wholeEtaPhrase(on.estimate, []), true) === "about 48 s left (est.)", "the HUD line carries the whole-prompt ETA");
const fresh = etaPhrase(estimateFromSamples(5_000, [], 2));
ok(fresh === ETA_ESTIMATING && prefs.shownEta(fresh, true) === "", "without history the placeholder is suppressed, not shown");

console.log("\n[4] the progress ring");
ok(prefs.statusRing() === true, "the ring is on by default");
const r = prefs.ringView(on, false);
ok(r.pct === p.estimate.percent && r.tone === "run" && !r.tip.includes("left"), `it fills to ${r.pct}% with the estimate off, and its tooltip names no time`);
ok(prefs.ringView(withoutEstimate(on), false).pct === null, "without history it stays empty");
ok(prefs.ringView({ ...on, liveness: { state: "dead", label: "gone", detail: "" } }, false).tone === "dead", "a dead process turns it red");

console.log("\nP-PROGRESS.3 demo: all checks passed.");
