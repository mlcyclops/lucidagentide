// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_p_trainer_1.ts - P-TRAINER.1 (ADR-0252/0255): the interview engine drives a
// scripted extraction session over the WMO coverage map: scenario-first, one question at a time,
// five-whys on deviations, session cap, visible progress.

import { WMO_OBJECTIVES } from "../trainer/wmo_pack.ts";
import { nextQuestion, openingRecap, recordAnswer, startSession } from "../trainer/planner.ts";
import type { UnitForCoverage } from "../trainer/coverage.ts";

const fail = (m: string): never => {
  console.error(`FAIL: ${m}`);
  process.exit(1);
};

const units = new Map<string, readonly UnitForCoverage[]>(WMO_OBJECTIVES.map((o) => [o.objectiveId, []]));
let state = startSession(WMO_OBJECTIVES, units, { sessionCapMs: 8 * 60 * 1000 });
console.log(`LUCID: ${openingRecap(state)}`);

const SCRIPT = [
  "The client calls, we verify on a known number, ops enters it, the custodian releases before the cutoff.",
  "Well, usually. Except when the cutoff has passed we call the custodian desk for a manual exception.",
  "Because the desk can push a same-day wire until 5:30 if a manager signs off.",
  "The manager signs because the firm eats the risk if the client authenticated properly.",
  "It never made the written procedure because it depends on which custodian rep answers.",
  "That gap is why we log every manual exception in the ops journal.",
  "The journal review happens Monday mornings.",
  "Standard reviews are quarterly for A clients.",
];

let asked = 0;
let followups = 0;
let elapsed = 0;
for (const answer of SCRIPT) {
  const r = nextQuestion(state, elapsed);
  if (!r.question) break;
  // one-question-at-a-time: a second call must re-issue the SAME question
  const again = nextQuestion(r.state, elapsed);
  if (again.question?.text !== r.question.text) fail("planner issued a second question before the answer");
  asked++;
  if (r.question.kind === "followup") followups++;
  console.log(`LUCID (${r.question.kind}${r.question.whyDepth ? ` why#${r.question.whyDepth}` : ""}): ${r.question.text}`);
  console.log(`EXPERT: ${answer}`);
  state = recordAnswer(again.state, answer);
  elapsed += 60 * 1000;
}

if (asked === 0) fail("no questions asked");
const first = state.history[0];
if (!first || first.question.kind !== "scenario") fail("an unexplored objective must open with a scenario probe");
if (followups === 0) fail("deviation cues in the script must trigger five-whys followups");

// spend the cap: the session closes with a recap and never asks past it
const closed = nextQuestion(state, 9 * 60 * 1000);
if (closed.question !== null) fail("planner asked past the session cap");
if (!closed.closing?.includes("coverage")) fail("closing recap missing");
console.log(`LUCID: ${closed.closing}`);
console.log(`PASS: ${asked} questions (${followups} five-whys followups), scenario-first, one at a time, capped with a recap.`);
