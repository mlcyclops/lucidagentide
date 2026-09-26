// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-REMOTE.14: the Web Speech wrapper's LOGIC, against an injected fake recognizer (no real browser).
//
// What is worth pinning here is the fail-closed shape of the probe: an unprovable or unreadable answer must
// NEVER come back looking local, an iOS-installed PWA must be reported unsupported with the reason that
// explains it, and a rejecting availability call must resolve rather than throw. Plus the dictation plumbing:
// interim text streams, the committed transcript lands once, and `processLocally` reaches the recognizer only
// when it was asked for.

import { afterEach, describe, expect, it } from "bun:test";
import { installSttLanguage, probeSttCapability, startDictation } from "./device_stt.ts";

interface FakeOpts { langs: string[]; processLocally: boolean }
interface FakeSegment { transcript: string; isFinal: boolean }

/** The recognizer the wrapper drives: records what was set on it and lets a test fire events by hand. */
class FakeRecognizer {
  static last: FakeRecognizer | null = null;
  lang = "";
  continuous = true;
  interimResults = false;
  options: FakeOpts | undefined = undefined;
  started = 0;
  stopped = 0;
  aborted = 0;
  onresult: ((ev: { resultIndex: number; results: Record<number, Record<number, { transcript: string }> & { length: number; isFinal: boolean }> & { length: number } }) => void) | null = null;
  onerror: ((ev: { error?: string; message?: string }) => void) | null = null;
  onend: (() => void) | null = null;

  constructor() { FakeRecognizer.last = this; }
  start(): void { this.started++; }
  stop(): void { this.stopped++; this.onend?.(); }
  abort(): void { this.aborted++; }

  /** Fire one result event holding `segments`, shaped like the real indexed SpeechRecognitionResultList. */
  emit(segments: FakeSegment[]): void {
    const results: Record<number, unknown> & { length: number } = { length: segments.length };
    segments.forEach((s, i) => { results[i] = { length: 1, isFinal: s.isFinal, 0: { transcript: s.transcript } }; });
    const ev = { resultIndex: 0, results } as unknown as Parameters<NonNullable<FakeRecognizer["onresult"]>>[0]; // the real event type is not in lib.dom
    this.onresult?.(ev);
  }
}

/** Everything this suite plants on globalThis, so afterEach can put the world back exactly as it was. */
const KEYS = ["SpeechRecognition", "webkitSpeechRecognition", "navigator", "matchMedia"] as const;
const saved = new Map<string, { present: boolean; value: unknown }>();
const g = globalThis as unknown as Record<string, unknown>; // the fakes live on the global object, which lib.dom cannot type

function plant(key: string, value: unknown): void {
  if (!saved.has(key)) saved.set(key, { present: key in g, value: g[key] });
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}

/** A constructor with the optional Chrome-only statics attached; `undefined` leaves a static off entirely. */
function plantCtor(statics: { available?: (o: FakeOpts) => Promise<unknown>; install?: (o: FakeOpts) => Promise<unknown> } = {}): void {
  const ctor = FakeRecognizer as unknown as Record<string, unknown>; // statics are per-test, so attach them dynamically
  delete ctor.available;
  delete ctor.install;
  if (statics.available) ctor.available = statics.available;
  if (statics.install) ctor.install = statics.install;
  plant("SpeechRecognition", FakeRecognizer);
  plant("webkitSpeechRecognition", undefined);
}

const nav = (ua: string, standalone?: boolean): void => plant("navigator", { userAgent: ua, standalone, maxTouchPoints: 0, language: "en-US" });
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15";
const ANDROID = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/139.0.0.0 Mobile Safari/537.36";

afterEach(() => {
  const ctor = FakeRecognizer as unknown as Record<string, unknown>; // drop the per-test statics again
  delete ctor.available;
  delete ctor.install;
  FakeRecognizer.last = null;
  for (const key of KEYS) {
    const prev = saved.get(key);
    if (!prev) continue;
    if (prev.present) Object.defineProperty(globalThis, key, { value: prev.value, configurable: true, writable: true });
    else delete g[key];
  }
  saved.clear();
});

