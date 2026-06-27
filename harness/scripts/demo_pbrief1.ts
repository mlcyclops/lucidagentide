// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_pbrief1.ts
//
// P-BRIEF.1 (ADR-0070): generate an Executive Engineering Update from THIS repo's own change logs -
// DECISIONS.md (ADRs) + PROGRESS.md - with zero network and no audio vendor. Proves the decision-
// independent core: parse → structured update (load-bearing deps / tech debt / upcoming decisions) →
// written brief + a TTS-ready two-host podcast script through the ScriptOnly backend seam.
//
// Run with: bun run harness/scripts/demo_pbrief1.ts

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  buildEngineeringUpdate, renderEngineeringBrief, buildPodcastScript, renderScript, ScriptOnlyBackend,
} from "../brief/engineering_update.ts";

const ROOT = join(import.meta.dir, "..", "..");
const read = (f: string) => (existsSync(join(ROOT, f)) ? readFileSync(join(ROOT, f), "utf8") : "");
const fail = (m: string): never => { console.error(`FAIL: ${m}`); process.exit(1); };

// A real-ish label without Date.now (purity): read the branch from .git/HEAD if present.
let branch = "unknown";
try { const h = read(".git/HEAD"); const m = h.match(/ref:\s*refs\/heads\/(.+)/); if (m) branch = m[1]!.trim(); } catch { /* ignore */ }

try {
  const progressMd = read("PROGRESS.md");
  const decisionsMd = read("DECISIONS.md");
  if (!progressMd && !decisionsMd) fail("no PROGRESS.md/DECISIONS.md to read");

  const update = buildEngineeringUpdate({ label: `LucidAgentIDE / ${branch}`, progressMd, decisionsMd, recentWindow: 6 });

  console.log("== [1/3] structured Executive Engineering Update from the repo's own logs ==");
  console.log(`   shipped=${update.recentlyShipped.length}  load-bearing=${update.loadBearingDependencies.length}  ` +
    `tech-debt=${update.techDebt.length}  upcoming-decisions=${update.upcomingDecisions.length}  risks=${update.risks.length}`);
  if (update.upcomingDecisions.length === 0) fail("expected at least one open decision from the live DECISIONS.md");
  if (update.techDebt.length === 0) fail("expected tech-debt signal from PROGRESS 'stubbed' lines");

  console.log("\n== [2/3] the written brief (first lines) ==");
  const brief = renderEngineeringBrief(update);
  for (const want of ["## Load-bearing dependencies", "## Tech debt", "## Upcoming decisions"]) {
    if (!brief.includes(want)) fail(`brief missing section: ${want}`);
  }
  console.log(brief.split("\n").slice(0, 14).map((l) => "   " + l).join("\n"));

  console.log("\n== [3/3] TTS-ready podcast script through the ScriptOnly backend (no cloud vendor) ==");
  const script = buildPodcastScript(update);
  const result = await new ScriptOnlyBackend().synthesize(script);
  if (result.backendId !== "script-only" || result.audioPath) fail("default path must be script-only with no audio");
  const speakers = new Set(script.turns.map((t) => t.speaker));
  if (speakers.size !== 2) fail("podcast script must be a two-host dialogue");
  console.log(`   backend=${result.backendId}  turns=${script.turns.length}  speakers=${[...speakers].join(" + ")}`);
  console.log(`   note: ${result.note}`);
  console.log(renderScript(script).split("\n").slice(0, 6).map((l) => "   " + l).join("\n"));

  console.log("\nPASS: Executive Engineering Update generated from the repo's logs — written brief + two-host script, air-gap clean, audio backend behind the seam.");
} catch (e) {
  fail(String((e as Error)?.stack ?? e));
}
process.exit(0);
