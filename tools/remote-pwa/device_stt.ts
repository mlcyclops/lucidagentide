// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// tools/remote-pwa/device_stt.ts - P-REMOTE.14: a typed wrapper over the browser's Web Speech recognizer.
//
// The Web Speech API is NOT in the project's DOM typings (and the on-device additions are newer than any
// lib.dom), so every member it needs is declared locally here and reached by narrowing off globalThis. This
// file only PROBES and DRIVES the recognizer; whether it may be used at all is decided by the pure policy in
// desktop/collab/device_stt_policy.ts.
//
// The one fact that shapes everything: the DEFAULT Web Speech behavior is CLOUD. The browser vendor receives
// the audio. On-device recognition exists only where `SpeechRecognition.available()` / `.install()` exist
// (Chrome 139+) and the language pack is present; iOS Safari has neither, and is documented to fall back to
// cloud recognition mid-session, so "local" is never provable there. Every uncertain answer here resolves to
// "not supported" or "unknown" so the policy fails closed (AGENTS.md #3).

import type { SttCapability } from "../../desktop/collab/device_stt_policy.ts";

/** The options bag Chrome's on-device additions accept, on the instance and on the static members. */
interface SttLocalOptions { langs: string[]; processLocally: boolean }

/** One alternative of one recognition result. */
interface SttAlternative { transcript?: unknown }
/** One recognized segment: alternatives by index, `isFinal` once the recognizer commits to it. */
interface SttResult { length?: unknown; isFinal?: unknown; [index: number]: SttAlternative | undefined }
/** The growing list of segments for the current session. */
interface SttResultList { length?: unknown; [index: number]: SttResult | undefined }
interface SttResultEvent { resultIndex?: unknown; results?: SttResultList }
interface SttErrorEvent { error?: unknown; message?: unknown }