describe("probeSttCapability", () => {
  it("maps every availability status the static API can answer", async () => {
    nav(ANDROID);
    for (const status of ["available", "downloadable", "downloading", "unavailable"] as const) {
      plantCtor({ available: () => Promise.resolve(status) });
      expect(await probeSttCapability("en-US")).toEqual({ supported: true, localProvable: true, localStatus: status });
    }
  });

  it("passes the language and processLocally:true to the availability check", async () => {
    nav(ANDROID);
    const seen: FakeOpts[] = [];
    plantCtor({ available: (o) => { seen.push(o); return Promise.resolve("available"); } });
    await probeSttCapability("de-DE");
    expect(seen).toEqual([{ langs: ["de-DE"], processLocally: true }]);
  });

  it("without the static API the recognizer is supported but local is NOT provable", async () => {
    nav(IPHONE); // iOS Safari in a browser tab: webkitSpeechRecognition exists, availability does not
    plantCtor();
    expect(await probeSttCapability("en-US")).toEqual({ supported: true, localProvable: false, localStatus: "unknown" });
  });

  it("an unreadable availability answer is reported unknown, never available", async () => {
    nav(ANDROID);
    plantCtor({ available: () => Promise.resolve("maybe-later") });
    expect(await probeSttCapability("en-US")).toEqual({ supported: true, localProvable: false, localStatus: "unknown" });
  });

  it("a rejecting availability call resolves to unsupported instead of throwing", async () => {
    nav(ANDROID);
    plantCtor({ available: () => Promise.reject(new Error("boom")) });
    expect(await probeSttCapability("en-US")).toEqual({ supported: false, localProvable: false, localStatus: "unknown", reason: "probe-failed" });
  });

  it("an installed iOS PWA is unsupported even when a constructor exists (Safari refuses it there)", async () => {
    nav(IPHONE, true);
    plantCtor({ available: () => Promise.resolve("available") });
    expect(await probeSttCapability("en-US")).toEqual({ supported: false, localProvable: false, localStatus: "unknown", reason: "installed-pwa-ios" });
  });

  it("standalone display-mode counts as installed even without Safari's flag", async () => {
    nav(IPHONE);
    plant("matchMedia", (q: string) => ({ matches: q.includes("standalone") }));
    plantCtor();
    expect((await probeSttCapability("en-US")).reason).toBe("installed-pwa-ios");
  });

  it("iOS without a constructor reports ios-webkit", async () => {
    nav(IPHONE);
    plant("SpeechRecognition", undefined);
    plant("webkitSpeechRecognition", undefined);
    expect(await probeSttCapability("en-US")).toEqual({ supported: false, localProvable: false, localStatus: "unknown", reason: "ios-webkit" });
  });

  it("anywhere else without a constructor reports no-api", async () => {
    nav(ANDROID);
    plant("SpeechRecognition", undefined);
    plant("webkitSpeechRecognition", undefined);
    expect(await probeSttCapability("en-US")).toEqual({ supported: false, localProvable: false, localStatus: "unknown", reason: "no-api" });
  });

  it("falls back to the webkit-prefixed constructor", async () => {
    nav(IPHONE);
    plant("SpeechRecognition", undefined);
    plant("webkitSpeechRecognition", FakeRecognizer);
    expect((await probeSttCapability("en-US")).supported).toBe(true);
  });
});

describe("installSttLanguage", () => {
  it("resolves true when the language pack downloads", async () => {
    nav(ANDROID);
    const seen: FakeOpts[] = [];
    plantCtor({ install: (o) => { seen.push(o); return Promise.resolve(true); } });
    expect(await installSttLanguage("fr-FR")).toBe(true);
    expect(seen).toEqual([{ langs: ["fr-FR"], processLocally: true }]);
  });

  it("resolves false when the download fails or rejects", async () => {
    nav(ANDROID);
    plantCtor({ install: () => Promise.resolve(false) });
    expect(await installSttLanguage("en-US")).toBe(false);
    plantCtor({ install: () => Promise.reject(new Error("offline")) });
    expect(await installSttLanguage("en-US")).toBe(false);
  });

  it("resolves false when the browser has no install API at all", async () => {
    nav(IPHONE);
    plantCtor();
    expect(await installSttLanguage("en-US")).toBe(false);
  });
});

