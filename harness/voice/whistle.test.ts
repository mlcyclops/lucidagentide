// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// CREATOR-WHISTLE (ADR-0432, decision 7): the egress proof as a permanent test. The wasm import table is
// pinned to its 16 names (any socket import, or ANY upstream change, fails here), the glue's ENV is
// empty, load + transcribe run with fetch/XMLHttpRequest/WebSocket replaced by throwing traps, and the
// real model transcribes a real 16 kHz clip with word times. The suite needs the three pinned assets;
// without them every asset-backed test skips with a printed reason (never a vacuous pass).

import { expect, test } from "bun:test";
import {
  WHISTLE_CUT_SEARCH_MS, WHISTLE_LANGUAGES, WHISTLE_SAMPLE_RATE, WHISTLE_WINDOW_MS, WhistleEngine,
  whistleLanguageRefusal, windowPcm,
} from "./whistle.ts";
import {
  FIXTURE_TEXT, WHISTLE_SKIP_REASON, findWhistleAssetDir, normalizedTokens, readFixturePcm16k, readVerifiedWhistleAssets,
  tokenMatch, type VerifiedWhistleAssets,
} from "./whistle_test_assets.ts";

const PINNED_IMPORTS = [
  "___cxa_throw", "___syscall_fcntl64", "___syscall_ioctl", "___syscall_openat", "___syscall_rmdir", "___syscall_unlinkat",
  "__abort_js", "__munmap_js", "_clock_time_get", "_emscripten_resize_heap", "_environ_get", "_environ_sizes_get",
  "_fd_close", "_fd_read", "_fd_seek", "_fd_write",
];

const ASSET_DIR = findWhistleAssetDir();
if (ASSET_DIR === null) console.log(`whistle.test: ${WHISTLE_SKIP_REASON}`);
const withAssets = test.skipIf(ASSET_DIR === null);

let assets: VerifiedWhistleAssets | null = null;
function verifiedAssets(): VerifiedWhistleAssets {
  if (assets === null) assets = readVerifiedWhistleAssets(ASSET_DIR!);
  return assets;
}

function noise(seconds: number, amplitude: number, seed = 1): Float32Array {
  const out = new Float32Array(Math.round(WHISTLE_SAMPLE_RATE * seconds));
  let s = seed >>> 0;
  for (let i = 0; i < out.length; i++) {
    s = (s * 1664525 + 1013904223) >>> 0; // LCG: deterministic
    out[i] = amplitude * ((s / 4294967296) * 2 - 1);
  }
  return out;
}

// ---- pure: windowing and language refusal (no assets) ----

test("windowPcm: 29 s is one window, 30 s is one window, empty is none", () => {
  expect(windowPcm(noise(29, 0.5))).toEqual([{ start: 0, end: 29 * WHISTLE_SAMPLE_RATE }]);
  expect(windowPcm(noise(30, 0.5)).length).toBe(1);
  expect(windowPcm(new Float32Array(0))).toEqual([]);
});

test("windowPcm: the cut lands on the quietest 20 ms hop inside the last 5 s of the window", () => {
  const pcm = noise(40, 0.5);
  const silentAt = Math.round(27.5 * WHISTLE_SAMPLE_RATE); // on the hop grid (25 s + 125 hops of 320)
  pcm.fill(0, silentAt, silentAt + 320);
  expect(windowPcm(pcm)).toEqual([{ start: 0, end: silentAt }, { start: silentAt, end: pcm.length }]);
});

test("windowPcm: no window exceeds 30 s, windows tile the clip, the last may be short", () => {
  const pcm = noise(95, 0.3, 7);
  const windows = windowPcm(pcm);
  expect(windows.length).toBeGreaterThanOrEqual(4);
  const max = (WHISTLE_SAMPLE_RATE * WHISTLE_WINDOW_MS) / 1000;
  const search = (WHISTLE_SAMPLE_RATE * WHISTLE_CUT_SEARCH_MS) / 1000;
  expect(windows[0]!.start).toBe(0);
  for (let i = 0; i < windows.length; i++) {
    const w = windows[i]!;
    expect(w.end - w.start).toBeLessThanOrEqual(max);
    if (i > 0) expect(w.start).toBe(windows[i - 1]!.end);
    if (i < windows.length - 1) expect(w.end - w.start).toBeGreaterThanOrEqual(max - search);
  }
  expect(windows[windows.length - 1]!.end).toBe(pcm.length);
  // Custom rates and sizes: 200000 samples at 8 kHz (25 s), 10 s windows, 2 s search -> 3 windows.
  expect(windowPcm(noise(12.5, 0.2), 8000, 10000, 2000).length).toBe(3);
});

