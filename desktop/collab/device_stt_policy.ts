// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/collab/device_stt_policy.ts - P-REMOTE.14: should the PHONE transcribe, or should the DESKTOP?
//
// The phone PWA can dictate two ways:
//   1. Device STT: the browser's Web Speech API turns speech into text on the phone, and only TEXT is sent.
//   2. Hold-to-talk (P-REMOTE.12, the existing path): the phone records a WAV, the HOST transcribes it with
//      offline whisper.cpp, and the audio never leaves the user's own two machines.
//
// Option 1 is only acceptable when the phone can PROVE the recognition runs on the device. The Web Speech API
// DEFAULTS TO THE CLOUD: without `processLocally` the browser vendor receives the audio and transcribes it on
// its own servers. Chrome 139+ exposes `SpeechRecognition.available({ langs, processLocally })` so that claim
// is checkable; iOS Safari exposes no such API and is documented to switch to cloud recognition mid-session,
// so "local" is NOT provable there, ever.
//
// This module is the whole decision, and nothing else: PURE, DOM-free, import-free, so it is exhaustively
// unit-testable and can be read top to bottom by a reviewer asking "can my voice leave the phone?". The
// browser probing lives in the PWA; the enforcement lives in host.ts. Fail-closed (AGENTS.md #3): every path
// that cannot prove on-device recognition resolves to "host", the offline desktop transcription.
//
// The note/warn/reason strings are USER-FACING copy rendered on a phone: one plain sentence each.

/** What the phone's browser can actually do, probed at runtime by the PWA. */
export interface SttCapability {
  /** A `SpeechRecognition` (or `webkitSpeechRecognition`) constructor exists. */
  supported: boolean;
  /** The static availability API exists, so "runs on the device" is CHECKABLE rather than hoped for. */
  localProvable: boolean;
  /** What `SpeechRecognition.available({ processLocally: true })` answered, or "unknown" when unaskable. */
  localStatus: "available" | "downloadable" | "downloading" | "unavailable" | "unknown";
  /** Why unsupported: "installed-pwa-ios" | "ios-webkit" | "no-api", or free text for anything else. */
  reason?: string;
}

/** The host's stance, learned from a `welcome`/`state` frame. Strictest assumption until a frame says otherwise. */
export interface HostPosture { cui: boolean; lockdown: boolean }

export type SttDecision =
  | { mode: "device-local"; note: string }
  | { mode: "install-first"; note: string }
  | { mode: "device-cloud"; warn: string }
  | { mode: "host"; reason: string };

/** Both halves of the CUI guarantee: a CUI-designated session AND model lockdown. Under strict posture, only
 *  PROVEN on-device recognition (or the one-time language-pack install that reaches it) may transcribe here. */
export function isStrict(posture: HostPosture): boolean {
  return posture.cui === true && posture.lockdown === true;
}

/** Fall back to hold-to-talk, which the desktop transcribes offline. Appended to every refusal so the phone
 *  always tells the user what to do INSTEAD of just what it will not do. */
const USE_HOLD_TO_TALK = "hold the mic button instead and your desktop will transcribe the recording offline";

/** Plain-language explanations for the platforms that simply cannot offer web speech recognition. */
const UNSUPPORTED_COPY: Record<string, string> = {
  // iOS Safari refuses SpeechRecognition once the site runs as an installed home-screen app, which is
  // LUCID's normal phone client, so this is the common case and needs its own sentence.
  "installed-pwa-ios": `Safari turns off speech recognition once LUCID is installed to your home screen, so ${USE_HOLD_TO_TALK}.`,
  // Every iOS browser is WebKit underneath, so a non-Safari iOS browser has no recognizer at all.
  "ios-webkit": `Browsers on iPhone and iPad do not give web apps on-device speech recognition, so ${USE_HOLD_TO_TALK}.`,
  "no-api": `This browser has no speech recognition, so ${USE_HOLD_TO_TALK}.`,
  // The static availability API rejected, so nothing about this browser is provable either way.
  "probe-failed": `This browser could not confirm that it would keep your voice on the phone, so ${USE_HOLD_TO_TALK}.`,
};

/**
 * Decide how a phone should turn speech into text, fail-closed.
 *
 * Order matters, and each step is a hard gate:
 *   1. No recognizer at all: the desktop transcribes.
 *   2. On-device recognition PROVEN available: use it, even under a strict CUI posture, because the audio
 *      never leaves the phone.
 *   3. On-device recognition is one download away: offer the one-time language-pack install. Under a strict
 *      posture this is the ONLY route to device transcription.
 *   4. Strict posture with no proven local path: the desktop transcribes, and we say why.
 *   5. Otherwise the vendor's cloud would do the work, so we allow it only with an explicit warning.
 */
export function decideSttMode(cap: SttCapability, posture: HostPosture): SttDecision {
  if (!cap.supported) {
    const known = cap.reason ? UNSUPPORTED_COPY[cap.reason] : undefined;
    if (known) return { mode: "host", reason: known };
    // Anything else: surface the detail ONLY when it reads as prose. A one-word token (a new probe result this
    // build has no copy for) would leak jargon into a phone UI, so it collapses to the generic sentence.
    const detail = cap.reason?.trim();
    return {
      mode: "host",
      reason: detail && detail.includes(" ")
        ? `This browser cannot turn your voice into text on the phone (${detail}), so ${USE_HOLD_TO_TALK}.`
        : `This browser cannot turn your voice into text on the phone, so ${USE_HOLD_TO_TALK}.`,
    };
  }

  // A status is only believed when the availability API actually answered it. An "available" claim without a
  // provable source is treated as unproven (fail-closed), so a spoofed or half-probed capability cannot buy
  // device transcription inside a CUI session.
  if (cap.localProvable) {
    if (cap.localStatus === "available") {
      return { mode: "device-local", note: "Your phone turns your voice into text on the device, so the audio never leaves your phone." };
    }
    if (cap.localStatus === "downloadable") {
      return { mode: "install-first", note: "Install the on-device language pack once, then your phone can turn your voice into text without sending the audio anywhere." };
    }
    if (cap.localStatus === "downloading") {
      return { mode: "install-first", note: "The on-device language pack is still downloading, so wait for it to finish before dictating on the phone." };
    }
  }

  if (isStrict(posture)) {
    return {
      mode: "host",
      reason: `This session is marked CUI and model lockdown is on, so nothing may go to a cloud transcriber: ${USE_HOLD_TO_TALK}.`,
    };
  }

  return {
    mode: "device-cloud",
    warn: `Your browser vendor transcribes this audio on its own servers, so your voice leaves the phone: ${USE_HOLD_TO_TALK} to keep it between your devices.`,
  };
}
