// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_avatar_4.ts - P-AVATAR.4 (ADR-0251): the LUCID Agent enter flow.
//
// Proves with no DOM: Regular/Max chooses actual accessible models within the current provider route
// (Opus/Fable or Luna/Astra) and never switches pointlessly; the readiness checklist surfaces ONE
// gap at a time in fix order (provider -> voice out -> voice in); the Knowledge Graph is an OFFER that
// fires at most once and never gates the session; and exit restores the prior model only when it is
// still accessible.
//
// Run: bun run desktop/scripts/demo_p_avatar_4.ts

import { nextGap, readinessChecklist, resolveAgentTierModel, restoreModel } from "../renderer/agent_flow.ts";

const fail = (msg: string): never => { console.error(`FAIL: ${msg}`); process.exit(1); };
const ok = (msg: string): void => console.log(`   ${msg} \u2713`);

console.log("== P-AVATAR.4 (ADR-0251) - the enter flow ==");

const opts = [
  "anthropic/claude-opus-4-8", "anthropic/claude-opus-5", "anthropic/claude-fable-5.1",
  "openai-codex/gpt-5.6-luna", "openai-codex/gpt-6-astra", "openai/gpt-7-astra",
  "asksage-anthropic/google-claude-fable-6", "google-antigravity/gemini-3.5-flash",
].map((value) => ({ value }));

// (1) tier preferences never cross provider routes, even when another route offers a newer model.
if (resolveAgentTierModel(opts, "anthropic/claude-fable-5.1", "regular") !== "anthropic/claude-opus-5") fail("Regular must prefer accessible Opus");
if (resolveAgentTierModel(opts, "anthropic/claude-opus-5", "max") !== "anthropic/claude-fable-5.1") fail("Max must prefer same-route Fable");
if (resolveAgentTierModel(opts, "openai-codex/gpt-6-astra", "regular") !== "openai-codex/gpt-5.6-luna") fail("Regular must prefer accessible Luna");
if (resolveAgentTierModel(opts, "openai-codex/gpt-5.6-luna", "max") !== "openai-codex/gpt-6-astra") fail("Max must not cross from Codex to API credits");
if (resolveAgentTierModel(opts, "openai-codex/gpt-6-astra", "max") !== null) fail("a winning current model must not be switched");
if (resolveAgentTierModel(opts.filter((o) => !o.value.includes("fable")), "anthropic/claude-opus-5", "max") !== null) fail("an unavailable Fable must not be invented");
ok("Regular/Max: accessible Opus/Fable and Luna/Astra, exact provider route, no pointless switches");

// (2) one gap at a time; vault offers, never gates.
const good = { providers: 1, ttsReady: true, sttReady: true, vaultConfigured: true, vaultUnlocked: true };
if (nextGap(readinessChecklist({ ...good, providers: 0, ttsReady: false }), false)?.id !== "provider") fail("provider gap must come first");
if (nextGap(readinessChecklist({ ...good, ttsReady: false, sttReady: false }), false)?.id !== "tts") fail("voice OUT before voice IN");
const offer = nextGap(readinessChecklist({ ...good, vaultUnlocked: false }), false);
if (offer?.id !== "vault" || offer.required) fail("a locked vault must be a non-required OFFER");
if (nextGap(readinessChecklist({ ...good, vaultUnlocked: false }), true) !== null) fail("the vault offer must fire at most once");
if (nextGap(readinessChecklist(good), false) !== null) fail("all green must mean GO");
ok("checklist: provider -> tts -> stt, one at a time; the KG is a one-time offer");

// (3) exit restoration.
const prior = { model: "anthropic/claude-opus-4-8", uiMode: "ask" as const, autoSpeak: false, conversation: false };
if (restoreModel(prior, "anthropic/claude-fable-5.1", opts) !== "anthropic/claude-opus-4-8") fail("exit must restore the prior model");
if (restoreModel({ ...prior, model: "gone/model" }, "anthropic/claude-fable-5.1", opts) !== null) fail("a vanished prior model must not be forced");
ok("exit restores the prior model only when still accessible");

console.log("\nALL CHECKS PASSED");
