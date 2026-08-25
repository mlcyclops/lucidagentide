// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/agent_flow.ts - P-AVATAR.4 (ADR-0251): entering the LUCID Agent role.
//
// PURE decisions for the enter flow, unit-tested here; app.ts wires the side effects. Picking the role
// (or booting into it) should land the user in a WORKING hands-free session: full agent mode, a fast
// conversation model, conversation mode on - or, when something is missing, ONE gap at a time with a
// deep-link fix, never a wall of setup. The Knowledge Graph is an OFFER (ask once per session), never a
// gate. The prior model is remembered so leaving the role restores exactly what the user had.

export interface ModelOptionLike { value: string; name?: string }

/** Fast, capable conversation models, in the user's stated order (ADR-0251): GPT-5.6 Terra, then a
 *  Claude Sonnet 5 (incl. the gov-routed id), then Gemini 3.5/3.6 Flash - with sane family fallbacks.
 *  Matched against the ACCESSIBLE picker options, so a pick is always actually usable. */
export const CONVERSATION_MODEL_PREFS: readonly RegExp[] = [
  /gpt-5\.6-terra/i,
  /claude-sonnet-5(\b|[-.])|google-claude-sonnet-5/i,
  /gemini-3\.[56]-flash/i,
  /gpt-5\.6-(luna|sol)/i,
  /claude-sonnet-4-6/i,
  /gemini-[\d.]+-flash/i,
];

/** The model the conversation should run on. Null = keep the current one (it already qualifies, or
 *  nothing accessible qualifies - never force a switch that gains nothing). */
export function resolveConversationModel(options: readonly ModelOptionLike[], current: string): string | null {
  if (CONVERSATION_MODEL_PREFS.some((re) => re.test(current))) return null; // already on a fast model
  for (const re of CONVERSATION_MODEL_PREFS) {
    const hit = options.find((o) => re.test(o.value));
    if (hit) return hit.value;
  }
  return null;
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
export interface AgentPrior { model: string; uiMode: "agent" | "ask" | "plan"; autoSpeak: boolean; conversation: boolean }

/** The model to restore on exit: the prior one, but only if it is still accessible (a provider may have
 *  been disconnected mid-session) and an actual change. Null = leave the model alone. */
export function restoreModel(prior: AgentPrior, current: string, options: readonly ModelOptionLike[]): string | null {
  if (prior.model === current) return null;
  return options.some((o) => o.value === prior.model) ? prior.model : null;
}
