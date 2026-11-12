// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

/** Silence after which the stream sends a ping; worst-case quiet is this plus HEARTBEAT_CHECK_MS. */
const HEARTBEAT_IDLE_MS = 15_000;
const HEARTBEAT_CHECK_MS = 1_000;

/** The HTTP connection owns its observer, never the work awaited by run. */
export function ndjsonStream(
  label: string,
  run: (emit: (e: unknown) => void, connectionAbort: AbortSignal) => Promise<void>,
  requestSignal?: AbortSignal,
): Response {
  const connection = new AbortController();
  const encoder = new TextEncoder();
  let cancelConnection: ((reason?: unknown) => void) | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;
      let lastSend = Date.now();
      let reportedFailure = false;
      // Check more often than the ping period: with check == period, a send just after one check left
      // ~30 s of silence before the next ping, so a briefly stalled engine event loop ran the client into
      // its 45 s idle deadline (ndjson_stream.ts) and a healthy turn read as a dropped connection.
      const heartbeat = setInterval(() => {
        if (Date.now() - lastSend >= HEARTBEAT_IDLE_MS) emit({ type: "ping" });
      }, HEARTBEAT_CHECK_MS);
      const onRequestAbort = () => close(requestSignal?.reason);
      const close = (reason?: unknown, readerCancelled = false) => {
        if (!open) return;
        open = false;
        clearInterval(heartbeat);
        requestSignal?.removeEventListener("abort", onRequestAbort);
        connection.abort(reason);
        if (!readerCancelled) {
          try { controller.close(); } catch { /* The consumer may already have closed it. */ }
        }
      };
      const emit = (event: unknown) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
          lastSend = Date.now();
        } catch (error) {
          close(error);
        }
      };
      const fail = (error: unknown) => {
        if (!reportedFailure) {
          reportedFailure = true;
          console.error(`[chat-stream] ${label} callback failed:`, error);
        }
        emit({ type: "error", message: "The chat stream failed." });
        emit({ type: "done" });
        close();
      };
      cancelConnection = reason => close(reason, true);
      requestSignal?.addEventListener("abort", onRequestAbort, { once: true });
      if (requestSignal?.aborted) onRequestAbort();

      // Invoke now so attach() is installed before returning the Response. Do not return
      // this promise from start(): reader.cancel() must not wait for execution to finish.
      try { void run(emit, connection.signal).then(() => close(), fail); }
      catch (error) { fail(error); }
    },
    cancel(reason) { cancelConnection?.(reason); },
  });
  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" },
  });
}
