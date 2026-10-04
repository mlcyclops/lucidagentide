// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/lockdown_route.ts
//
// CUI lockdown: the ONE routing predicate. Lockdown is `asksageLocked()` (the user's `asksageOnly` OR the
// org-managed lock, ADR-0217/0218/0219); this module extends what it permits. No user content may reach a
// service that is neither on this workstation nor a DGX enclave host unless that service is CUI-authorized.
// Concretely, under lockdown:
//   - a MODEL is routable when it is AskSage-routed (the CUI-authorized gov gateway) OR served by an ENABLED
//     Local Provider the user attested as a DGX enclave host (`LocalProviderDef.enclave === true`);
//   - cloud VOICE (ElevenLabs TTS/STT, OpenAI TTS) is refused; local engines (offline Whisper, Kokoro,
//     dots.tts) are allowed when their endpoint is loopback or an enclave host;
//   - agent EGRESS to loopback or an enclave provider host is not public egress.
// Enclave attestations widen ONLY the user's own lock. Under the org-managed asksageOnly lock every enclave
// set is empty (a user attestation never widens an org-managed control): models stay AskSage-only and voice
// and egress fall back to loopback only.
//
// PURE and DOM-free with no imports, so the server (acp_backend.ts, checker_model.ts, dev.ts) and the
// renderer (app.ts) evaluate the SAME predicate. Every function here is unit-tested in lockdown_route.test.ts.

/** The slice of a Local Provider declaration lockdown needs (structural, so the renderer's state and the
 *  server's `LocalProviderDef` both satisfy it without a cast). */
export interface EnclaveProviderRef { ompProvider: string; enabled: boolean; enclave?: boolean; baseUrl?: string }

/** The toggle's label and detail, shared so the Settings card and toasts never drift. */
export const LOCKDOWN_LABEL = "CUI lockdown";
export const LOCKDOWN_DETAIL = "Only AskSage (CUI-authorized) and local DGX enclave services";

/** Fail-closed refusal when lockdown is on and no allowed model exists. Names BOTH ways out. */
export const LOCKDOWN_NO_ROUTE_ERROR =
  "CUI lockdown is ON but no allowed model is available. Add your AskSage API key in Settings (the CUI-authorized gov gateway), or enable a Local Provider marked as a DGX enclave host, or turn lockdown off.";
/** The model switch was attempted but omp did not land on an allowed model. */
export const LOCKDOWN_SWITCH_FAILED_ERROR = "Could not switch to an AskSage or DGX enclave model for CUI lockdown.";

/** ADR-0217: a model goes through the accredited AskSage gov gateway when omp reports it under an
 *  `asksage`-prefixed PROVIDER (`asksage-openai/gpt-5.6-luna`, `asksage-query/rag`). Anchored on the
 *  provider segment (the text before the first "/", or the whole bare id), not a substring anywhere in the
 *  id: a self-hosted model whose id merely CONTAINS "asksage" (`dgx/asksage-clone`) is not gov-routed. */
export function isAsksageRouted(value: string): boolean {
  const v = value ?? "";
  const i = v.indexOf("/");
  return /^asksage/i.test(i === -1 ? v : v.slice(0, i));
}

/** The omp provider keys of the ENABLED Local Providers attested as DGX enclave hosts. Anything not
 *  literally `enabled === true && enclave === true` is excluded (fail-closed on missing/garbled fields).
 *  `managedLocked` (the org-managed asksageOnly lock is on) yields the EMPTY set: an enclave attestation is
 *  the user's (or a Loader import's), and a user attestation never widens an org-managed control, so the
 *  managed lock stays AskSage-only. Required, so no caller can forget the rule. */
export function enclaveProviderSet(providers: readonly EnclaveProviderRef[] | null | undefined, managedLocked: boolean): Set<string> {
  const out = new Set<string>();
  if (managedLocked) return out;
  for (const p of providers ?? []) {
    if (p && p.enabled === true && p.enclave === true && typeof p.ompProvider === "string" && p.ompProvider) out.add(p.ompProvider.toLowerCase());
  }
  return out;
}

/** THE lockdown model predicate: AskSage-routed, or served by an enabled enclave Local Provider. Every
 *  lockdown filter (turn clamp, agent-run clamp, checker list, renderer pickers) calls this. */
export function isLockdownRoutable(value: string, enclaveProviders: ReadonlySet<string>): boolean {
  if (!value) return false;
  if (isAsksageRouted(value)) return true;
  const i = value.indexOf("/");
  return i > 0 && enclaveProviders.has(value.slice(0, i).toLowerCase());
}

/** The lockdown toggle guard. Turning lockdown OFF is always allowed. Turning it ON needs at least one
 *  allowed route (AskSage configured, or an enabled enclave Local Provider), otherwise the backend would
 *  refuse every turn. Under the org-managed lock (`managedLocked`) enclave providers do not count (see
 *  enclaveProviderSet), so only AskSage satisfies it. */
