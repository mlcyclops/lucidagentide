// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_ptriv2.ts
//
// P-TRIV.2 (ADR-0175): role-aware Trivia Wire banks + idle engagement. Proves:
//   [1] each ADR-0088 role gets ITS domain: executive → GovCon (M&A / opportunities / federal
//       priorities), manager → CMMI-DEV L3 + PM, security → CMMC + RMF; developer and "no role
//       picked yet" keep the general engineering bank;
//   [2] every role bank is REAL: 18+ valid entries, duplicate-free (also across banks), answers
//       spread across positions, topics confined to the role's domain;
//   [3] a role bank plays through the untouched P-TRIV.1 game core (cycle, scoring, persistence);
//   [4] IDLE ENGAGEMENT: with the composer empty and something to come back to (past sessions OR an
//       unlocked Knowledge Graph), the ticker wakes after the idle grace - but a brand-new empty
//       install never sees it uninvited, one composer keystroke hides it, and the P-TRIV.1
//       streaming rule is unchanged and takes precedence.
//
// Run with: bun run harness/scripts/demo_ptriv2.ts

import {
  TRIVIA_BASE_POINTS, TRIVIA_IDLE_AFTER_MS, TRIVIA_SHOW_AFTER_MS,
  createTriviaGame, isTriviaQuestion, triviaVisible,
} from "../../desktop/renderer/trivia.ts";
import { TRIVIA_BANK } from "../../desktop/renderer/trivia_bank.ts";
import { TRIVIA_EXEC_BANK, TRIVIA_MANAGER_BANK, TRIVIA_SECURITY_BANK, bankForRole } from "../../desktop/renderer/trivia_roles.ts";

function fail(m: string): never { console.error(`FAIL: ${m}`); process.exit(1); }
function ok(m: string): void { console.log(`  PASS  ${m}`); }
const lcg = (seed = 42): (() => number) => {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
};

console.log("P-TRIV.2 demo - role-aware banks + idle engagement\n");

// [1] role → domain mapping
if (bankForRole("executive") !== TRIVIA_EXEC_BANK) fail("executive must get the GovCon bank");
if (bankForRole("manager") !== TRIVIA_MANAGER_BANK) fail("manager must get the CMMI/PM bank");
if (bankForRole("security") !== TRIVIA_SECURITY_BANK) fail("security must get the CMMC/RMF bank");
if (bankForRole("developer") !== TRIVIA_BANK || bankForRole(null) !== TRIVIA_BANK || bankForRole(undefined) !== TRIVIA_BANK) {
  fail("developer / no-role must keep the general engineering bank");
}
ok("role mapping: executive→GovCon, manager→CMMI+PM, security→CMMC+RMF, developer/none→general");

// [2] every role bank is real and domain-confined
const DOMAINS: [string, readonly typeof TRIVIA_EXEC_BANK[number][], (t: string) => boolean][] = [
  ["executive", TRIVIA_EXEC_BANK, (t) => t.startsWith("govcon")],
  ["manager", TRIVIA_MANAGER_BANK, (t) => t === "cmmi" || t === "pm"],
  ["security", TRIVIA_SECURITY_BANK, (t) => t === "cmmc" || t === "rmf"],
];
for (const [role, bank, inDomain] of DOMAINS) {
  if (bank.length < 18) fail(`${role} bank too small: ${bank.length}`);
  for (const e of bank) {
    if (!isTriviaQuestion(e)) fail(`${role} bank has an invalid entry: ${JSON.stringify(e).slice(0, 80)}`);
    if (!inDomain(e.topic)) fail(`${role} bank strayed off-domain: topic '${e.topic}'`);
  }
  if (new Set(bank.map((e) => e.q)).size !== bank.length) fail(`${role} bank has duplicate prompts`);
  for (const p of [0, 1, 2, 3]) if (bank.filter((e) => e.a === p).length < 2) fail(`${role} bank underuses answer position ${p}`);
}
const all = [...TRIVIA_BANK, ...TRIVIA_EXEC_BANK, ...TRIVIA_MANAGER_BANK, ...TRIVIA_SECURITY_BANK];
if (new Set(all.map((e) => e.q)).size !== all.length) fail("a prompt appears in two banks");
ok(`banks real + domain-confined: exec ${TRIVIA_EXEC_BANK.length}, manager ${TRIVIA_MANAGER_BANK.length}, security ${TRIVIA_SECURITY_BANK.length} (+${TRIVIA_BANK.length} general), no cross-bank duplicates`);

// [3] a role bank plays through the untouched game core
{
  let saved: string | null = null;
  const store = { get: () => saved, set: (v: string) => { saved = v; } };
  const g = createTriviaGame(TRIVIA_SECURITY_BANK, store, lcg());
  const seen = new Set<string>();
  for (let i = 0; i < TRIVIA_SECURITY_BANK.length; i++) {
    const q = g.state().question;
    if (!(q.topic === "cmmc" || q.topic === "rmf")) fail("security game served an off-domain question");
    if (seen.has(q.q)) fail("security bank repeated before exhaustion");
    seen.add(q.q);
    g.answer(q.a); g.advance();
  }
  const g2 = createTriviaGame(TRIVIA_SECURITY_BANK, store, lcg(7));
  if (g2.state().score < TRIVIA_BASE_POINTS) fail("role-bank score did not persist through the shared store");
  ok(`the security bank cycles all ${TRIVIA_SECURITY_BANK.length} CMMC/RMF questions once, score persists (${g2.state().score})`);
}

// [4] idle engagement
{
  const idle = { enabled: true, streaming: false, streamStartedAt: null, composerEmpty: true, hasHistory: true, kgUnlocked: false, idleSince: 1000 };
  if (triviaVisible({ ...idle, now: 1000 + TRIVIA_IDLE_AFTER_MS - 1 })) fail("idle mode woke before the grace");
  if (!triviaVisible({ ...idle, now: 1000 + TRIVIA_IDLE_AFTER_MS })) fail("idle mode did not wake: empty composer + past sessions");
  if (!triviaVisible({ ...idle, hasHistory: false, kgUnlocked: true, now: 99_999 })) fail("an unlocked KG alone must count as history");
  if (triviaVisible({ ...idle, hasHistory: false, kgUnlocked: false, now: 99_999 })) fail("a brand-new empty install must never see the game uninvited");
  if (triviaVisible({ ...idle, composerEmpty: false, now: 99_999 })) fail("typing in the composer must hide idle mode");
  if (triviaVisible({ ...idle, idleSince: null, now: 99_999 })) fail("no idle anchor must mean hidden");
  if (!triviaVisible({ ...idle, streaming: true, streamStartedAt: 1000, composerEmpty: false, now: 1000 + TRIVIA_SHOW_AFTER_MS })) {
    fail("the streaming branch must take precedence over idle inputs");
  }
  if (triviaVisible({ enabled: true, streaming: false, streamStartedAt: null, now: 99_999 })) fail("P-TRIV.1 callers (no idle fields) must behave as before");
  ok(`idle engagement: wakes after ${TRIVIA_IDLE_AFTER_MS / 1000}s with history or an unlocked KG; empty installs and typing users are left alone; streaming rule unchanged`);
}

console.log("\nP-TRIV.2 demo: ALL GREEN - the Trivia Wire follows the role and fills the idle gap.");
