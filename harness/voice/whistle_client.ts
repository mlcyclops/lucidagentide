// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/voice/whistle_client.ts - the main-thread owner of the ONE Whistle worker (ADR-0432, decision 2).
//
// `start` spawns `whistle_worker.ts`, hands it the verified glue path and bytes, and resolves on `ready`.
// A worker that answers `load-error`, dies, or says nothing for `readyTimeoutMs` is terminated and the
// start rejects with the reason: a dead or absent model is a named refusal, never a silent "ok".
// `transcribe` calls are serialized through one FIFO (the model is not thread-safe and the worker runs
// one decode at a time anyway), each tagged with an incrementing id; a worker crash fails every call in
// the queue with its reason and the client stays closed.

import type { WhistleLoadInput, WhistleOptions, WhistleTranscript } from "./whistle.ts";

export interface WhistleTranscriber {
  transcribe(pcm16k: Float32Array, opts?: WhistleOptions): Promise<WhistleTranscript>;
  readonly modelSha256: string;
}

export interface WhistleClientStart extends WhistleLoadInput {
  readonly modelSha256: string;
  /** Default 10000. */
  readonly readyTimeoutMs?: number;
}

const DEFAULT_READY_TIMEOUT_MS = 10000;
const WORKER_URL = new URL("./whistle_worker.ts", import.meta.url).href;

interface Pending {
  readonly id: number;
  readonly pcm: Float32Array;
  readonly opts: WhistleOptions | undefined;
  readonly resolve: (t: WhistleTranscript) => void;
  readonly reject: (e: Error) => void;
}

/** A standalone copy of `bytes` whose whole buffer can be transferred; the caller's bytes stay usable. */
function transferableCopy(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const buf = new ArrayBuffer(bytes.byteLength);
  const copy = new Uint8Array<ArrayBuffer>(buf);
  copy.set(bytes);
  return copy;
}

function isTranscript(v: unknown): v is WhistleTranscript {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return typeof r.text === "string" && typeof r.language === "string" && Array.isArray(r.words) && typeof r.windows === "number";
}

export class WhistleClient implements WhistleTranscriber {
  readonly modelSha256: string;
  private readonly worker: Worker;
  private nextId = 1;
  /** FIFO; `queue[0]` is the call in flight. */
  private readonly queue: Pending[] = [];
  private closedReason: string | null = null;
  private onReady: ((reason: string | null) => void) | null = null;

  private constructor(worker: Worker, modelSha256: string) {
    this.worker = worker;
    this.modelSha256 = modelSha256;
    worker.onmessage = (ev: MessageEvent) => { this.onMessage(ev.data); };
    worker.onerror = (ev: ErrorEvent) => { this.die(`Whistle worker failed: ${ev.message || "unknown error"}`); };
    worker.addEventListener("close", () => { if (this.closedReason === null) this.die("Whistle worker exited"); });
  }

  /** Spawn the worker, post the verified assets, and resolve once the model is loaded. Rejects with the
   *  worker's reason on `load-error`, on a crash, or after `readyTimeoutMs` of silence (the worker is
   *  terminated in every failure case). */
  static start(input: WhistleClientStart): Promise<WhistleClient> {
    const timeoutMs = input.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    const client = new WhistleClient(new Worker(WORKER_URL), input.modelSha256);
    const { promise, resolve, reject } = Promise.withResolvers<WhistleClient>();
    const timer = setTimeout(() => {
      client.onReady = null;
      client.die(`Whistle worker was not ready after ${timeoutMs} ms`);
      reject(new Error(`Whistle worker was not ready after ${timeoutMs} ms`));
    }, timeoutMs);
    client.onReady = (reason) => {
      clearTimeout(timer);
      client.onReady = null;
      if (reason === null) { resolve(client); return; }
      client.die(reason);
      reject(new Error(reason));
    };
    const wasm = transferableCopy(input.wasm);
    const cact = transferableCopy(input.cact);
    client.worker.postMessage({ type: "load", gluePath: input.gluePath, wasm, cact }, [wasm.buffer, cact.buffer]);
    return promise;
  }

  /** Queue one transcription. `pcm16k` is MOVED to the worker when it owns its whole buffer (the caller's
   *  view detaches); a view into a larger buffer is copied first so the rest of that buffer stays put. */
  transcribe(pcm16k: Float32Array, opts?: WhistleOptions): Promise<WhistleTranscript> {
    if (this.closedReason !== null) return Promise.reject(new Error(this.closedReason));
    const id = this.nextId++;
    const { promise, resolve, reject } = Promise.withResolvers<WhistleTranscript>();
    this.queue.push({ id, pcm: pcm16k, opts, resolve, reject });
    if (this.queue.length === 1) this.send();
    return promise;
  }

  /** Terminate the worker; every queued call rejects. Idempotent. */
  close(): void {
    if (this.closedReason !== null) return;
    this.die("Whistle worker closed");
  }

  private send(): void {
    const p = this.queue[0];
    if (!p || this.closedReason !== null) return;
    const whole = p.pcm.byteOffset === 0 && p.pcm.buffer instanceof ArrayBuffer && p.pcm.byteLength === p.pcm.buffer.byteLength;
    const pcm = whole ? p.pcm : p.pcm.slice(); // slice() always yields a fresh, whole ArrayBuffer
    try {
      this.worker.postMessage({ type: "transcribe", id: p.id, pcm, opts: p.opts }, [pcm.buffer as ArrayBuffer]);
    } catch (e) {
      this.queue.shift();
      p.reject(e instanceof Error ? e : new Error(String(e)));
      this.send();
    }
  }

  private onMessage(data: unknown): void {
    if (!data || typeof data !== "object") return;
    const m = data as Record<string, unknown>;
    if (m.type === "ready") { this.onReady?.(null); return; }
    if (m.type === "load-error") { this.onReady?.(typeof m.reason === "string" ? m.reason : "Whistle worker refused the load"); return; }
    if (typeof m.id !== "number") return;
    const p = this.queue[0];
    if (!p || p.id !== m.id) return;
    this.queue.shift();
    if (m.type === "result" && isTranscript(m.transcript)) p.resolve(m.transcript);
    else if (m.type === "result") p.reject(new Error("Whistle worker returned a malformed transcript"));
    else p.reject(new Error(typeof m.reason === "string" ? m.reason : "Whistle worker failed the transcription"));
    this.send();
  }

  private die(reason: string): void {
    if (this.closedReason !== null) return;
    this.closedReason = reason;
    this.worker.terminate();
    const waiting = this.queue.splice(0, this.queue.length);
    for (const p of waiting) p.reject(new Error(reason));
    this.onReady?.(reason);
  }
}