export function lockdownToggleDecision(input: { enable: boolean; asksageConfigured: boolean; providers: readonly EnclaveProviderRef[] | null | undefined; managedLocked: boolean }): { ok: boolean; reason?: string } {
  if (!input.enable) return { ok: true };
  if (input.asksageConfigured || enclaveProviderSet(input.providers, input.managedLocked).size > 0) return { ok: true };
  return {
    ok: false,
    reason: input.managedLocked
      ? "Your organization's lockdown is AskSage-only: add your AskSage API key (AskSage gov gateway card). DGX enclave Local Providers do not satisfy an org-managed lock."
      : "CUI lockdown needs an allowed model route first: add your AskSage API key (AskSage gov gateway card), or mark an enabled Local Provider as a DGX enclave host. Without one every turn would be refused.",
  };
}

// ── hosts: loopback and enclave ──────────────────────────────────────────────────────────────────

/** Lowercase hostname of an http(s) URL with IPv6 brackets stripped, or null. */
export function httpHost(url: string | null | undefined): string | null {
  let u: URL;
  try { u = new URL(String(url ?? "").trim()); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return h || null;
}

/** On this workstation: `localhost`, `*.localhost`, 127.0.0.0/8, or ::1. */
export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h.endsWith(".localhost") || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h) || h === "::1";
}

/** Hostnames of the enabled enclave Local Providers' base URLs. Empty under the org-managed lock, for the
 *  same reason as enclaveProviderSet (loopback, being on-device rather than attested, is unaffected). */
export function enclaveHostSet(providers: readonly EnclaveProviderRef[] | null | undefined, managedLocked: boolean): Set<string> {
  const out = new Set<string>();
  if (managedLocked) return out;
  for (const p of providers ?? []) {
    if (!p || p.enabled !== true || p.enclave !== true) continue;
    const h = httpHost(p.baseUrl);
    if (h) out.add(h);
  }
  return out;
}

/** True when an agent egress target is loopback or an enclave host, i.e. not PUBLIC egress, so the
 *  lockdown CUI-session block does not apply (the normal whitelist/approval posture still does). Only an
 *  absolute http(s) URL qualifies; a bare search query or unparseable target is never exempt. */
export function lockdownEgressExempt(target: string | null | undefined, enclaveHosts: ReadonlySet<string>): boolean {
  if (!target || !/^https?:\/\//i.test(target)) return false;
  const h = httpHost(target);
  return !!h && (isLoopbackHost(h) || enclaveHosts.has(h));
}

// ── voice ────────────────────────────────────────────────────────────────────────────────────────

/** Speech engines as settings_store names them. STT "elevenlabs" is ElevenLabs Scribe. */
export type VoiceKind = "tts" | "stt";
const CLOUD_VOICE: Record<string, string> = { elevenlabs: "ElevenLabs", "openai-tts": "OpenAI TTS" };
const LOCAL_VOICE: Record<string, string> = { "local-tts": "Kokoro", "dots-tts": "dots.tts", whisper: "offline Whisper" };

/** May this speech engine run under lockdown? Lock off: always. Lock on: cloud engines (not CUI-authorized)
 *  are refused; a local engine is allowed only when its endpoint is loopback or an enclave host; an unknown
 *  engine is refused (fail-closed). `reason` is the user-facing refusal and the audit reason. */
export function lockdownVoiceVerdict(locked: boolean, kind: VoiceKind, engine: string, url: string | null | undefined, enclaveHosts: ReadonlySet<string>): { allowed: boolean; reason: string } {
  if (!locked) return { allowed: true, reason: "" };
  const cloud = CLOUD_VOICE[engine];
  const fallback = kind === "stt" ? "Switch speech-to-text to offline Whisper (Settings \u2192 Voice)." : "Switch read-aloud to Kokoro or your DGX dots.tts voice (Settings \u2192 Voice).";
  if (cloud) {
    return { allowed: false, reason: `CUI lockdown: ${cloud} is a cloud service that is not CUI-authorized, so ${kind === "stt" ? "your audio" : "this text"} is not sent to it. ${fallback}` };
  }
  const local = LOCAL_VOICE[engine];
  if (!local) return { allowed: false, reason: `CUI lockdown: the speech engine "${String(engine).slice(0, 40)}" is not recognized, so it is refused. ${fallback}` };
  const h = httpHost(url);
  if (h && (isLoopbackHost(h) || enclaveHosts.has(h))) return { allowed: true, reason: "" };
  return { allowed: false, reason: `CUI lockdown: the ${local} endpoint ${h ?? "(invalid URL)"} is neither on this workstation nor a DGX enclave host, so it is refused. Point it at localhost or an SSH forward to the DGX.` };
}