/** The recognizer instance surface this wrapper uses. */
interface SttRecognizer {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  /** Chrome 139+: instructs the recognizer to stay on the device for these languages. */
  options?: SttLocalOptions;
  onresult: ((ev: SttResultEvent) => void) | null;
  onerror: ((ev: SttErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

/** The constructor plus the (optional, Chrome-only) static on-device members. */
interface SttCtor {
  new (): SttRecognizer;
  available?: (opts: SttLocalOptions) => Promise<unknown>;
  install?: (opts: SttLocalOptions) => Promise<unknown>;
}

/** The globals this wrapper reads. Declared locally because none of them are in the project's DOM typings. */
interface SttGlobals {
  SpeechRecognition?: SttCtor;
  webkitSpeechRecognition?: SttCtor;
  navigator?: { userAgent?: unknown; standalone?: unknown; maxTouchPoints?: unknown; language?: unknown };
  matchMedia?: (query: string) => { matches?: unknown };
}

/** The four availability answers Chrome's static `available()` resolves. */
const AVAILABILITY: Record<string, "available" | "downloadable" | "downloading" | "unavailable"> = {
  available: "available",
  downloadable: "downloadable",
  downloading: "downloading",
  unavailable: "unavailable",
};

/** Plain-language messages for the recognizer's error codes; anything else falls back to the event message. */
const STT_ERRORS: Record<string, string> = {
  "not-allowed": "This site is not allowed to use the microphone.",
  "service-not-allowed": "This browser refused to run speech recognition.",
  "audio-capture": "No microphone was available.",
  "no-speech": "No speech was heard.",
  network: "Speech recognition lost its connection.",
  aborted: "Dictation was interrupted.",
  "language-not-supported": "This language is not available for dictation.",
  "bad-grammar": "The recognizer rejected the request.",
};

const g = globalThis as unknown as SttGlobals; // the Web Speech globals are absent from lib.dom: widen once, here

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** The recognizer constructor, prefixed or not, or null when this browser has none. */
function sttCtor(): SttCtor | null {
  const plain = "SpeechRecognition" in g ? g.SpeechRecognition : undefined;
  if (typeof plain === "function") return plain;
  const webkit = "webkitSpeechRecognition" in g ? g.webkitSpeechRecognition : undefined;
  return typeof webkit === "function" ? webkit : null;
}

/** iPhone/iPad, including iPadOS 13+ which reports a desktop-Mac user agent with a touch screen. */
function isIos(): boolean {
  const ua = str(g.navigator?.userAgent);
  if (/iphone|ipad|ipod/i.test(ua)) return true;
  const touch = typeof g.navigator?.maxTouchPoints === "number" ? g.navigator.maxTouchPoints : 0;
  return /macintosh/i.test(ua) && touch > 1;
}

/** Running as an INSTALLED app (no browser chrome): Safari's own flag, else the standalone display mode. */
function isStandalone(): boolean {
  if (g.navigator?.standalone === true) return true;
  const mm = g.matchMedia;
  if (typeof mm !== "function") return false;
  try { return mm.call(g, "(display-mode: standalone)").matches === true; } catch { return false; }
}

/**
 * What this phone's browser can actually do with speech, probed at runtime. Never throws or rejects: an
 * unreadable answer means we cannot prove where the audio would go, and the policy treats that as no local
 * path (fail-closed).
 *
 * Note the iOS-installed short circuit: iOS Safari REFUSES SpeechRecognition once the site runs as an
 * installed PWA (LUCID's normal phone client), so a constructor may exist and still never yield a word.
 * Reporting it unsupported here is what keeps a dead dictate button off the composer.
 */
export async function probeSttCapability(lang: string): Promise<SttCapability> {
  if (isIos() && isStandalone()) return { supported: false, localProvable: false, localStatus: "unknown", reason: "installed-pwa-ios" };
  const ctor = sttCtor();
  if (!ctor) return { supported: false, localProvable: false, localStatus: "unknown", reason: isIos() ? "ios-webkit" : "no-api" };
  const available = ctor.available;
  // No static availability API (iOS Safari, older Chrome): the recognizer works, but "on-device" is not
  // checkable, so the local status stays UNKNOWN rather than being assumed either way.
  if (typeof available !== "function") return { supported: true, localProvable: false, localStatus: "unknown" };
  try {
    const answer = await available.call(ctor, { langs: [lang], processLocally: true });
    const status = AVAILABILITY[str(answer)];
    // An answer we cannot interpret proves nothing: report it as not provable, never as available.
    if (!status) return { supported: true, localProvable: false, localStatus: "unknown" };
    return { supported: true, localProvable: true, localStatus: status };
  } catch {
    return { supported: false, localProvable: false, localStatus: "unknown", reason: "probe-failed" };
  }
}

/**
 * Download the on-device language pack once (Chrome 139+), so recognition afterwards runs fully offline.
 * Resolves false when the browser has no install API or the download did not complete.
 */
export async function installSttLanguage(lang: string): Promise<boolean> {
  const ctor = sttCtor();
  const install = ctor?.install;
  if (typeof install !== "function") return false;
  try { return (await install.call(ctor, { langs: [lang], processLocally: true })) === true; } catch { return false; }
}

/** Everything a dictation session needs; `processLocally` also INSTRUCTS the recognizer to stay on device. */
export interface DictationOpts {
  lang: string;
  processLocally: boolean;
  onInterim: (text: string) => void;
  onFinal: (text: string) => void;
  onError: (message: string) => void;
}

/** Split one result event into its newly committed text and its still-changing text. */
function readResults(ev: SttResultEvent): { final: string; interim: string } {
  const results = ev.results;
  if (!results) return { final: "", interim: "" };
  const from = typeof ev.resultIndex === "number" && ev.resultIndex >= 0 ? Math.floor(ev.resultIndex) : 0;
  const count = typeof results.length === "number" && results.length > 0 ? Math.floor(results.length) : 0;
  let final = "";
  let interim = "";
  for (let i = from; i < count; i++) {
    const r = results[i];
    if (!r) continue;
    const text = str(r[0]?.transcript).trim();
    if (!text) continue; // an event with no usable transcript is normal, not an error
    if (r.isFinal === true) final = final ? `${final} ${text}` : text;
    else interim = interim ? `${interim} ${text}` : text;
  }
  return { final, interim };
}

/**
 * Run one dictation utterance. Interim text streams through `onInterim` so the composer fills live; the
 * committed transcript arrives once through `onFinal` (the caller reviews it and sends it by hand: an
 * unreviewed transcript is worse than one extra tap, and iOS interim results are unreliable).
 */
export function startDictation(opts: DictationOpts): { stop: () => void } {
  const ctor = sttCtor();
  if (!ctor) {
    opts.onError("This browser cannot transcribe on the device.");
    return { stop: () => { /* nothing started */ } };
  }
  let rec: SttRecognizer;
  try {
    rec = new ctor();
  } catch {
    opts.onError("This browser could not start speech recognition.");
    return { stop: () => { /* nothing started */ } };
  }
  rec.lang = opts.lang;
  rec.continuous = false; // one utterance per tap: no hot mic, ever
  rec.interimResults = true;
  if (opts.processLocally) rec.options = { langs: [opts.lang], processLocally: true };

  let committed = "";
  let settled = false;
  const settle = (): void => {
    if (settled) return;
    settled = true;
    if (committed) opts.onFinal(committed);
  };
  rec.onresult = (ev) => {
    const { final, interim } = readResults(ev);
    if (final) committed = committed ? `${committed} ${final}` : final;
    const live = interim ? (committed ? `${committed} ${interim}` : interim) : committed;
    if (live) opts.onInterim(live);
    if (final) settle(); // continuous=false: a committed segment ends this utterance
  };
  rec.onerror = (ev) => {
    settled = true; // a failed session must never deliver a transcript afterwards
    try { rec.abort(); } catch { /* already dead */ }
    opts.onError(STT_ERRORS[str(ev.error)] || str(ev.message) || "Dictation failed.");
  };
  rec.onend = () => settle();
  try {
    rec.start();
  } catch {
    settled = true;
    opts.onError("This browser could not start speech recognition.");
  }
  return { stop: () => { try { rec.stop(); } catch { /* already stopped */ } } };
}
