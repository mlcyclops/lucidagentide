// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_avatar_4.ts - P-AVATAR.4 (ADR-0251): the LUCID Agent enter flow.
//
// Proves with no DOM: the fast-model pick follows the user's stated order (Terra -> Sonnet 5 -> Gemini
// Flash, family fallbacks after) and never switches pointlessly; the readiness checklist surfaces ONE
// gap at a time in fix order (provider -> voice out -> voice in); the Knowledge Graph is an OFFER that
// fires at most once and never gates the session; and exit restores the prior model only when it is
// still accessible.
//
// Run: bun run desktop/scripts/demo_p_avatar_4.ts

import { nextGap, readinessChecklist, resolveConversationModel, restoreModel } from "../renderer/agent_flow.ts";

const fail = (msg: string): never => { console.error(`FAIL: ${msg}`); process.exit(1); };
const ok = (msg: string): void => console.log(`   ${msg} \u2713`);

console.log("== P-AVATAR.4 (ADR-0251) - the enter flow ==");

const opts = ["anthropic/claude-opus-4-8", "openai-codex/gpt-5.6-terra", "asksage-anthropic/google-claude-sonnet-5", "google-antigravity/gemini-3.5-flash"].map((value) => ({ value }));

// (1) the fast-model pick.
if (resolveConversationModel(opts, "anthropic/claude-opus-4-8") !== "openai-codex/gpt-5.6-terra") fail("Terra must be first choice");
if (resolveConversationModel(opts.filter((o) => !o.value.includes("terra")), "x/slow") !== "asksage-anthropic/google-claude-sonnet-5") fail("Sonnet 5 must be second");
if (resolveConversationModel(opts, "openai-codex/gpt-5.6-terra") !== null) fail("an already-fast model must not be switched");
ok("fast model: Terra > Sonnet 5 > Gemini Flash; no pointless switches");

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
if (restoreModel(prior, "openai-codex/gpt-5.6-terra", opts) !== "anthropic/claude-opus-4-8") fail("exit must restore the prior model");
if (restoreModel({ ...prior, model: "gone/model" }, "openai-codex/gpt-5.6-terra", opts) !== null) fail("a vanished prior model must not be forced");
ok("exit restores the prior model only when still accessible");

console.log("\nALL CHECKS PASSED");
