// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/net_probe.ts - P-NETSTAT.1 (ADR-0422). The engine-side half of the network indicator: time a
// HEAD request to the host the active model's turns travel to, keep the last NET_WINDOW samples, and
// report the pure summary (renderer/net_status.ts). Probing from the ENGINE, not the renderer, measures
// the path omp actually uses and needs no CORS or CSP exception in the UI.
//
// Any HTTP answer (401, 404, 405 included) counts as reachable: the question is "does the wire work",
// not "is this request authorized". No credentials and no body are ever sent. Calls are deduplicated
// and rate-limited, so however many renderers poll, the host sees at most one probe per MIN_GAP_MS.

import { hostOf, NET_WINDOW, type NetSample, type NetView, summarizeNet } from "./renderer/net_status.ts";

/** A probe that has not answered in this long is a failed sample. */
export const PROBE_TIMEOUT_MS = 4_000;
/** Minimum spacing between real probes; a poll inside the gap reads the cached summary. */
export const MIN_GAP_MS = 2_500;

export type ProbeFn = (url: string, timeoutMs: number) => Promise<number | null>;

/** Time one HEAD round trip; null when nothing answered. */
export const headProbe: ProbeFn = async (url, timeoutMs) => {
  const t0 = performance.now();
  try {
    await fetch(url, { method: "HEAD", redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
    return Math.round(performance.now() - t0);
  } catch {
    return null;
  }
};

export class NetProbe {
  #samples: NetSample[] = [];
  #url = "";
  #inflight: Promise<void> | null = null;
  #lastAt = -Infinity;

  constructor(private readonly probe: ProbeFn = headProbe, private readonly now: () => number = Date.now) {}

  /** Probe `url` unless one ran within MIN_GAP_MS (or is running), then return the summary. A target
   *  change (the user switched provider) starts a fresh window: the old host's latency says nothing. */
  async check(url: string): Promise<NetView> {
    if (url !== this.#url) { this.#url = url; this.#samples = []; this.#lastAt = -Infinity; }
    if (!this.#inflight && this.now() - this.#lastAt >= MIN_GAP_MS) {
      this.#inflight = (async () => {
        const ms = await this.probe(url, PROBE_TIMEOUT_MS);
        if (url !== this.#url) return; // retargeted while in flight: this sample belongs to no window
        this.#lastAt = this.now();
        this.#samples.push({ at: this.#lastAt, ok: ms !== null, ms });
        if (this.#samples.length > NET_WINDOW) this.#samples.splice(0, this.#samples.length - NET_WINDOW);
      })().finally(() => { this.#inflight = null; });
    }
    await this.#inflight;
    return summarizeNet(this.#samples, hostOf(this.#url));
  }
}
