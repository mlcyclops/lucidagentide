// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/omp/token_speed_extension.ts
//
// P-TPS.1 (ADR-0044): the TERMINAL adapter for the streaming output-token readout.
// Load it into an interactive omp session to get a live "⚡ TPS:" figure in the
// status bar while the model streams — the same idea as Claude Code's counter,
// and the same idea as the upstream `pi-token-speed` extension, but driven by our
// vendored, shared engine (harness/metrics/token_speed.ts) so the omp terminal and
// the desktop IDE share one tested core.
//
//   omp -e harness/omp/security_extension.ts -e harness/omp/token_speed_extension.ts "..."
//   (wired into the `omp:secure` npm script.)
//
// The number is OUTPUT only: it is fed from assistant text/thinking/tool-call
// deltas and, when present, omp's `ev.partial.usage.output` — never the system
// prompt or any input. That is the whole point (the user did not want a count
// that looks like the frozen prefix is being re-charged each turn). omp's context
// segment, which DOES include the prompt because it measures window fill, is a
// separate figure we intentionally leave alone.
//
// This adapter is NOT loaded on the ACP/desktop path (lucid_acp.ts): omp's RPC
// UIContext stubs `ui.setStatus` to a no-op, so the desktop draws its OWN readout
// from the same engine in the renderer HUD. Terminal-only by design.
//
// Intentionally omp-import-free (typed `any`) so it loads under any omp version,
// mirroring security_extension.ts.

import {
  type DisplayMode,
  formatReadout,
  TokenSpeedEngine,
} from "../metrics/token_speed.ts";

const STATUS_KEY = "tokenSpeed";
const MODES: DisplayMode[] = ["tps", "ttft", "stats", "full"];

// One engine for the session; reset() per assistant message. useProviderTokens so
// the count is exact whenever omp reports usage.output, with the word/punctuation
// estimate covering the deltas before the first usage figure arrives.
const engine = new TokenSpeedEngine({ countStrategy: "estimate", useProviderTokens: true });
let mode: DisplayMode = "stats"; // count + elapsed by default — the figure the user asked to see

/** Paint the readout into omp's status bar. Defensive: any UI shape change across
 *  omp versions degrades to a plain string rather than throwing inside a hot
 *  streaming handler. */
function paint(ctx: any): void {
  try {
    const body = formatReadout(engine, mode);
    const label = ctx?.ui?.theme?.fg ? ctx.ui.theme.fg("dim", "⚡ TPS:") : "⚡ TPS:";
    ctx?.ui?.setStatus?.(STATUS_KEY, `${label} ${body}`);
  } catch {
    /* never let the readout break the turn */
  }
}

export default function tokenSpeedExtension(pi: any): void {
  pi.registerCommand?.("tps", {
    description: "Cycle the streaming token-speed readout (tps → ttft → stats → full)",
    handler: async (_args: string, ctx: any) => {
      mode = MODES[(MODES.indexOf(mode) + 1) % MODES.length]!;
      ctx?.ui?.notify?.(`token-speed display: ${mode}`, "info");
      paint(ctx);
    },
  });

  pi.on("session_start", (_e: any, ctx: any) => paint(ctx));

  pi.on("message_start", (event: any) => {
    if (event?.message?.role === "user") engine.startTTFT();
    else if (event?.message?.role === "assistant") engine.start();
  });

  pi.on("message_update", (event: any, ctx: any) => {
    const ev = event?.assistantMessageEvent;
    if (!ev) return;
    if (ev.type === "text_start" || ev.type === "thinking_start" || ev.type === "toolcall_start") {
      engine.stopTTFT();
      return;
    }
    if (ev.type === "text_delta" || ev.type === "thinking_delta") {
      engine.recordDelta(ev.delta ?? "", ev.partial?.usage?.output);
      paint(ctx);
    } else if (ev.type === "toolcall_delta") {
      // Tool-call ARGUMENT tokens are genuine output the model generated; count
      // them like text. (omp's usage.output includes them too.)
      engine.recordDelta(ev.delta ?? "", ev.partial?.usage?.output);
      paint(ctx);
    }
  });

  pi.on("message_end", (event: any, ctx: any) => {
    if (event?.message?.role !== "assistant" || !engine.isStreaming) return;
    engine.reconcileTotal(event?.message?.usage?.output ?? 0);
    engine.stop();
    paint(ctx);
  });

  pi.on("turn_end", () => {
    if (engine.isStreaming) engine.stop();
  });
}