test("whistleLanguageRefusal admits the seven languages and detection, refuses others by name", () => {
  expect(whistleLanguageRefusal(undefined)).toBeNull();
  expect(whistleLanguageRefusal("")).toBeNull();
  for (const l of WHISTLE_LANGUAGES) expect(whistleLanguageRefusal(l)).toBeNull();
  expect(whistleLanguageRefusal("ja")).toBe('Whistle supports en, de, fr, es, it, nl, pl; got "ja"');
  expect(whistleLanguageRefusal("EN")).toContain('"EN"');
});

// ---- assets: pins, traps, real speech ----

withAssets("the three pinned assets verify by size and sha256 before anything loads", () => {
  const a = verifiedAssets();
  expect(a.wasm.byteLength).toBe(903655);
  expect(a.cact.byteLength).toBe(16919407);
  expect(a.glue.startsWith("var createNeedle=")).toBe(true);
});

withAssets("wasm import table: 16 imports from module \"a\"; the glue's wasmImports= maps exactly the 16 pinned names; ENV is empty", async () => {
  const a = verifiedAssets();
  const compiled = await WebAssembly.compile(a.wasm);
  const imports = WebAssembly.Module.imports(compiled);
  expect(imports.length).toBe(16);
  expect(imports.every((i) => i.module === "a")).toBe(true);
  // Exports are minified too (one letter each); the glue binds them by name: `_needle_load=Module["_needle_load"]=wasmExports["w"]`.
  const exportsList = WebAssembly.Module.exports(compiled).map((e) => e.name);
  expect(exportsList.length).toBe(17);
  for (const fn of ["_needle_load", "_needle_transcribe", "_needle_last_error", "_needle_models", "_malloc", "_free"]) {
    const bound = new RegExp(`${fn}=Module\\["${fn}"\\]=wasmExports\\["([A-Za-z])"\\]`).exec(a.glue);
    expect(bound).not.toBeNull();
    expect(exportsList).toContain(bound![1]!);
  }

  const mapping = /wasmImports=\{([^}]*)\}/.exec(a.glue);
  expect(mapping).not.toBeNull();
  const names = mapping![1]!.split(",").map((pair) => pair.split(":")[1]?.trim() ?? "").filter((n) => n.length > 0);
  expect(names.length).toBe(16);
  expect([...names].sort()).toEqual([...PINNED_IMPORTS].sort());
  // No socket, connect, send or receive import anywhere in the mapping.
  expect(names.some((n) => /socket|connect|send|recv|fetch/i.test(n))).toBe(false);
  expect(a.glue).toContain("var ENV={}");
});

let engine: WhistleEngine | null = null;

withAssets("loads and transcribes with fetch/XMLHttpRequest/WebSocket trapped: zero egress; 1 s of silence is empty text", async () => {
  const a = verifiedAssets();
  const g = globalThis as unknown as Record<string, unknown>; // deliberate: swapping runtime globals for the trap
  const egress: string[] = [];
  const originals: Record<string, { had: boolean; value: unknown }> = {};
  for (const name of ["fetch", "XMLHttpRequest", "WebSocket"]) originals[name] = { had: name in g, value: g[name] };
  g.fetch = (...args: unknown[]) => { egress.push(`fetch ${String(args[0]).slice(0, 80)}`); throw new Error("egress blocked: fetch"); };
  g.XMLHttpRequest = class { constructor() { egress.push("XMLHttpRequest"); throw new Error("egress blocked: XMLHttpRequest"); } };
  g.WebSocket = class { constructor(url: unknown) { egress.push(`WebSocket ${String(url)}`); throw new Error("egress blocked: WebSocket"); } };
  try {
    const t0 = performance.now();
    engine = await WhistleEngine.load(a);
    console.log(`whistle.test: load ${Math.round(performance.now() - t0)} ms`);
    const silence = engine.transcribe(new Float32Array(WHISTLE_SAMPLE_RATE));
    expect(silence.text).toBe("");
    expect(silence.words).toEqual([]);
    expect(silence.windows).toBe(1);
  } finally {
    for (const [name, o] of Object.entries(originals)) {
      if (o.had) g[name] = o.value;
      else delete g[name];
    }
  }
  expect(egress).toEqual([]);
}, 60000);

