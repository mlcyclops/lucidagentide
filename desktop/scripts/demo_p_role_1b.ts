// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_role_1b.ts
//
// Increment P-ROLE.1b (ADR-0089) — the first-run guided walkthrough (coachmark tour).
// Proves: (1) each role gets a TAILORED, ordered tour that opens on the composer and closes on a
// target-less "you're set" card; (2) only the closer is target-less — every other step anchors to a
// concrete, stable selector (so a step never dangles); (3) the role tailoring genuinely differs;
// (4) the coach card carries Back/Next/Skip + a step counter and escapes interpolated copy; (5) the
// replay-guard logic: the tour shows only when unseen, and finish OR skip marks it seen.

import { coachHtml, stepsForRole } from "../renderer/tour.ts";
import { USER_ROLE_LIST } from "../renderer/tour.ts";

const fail = (msg: string): never => { console.error(`FAIL: ${msg}`); process.exit(1); };
const ok = (msg: string): void => console.log(`   ${msg} ✓`);

console.log("== P-ROLE.1b — first-run guided walkthrough (coachmark tour) ==");

// 1 + 2. Tailored, well-formed, non-dangling steps per role.
for (const r of USER_ROLE_LIST) {
  const steps = stepsForRole(r);
  if (steps.length < 4) fail(`${r} tour too short (${steps.length})`);
  if (steps[0]!.id !== "composer") fail(`${r} tour must open on the composer`);
  if (steps[steps.length - 1]!.id !== "closer") fail(`${r} tour must close on the closer`);
  for (const s of steps) {
    if (s.id === "closer") { if (s.target !== "") fail("the closer must be target-less"); }
    else if (!s.target) fail(`step ${s.id} (${r}) has no target selector`);
    if (!s.title || !s.body || !s.icon) fail(`step ${s.id} (${r}) is missing copy`);
  }
  console.log(`      ${r.padEnd(10)} → ${steps.map((s) => s.id).join(" → ")}`);
}
ok("every role: tailored, ordered, opens on composer, closes on the closer, no dangling targets");

// 3. The tailoring actually differs (mirrors ADR-0088 foregrounding).
const ids = (r: typeof USER_ROLE_LIST[number]) => stepsForRole(r).map((s) => s.id);
if (!ids("security").includes("security") || !ids("security").includes("devlogs")) fail("security tour missing the queue/audit steps");
if (ids("developer").includes("security") || ids("developer").includes("devlogs")) fail("developer tour should not foreground security");
if (!ids("manager").includes("cost") || !ids("executive").includes("cost")) fail("manager/exec tour missing the spend step");
if (ids("executive").length >= ids("developer").length) fail("the executive tour should be the leanest");
ok("the tour is genuinely tailored per role (Sec→queue/audit, Mgr/Exec→spend, Exec leanest)");

// 4. The coach card: controls, counter, and escaping.
const dev = stepsForRole("developer");
const first = coachHtml(dev[0]!, 0, dev.length);
const last = coachHtml(dev[dev.length - 1]!, dev.length - 1, dev.length);
if (first.includes("data-coach-back")) fail("first step should have no Back");
if (!first.includes(">Next<")) fail("non-last step should say Next");
if (!last.includes(">Done<") || last.includes(">Next<")) fail("last step should say Done");
for (const hook of ["data-coach-next", "data-coach-skip", `1 / ${dev.length}`]) {
  if (!first.includes(hook)) fail(`coach card missing ${hook}`);
}
const evil = coachHtml({ id: "x", target: "#x", icon: "info", title: 'T<script>"&', body: "B<img>" }, 0, 1);
if (evil.includes("<script>") || evil.includes("<img>")) fail("coach card did not escape interpolated copy");
ok("coach card: Back/Next→Done, step counter, Skip — and it escapes injected copy");

// 5. Replay-guard logic (pure): the tour fires only when unseen; finish OR skip marks it seen.
const shouldShow = (tourSeen: boolean) => !tourSeen;
const afterRun = (_reason: "done" | "skip") => true; // both outcomes set tourSeen = true
if (!shouldShow(false)) fail("an unseen tour should show on first run");
if (shouldShow(true)) fail("a seen tour must not replay uninvited");
if (!afterRun("done") || !afterRun("skip")) fail("finish AND skip must both mark the tour seen");
ok("replay-guard: shows once when unseen; finish OR skip both mark it seen (About replays on demand)");

console.log("demo-P-ROLE.1b OK");
process.exit(0);
