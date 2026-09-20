// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/agent_flow.ts - P-AVATAR.4 (ADR-0251): entering the LUCID Agent role.
//
// PURE decisions for the enter flow, unit-tested here; app.ts wires the side effects. Picking the role
// (or booting into it) should land the user in a WORKING hands-free session: full agent mode, a selected
// Regular/Max model tier, conversation mode on - or, when something is missing, ONE gap at a time with a
// deep-link fix, never a wall of setup. The Knowledge Graph is an OFFER (ask once per session), never a
// gate. The prior model is remembered so leaving the role restores exactly what the user had.

import { capabilityTier, familyOf, isAuxiliaryModel, providerPrefixOf } from "./model_families.ts";

export interface ModelOptionLike { value: string; name?: string; provider?: string }
export type AgentModelTier = "regular" | "max";

// Route identities stay exact: OAuth, API-key and accredited gateway routes are NOT interchangeable.
// Unrecognized/local routes have no reliable capability metadata, so retain their current model.
const TIER_PROVIDERS: Record<string, true> = {
  anthropic: true, openai: true, "openai-codex": true, google: true, gemini: true,
  "google-antigravity": true, "google-gemini-cli": true, "google-vertex": true, vertex: true,
  azure: true, "azure-openai": true, xai: true, "xai-oauth": true, grok: true,
  "github-copilot": true, openrouter: true, asksage: true,
  "asksage-anthropic": true, "asksage-openai": true, "asksage-google": true,
};

function tierFamily(value: string): string {
  const family = familyOf(value).id;
  return family !== "other" ? family : /(?:^|\/)grok-\d/i.test(value) ? "grok" : "other";
}

function tierProvider(value: string, provider?: string): string {
  const prefix = providerPrefixOf(value);
  if (prefix) return prefix;
  if (provider) return provider;
  // Infer only unambiguous bare vendor ids, never display names or arbitrary deployment aliases.
  if (/^claude-/i.test(value)) return "anthropic";
  if (/^(?:gpt-|o\d)/i.test(value)) return "openai";
  if (/^gemini-/i.test(value)) return "google";
  if (/^grok-/i.test(value)) return "xai";
  return "";
}

/** Read ONLY the version directly attached to a known model family. Scanning all digits would let
 *  preview dates or parameter counts outrank real versions (and lexical sorting puts 9 above 10).
 *  Hyphenated minor versions support Claude's 4-8 spelling without treating -2026-09-20 as a version. */
function tierVersion(value: string): number[] {
  const match = /(?:claude-(?:(?:opus|sonnet|haiku|fable|mythos)-)?|gpt-(?:o)?|gemini-|grok-)(\d+(?:(?:\.\d+)|(?:-\d{1,2}(?!\d)))*)/i.exec(value);
  return match ? match[1]!.split(/[.-]/).map(Number) : [];
}

function newerTierVersion(candidate: readonly number[], best: readonly number[]): boolean {
  for (let i = 0; i < Math.max(candidate.length, best.length); i++) {
    const difference = (candidate[i] ?? 0) - (best[i] ?? 0);
    if (difference) return difference > 0;
  }
  return false;
}

/** Resolve a role tier inside the CURRENT provider route and model family. Callers supply only
 *  accessible options (including their auth/sovereignty restrictions); this function never invents ids.
 *  Regular prefers Opus/Luna, otherwise retains a usable current model. Max prefers Fable 5+/Astra 6+
 *  and falls back to the highest recognized flagship. Unknown/local models stay unchanged. Null means
 *  keep current, including ties and an empty eligible pool. Restore/conversation decisions stay separate. */
export function resolveAgentTierModel(options: readonly ModelOptionLike[], current: string, tier: AgentModelTier): string | null {
  const currentOption = options.find((option) => option.value === current);
  const provider = tierProvider(current, currentOption?.provider);
  const family = tierFamily(current);
  if (TIER_PROVIDERS[provider] !== true || family === "other" || family === "rag") return null;

  let best: ModelOptionLike | null = null;
  let bestPreference = -1;
  let bestVersion: readonly number[] = [];
  for (const option of options) {
    if (tierProvider(option.value, option.provider) !== provider || tierFamily(option.value) !== family) continue;
    // Reuse the picker's capability source of truth. Explicit fast variants are also never Max picks.
    if (isAuxiliaryModel(option.value) || capabilityTier(option.value) !== 2 || /(?:^|[-_/])fast(?:$|[-_.])/i.test(option.value)) continue;
    const version = tierVersion(option.value);
    if (!version.length) continue;
    const preferred = tier === "regular"
      ? /(?:^|[-/])opus(?:$|[-.])|(?:^|[-/])luna(?:$|[-.])/i.test(option.value)
      : /(?:^|[-/])fable(?:$|[-.])/i.test(option.value) && version[0]! >= 5
        || /(?:^|[-/])astra(?:$|[-.])/i.test(option.value) && version[0]! >= 6;
    if (tier === "regular" && !preferred && currentOption) continue;
    const preference = preferred ? 1 : 0;
    if (preference > bestPreference || preference === bestPreference && (
      newerTierVersion(version, bestVersion)
      || option.value === current && !newerTierVersion(bestVersion, version)
    )) {
      best = option;
      bestPreference = preference;
      bestVersion = version;
    }
  }
  return best && best.value !== current ? best.value : null;
}

