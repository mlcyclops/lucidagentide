// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/ndjson_stream.ts - the NDJSON turn-stream reader, with mid-turn RE-ATTACH.
//
// P-REATTACH.1 (the frozen-composer bug): a chat turn's socket can die while the server turn keeps
// running (dev.ts logs "chat stream write failed - server turn continues"). stream_end.ts made that
// death VISIBLE (drop notice + synthesized done), but the rest of the turn stayed lost until the
// session was reopened. This module closes the loop: when a read ends in `dropped` and the caller
// provided a `reattach` path, the client re-connects to that path and ADOPTS the same running turn
// (the server swaps the turn's downstream to the new stream; see acp_backend.attachTurn). The turn's
// final `done` carries the full assistant text, so anything missed while disconnected reconciles at
// settle. Only when re-attach itself is impossible does the user get the old drop notice.
//
// Extracted from bridge.ts so a real Bun.serve can exercise the loop in tests (bridge pulls the whole
// renderer world in; this module depends only on the event contract and the end classifier).

import type { ChatEvent } from "./chat_events.ts";
import { streamEndEvents, TERMINAL_EVENT_TYPES } from "./stream_end.ts";

export interface StreamNdjsonOpts {
  /** Live tail stream (fleet lane watch): a clean close with no terminal `done` is normal, never a drop. */
  tail?: boolean;
  /** POST path to re-attach to the running turn after a mid-stream drop (e.g. "/api/chat/attach").
   *  Absent -> the drop notice + synthesized done settle the turn (the pre-existing behavior). */
  reattach?: string;
  /** Per-request headers (auth token etc.); a thunk so a refreshed token is picked up on re-attach. */
  headers?: () => Record<string, string>;
  /** Milliseconds between re-attach attempts (test seam; default 1000). */
  reattachDelayMs?: number;
}

/** How one connection ended. `settled` = a pre-stream failure already emitted its own explanation +
 *  done (unreachable / 404 / non-OK), so the caller must NOT stack more events on top. */
type ReadEnd = "aborted" | "complete" | "dropped" | "settled";

/** Generic NDJSON event stream (used by /api/chat, /api/goal, fleet lanes). `signal` lets Stop abort
 *  the CLIENT read so the turn settles even if the server/omp never closes the stream (a wedged turn). */
export async function streamNdjson(path: string, body: unknown, onEvent: (e: ChatEvent) => void, signal?: AbortSignal, opts?: StreamNdjsonOpts): Promise<void> {
  const readOnce = async (p: string, b: unknown): Promise<ReadEnd> => {
    let res: Response;
    try {
      res = await fetch(p, { method: "POST", headers: { "content-type": "application/json", ...(opts?.headers?.() ?? {}) }, body: JSON.stringify(b), signal });
    } catch {
      if (signal?.aborted) return "aborted"; // Stop pressed - the caller's finally settles the UI; no error line
      onEvent({ type: "token", text: "[backend unreachable - is the GUI server running?]" });
      onEvent({ type: "done" });
      return "settled";
    }
    if (res.status === 404) { onEvent({ type: "token", text: "[backend is out of date - close the GUI server window and relaunch (launcher \u2192 G)]" }); onEvent({ type: "done" }); return "settled"; }
    if (!res.ok || !res.body) { onEvent({ type: "token", text: `[backend error ${res.status}]` }); onEvent({ type: "done" }); return "settled"; }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    // Did the turn end on its OWN terms? Only a terminal event seen on the wire proves that; anything else
    // ending this stream is a drop, and the server turn is probably still running (see stream_end.ts).
    let terminalDone = false;
    // TWO different faults, so TWO separate guards. A torn line is bad JSON and is skipped. A throw out of
    // onEvent is a RENDER bug, and the old single `catch {}` swallowed it as if it were bad JSON - so a
    // renderer exception silently ate an event with nothing logged. Neither fault may kill the read: one
    // unrenderable event must never cost the user the REST of the turn.
    const flush = (line: string) => {
      const s = line.trim();
      if (!s) return;
      let parsed: unknown;
      try { parsed = JSON.parse(s); }
      catch { return; } // a truncated/partial line, not a turn failure
      if (!parsed || typeof parsed !== "object" || !("type" in parsed) || typeof parsed.type !== "string") return;
      if (parsed.type === "ping") return; // server heartbeat: keeps the socket alive through long tool calls
      // `done`, but ALSO a fleet lane's terminal `error` - a turn that reported its own failure has explained
      // itself and must not get a "connection dropped" line stacked on top of it.
      if (TERMINAL_EVENT_TYPES[parsed.type]) terminalDone = true;
      // Narrowed above to an object with a string `type`. The payload fields are the engine's own ChatEvent
      // contract (same module, same process family), so this is the ONE documented boundary assertion.
      const ev = parsed as ChatEvent;
      try { onEvent(ev); }
      catch (e) { console.error("[TURN_DIAG] a chat event handler threw; the stream continues", e); }
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) { flush(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
      }
      flush(buf);
    } catch { /* Stop aborted the read, or the socket died mid-turn - classified below, never silent. */ }
    if (signal?.aborted) return "aborted";
    if (terminalDone || opts?.tail) return "complete"; // a tail's clean close is its normal end
    return "dropped";
  };

  let end = await readOnce(path, body);
  // P-REATTACH.1: a dropped chat stream re-adopts the running turn instead of freezing or lying "done".
  // Each hop waits briefly (a dying engine should fail the NEXT fetch fast, which lands in `settled`);
  // the hop cap only bounds a pathologically flapping socket - a healthy attach ends in `complete`.
  let hops = 0;
  while (end === "dropped" && opts?.reattach && !signal?.aborted && hops < 60) {
    hops += 1;
    if (hops === 1) onEvent({ type: "token", text: "\n[connection to the engine dropped - re-attaching to the running turn\u2026]\n" });
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, opts.reattachDelayMs ?? 1000);
    await promise;
    end = await readOnce(opts.reattach, {});
  }
  // The reported bug: this used to end silently. A mid-stream death with no re-attach path announces
  // itself and settles the turn honestly (drop notice + synthesized done). Aborted/complete/settled
  // ends emit nothing extra.
  if (end === "dropped") {
    for (const ev of streamEndEvents({ aborted: !!signal?.aborted, terminalDone: false, tail: opts?.tail }).events) onEvent(ev);
  }
}
