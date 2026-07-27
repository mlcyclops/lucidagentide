// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/voice/catalog.ts
//
// P-VOICE.2 (ADR-0247): the CANONICAL voice catalog, one place, for every TTS engine LUCID speaks with.
//
// Before this module the picker could only list ElevenLabs (the one engine with a `GET /v1/voices` endpoint);
// the OpenAI and Kokoro voice ids were scattered as inline string literals in dev.ts (`"alloy"`, `"af_heart"`,
// `"am_onyx"`), so choosing a voice for those engines was impossible from the UI. OpenAI and Kokoro publish a
// FIXED voice set - there is no list endpoint to call - so the correct source of truth is a static catalog.
//
// Pure data + pure functions: no fetch, no fs, no env. The server merges the live ElevenLabs list over this
// (ElevenLabs is per-ACCOUNT: premade + cloned voices), and the renderer renders whatever comes back.

/** The TTS engines LUCID can speak with. Mirrors `VoiceSettings["ttsProvider"]` in desktop/settings_store.ts. */
export type TtsProviderId = "elevenlabs" | "openai-tts" | "local-tts";

/** One selectable voice. Same shape the ElevenLabs list parses into, so the picker renders both identically. */
export interface CatalogVoice {
  voiceId: string;
  name: string;
  /** Coarse grouping shown next to the name (e.g. "neutral", "american female"). */
  category?: string;
  description?: string;
}

/** Non-secret, user-facing description of an engine — drives the composer picker's provider rows. */
export interface TtsProviderInfo {
  id: TtsProviderId;
  label: string;
  /** One line the UI shows under the label. Honest about where the audio goes. */
  blurb: string;
  /** True when the text leaves this machine. Drives the "cloud" marker in the picker. */
  cloud: boolean;
  /** The settings key whose API key this engine needs, or null when it needs none (self-hosted). */
  keyEnv: "ELEVENLABS_API_KEY" | "OPENAI_API_KEY" | null;
  /** True when the voice list is fetched live from the provider rather than read from this catalog. */
  liveList: boolean;
}

export const TTS_PROVIDERS: readonly TtsProviderInfo[] = [
  {
    id: "elevenlabs",
    label: "ElevenLabs",
    blurb: "Cloud · your account's premade + cloned voices",
    cloud: true,
    keyEnv: "ELEVENLABS_API_KEY",
    liveList: true,
  },
  {
    id: "openai-tts",
    label: "ChatGPT / OpenAI",
    blurb: "Cloud · steerable tone, low latency",
    cloud: true,
    keyEnv: "OPENAI_API_KEY",
    liveList: false,
  },
  {
    id: "local-tts",
    label: "Kokoro",
    blurb: "Offline on this machine · air-gap safe, no key",
    cloud: false,
    keyEnv: null,
    liveList: false,
  },
] as const;

/** OpenAI's fixed `/v1/audio/speech` voice set (2026). `marin` and `cedar` are the newest + most natural;
 *  the rest are the original ten. All work with `gpt-4o-mini-tts` / `tts-1` / `tts-1-hd`. */
export const OPENAI_VOICES: readonly CatalogVoice[] = [
  { voiceId: "marin", name: "Marin", category: "natural", description: "Newest — warm, conversational, most human" },
  { voiceId: "cedar", name: "Cedar", category: "natural", description: "Newest — calm, grounded, measured" },
  { voiceId: "alloy", name: "Alloy", category: "neutral", description: "Balanced and even — the default" },
  { voiceId: "ash", name: "Ash", category: "neutral", description: "Dry and matter-of-fact" },
  { voiceId: "ballad", name: "Ballad", category: "expressive", description: "Lyrical, gentle delivery" },
  { voiceId: "coral", name: "Coral", category: "expressive", description: "Bright and upbeat" },
  { voiceId: "echo", name: "Echo", category: "neutral", description: "Soft-spoken, unhurried" },
  { voiceId: "fable", name: "Fable", category: "expressive", description: "Storytelling cadence" },
  { voiceId: "nova", name: "Nova", category: "neutral", description: "Clear and energetic" },
  { voiceId: "onyx", name: "Onyx", category: "deep", description: "Deep and authoritative" },
  { voiceId: "sage", name: "Sage", category: "neutral", description: "Steady and reassuring" },
  { voiceId: "shimmer", name: "Shimmer", category: "expressive", description: "Light and airy" },
  { voiceId: "verse", name: "Verse", category: "expressive", description: "Animated, wide range" },
] as const;

/** Kokoro-82M's bundled voice packs, as served by the self-hosted OpenAI-compatible server (LUCID_TTS_URL).
 *  The id prefix encodes accent + gender: `a`=American, `b`=British; `f`=female, `m`=male. */