// ── Readiness: what the hands-free session actually needs ───────────────────────────────────────
export type ReadyItemId = "provider" | "tts" | "stt" | "vault";
export interface ReadySignals {
  /** configuredProviderCount(auth) - chat providers with a usable credential. */
  providers: number;
  /** The SELECTED TTS engine reports ready (VoiceListView.engines). */
  ttsReady: boolean;
  /** STT reachable: managed whisper running, or startable (capable + binary), or cloud STT keyed. */
  sttReady: boolean;
  /** Personal KG store state (PersonalStatus.configured / .unlocked). */
  vaultConfigured: boolean;
  vaultUnlocked: boolean;
}

export interface ReadyItem {
  id: ReadyItemId;
  ok: boolean;
  /** True gaps block conversation mode; the vault is an offer, never a blocker. */
  required: boolean;
  title: string;
  hint: string;
  /** Which surface fixes it. */
  action: "hub" | "voice" | "knowledge";
  actionLabel: string;
}

/** The ordered checklist. Order is the fix order: no provider means nothing else matters; voice output
 *  before voice input (you must hear it before talking to it is worth anything). */
export function readinessChecklist(s: ReadySignals): ReadyItem[] {
  return [
    {
      id: "provider", ok: s.providers > 0, required: true,
      title: "Connect a model provider",
      hint: "LUCID needs at least one connected provider to think. One click in the Provider Hub.",
      action: "hub", actionLabel: "Open Provider Hub",
    },
    {
      id: "tts", ok: s.ttsReady, required: true,
      title: "Give LUCID a voice",
      hint: "The selected speech engine can't speak yet. Pick or configure one in the Voice card - offline Kokoro needs no key.",
      action: "voice", actionLabel: "Open Voice settings",
    },
    {
      id: "stt", ok: s.sttReady, required: true,
      title: "Let LUCID hear you",
      hint: "No speech-to-text is reachable. The bundled offline Whisper starts with one click in the Voice card.",
      action: "voice", actionLabel: "Open Voice settings",
    },
    {
      id: "vault", ok: s.vaultConfigured && s.vaultUnlocked, required: false,
      title: s.vaultConfigured ? "Unlock your Knowledge Graph?" : "Set up your Knowledge Graph?",
      hint: s.vaultConfigured
        ? "Your encrypted personal graph is locked. Unlock it so LUCID remembers what matters to you."
        : "An encrypted, on-device memory of durable facts about you. Optional - takes a minute.",
      action: "knowledge", actionLabel: s.vaultConfigured ? "Unlock" : "Set it up",
    },
  ];
}

/** The single item to surface right now: the FIRST required gap; when none, the vault OFFER (caller
 *  enforces ask-once-per-session); when nothing at all, null - the session is good to go. */
export function nextGap(items: readonly ReadyItem[], vaultAskedAlready: boolean): ReadyItem | null {
  const gap = items.find((i) => i.required && !i.ok);
  if (gap) return gap;
  const vault = items.find((i) => i.id === "vault");
  if (vault && !vault.ok && !vaultAskedAlready) return vault;
  return null;
}

/** What entering the role must remember, so leaving restores the user's world exactly. */
// CREATOR-0 (ADR-0280): `creator` joins the mode union, so leaving the hands-free role restores a user
// who was in Creator Mode back INTO Creator Mode rather than dropping them to plain Agent.
export interface AgentPrior { model: string; uiMode: "agent" | "creator" | "ask" | "plan"; autoSpeak: boolean; conversation: boolean }

/** The model to restore on exit: the prior one, but only if it is still accessible (a provider may have
 *  been disconnected mid-session) and an actual change. Null = leave the model alone. */
export function restoreModel(prior: AgentPrior, current: string, options: readonly ModelOptionLike[]): string | null {
  if (prior.model === current) return null;
  return options.some((o) => o.value === prior.model) ? prior.model : null;
}