describe("startDictation", () => {
  const collect = (processLocally: boolean): { interim: string[]; final: string[]; errors: string[]; handle: { stop: () => void } } => {
    const interim: string[] = [];
    const final: string[] = [];
    const errors: string[] = [];
    const handle = startDictation({
      lang: "en-US",
      processLocally,
      onInterim: (t) => interim.push(t),
      onFinal: (t) => final.push(t),
      onError: (m) => errors.push(m),
    });
    return { interim, final, errors, handle };
  };

  it("streams interim text, then delivers the committed transcript once", () => {
    nav(ANDROID);
    plantCtor();
    const c = collect(true);
    const rec = FakeRecognizer.last!;
    expect(rec.started).toBe(1);
    rec.emit([{ transcript: "fix the auth", isFinal: false }]);
    rec.emit([{ transcript: "fix the auth guard", isFinal: false }]);
    expect(c.interim).toEqual(["fix the auth", "fix the auth guard"]);
    expect(c.final).toEqual([]);
    rec.emit([{ transcript: "fix the auth guard", isFinal: true }]);
    expect(c.final).toEqual(["fix the auth guard"]);
    rec.onend?.(); // the recognizer's own end must not deliver a second transcript
    expect(c.final).toEqual(["fix the auth guard"]);
  });

  it("configures one utterance with interim results, and asks to stay on device only when told to", () => {
    nav(ANDROID);
    plantCtor();
    collect(true);
    const local = FakeRecognizer.last!;
    expect(local.lang).toBe("en-US");
    expect(local.continuous).toBe(false);
    expect(local.interimResults).toBe(true);
    expect(local.options).toEqual({ langs: ["en-US"], processLocally: true });
    collect(false);
    expect(FakeRecognizer.last!.options).toBeUndefined();
  });

  it("accumulates several committed segments in order", () => {
    nav(ANDROID);
    plantCtor();
    const c = collect(true);
    FakeRecognizer.last!.emit([{ transcript: "run the tests", isFinal: true }, { transcript: "then push", isFinal: true }]);
    expect(c.final).toEqual(["run the tests then push"]);
  });

  it("a result event with no usable transcript is not an error and delivers nothing", () => {
    nav(ANDROID);
    plantCtor();
    const c = collect(true);
    FakeRecognizer.last!.emit([{ transcript: "   ", isFinal: false }]);
    expect(c.interim).toEqual([]);
    expect(c.final).toEqual([]);
    expect(c.errors).toEqual([]);
  });

  it("surfaces a plain sentence for an error code, aborts, and never delivers a transcript after it", () => {
    nav(ANDROID);
    plantCtor();
    const c = collect(true);
    const rec = FakeRecognizer.last!;
    rec.emit([{ transcript: "half a sentence", isFinal: true }]);
    c.final.length = 0; // the committed segment already landed; the error must not re-deliver it
    rec.onerror?.({ error: "not-allowed" });
    expect(c.errors).toEqual(["This site is not allowed to use the microphone."]);
    expect(rec.aborted).toBe(1);
    rec.onend?.();
    expect(c.final).toEqual([]);
  });

  it("falls back to the event message for an unknown error code", () => {
    nav(ANDROID);
    plantCtor();
    const c = collect(true);
    FakeRecognizer.last!.onerror?.({ error: "weird-new-code", message: "recognizer went away" });
    expect(c.errors).toEqual(["recognizer went away"]);
  });

  it("stop() ends the session and hands back whatever was committed", () => {
    nav(ANDROID);
    plantCtor();
    const c = collect(true);
    const rec = FakeRecognizer.last!;
    rec.onresult?.({ resultIndex: 0, results: Object.assign({ length: 1 }, { 0: Object.assign({ length: 1, isFinal: true }, { 0: { transcript: "ship it" } }) }) });
    c.final.length = 0;
    c.handle.stop();
    expect(rec.stopped).toBe(1);
    expect(c.final).toEqual([]); // already settled by the committed segment
  });

  it("reports an error instead of throwing when the browser has no recognizer", () => {
    nav(ANDROID);
    plant("SpeechRecognition", undefined);
    plant("webkitSpeechRecognition", undefined);
    const c = collect(true);
    expect(c.errors).toEqual(["This browser cannot transcribe on the device."]);
    c.handle.stop(); // the no-op handle must be safe to call
  });
});
