// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/ndjson_stream.test.ts - P-REATTACH.1: the dropped-stream recovery loop, exercised
// against a REAL Bun.serve. The scenario is the reported bug verbatim: a chat stream dies mid-turn
// (server keeps working), and the client must re-adopt the running turn via the attach path instead
// of freezing (the old bug) or settling with a lie (the drop notice) when recovery is possible.

import { afterAll, describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { streamNdjson } from "./ndjson_stream.ts";
import { STREAM_DROPPED_NOTICE } from "./stream_end.ts";
import type { ChatEvent } from "./chat_events.ts";

const enc = new TextEncoder();
const line = (e: unknown) => enc.encode(JSON.stringify(e) + "\n");

// One tiny server per scenario, chosen by path. /chat streams two tokens then DIES with no terminal
// event (an abrupt close, exactly what a killed socket looks like to the reader). /attach streams the
// rest of the "turn" and ends with the reconciling done. /attach-dead also dies, to prove the loop
// retries and then gives up through the fetch-failure path when the server disappears.
let attachCalls = 0;
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const p = new URL(req.url).pathname;
    if (p === "/chat") {
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(line({ type: "token", text: "early " }));
          c.enqueue(line({ type: "token", text: "tokens" }));
          // Real timer, deliberately (ts-no-test-timers exception): this integration test exercises
          // Bun.serve's actual socket teardown, and only the platform clock can order "chunks flushed
          // onto the wire, THEN the stream dies". A sync error would fail the whole response before
          // headers - a different fault (the pre-stream 500 path) than the mid-stream drop under test.
          setTimeout(() => { try { c.error(new Error("socket died")); } catch { /* already closed */ } }, 20);
        },
      });
      return new Response(stream, { headers: { "content-type": "application/x-ndjson" } });
    }
    if (p === "/attach") {
      attachCalls += 1;
      const stream = new ReadableStream({
        start(c) { c.enqueue(line({ type: "token", text: "late tokens" })); c.enqueue(line({ type: "done", text: "early tokens late tokens" })); c.close(); },
      });
      return new Response(stream, { headers: { "content-type": "application/x-ndjson" } });
    }
    if (p === "/chat-clean") {
      const stream = new ReadableStream({
        start(c) { c.enqueue(line({ type: "token", text: "all good" })); c.enqueue(line({ type: "done" })); c.close(); },
      });
      return new Response(stream, { headers: { "content-type": "application/x-ndjson" } });
    }
    return new Response("nope", { status: 404 });
  },
});
const base = `http://127.0.0.1:${server.port}`;
afterAll(() => { server.stop(true); });

async function collect(path: string, opts?: { reattach?: string }): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  // reattach is absolutized here because bun:test has no document origin for a relative fetch to
  // resolve against; in the renderer the same option is the origin-relative "/api/chat/attach".
  await streamNdjson(`${base}${path}`, {}, (e) => events.push(e), undefined, { ...opts, ...(opts?.reattach ? { reattach: `${base}${opts.reattach}` } : {}), reattachDelayMs: 10 });
  return events;
}

describe("streamNdjson reattach", () => {
  test("a dropped stream re-adopts the running turn and finishes with the reconciling done", async () => {
    const events = await collect("/chat", { reattach: "/attach" });
    const text = events.flatMap((e) => (e.type === "token" ? [e.text] : [])).join("");
    expect(text).toContain("early tokens");
    expect(text).toContain("re-attaching to the running turn");
    expect(text).toContain("late tokens");
    // the turn settled on its OWN terms: exactly one done, carrying the reconciling full text
    const dones = events.flatMap((e) => (e.type === "done" ? [e] : []));
    expect(dones.length).toBe(1);
    expect(dones[0]?.text).toBe("early tokens late tokens");
    // and the drop notice must NOT appear - recovery succeeded, the turn never lied about dying
    expect(text).not.toContain(STREAM_DROPPED_NOTICE.slice(1, 40));
    expect(attachCalls).toBe(1);
  });

  test("without a reattach path, a drop still settles honestly (notice + synthesized done)", async () => {
    const events = await collect("/chat");
    const text = events.flatMap((e) => (e.type === "token" ? [e.text] : [])).join("");
    expect(text).toContain("connection to the engine dropped mid-turn");
    expect(events.at(-1)?.type).toBe("done");
  });

  test("a clean stream is untouched: no notices, one done", async () => {
    const events = await collect("/chat-clean", { reattach: "/attach" });
    const text = events.flatMap((e) => (e.type === "token" ? [e.text] : [])).join("");
    expect(text).toBe("all good");
    expect(events.flatMap((e) => (e.type === "done" ? [e] : [])).length).toBe(1);
  });
});

