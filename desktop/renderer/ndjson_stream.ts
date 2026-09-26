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
import { STREAM_DROPPED_NOTICE, streamEndEvents, TERMINAL_EVENT_TYPES } from "./stream_end.ts";

export interface StreamNdjsonOpts {
  /** Live tail stream (fleet lane watch): a clean close with no terminal `done` is normal, never a drop. */
  tail?: boolean;
  /** POST path to re-attach to the running turn after a mid-stream drop (e.g. "/api/chat/attach").
   *  Absent -> the drop notice + synthesized done settle the turn (the pre-existing behavior). */
  reattach?: string;
  /** Body for each re-attach (e.g. the acknowledged turn ID); never resends the original prompt. */
  reattachBody?: () => unknown;
  /** Per-request headers (auth token etc.); a thunk so a refreshed token is picked up on re-attach. */
  headers?: () => Record<string, string>;
  /** Milliseconds between re-attach attempts (test seam; default 1000). */
  reattachDelayMs?: number;
  /** Per-connection headers/idle deadline, enabled only with reattach (default 45000, above 15s pings).
   *  Valid events reset it, so a healthy long-running tool has no total turn deadline. */
  connectionTimeoutMs?: number;
  /** Route transport notices outside assistant text. Failures reject without a synthetic done;
   *  callers can keep the pending turn recoverable instead of treating transport loss as completion. */
  onRecovery?: (state: "reconnecting" | "failed", message: string) => void;
}

/** How one connection ended. `settled` = a pre-stream failure already emitted its own explanation +
 *  done (unreachable / 404 / non-OK), so the caller must NOT stack more events on top. */
type ReadEnd = "aborted" | "complete" | "dropped" | "settled";

/** Generic NDJSON event stream (used by /api/chat, /api/goal, fleet lanes). `signal` lets Stop abort
 *  the CLIENT read so the turn settles even if the server/omp never closes the stream (a wedged turn). */
export async function streamNdjson(path: string, body: unknown, onEvent: (e: ChatEvent) => void, signal?: AbortSignal, opts?: StreamNdjsonOpts): Promise<void> {
  const emit = (ev: ChatEvent) => {
    if (signal?.aborted) return;
    try { onEvent(ev); }
    catch (e) { console.error("[TURN_DIAG] a chat event handler threw; the stream continues", e); }
  };
  const recovery = (state: "reconnecting" | "failed", message: string) => {
    if (signal?.aborted) return;
    try { opts?.onRecovery?.(state, message); }
    catch (e) { console.error("[TURN_DIAG] a recovery handler threw; the stream continues", e); }
  };
  const fail = (message: string): ReadEnd => {
    if (signal?.aborted) return "aborted";
    if (opts?.onRecovery) {
      recovery("failed", message);
      if (signal?.aborted) return "aborted";
      throw new Error(message);
    }
    emit({ type: "token", text: message });
    emit({ type: "done" });
    return "settled";
  };
  const readOnce = async (p: string, b: unknown): Promise<ReadEnd> => {
    if (signal?.aborted) return "aborted";
    // Own the transport signal: an idle socket must not abort the caller's turn/Stop controller.
    const connection = new AbortController();
    const abort = () => connection.abort();
    signal?.addEventListener("abort", abort, { once: true });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let res: Response | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const touch = () => {
      if (!opts?.reattach) return;
      clearTimeout(deadline);
      deadline = setTimeout(abort, opts.connectionTimeoutMs ?? 45000);
    };
    try {
      touch(); // Includes a server that accepts the POST but never sends response headers.
      try {
        res = await fetch(p, { method: "POST", headers: { "content-type": "application/json", ...(opts?.headers?.() ?? {}) }, body: JSON.stringify(b), signal: connection.signal });
      } catch {
        if (signal?.aborted) return "aborted";
        // Even the initial POST may have started work before its acknowledgement was lost.
        // Only adopt that work through attach, never repeat the original prompt POST.
        if (opts?.reattach) return "dropped";
        return fail("[backend unreachable - is the GUI server running?]");
      }
      if (signal?.aborted) return "aborted";
      if (connection.signal.aborted) return "dropped";
      if (opts?.reattach && (res.status === 408 || res.status === 429 || res.status >= 500)) return "dropped";
      if (res.status === 404) return fail("[backend is out of date - close the GUI server window and relaunch (launcher \u2192 G)]");
      if (!res.ok || !res.body) return fail(`[backend error ${res.status}]`);
      reader = res.body.getReader();
      touch();
      const dec = new TextDecoder();
      let buf = "";
      let terminalDone = false;
      const flush = (line: string) => {
        const s = line.trim();
        if (!s) return;
        let parsed: unknown;
        try { parsed = JSON.parse(s); }
        catch { return; } // A torn line is not a valid heartbeat or event.
        if (!parsed || typeof parsed !== "object" || !("type" in parsed) || typeof parsed.type !== "string") return;
        touch();
        if (parsed.type === "ping") return;
        if (TERMINAL_EVENT_TYPES[parsed.type] === true) terminalDone = true;
        // The engine owns payload fields; object + string type is the NDJSON envelope boundary.
        emit(parsed as ChatEvent);
      };
      try {
        while (!terminalDone && !connection.signal.aborted) {
          const { done, value } = await reader.read();
          if (connection.signal.aborted) break;
          if (done) { flush(buf + dec.decode()); break; }
          buf += dec.decode(value, { stream: true });
          let nl: number;
          while (!terminalDone && !connection.signal.aborted && (nl = buf.indexOf("\n")) >= 0) {
            flush(buf.slice(0, nl));
            buf = buf.slice(nl + 1);
          }
        }
      } catch { /* Stop, an idle deadline, or a broken socket: classified below. */ }
      if (signal?.aborted) return "aborted";
      if (terminalDone || opts?.tail) return "complete";
      return "dropped";
    } finally {
      clearTimeout(deadline);
      signal?.removeEventListener("abort", abort);
      connection.abort();
      // Terminal events end the client read even when the server leaves its socket open.
      // Cancel error responses too; an unread retry body must not retain the old connection.
      try {
        if (reader) await reader.cancel();
        else if (res?.body) await res.body.cancel();
      } catch { /* Aborting the owned fetch may already have errored its body. */ }
      finally { reader?.releaseLock(); }
    }
  };

  const waitForRetry = async () => {
    if (signal?.aborted) return;
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, opts?.reattachDelayMs ?? 1000);
      signal?.addEventListener("abort", finish, { once: true });
    });
  };
  let end = await readOnce(path, body);
  let hops = 0;
  // Bound reconnect attempts, not tool runtime. A healthy connection can run indefinitely.
  while (end === "dropped" && opts?.reattach && !signal?.aborted && hops < 60) {
    hops += 1;
    if (hops === 1) {
      const message = "[connection to the engine dropped - re-attaching to the running turn\u2026]";
      if (opts.onRecovery) recovery("reconnecting", message);
      else emit({ type: "token", text: `\n${message}\n` });
    }
    await waitForRetry();
    if (signal?.aborted) return;
    end = await readOnce(opts.reattach, opts.reattachBody?.() ?? {});
  }
  if (end === "dropped") {
    if (opts?.onRecovery && !signal?.aborted && !opts.tail) fail(STREAM_DROPPED_NOTICE);
    for (const ev of streamEndEvents({ aborted: !!signal?.aborted, terminalDone: false, tail: opts?.tail }).events) emit(ev);
  }
}
