// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_pchata.ts
//
// P-CHAT.A (ADR-0179): the sectioned-answer keystone. The DOM wiring (settle-time transform in app.ts +
// the collapsed-by-default subagent card) is live-renderer behavior that needs in-app QA; this demo
// proves the PURE logic the wiring depends on - the fence-aware heading/rule splitter and the
// "don't accordion a trivial answer" gate.
//
// Run with: bun run harness/scripts/demo_pchata.ts

import { sectionizeAnswer, shouldSectionize } from "../../desktop/renderer/answer_sections.ts";

function fail(m: string): never { console.error(`FAIL: ${m}`); process.exit(1); }
function ok(m: string): void { console.log(`  PASS  ${m}`); }

console.log("P-CHAT.A demo - sectioned answer (pure keystone)\n");

// [1] a real multi-heading answer -> intro + collapsible sections
const answer = "Here is the summary.\n\n## Problem\nIt broke because X.\n\n## What I changed\nFixed it via Y.\n\n```bash\n# not a heading\nmake test\n```\n\n## Verification\nall green";
const secs = sectionizeAnswer(answer);
if (secs.map((s) => s.title).join("|") !== "|Problem|What I changed|Verification") fail(`unexpected titles: ${secs.map((s) => s.title)}`);
if (secs[0]!.title !== null || secs[0]!.body !== "Here is the summary.") fail("intro not captured");
if (!secs[1]!.body.includes("because X")) fail("section body lost");
if (!shouldSectionize(secs)) fail("multi-heading answer should sectionize");
ok("multi-heading answer -> intro + collapsible sections (titles/levels/bodies intact)");

// [2] fence-aware: a `#` inside a code block is not a heading
const inFence = sectionizeAnswer("## Real\n```\n# echo hi\n```\n## Also");
if (inFence.map((s) => s.title).join("|") !== "Real|Also") fail("fence heading leaked as a section");
ok("fence-aware: a `#` inside a code block is not treated as a heading");

// [3] rules split; [4] a trivial answer is never accordioned
const ruled = sectionizeAnswer("alpha\n\n-----\n\nbravo");
if (ruled.length !== 2 || shouldSectionize(ruled)) fail("rule split / trivial gate wrong");
const trivial = sectionizeAnswer("a short reply with `code` and no headings");
if (trivial.length !== 1 || shouldSectionize(trivial)) fail("a heading-less answer must render inline, not accordioned");
ok("horizontal rules split into blocks; a heading-less answer stays a single inline block");

console.log("\nP-CHAT.A demo complete - pure sectionizer verified. DOM wiring (settle transform + collapsed subagent) is typechecked and awaits in-app QA.");
