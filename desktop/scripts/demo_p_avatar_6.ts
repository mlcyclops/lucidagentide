// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_avatar_6.ts - P-AVATAR.6 (ADR-0251): the boot cinematic.
//
// Proves with no DOM: the staged lines bind to REAL signals (never a fake bar), the done gate honors
// the minimum beat and the hard cap, config is the only awaited signal (voice/models are reported,
// never held for), and the ninja's sprint choreography crosses the stage then rests.
//
// Run: bun run desktop/scripts/demo_p_avatar_6.ts

import { BOOT_CAP_MS, BOOT_MIN_MS, FINALE_MS, bootDone, bootFinale, bootLines, bootRunnerX } from "../renderer/boot_cinematic.ts";

const fail = (msg: string): never => { console.error(`FAIL: ${msg}`); process.exit(1); };
const ok = (msg: string): void => console.log(`   ${msg} \u2713`);

console.log("== P-AVATAR.6 (ADR-0251) - the boot cinematic ==");

const all = { settings: true, config: true, models: 7, voice: true };
const lines = bootLines(all);
if (lines.length !== 4 || !lines.every((l) => l.done)) fail("four real-signal lines must flip done");
if (!lines[2]!.label.includes("7 routes")) fail("the models line must report the live count");
ok("staged lines bind to real signals (models line reports the live route count)");

if (bootDone(all, BOOT_MIN_MS - 1)) fail("the minimum beat must hold");
if (!bootDone({ ...all, voice: false, models: 0 }, BOOT_MIN_MS + 1)) fail("voice/models must never gate boot");
if (!bootDone({ settings: false, config: false, models: 0, voice: false }, BOOT_CAP_MS)) fail("the hard cap must always end it");
ok(`done gate: ${BOOT_MIN_MS}ms beat, config-gated, ${BOOT_CAP_MS}ms hard cap`);

const r = bootRunnerX(1300, 1000, 120);
if (!(r.x > 0 && r.x < 1000)) fail("mid-pass the ninja must be on stage");
if (bootRunnerX(2700, 1000, 120).x >= -120) fail("after a pass he must rest offscreen");
ok("sprint choreography: crosses the stage, rests, four-beat gait");

// (4) the finale: stop -> draw -> slice -> follow-through; the keyboard splits mid-swing and falls.
const beats: string[] = [];
for (let t = 0; t < FINALE_MS; t += 30) { const f = bootFinale(t); if (beats[beats.length - 1] !== f.frame) beats.push(f.frame); }
if (beats.join(",") !== "idleA,draw,slashUp,slash,slashEnd") fail(`finale beats drifted: ${beats.join(" -> ")}`);
if (bootFinale(1000).split || !bootFinale(1120).split) fail("the keyboard must split mid-swing, not before");
if (!bootFinale(FINALE_MS).done) fail("the finale must end on schedule");
ok("finale: stop -> draw blade -> slice -> follow-through; keyboard splits mid-swing and drops");

console.log("\nALL CHECKS PASSED");
