// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, test } from "bun:test";
import { getEventListeners } from "node:events";
import { ndjsonStream } from "./chat_stream.ts";
import { LiveTurn } from "./turn_recovery.ts";

type TokenEvent = { type: "token"; text: string };

async function readEvent(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const chunk = await reader.read();
  expect(chunk.done).toBe(false);
  return JSON.parse(new TextDecoder().decode(chunk.value));
}

async function readEvents(response: Response) {
  return (await response.text()).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
}

describe("ndjsonStream observer lifetime", () => {
  test("installs the observer synchronously and preserves two-argument callers", async () => {
    const turn = new LiveTurn<TokenEvent>("prompt", "session", () => []);
    const response = ndjsonStream("immediate", async emit => {
      const attachment = turn.attach(emit);
      try { await attachment.ended; }
      finally { attachment.detach(); }
    });
    try {
      expect(turn.subscriberCount).toBe(1);
      turn.text = "immediate token";
      turn.emit({ type: "token", text: turn.text });
      turn.finish();
      const events = await readEvents(response);
      expect(events.map(event => event.type)).toEqual(["turn-snapshot", "token", "done"]);
      expect(events[1].text).toBe("immediate token");
      expect(events[2].text).toBe(turn.text);
    } finally { turn.finish(); }
  });

  test.each(["request abort", "reader cancel"])("%s detaches immediately while execution still awaits work", async mode => {
    const request = new AbortController();
    const turn = new LiveTurn<TokenEvent>("prompt", "session", () => []);
    const callbackEnded = Promise.withResolvers<void>();
    let callbackFinished = false;
    let connectionSignal: AbortSignal | undefined;
    let send: ((event: unknown) => void) | undefined;
    const response = ndjsonStream(mode, async (emit, signal) => {
      connectionSignal = signal;
      send = emit;
      const attachment = turn.attach(emit, signal);
      await attachment.ended;
      callbackFinished = true;
      callbackEnded.resolve();
    }, request.signal);
    const reader = response.body!.getReader();
    try {
      expect((await readEvent(reader)).type).toBe("turn-snapshot");
      const waitingRead = reader.read();
      if (mode === "request abort") request.abort("viewer left");
      else await reader.cancel("viewer left");
      expect(await waitingRead).toEqual({ done: true, value: undefined });
      expect(connectionSignal?.aborted).toBe(true);
      expect(connectionSignal?.reason).toBe("viewer left");
      expect(turn.subscriberCount).toBe(0);
      expect(turn.running).toBe(true);
      expect(callbackFinished).toBe(false);
      expect(getEventListeners(request.signal, "abort")).toHaveLength(0);
      let serialized = false;
      send?.({ toJSON() { serialized = true; throw new Error("must not serialize after disconnect"); } });
      expect(serialized).toBe(false);
      turn.text = "execution continued after disconnect";
      turn.emit({ type: "token", text: turn.text });
      turn.finish();
      await callbackEnded.promise;
      expect(turn.text).toBe("execution continued after disconnect");
      expect(callbackFinished).toBe(true);
    } finally {
      turn.finish();
      await reader.cancel();
    }
  });

  test("disconnecting one of two viewers leaves the other attached to the authoritative answer", async () => {
    const turn = new LiveTurn<TokenEvent>("prompt", "session", () => []);
    const firstRequest = new AbortController();
    const secondRequest = new AbortController();
    let secondSignal: AbortSignal | undefined;
    const first = ndjsonStream("first", async (emit, signal) => {
      await turn.attach(emit, signal).ended;
    }, firstRequest.signal);
    const second = ndjsonStream("second", async (emit, signal) => {
      secondSignal = signal;
      await turn.attach(emit, signal).ended;
    }, secondRequest.signal);
    const firstReader = first.body!.getReader();
    const secondReader = second.body!.getReader();
    try {
      expect(turn.subscriberCount).toBe(2);
      await readEvent(firstReader);
      await readEvent(secondReader);
      firstRequest.abort();
      expect(turn.subscriberCount).toBe(1);
      expect(secondSignal?.aborted).toBe(false);
      expect(turn.running).toBe(true);
      turn.text = "full answer";
      turn.emit({ type: "token", text: "answer" });
      expect(await readEvent(secondReader)).toEqual({ type: "token", text: "answer" });
      turn.finish();
      expect(await readEvent(secondReader)).toEqual({ type: "done", text: "full answer" });
      expect((await secondReader.read()).done).toBe(true);
      expect(getEventListeners(secondRequest.signal, "abort")).toHaveLength(0);
      expect(turn.subscriberCount).toBe(0);
    } finally {
      turn.finish();
      await Promise.all([firstReader.cancel(), secondReader.cancel()]);
    }
  });

  test("an already-aborted request still starts execution with a detached observer", async () => {
    const request = new AbortController();
    request.abort("already gone");
    const turn = new LiveTurn<TokenEvent>("prompt", "session", () => []);
    const callbackEnded = Promise.withResolvers<void>();
    let started = false;
    let connectionSignal: AbortSignal | undefined;
    const response = ndjsonStream("pre-aborted", async (emit, signal) => {
      started = true;
      connectionSignal = signal;
      await turn.attach(emit, signal).ended;
      callbackEnded.resolve();
    }, request.signal);
    try {
      expect(started).toBe(true);
      expect(connectionSignal?.aborted).toBe(true);
      expect(connectionSignal?.reason).toBe("already gone");
      expect(turn.subscriberCount).toBe(0);
      expect(turn.running).toBe(true);
      expect(await response.text()).toBe("");
      expect(getEventListeners(request.signal, "abort")).toHaveLength(0);
      turn.text = "finished without a viewer";
      turn.finish();
      await callbackEnded.promise;
      expect(turn.text).toBe("finished without a viewer");
    } finally { turn.finish(); }
  });

  test.each(["throw", "reject"])("callback %s emits an explicit error and done before clean EOF", async mode => {
    const request = new AbortController();
    let connectionSignal: AbortSignal | undefined;
    const response = ndjsonStream(mode, (emit, signal) => {
      connectionSignal = signal;
      emit({ type: "token", text: "partial" });
      const error = new Error("private backend failure details");
      if (mode === "throw") throw error;
      return Promise.reject(error);
    }, request.signal);
    const events = await readEvents(response);
    expect(events.map(event => event.type)).toEqual(["token", "error", "done"]);
    expect(typeof events[1].message).toBe("string");
    expect(events[1].message.length).toBeGreaterThan(0);
    expect(JSON.stringify(events)).not.toContain("private backend failure details");
    expect(connectionSignal?.aborted).toBe(true);
    expect(getEventListeners(request.signal, "abort")).toHaveLength(0);
  });

  test("callback rejection after cancellation is handled without reopening the stream", async () => {
    const execution = Promise.withResolvers<void>();
    const request = new AbortController();
    const response = ndjsonStream("late rejection", async () => { await execution.promise; }, request.signal);
    const reader = response.body!.getReader();
    await reader.cancel();
    execution.reject(new Error("execution failed after the viewer left"));
    // Bun's test runner also fails this test on an unhandled rejection.
    await new Promise<void>(resolve => queueMicrotask(resolve));
    expect((await reader.read()).done).toBe(true);
    expect(getEventListeners(request.signal, "abort")).toHaveLength(0);
  });

  test("normal completion closes the connection signal and removes its request listener", async () => {
    const request = new AbortController();
    let aborts = 0;
    const response = ndjsonStream("completed", async (emit, signal) => {
      signal.addEventListener("abort", () => { aborts++; });
      emit({ type: "done" });
    }, request.signal);
    expect((await readEvents(response)).map(event => event.type)).toEqual(["done"]);
    expect(aborts).toBe(1);
    expect(getEventListeners(request.signal, "abort")).toHaveLength(0);
    request.abort();
    expect(aborts).toBe(1);
  });

  // This platform integration deliberately exercises the real heartbeat interval; fake
  // timers would not verify a live Response remains readable while execution is pending.
  test("a quiet live connection sends a real heartbeat and can still be cancelled", async () => {
    const execution = Promise.withResolvers<void>();
    const response = ndjsonStream("heartbeat", async () => { await execution.promise; });
    const reader = response.body!.getReader();
    try {
      const chunk = await reader.read();
      expect(chunk.done).toBe(false);
      expect(JSON.parse(new TextDecoder().decode(chunk.value))).toEqual({ type: "ping" });
      await reader.cancel();
      expect((await reader.read()).done).toBe(true);
    } finally {
      execution.resolve();
      await reader.cancel();
    }
  }, 25_000);

  test.each(["request abort", "reader cancel and request abort"])("real HTTP %s disconnects only the subscriber", async mode => {
    const turn = new LiveTurn<TokenEvent>("prompt", "session", () => []);
    const detached = Promise.withResolvers<void>();
    const callbackEnded = Promise.withResolvers<void>();
    let callbackFinished = false;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        return ndjsonStream("http disconnect", async (emit, signal) => {
          signal.addEventListener("abort", () => detached.resolve(), { once: true });
          await turn.attach(emit, signal).ended;
          callbackFinished = true;
          callbackEnded.resolve();
        }, request.signal);
      },
    });
    const request = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await fetch(server.url, { signal: request.signal });
      reader = response.body!.getReader();
      expect((await reader.read()).done).toBe(false);
      expect(turn.subscriberCount).toBe(1);
      if (mode === "request abort") request.abort();
      else {
        // This is Bun fetch's CLIENT body, not ndjsonStream's server-side body (whose
        // cancel hook is covered above). Cancelling the client reader alone need not
        // tear down the HTTP request; explicitly abort its transport as the caller must.
        const cancelled = reader.cancel();
        request.abort();
        await cancelled;
      }
      await detached.promise;
      expect(turn.subscriberCount).toBe(0);
      expect(turn.running).toBe(true);
      expect(callbackFinished).toBe(false);
      turn.text = "completed after HTTP disconnected";
      turn.emit({ type: "token", text: turn.text });
      turn.finish();
      await callbackEnded.promise;
      expect(turn.text).toBe("completed after HTTP disconnected");
    } finally {
      request.abort();
      turn.finish();
      await reader?.cancel().catch(() => {});
      await server.stop(true);
    }
  });
});
