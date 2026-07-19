// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_pgovcui1.ts
//
// P-GOVCUI.1: the Government / GovCon + CUI onboarding step, proven headlessly against the PURE core the
// first-run modals wire in. During onboarding LUCID asks "are you a Government/GovCon user handling CUI?" A
// "yes" walks a novice (manager / exec / new dev) into the CUI-safe posture: the accredited AskSage gov
// gateway in LOCKDOWN, with the CIV (government) routing endpoint PREFILLED and step-by-step token
// instructions. What this demo guarantees:
//   1. the step asks EXACTLY ONCE (a prior answer skips; an org that already forces gov routing auto-enables
//      with no question);
//   2. a user with a key gets the CIV endpoint persisted + lockdown turned ON;
//   3. a user WITHOUT a key ("I'll add it later") still gets the CIV endpoint prefilled, but lockdown is
//      NEVER flipped on without a key (that would leave no gov model to route to -> the backend fail-closes
//      and blocks every turn);
//   4. the prefilled endpoint is the CIV (government) proxy, never the commercial one.
//
// The modals themselves are renderer DOM (QA-gated in-app like the rest of onboarding); the load-bearing
// decision + setup plan are pure and covered here + in gov_onboarding.test.ts.
//
// Run with: bun run harness/scripts/demo_pgovcui1.ts

import { CIV_ASKSAGE_BASE, ASKSAGE_TOKEN_STEPS, decideGovOnboarding, planGovSetup } from "../../desktop/renderer/gov_onboarding.ts";

function fail(m: string): never { console.error(`FAIL: ${m}`); process.exit(1); }
function ok(m: string): void { console.log(`  PASS  ${m}`); }

console.log("P-GOVCUI.1 demo - Government/CUI onboarding (pure core)\n");

// ── [1] the step asks exactly once, and defers to org policy ──
if (decideGovOnboarding({ decided: false, managedGovLocked: false }) !== "ask") fail("a fresh, unmanaged user must be ASKED");
if (decideGovOnboarding({ decided: true, managedGovLocked: false }) !== "skip") fail("a user who already answered must NOT be asked again");
if (decideGovOnboarding({ decided: true, managedGovLocked: true }) !== "skip") fail("a prior answer wins even under a managed lock");
if (decideGovOnboarding({ decided: false, managedGovLocked: true }) !== "auto-enable") fail("an org that forces gov routing needs no question (auto-enable)");
ok("asks a fresh user once; skips once answered; auto-enables (no question) when the org forces gov routing");

// ── [2] a CUI user WITH a key: CIV endpoint persisted + lockdown ON ──
const withKey = planGovSetup({ key: "  sk-gov-abc  ", base: CIV_ASKSAGE_BASE });
if (withKey.key !== "sk-gov-abc") fail("the pasted key must be trimmed + saved");
if (withKey.baseUrl !== CIV_ASKSAGE_BASE) fail("the CIV endpoint must be persisted");
if (!withKey.enableLockdown) fail("with a key, lockdown must be ENABLED");
ok("with a key: key saved, CIV endpoint persisted, lockdown turned ON");

// ── [3] THE FAIL-CLOSED RULE: no key -> prefill the endpoint but NEVER flip lockdown ──
const later = planGovSetup({ key: "   ", base: "" });
if (later.key !== null) fail("no key -> nothing to save into ASKSAGE_API_KEY");
if (later.baseUrl !== CIV_ASKSAGE_BASE) fail("even when deferring the key, the CIV endpoint must be prefilled/persisted");
if (later.enableLockdown) fail("lockdown must NEVER be enabled without a key (the backend would fail-closed and block every turn)");
ok("\"I'll add it later\": CIV endpoint prefilled, but lockdown left OFF (no key -> no gov model to route to)");

// ── [4] the prefilled endpoint is the CIV (government) proxy, not the commercial one ──
if (!CIV_ASKSAGE_BASE.includes("api.civ.asksage.ai")) fail("the CUI default must be the CIV (government) endpoint");
if (CIV_ASKSAGE_BASE.includes("//api.asksage.ai")) fail("the commercial endpoint must NOT be the CUI default");
ok(`CUI routing prefilled to the CIV gov endpoint (${CIV_ASKSAGE_BASE})`);

// ── [5] a novice gets concrete, ordered token steps ──
if (ASKSAGE_TOKEN_STEPS.length < 3) fail("need at least three plain-language token steps");
if (!ASKSAGE_TOKEN_STEPS.join(" ").includes("Account") || !ASKSAGE_TOKEN_STEPS.join(" ").includes("API Key")) fail("steps must name the Account tab + Manage your API Keys");
ok(`${ASKSAGE_TOKEN_STEPS.length} plain-language steps end at the paste field (Settings -> Account -> Manage your API Keys)`);

console.log("\nP-GOVCUI.1 demo complete - a GovCon/CUI user is asked once, prefilled to the CIV gov endpoint, handed token steps, and put in AskSage lockdown; a key-less user is set up short of the fail-closed flip.");
process.exit(0);
