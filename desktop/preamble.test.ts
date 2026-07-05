// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/preamble.test.ts
//
// Issue #54: standing guidance (persona, skill, <user-profile> profile) must be re-delivered on
// EVERY turn so it doesn't fade across a conversation; the cross-session <recalled-memory> recall
// is delivered ONCE per session.

import { expect, test } from "bun:test";
import { buildUserTurnPreamble, type PreambleState } from "./preamble.ts";

const persona = "UNTRUSTED_CONTENT_START\n[persona]\nBe terse.\nUNTRUSTED_CONTENT_END";
const skill = `<active-skill name="reviewer">\nReview carefully.\n</active-skill>`;
const profile = `<user-profile note="learned">\nLikes caramel custard.\n</user-profile>`;
const memory = `<recalled-memory>\n- (trusted) build-system: builds with Bun.\n</recalled-memory>`;

const base = (over: Partial<PreambleState> = {}): PreambleState => ({
  persona: null, skill: null, profile: "", memoryRecall: null, memoryRecallDelivered: false, ...over,
});

test("empty state -> empty preamble", () => {
  const r = buildUserTurnPreamble(base());
  expect(r.preamble).toBe("");
  expect(r.memoryRecallDelivered).toBe(false);
});

test("persona + skill + profile are all included on a turn", () => {
  const r = buildUserTurnPreamble(base({ persona, skill, profile }));
  expect(r.preamble).toContain("Be terse.");
  expect(r.preamble).toContain("active-skill");
  expect(r.preamble).toContain("Likes caramel custard.");
});

test("persona/skill/profile PERSIST across turns (re-delivered every turn) — issue #54", () => {
  const state = base({ persona, skill, profile, memoryRecall: memory });
  // turn 1
  const t1 = buildUserTurnPreamble(state);
  expect(t1.preamble).toContain("Be terse.");
  expect(t1.preamble).toContain("active-skill");
  expect(t1.preamble).toContain("Likes caramel custard.");
  expect(t1.preamble).toContain("recalled-memory"); // memory delivered on turn 1

  // turn 2 (carry forward the updated memoryRecallDelivered flag)
  const t2 = buildUserTurnPreamble({ ...state, memoryRecallDelivered: t1.memoryRecallDelivered });
  expect(t2.preamble).toContain("Be terse.");          // persona still here
  expect(t2.preamble).toContain("active-skill");        // skill still here
  expect(t2.preamble).toContain("Likes caramel custard."); // profile still here
  expect(t2.preamble).not.toContain("recalled-memory"); // memory NOT re-sent (once per session)
});

test("cross-session memory recall is delivered exactly once and flips the flag", () => {
  const first = buildUserTurnPreamble(base({ memoryRecall: memory }));
  expect(first.preamble).toContain("recalled-memory");
  expect(first.memoryRecallDelivered).toBe(true);
  const second = buildUserTurnPreamble(base({ memoryRecall: memory, memoryRecallDelivered: true }));
  expect(second.preamble).toBe("");
});

test("the live profile reflects the latest value each turn (re-read, not cached)", () => {
  const t1 = buildUserTurnPreamble(base({ profile: "<user-profile note=\"learned\">\nA\n</user-profile>" }));
  expect(t1.preamble).toContain("A");
  const t2 = buildUserTurnPreamble(base({ profile: "<user-profile note=\"learned\">\nA\nB\n</user-profile>" }));
  expect(t2.preamble).toContain("B"); // newly-learned fact shows up on the next turn
});

test("P-DESIGN.1: DESIGN.md invariants are STANDING guidance, re-delivered every turn", () => {
  const design = "<design-invariants>\nHonor them: 8px grid, brand blue.\n</design-invariants>";
  const state = base({ designInvariants: design });
  expect(buildUserTurnPreamble(state).preamble).toContain("design-invariants");
  expect(buildUserTurnPreamble(state).preamble).toContain("8px grid"); // present on a second turn too
  // absent when there is no DESIGN.md
  expect(buildUserTurnPreamble(base()).preamble).not.toContain("design-invariants");
});
