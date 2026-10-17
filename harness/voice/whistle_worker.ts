// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/voice/whistle_worker.ts - the ONE Bun Worker that owns the Whistle model (ADR-0432, decision 2).
//
// The model is process-global and not thread-safe, and a 3 s decode on the main thread would stall every
// engine route, so the engine runs it here and talks to it through `WhistleClient`. Messages:
//   in  { type: "load", gluePath, wasm: Uint8Array, cact: Uint8Array }   out { type: "ready" } | { type: "load-error", reason }
//   in  { type: "transcribe", id, pcm: Float32Array, opts }               out { type: "result", id, transcript } | { type: "error", id, reason }
// Byte buffers travel as transferables in both directions; results are plain JSON.

import { WhistleEngine, type WhistleOptions } from "./whistle.ts";

interface WorkerScope {
  onmessage: ((ev: MessageEvent<unknown>) => void) | null;
  postMessage(message: unknown, transfer?: ArrayBuffer[]): void;
}
// The harness tsconfig has no DOM lib, so `self` is undeclared at type level; in a dedicated worker it is the worker scope.
declare const self: unknown;
const scope = self as WorkerScope;

let engine: WhistleEngine | null = null;
let loading = false;

async function onLoad(msg: Record<string, unknown>): Promise<void> {
  if (engine !== null || loading) { scope.postMessage({ type: "load-error", reason: "Whistle worker already loaded a model" }); return; }
  const { gluePath, wasm, cact } = msg;
  if (typeof gluePath !== "string" || !(wasm instanceof Uint8Array) || !(cact instanceof Uint8Array)) {
    scope.postMessage({ type: "load-error", reason: "Whistle load message needs gluePath, wasm bytes and cact bytes" });
    return;
  }
  loading = true;
  try {
    engine = await WhistleEngine.load({ gluePath, wasm, cact });
    scope.postMessage({ type: "ready" });
  } catch (e) {
    scope.postMessage({ type: "load-error", reason: e instanceof Error ? e.message : String(e) });
  } finally {
    loading = false;
  }
}

function onTranscribe(msg: Record<string, unknown>): void {
  const id = msg.id;
  if (typeof id !== "number") return;
  const pcm = msg.pcm;
  if (!(pcm instanceof Float32Array)) { scope.postMessage({ type: "error", id, reason: "Whistle transcribe message needs Float32Array pcm" }); return; }
  if (engine === null) { scope.postMessage({ type: "error", id, reason: "Whistle model is not loaded in the worker" }); return; }
  const opts = msg.opts && typeof msg.opts === "object" ? (msg.opts as WhistleOptions) : {};
  try {
    scope.postMessage({ type: "result", id, transcript: engine.transcribe(pcm, opts) });
  } catch (e) {
    scope.postMessage({ type: "error", id, reason: e instanceof Error ? e.message : String(e) });
  }
}

scope.onmessage = (ev: MessageEvent<unknown>) => {
  const data = ev.data;
  if (!data || typeof data !== "object") return;
  const msg = data as Record<string, unknown>;
  if (msg.type === "load") void onLoad(msg);
  else if (msg.type === "transcribe") onTranscribe(msg);
};