withAssets("real speech: the fixture transcribes with >= 90% token match and non-decreasing word starts", () => {
  expect(engine).not.toBeNull();
  const pcm = readFixturePcm16k();
  const t0 = performance.now();
  const t = engine!.transcribe(pcm);
  const wall = Math.round(performance.now() - t0);
  console.log(`whistle.test: fixture ${(pcm.length / WHISTLE_SAMPLE_RATE).toFixed(2)} s transcribed in ${wall} ms (ttft ${Math.round(t.ttftMs)} ms, ${t.decodeTps.toFixed(1)} tok/s, language ${t.language})`);
  console.log(`whistle.test: transcript: ${t.text}`);
  const want = normalizedTokens(FIXTURE_TEXT);
  const got = normalizedTokens(t.text);
  const match = tokenMatch(want, got);
  console.log(`whistle.test: token match ${(match * 100).toFixed(1)}% (${got.length} tokens, ${t.words.length} timed words)`);
  expect(match).toBeGreaterThanOrEqual(0.9);
  expect(t.language).toBe("en");
  expect(t.windows).toBe(1);
  expect(t.words.length).toBeGreaterThanOrEqual(Math.floor(want.length * 0.9));
  // Every transcript token carries a time (segmentation may differ by a hyphen or a compound).
  expect(Math.abs(t.words.length - got.length)).toBeLessThanOrEqual(2);
  const clipMs = Math.ceil((pcm.length * 1000) / WHISTLE_SAMPLE_RATE);
  let prev = 0;
  for (const w of t.words) {
    expect(w.startMs).toBeGreaterThanOrEqual(prev);
    expect(w.endMs).toBeGreaterThanOrEqual(w.startMs);
    expect(w.endMs).toBeLessThanOrEqual(clipMs + 1000);
    expect(w.probability).toBeGreaterThanOrEqual(0);
    expect(w.probability).toBeLessThanOrEqual(1);
    prev = w.startMs;
  }
}, 60000);

withAssets("a 44 s clip (fixture, 20 s silence, fixture) is windowed into two calls with offsets applied", () => {
  expect(engine).not.toBeNull();
  const clip = readFixturePcm16k();
  const gapSamples = 20 * WHISTLE_SAMPLE_RATE;
  const pcm = new Float32Array(clip.length * 2 + gapSamples);
  pcm.set(clip, 0);
  pcm.set(clip, clip.length + gapSamples);
  const windows = windowPcm(pcm);
  expect(windows.length).toBe(2);
  // The cut falls in the silent gap, never through speech.
  expect(windows[0]!.end).toBeGreaterThanOrEqual(clip.length);
  expect(windows[0]!.end).toBeLessThanOrEqual(clip.length + gapSamples);
  const t = engine!.transcribe(pcm);
  expect(t.windows).toBe(2);
  const secondStartMs = Math.round(((clip.length + gapSamples) * 1000) / WHISTLE_SAMPLE_RATE);
  const first = t.words.filter((w) => w.endMs <= secondStartMs);
  const second = t.words.filter((w) => w.startMs >= secondStartMs - 500);
  expect(first.length).toBeGreaterThanOrEqual(20);
  expect(second.length).toBeGreaterThanOrEqual(20);
  expect(first.length + second.length).toBe(t.words.length);
  let prev = 0;
  for (const w of t.words) { expect(w.startMs).toBeGreaterThanOrEqual(prev); prev = w.startMs; }
  const want = normalizedTokens(FIXTURE_TEXT);
  // Accuracy is pinned by the single-window test above; here the point is that both windows were heard.
  expect(tokenMatch([...want, ...want], normalizedTokens(t.text))).toBeGreaterThanOrEqual(0.85);
}, 90000);

withAssets("transcribeWindow refuses an over-long window and an unsupported language by name", () => {
  expect(engine).not.toBeNull();
  expect(() => engine!.transcribeWindow(new Float32Array(WHISTLE_SAMPLE_RATE * 30 + 1))).toThrow(/at most 480000/);
  expect(() => engine!.transcribeWindow(new Float32Array(WHISTLE_SAMPLE_RATE), { language: "ja" })).toThrow(/Whistle supports .*; got "ja"/);
});