export const KOKORO_VOICES: readonly CatalogVoice[] = [
  { voiceId: "af_heart", name: "Heart", category: "american female", description: "Warm — the Kokoro default" },
  { voiceId: "af_bella", name: "Bella", category: "american female", description: "Bright and articulate" },
  { voiceId: "af_nicole", name: "Nicole", category: "american female", description: "Soft, close-mic" },
  { voiceId: "af_aoede", name: "Aoede", category: "american female", description: "Even, newsreader-like" },
  { voiceId: "af_kore", name: "Kore", category: "american female", description: "Crisp and quick" },
  { voiceId: "af_sarah", name: "Sarah", category: "american female", description: "Conversational" },
  { voiceId: "am_michael", name: "Michael", category: "american male", description: "Neutral and clear" },
  { voiceId: "am_onyx", name: "Onyx", category: "american male", description: "Deep — the briefing co-host" },
  { voiceId: "am_fenrir", name: "Fenrir", category: "american male", description: "Gravelly, weighty" },
  { voiceId: "am_puck", name: "Puck", category: "american male", description: "Playful, quick" },
  { voiceId: "bf_emma", name: "Emma", category: "british female", description: "Received-pronunciation, poised" },
  { voiceId: "bm_george", name: "George", category: "british male", description: "Measured, documentary" },
  { voiceId: "bm_fable", name: "Fable", category: "british male", description: "Storytelling cadence" },
] as const;

/** What an engine needs to know about the environment to say whether it can actually speak right now. */
export interface TtsReadinessInput {
  /** A platform API key is configured for this engine's provider. */
  keySet: boolean;
  /** An OAuth / subscription login exists for this provider (a ChatGPT sign-in, a Claude Pro login, ...). */
  oauthActive: boolean;
  /** Self-hosted engine only: did anything answer at `localUrl`? */
  localUp: boolean;
  /** Self-hosted engine only: where we looked. */
  localUrl: string;
}

/** Can this engine speak, and if not, what EXACTLY is missing?
 *
 *  This exists because the picker used to offer every engine unconditionally: selecting ChatGPT/OpenAI with
 *  only a subscription sign-in showed thirteen voices, let you choose one, and then failed with a toast on
 *  every single reply. The reason has to be specific, because the two OpenAI failure modes need different
 *  actions from the user -- and one of them is NOT fixable inside LUCID:
 *
 *  OpenAI's `/v1/audio/speech` is a PLATFORM endpoint and takes a platform API key (`sk-...`) only. A ChatGPT
 *  OAuth/subscription login is a different credential for a different backend; the platform API rejects it,
 *  and there is no OAuth flow that mints a platform key. So an OAuth-only user must add a key or pick another
 *  engine -- saying just "add your API key" to someone who is visibly signed in reads like a bug in LUCID.
 *
 *  Pure: the caller supplies the environment (key presence, OAuth row, local probe). */
export function ttsEngineStatus(id: string, i: TtsReadinessInput): { ready: boolean; reason: string } {
  const p = normalizeTtsProvider(id);
  if (p === "local-tts") {
    return i.localUp
      ? { ready: true, reason: "" }
      : { ready: false, reason: `No Kokoro server answered at ${i.localUrl}. Start one there, or pick a cloud engine.` };
  }
  if (i.keySet) return { ready: true, reason: "" };
  if (p === "elevenlabs") return { ready: false, reason: "Add your ElevenLabs API key in Settings \u2192 Voice." };
  return {
    ready: false,
    reason: i.oauthActive
      ? "A ChatGPT sign-in can't reach OpenAI's speech API \u2014 it needs a platform API key (sk-\u2026). Add one in Providers \u2192 OpenAI, or use ElevenLabs / Kokoro."
      : "Add your OpenAI API key in Providers \u2192 OpenAI.",
  };
}

/** Fold any incoming string to a valid engine id. Unknown/empty → "elevenlabs" (the shipped default). */
export function normalizeTtsProvider(id: string | undefined | null): TtsProviderId {
  return id === "openai-tts" || id === "local-tts" || id === "elevenlabs" ? id : "elevenlabs";
}

/** The STATIC voices for an engine. ElevenLabs returns [] — its list is per-account and fetched live. */
export function voicesForProvider(id: string): readonly CatalogVoice[] {
  const p = normalizeTtsProvider(id);
  return p === "openai-tts" ? OPENAI_VOICES : p === "local-tts" ? KOKORO_VOICES : [];
}

/** The voice used when the user has not picked one. Matches the ids already hard-coded in the TTS callers,
 *  so turning the picker on never changes how an existing install sounds. */
export function defaultVoiceFor(id: string): string {
  const p = normalizeTtsProvider(id);
  return p === "openai-tts" ? "alloy" : p === "local-tts" ? "af_heart" : "";
}

/** The voice to actually synthesize with: the user's choice when this engine offers it, else the default.
 *  Guards the cross-engine case — an ElevenLabs voice id selected, then the engine switched to Kokoro, must
 *  NOT be sent to Kokoro (which would 400 or silently substitute). ElevenLabs keeps whatever id it is given
 *  (its catalog is per-account and unknown here); an empty choice falls back to that engine's default. */
export function resolveVoice(id: string, selected: string | undefined | null): string {
  const p = normalizeTtsProvider(id);
  const want = (selected ?? "").trim();
  if (p === "elevenlabs") return want;
  if (!want) return defaultVoiceFor(p);
  return voicesForProvider(p).some((v) => v.voiceId === want) ? want : defaultVoiceFor(p);
}
