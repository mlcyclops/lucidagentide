// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/omp/stream_beat_extension.ts - P-HEALTH.3: tell the desktop the model is still WRITING while it
// streams a tool call's arguments, because ACP structurally cannot.
//
// THE DEFECT THIS FIXES. The stall watchdog (desktop/health_watch.ts) counts a turn as alive only while
// ACP updates arrive. omp's ACP mapper (node_modules/@oh-my-pi/pi-coding-agent/src/modes/acp/
// acp-event-mapper.ts, mapAssistantMessageUpdate) forwards text and thinking deltas and DROPS
// `toolcall_start` / `toolcall_delta` (its default branch returns []). The tool_call update is only sent
// once the arguments are complete. So while the model writes a large file (a 30 KB `write`, a long `edit`),
// the desktop sees minutes of silence with no tool call open, probes the session with a "Status?" note at
// three minutes and cancels and respawns it at seven: a healthy, busy agent killed mid-sentence, and two
// alarming notices in the chat about a problem that never existed (incident 20260930T022224Z-mlnj).
//
// WHAT IT DOES. Inside omp, `message_update` DOES carry those events. While a tool call's arguments are
// streaming, this posts `{ session }` to a token'd loopback URL at most once per BEAT_MS per session. The
// desktop credits the beat to the master chat or the fleet lane that owns that session id, exactly as if
// an ACP update had arrived. A model that is genuinely wedged sends no deltas, so it sends no beats and the
// watchdog still acts on it: the beat is evidence of output, never a blanket keep-alive.
//
// WHY A SESSION ID. Master and lanes share one engine and one URL. A beat without a session id is dropped
// (see beatSession), because crediting the wrong session would hide a real stall behind another session's
// streaming.
//
// FAIL-SOFT, like tool_meta_extension.ts. If the URL is unset, the hook API is missing or a POST fails, the
// outcome is the old behaviour (the watchdog may act on a long write), never a broken omp launch.

/** At most one beat per session per this many ms. The watchdog's first threshold (quiet) is 90 s, so a
 *  10 s beat keeps a streaming turn far from every threshold while costing one tiny loopback POST. */
export const BEAT_MS = 10_000;

interface OmpHookApi {
  on?: (event: "message_update", handler: (event: unknown, ctx: unknown) => void) => void;
}

/** The session id a beat should be credited to, or null when this event is not tool-call argument
 *  streaming or the session cannot be named. Text and thinking deltas already reach the desktop through
 *  ACP, so only tool-call streaming needs a beat. Pure. */
export function beatSession(event: unknown, ctx: unknown): string | null {
  if (!event || typeof event !== "object" || !("assistantMessageEvent" in event)) return null;
  const ame = event.assistantMessageEvent;
  if (!ame || typeof ame !== "object" || !("type" in ame)) return null;
  if (ame.type !== "toolcall_start" && ame.type !== "toolcall_delta") return null;
  if (!ctx || typeof ctx !== "object" || !("sessionManager" in ctx)) return null;
  const sm = ctx.sessionManager;
  if (!sm || typeof sm !== "object" || !("getSessionId" in sm) || typeof sm.getSessionId !== "function") return null;
  try {
    const id: unknown = sm.getSessionId();
    return typeof id === "string" && id.trim() ? id.trim() : null;
  } catch {
    return null; // a session manager mid-switch: skip this beat, the next delta tries again
  }
}

/** One throttle per extension instance. Returns true when a beat for `session` is due at `now`. */
export function makeThrottle(gapMs: number = BEAT_MS): (session: string, now: number) => boolean {
  const last = new Map<string, number>();
  return (session, now) => {
    const prev = last.get(session);
    if (prev !== undefined && now - prev < gapMs) return false;
    last.set(session, now);
    return true;
  };
}

export default function streamBeatExtension(pi: unknown): void {
  try {
    const api = (pi ?? {}) as OmpHookApi;
    if (typeof api.on !== "function") return;
    const url = (process.env.LUCID_STREAM_BEAT_URL ?? "").trim();
    if (!url) return; // not launched by the desktop: nobody is watching for stalls
    const due = makeThrottle();
    api.on("message_update", (event, ctx) => {
      const session = beatSession(event, ctx);
      if (!session || !due(session, Date.now())) return;
      // Fire-and-forget: a slow desktop must never slow the model's stream.
      void fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session }) })
        .catch(() => { /* liveness hint only; the watchdog falls back to ACP traffic */ });
    });
  } catch {
    /* A liveness hint must never break omp launch. */
  }
}
