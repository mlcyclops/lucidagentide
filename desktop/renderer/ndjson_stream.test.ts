// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/ndjson_stream.test.ts - P-REATTACH.1: the dropped-stream recovery loop, exercised
// against a REAL Bun.serve. The scenario is the reported bug verbatim: a chat stream dies mid-turn
// (server keeps working), and the client must re-adopt the running turn via the attach path instead
// of freezing (the old bug) or settling with a lie (the drop notice) when recovery is possible.

import { afterAll, describe, expect, test } from "bun:test";
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