// Real clocks are intentional: these scenarios exercise fetch headers, socket reads, and cancellation.
async function withRecoveryServer(
  fetch: (req: Request) => Response | Promise<Response>,
  run: (base: string, signal: AbortSignal) => Promise<void>,
): Promise<void> {
  const stop = new AbortController();
  const watchdog = setTimeout(() => stop.abort(), 4000);
  const local = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch });
  try {
    await run(`http://127.0.0.1:${local.port}`, stop.signal);
    expect(stop.signal.aborted).toBe(false);
  } finally {
    clearTimeout(watchdog);
    stop.abort();
    await local.stop(true);
  }
}

async function expectCancellation(cancelled: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const observed = await Promise.race([
      cancelled.then(() => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 1000); }),
    ]);
    expect(observed).toBe(true);
  } finally { clearTimeout(timer); }
}

describe("streamNdjson connection deadlines", () => {
  test("hanging initial headers attach once without repeating the prompt or aborting the caller", async () => {
    let prompts = 0;
    let attaches = 0;
    const cancelled = Promise.withResolvers<void>();
    await withRecoveryServer((req) => {
      if (new URL(req.url).pathname === "/chat") {
        prompts += 1;
        return new Promise<Response>((resolve) => {
          req.signal.addEventListener("abort", () => { cancelled.resolve(); resolve(new Response()); }, { once: true });
        });
      }
      attaches += 1;
      return new Response(line({ type: "done", text: "recovered work" }));
    }, async (origin, signal) => {
      const events: ChatEvent[] = [];
      await streamNdjson(`${origin}/chat`, { prompt: "do work once" }, (e) => events.push(e), signal, {
        reattach: `${origin}/attach`, connectionTimeoutMs: 100, reattachDelayMs: 0,
      });
      expect(events.at(-1)).toEqual({ type: "done", text: "recovered work" });
      expect(prompts).toBe(1);
      expect(attaches).toBe(1);
      expect(signal.aborted).toBe(false);
      await expectCancellation(cancelled.promise);
    });
  });

  test("a stalled reader is cancelled and reattached with the latest turn body", async () => {
    let prompts = 0;
    const bodies: unknown[] = [];
    const cancelled = Promise.withResolvers<void>();
    await withRecoveryServer(async (req) => {
      if (new URL(req.url).pathname === "/chat") {
        prompts += 1;
        return new Response(new ReadableStream({
          start(c) { c.enqueue(line({ type: "token", text: "acknowledged" })); },
          cancel() { cancelled.resolve(); },
        }));
      }
      bodies.push(await req.json());
      return new Response(line({ type: "done", text: "full answer" }));
    }, async (origin, signal) => {
      let turnId: string | undefined;
      const events: ChatEvent[] = [];
      await streamNdjson(`${origin}/chat`, { prompt: "never repeat" }, (e) => {
        events.push(e);
        if (e.type === "token" && e.text === "acknowledged") turnId = "owned-turn";
      }, signal, {
        reattach: `${origin}/attach`, reattachBody: () => ({ turnId }), connectionTimeoutMs: 100, reattachDelayMs: 0,
      });
      expect(bodies).toEqual([{ turnId: "owned-turn" }]);
      expect(prompts).toBe(1);
      expect(events.at(-1)).toEqual({ type: "done", text: "full answer" });
      await expectCancellation(cancelled.promise);
    });
  });

  test.each(["ping", "token"])("healthy %s events keep long work alive beyond multiple idle deadlines", async (type) => {
    let attaches = 0;
    let ticks = 0;
    let timer: ReturnType<typeof setInterval> | undefined;
    const cancelled = Promise.withResolvers<void>();
    try {
      await withRecoveryServer((req) => {
        if (new URL(req.url).pathname === "/attach") { attaches += 1; return new Response(null, { status: 404 }); }
        return new Response(new ReadableStream({
          start(c) {
            c.enqueue(line({ type, text: "working" }));
            timer = setInterval(() => {
              ticks += 1;
              c.enqueue(line({ type, text: "working" }));
              if (ticks === 8) { clearInterval(timer); c.enqueue(line({ type: "done", text: "long work complete" })); }
            }, 50);
          },
          cancel() { clearInterval(timer); cancelled.resolve(); },
        }));
      }, async (origin, signal) => {
        const events: ChatEvent[] = [];
        await streamNdjson(`${origin}/chat`, {}, (e) => events.push(e), signal, {
          reattach: `${origin}/attach`, connectionTimeoutMs: 150, reattachDelayMs: 0,
        });
        expect(events.at(-1)).toEqual({ type: "done", text: "long work complete" });
        expect(ticks).toBe(8);
        expect(attaches).toBe(0);
        expect(events.map((e) => e.type)).not.toContain("ping");
        await expectCancellation(cancelled.promise);
      });
    } finally { clearInterval(timer); }
  });

  test("malformed traffic does not postpone recovery forever", async () => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const cancelled = Promise.withResolvers<void>();
    try {
      await withRecoveryServer((req) => {
        if (new URL(req.url).pathname === "/attach") return new Response(line({ type: "done", text: "recovered" }));
        return new Response(new ReadableStream({
          start(c) {
            c.enqueue(line({ type: "token", text: "initial" }));
            timer = setInterval(() => c.enqueue(enc.encode(" \n{broken\n{}\n{\"type\":7}\n")), 25);
          },
          cancel() { clearInterval(timer); cancelled.resolve(); },
        }));
      }, async (origin, signal) => {
        const events: ChatEvent[] = [];
        await streamNdjson(`${origin}/chat`, {}, (e) => events.push(e), signal, {
          reattach: `${origin}/attach`, connectionTimeoutMs: 100, reattachDelayMs: 0,
        });
        expect(events.at(-1)).toEqual({ type: "done", text: "recovered" });
        await expectCancellation(cancelled.promise);
      });
    } finally { clearInterval(timer); }
  });

  test("an ambiguous initial network failure attaches instead of sending another prompt", async () => {
    let prompts = 0;
    let attaches = 0;
    // A real accepted POST loses its socket before response headers. Keep the listener alive
    // until finally; stopping Bun.serve from inside its pending fetch can hang its shutdown.
    const initial = createServer((req) => {
      prompts += 1;
      req.on("end", () => req.socket.destroy());
      req.resume();
    });
    await new Promise<void>((resolve, reject) => {
      initial.once("error", reject);
      initial.listen(0, "127.0.0.1", () => { initial.removeListener("error", reject); resolve(); });
    });
    try {
      await withRecoveryServer(() => { attaches += 1; return new Response(line({ type: "done", text: "adopted" })); }, async (origin, signal) => {
        const events: ChatEvent[] = [];
        const address = initial.address();
        if (!address || typeof address === "string") throw new Error("HTTP fixture did not bind a TCP port");
        await streamNdjson(`http://127.0.0.1:${address.port}/chat`, { prompt: "once" }, (e) => events.push(e), signal, {
          reattach: `${origin}/attach`, reattachDelayMs: 0,
        });
        expect(prompts).toBe(1);
        expect(attaches).toBe(1);
        expect(events.at(-1)).toEqual({ type: "done", text: "adopted" });
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        initial.close((error) => error ? reject(error) : resolve());
        initial.closeAllConnections();
      });
    }
  });

  test("transient attach 503, 408, 429 and 500 responses retry only the attach endpoint", async () => {
    let prompts = 0;
    let attaches = 0;
    const failures = [503, 408, 429, 500];
    await withRecoveryServer((req) => {
      if (new URL(req.url).pathname === "/chat") { prompts += 1; return new Response("busy", { status: 503 }); }
      const status = failures[attaches++];
      return status ? new Response("retry later", { status }) : new Response(line({ type: "done", text: "survived" }));
    }, async (origin, signal) => {
      const events: ChatEvent[] = [];
      await streamNdjson(`${origin}/chat`, {}, (e) => events.push(e), signal, { reattach: `${origin}/attach`, reattachDelayMs: 0 });
      expect(prompts).toBe(1);
      expect(attaches).toBe(5);
      expect(events.filter((e) => e.type === "done")).toEqual([{ type: "done", text: "survived" }]);
    });
  });

  test.each([401, 403, 404, 409])("nonretryable attach HTTP %i explains and settles immediately", async (status) => {
    let attaches = 0;
    await withRecoveryServer((req) => {
      if (new URL(req.url).pathname === "/chat") return new Response(line({ type: "token", text: "started" }));
      attaches += 1;
      return new Response("no attach", { status });
    }, async (origin, signal) => {
      const events: ChatEvent[] = [];
      await streamNdjson(`${origin}/chat`, {}, (e) => events.push(e), signal, { reattach: `${origin}/attach`, reattachDelayMs: 0 });
      expect(attaches).toBe(1);
      expect(events.filter((e) => e.type === "done")).toHaveLength(1);
      expect(events.at(-2)).toEqual({ type: "token", text: status === 404
        ? "[backend is out of date - close the GUI server window and relaunch (launcher \u2192 G)]"
        : `[backend error ${status}]` });
    });
  });

  test("repeated transient failures exhaust a finite attach budget and settle", async () => {
    let prompts = 0;
    let attaches = 0;
    await withRecoveryServer((req) => {
      if (new URL(req.url).pathname === "/chat") prompts += 1;
      else attaches += 1;
      return new Response("unavailable", { status: 503 });
    }, async (origin, signal) => {
      const events: ChatEvent[] = [];
      await streamNdjson(`${origin}/chat`, {}, (e) => events.push(e), signal, { reattach: `${origin}/attach`, reattachDelayMs: 0 });
      expect(prompts).toBe(1);
      expect(attaches).toBeGreaterThan(1);
      expect(attaches).toBeLessThanOrEqual(60);
      expect(events.at(-2)).toEqual({ type: "token", text: STREAM_DROPPED_NOTICE });
      expect(events.filter((e) => e.type === "done")).toHaveLength(1);
    });
  });

  test("Stop interrupts retry backoff without opening an attach or emitting done", async () => {
    let attaches = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = new AbortController();
    try {
      await withRecoveryServer((req) => {
        if (new URL(req.url).pathname === "/attach") attaches += 1;
        return new Response("busy", { status: 503 });
      }, async (origin, signal) => {
        const events: ChatEvent[] = [];
        const started = Date.now();
        await streamNdjson(`${origin}/chat`, {}, (e) => {
          events.push(e);
          if (e.type === "token") timer = setTimeout(() => stop.abort(), 20);
        }, AbortSignal.any([signal, stop.signal]), { reattach: `${origin}/attach`, reattachDelayMs: 2000 });
        expect(stop.signal.aborted).toBe(true);
        expect(Date.now() - started).toBeLessThan(1000);
        expect(attaches).toBe(0);
        expect(events.filter((e) => e.type === "done")).toHaveLength(0);
      });
    } finally { clearTimeout(timer); }
  });

  test("Stop interrupts a pending read, cancels its socket and suppresses recovery", async () => {
    let attaches = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = new AbortController();
    const cancelled = Promise.withResolvers<void>();
    try {
      await withRecoveryServer((req) => {
        if (new URL(req.url).pathname === "/attach") { attaches += 1; return new Response(null, { status: 404 }); }
        return new Response(new ReadableStream({
          start(c) { c.enqueue(line({ type: "token", text: "reading" })); },
          cancel() { cancelled.resolve(); },
        }));
      }, async (origin, signal) => {
        const events: ChatEvent[] = [];
        await streamNdjson(`${origin}/chat`, {}, (e) => {
          events.push(e);
          timer = setTimeout(() => stop.abort(), 20);
        }, AbortSignal.any([signal, stop.signal]), { reattach: `${origin}/attach`, connectionTimeoutMs: 1000, reattachDelayMs: 0 });
        expect(stop.signal.aborted).toBe(true);
        expect(events).toEqual([{ type: "token", text: "reading" }]);
        expect(attaches).toBe(0);
        await expectCancellation(cancelled.promise);
      });
    } finally { clearTimeout(timer); }
  });

  test.each(["done", "error", "lane-error"])("terminal %s ends an open socket even when its handler throws", async (type) => {
    const cancelled = Promise.withResolvers<void>();
    await withRecoveryServer(() => new Response(new ReadableStream({
      start(c) {
        c.enqueue(line({ type, text: "finished", message: "finished" }));
        c.enqueue(line({ type: "token", text: "must not render after terminal" }));
      },
      cancel() { cancelled.resolve(); },
    })), async (origin, signal) => {
      const events: ChatEvent[] = [];
      await streamNdjson(`${origin}/chat`, {}, (e) => { events.push(e); throw new Error("renderer failed"); }, signal);
      expect(events.map((e) => e.type)).toEqual([type]);
      await expectCancellation(cancelled.promise);
    });
  });

  test("a throwing recovery notice handler cannot prevent adoption or cleanup", async () => {
    let attaches = 0;
    await withRecoveryServer((req) => {
      if (new URL(req.url).pathname === "/chat") return new Response("busy", { status: 503 });
      attaches += 1;
      return new Response(line({ type: "done", text: "adopted" }));
    }, async (origin, signal) => {
      const events: ChatEvent[] = [];
      await streamNdjson(`${origin}/chat`, {}, (e) => {
        events.push(e);
        if (e.type === "token") throw new Error("notice renderer failed");
      }, signal, { reattach: `${origin}/attach`, reattachDelayMs: 0 });
      expect(attaches).toBe(1);
      expect(events.at(-1)).toEqual({ type: "done", text: "adopted" });
    });
  });

  test("legacy no-reattach callers have no idle deadline and retain unterminated final lines", async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await withRecoveryServer(() => new Response(new ReadableStream({
        start(c) {
          c.enqueue(line({ type: "token", text: "waiting" }));
          timer = setTimeout(() => { c.enqueue(enc.encode(JSON.stringify({ type: "done", text: "late final" }))); c.close(); }, 100);
        },
        cancel() { clearTimeout(timer); },
      })), async (origin, signal) => {
        const events: ChatEvent[] = [];
        await streamNdjson(`${origin}/chat`, {}, (e) => events.push(e), signal, { connectionTimeoutMs: 10 });
        expect(events).toEqual([{ type: "token", text: "waiting" }, { type: "done", text: "late final" }]);
      });
    } finally { clearTimeout(timer); }
  });

  test("a clean tail close remains normal without recovery notices or synthetic done", async () => {
    let calls = 0;
    await withRecoveryServer(() => { calls += 1; return new Response(line({ type: "token", text: "lane released" })); }, async (origin, signal) => {
      const events: ChatEvent[] = [];
      await streamNdjson(`${origin}/chat`, {}, (e) => events.push(e), signal, { tail: true, reattach: `${origin}/attach`, reattachDelayMs: 0 });
      expect(events).toEqual([{ type: "token", text: "lane released" }]);
      expect(calls).toBe(1);
    });
  });

  test("each attach gets a fresh deadline for stalled headers and then a stalled reader", async () => {
    let prompts = 0;
    let attaches = 0;
    const headersCancelled = Promise.withResolvers<void>();
    const readerCancelled = Promise.withResolvers<void>();
    await withRecoveryServer((req) => {
      if (new URL(req.url).pathname === "/chat") { prompts += 1; return new Response(null, { status: 503 }); }
      attaches += 1;
      if (attaches === 1) return new Promise<Response>((resolve) => {
        req.signal.addEventListener("abort", () => { headersCancelled.resolve(); resolve(new Response()); }, { once: true });
      });
      if (attaches === 2) return new Response(new ReadableStream({
        start(c) { c.enqueue(line({ type: "ping" })); },
        cancel() { readerCancelled.resolve(); },
      }));
      return new Response(line({ type: "done", text: "third connection recovered" }));
    }, async (origin, signal) => {
      const events: ChatEvent[] = [];
      await streamNdjson(`${origin}/chat`, {}, (e) => events.push(e), signal, {
        reattach: `${origin}/attach`, connectionTimeoutMs: 100, reattachDelayMs: 0,
      });
      expect(prompts).toBe(1);
      expect(attaches).toBe(3);
      expect(events.at(-1)).toEqual({ type: "done", text: "third connection recovered" });
      await expectCancellation(headersCancelled.promise);
      await expectCancellation(readerCancelled.promise);
    });
  });

  test("an already stopped caller cannot start a prompt POST", async () => {
    let requests = 0;
    await withRecoveryServer(() => { requests += 1; return new Response(line({ type: "done" })); }, async (origin) => {
      const stop = new AbortController();
      stop.abort();
      const events: ChatEvent[] = [];
      await streamNdjson(`${origin}/chat`, {}, (e) => events.push(e), stop.signal, { reattach: `${origin}/attach`, reattachDelayMs: 0 });
      expect(requests).toBe(0);
      expect(events).toEqual([]);
    });
  });

  test.each([401, 403, 404, 409, 503])("opt-in recovery rejects HTTP %i failure without synthetic assistant events", async (status) => {
    let prompts = 0;
    let attaches = 0;
    await withRecoveryServer((req) => {
      if (new URL(req.url).pathname === "/chat") { prompts += 1; return new Response(null, { status: 503 }); }
      attaches += 1;
      return new Response("cannot attach", { status });
    }, async (origin, signal) => {
      const events: ChatEvent[] = [];
      const states: string[] = [];
      await expect(streamNdjson(`${origin}/chat`, {}, (e) => events.push(e), signal, {
        reattach: `${origin}/attach`, reattachDelayMs: 0,
        onRecovery(state, message) { states.push(state); expect(message.length).toBeGreaterThan(0); },
      })).rejects.toThrow();
      expect(events).toEqual([]);
      expect(states).toEqual(["reconnecting", "failed"]);
      expect(prompts).toBe(1);
      if (status === 503) expect(attaches).toBeGreaterThan(1);
      else expect(attaches).toBe(1);
    });
  });

  test("a throwing recovery callback still adopts the turn without polluting assistant output", async () => {
    await withRecoveryServer((req) => new URL(req.url).pathname === "/chat"
      ? new Response(null, { status: 503 })
      : new Response(line({ type: "done", text: "authoritative result" })), async (origin, signal) => {
      const events: ChatEvent[] = [];
      const states: string[] = [];
      await streamNdjson(`${origin}/chat`, {}, (e) => events.push(e), signal, {
        reattach: `${origin}/attach`, reattachDelayMs: 0,
        onRecovery(state) { states.push(state); throw new Error("HUD failed"); },
      });
      expect(states).toEqual(["reconnecting"]);
      expect(events).toEqual([{ type: "done", text: "authoritative result" }]);
    });
  });

  test("Stop from the recovery callback returns normally without attaching or synthetic events", async () => {
    let calls = 0;
    const stop = new AbortController();
    await withRecoveryServer(() => { calls += 1; return new Response(null, { status: 503 }); }, async (origin, signal) => {
      const events: ChatEvent[] = [];
      const states: string[] = [];
      await streamNdjson(`${origin}/chat`, {}, (e) => events.push(e), AbortSignal.any([signal, stop.signal]), {
        reattach: `${origin}/attach`, reattachDelayMs: 2000,
        onRecovery(state) { states.push(state); stop.abort(); },
      });
      expect(states).toEqual(["reconnecting"]);
      expect(events).toEqual([]);
      expect(calls).toBe(1);
    });
  });

  test("a failing recovery handler cannot prevent cancelling an unread HTTP error body", async () => {
    const cancelled = Promise.withResolvers<void>();
    await withRecoveryServer(() => new Response(new ReadableStream({
      start(c) { c.enqueue(enc.encode("not authorized")); },
      cancel() { cancelled.resolve(); },
    }), { status: 401 }), async (origin, signal) => {
      const events: ChatEvent[] = [];
      await expect(streamNdjson(`${origin}/chat`, {}, (e) => events.push(e), signal, {
        reattach: `${origin}/attach`, reattachDelayMs: 0,
        onRecovery() { throw new Error("HUD failed"); },
      })).rejects.toThrow("backend error 401");
      expect(events).toEqual([]);
      await expectCancellation(cancelled.promise);
    });
  });
});
