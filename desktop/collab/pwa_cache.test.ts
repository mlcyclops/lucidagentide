// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/collab/pwa_cache.test.ts - P-REMOTE.16. Weighted toward the REFUSALS and the dedupe edges,
// because the failure modes here are worse than the feature: a merge that duplicates turns makes the
// transcript lie, and a cache that opens under tamper/staleness is an at-rest leak dressed as a resume.

import { describe, expect, test } from "bun:test";
import { importRoomKey, generateRoomKey } from "./crypto.ts";
import {
  mergeWelcome,
  openCache,
  pruneForCache,
  sealCache,
  PWA_CACHE_MAX_AGE_MS,
  PWA_CACHE_VERSION,
  WELCOME_CLIP,
  type PwaCachePayload,
} from "./pwa_cache.ts";
import type { ViewItem } from "./pwa_view.ts";
import type { CollabTranscriptTurn } from "./frames.ts";

const user = (text: string): ViewItem => ({ kind: "user", text });
const answer = (text: string, streaming = false): ViewItem => ({ kind: "answer", text, streaming });

describe("mergeWelcome", () => {
  test("fresh join: an empty item list becomes the replay, in order", () => {
    const replay: CollabTranscriptTurn[] = [
      { role: "user", text: "fix the bug" },
      { role: "assistant", text: "done, see foo.ts" },
    ];
    expect(mergeWelcome([], replay)).toEqual([user("fix the bug"), answer("done, see foo.ts")]);
  });

  test("turns already held (with thinking/tools between them) are not duplicated", () => {
    const items: ViewItem[] = [
      user("fix the bug"),
      { kind: "thinking", text: "hmm" },
      { kind: "tool", name: "edit", detail: "foo.ts" },
      answer("done, see foo.ts"),
    ];
    const replay: CollabTranscriptTurn[] = [
      { role: "user", text: "fix the bug" },
      { role: "assistant", text: "done, see foo.ts" },
    ];
    expect(mergeWelcome(items, replay)).toEqual(items);
  });

  test("turns missed while the screen was locked append AFTER the held items, in replay order", () => {
    const items: ViewItem[] = [user("fix the bug"), answer("done")];
    const replay: CollabTranscriptTurn[] = [
      { role: "user", text: "fix the bug" },
      { role: "assistant", text: "done" },
      { role: "user", text: "now the tests" },
      { role: "assistant", text: "tests pass" },
    ];
    expect(mergeWelcome(items, replay)).toEqual([
      ...items,
      user("now the tests"),
      answer("tests pass"),
    ]);
  });

  test("count-aware: three identical turns match three items, and a fourth appends", () => {
    const items: ViewItem[] = [user("continue"), user("continue"), user("continue")];
    const replay: CollabTranscriptTurn[] = [
      { role: "user", text: "continue" },
      { role: "user", text: "continue" },
      { role: "user", text: "continue" },
      { role: "user", text: "continue" },
    ];
    expect(mergeWelcome(items, replay)).toEqual([...items, user("continue")]);
  });

  test("a partial streamed answer is UPGRADED to the authoritative full text, never doubled", () => {
    const items: ViewItem[] = [user("go"), answer("The fix is", true)];
    // pruneForCache finalizes streaming before persist, but merge must handle both flags.
    const replay: CollabTranscriptTurn[] = [
      { role: "user", text: "go" },
      { role: "assistant", text: "The fix is in foo.ts line 12." },
    ];
    expect(mergeWelcome(items, replay)).toEqual([
      user("go"),
      answer("The fix is in foo.ts line 12."),
    ]);
  });

  test("an item that already matched one replay turn cannot also prefix-upgrade another", () => {
    const items: ViewItem[] = [answer("ok")];
    const replay: CollabTranscriptTurn[] = [
      { role: "assistant", text: "ok" },
      { role: "assistant", text: "ok then, moving on" },
    ];
    expect(mergeWelcome(items, replay)).toEqual([answer("ok"), answer("ok then, moving on")]);
  });

  test("dedupe compares CLIPPED text: an unclipped long item matches its clipped replay form", () => {
    const long = "x".repeat(WELCOME_CLIP + 500);
    const clipped = `${long.slice(0, WELCOME_CLIP)}\u2026`; // what host.ts clip() sends in welcome
    const merged = mergeWelcome([answer(long)], [{ role: "assistant", text: clipped }]);
    expect(merged).toEqual([answer(long)]);
  });

  test("user echoes from this phone and labelled turns from others both match by text", () => {
    const items: ViewItem[] = [{ kind: "user", text: "hi", from: "laptop" }];
    expect(mergeWelcome(items, [{ role: "user", text: "hi" }])).toEqual(items);
  });

  test("blank replay turns are ignored", () => {
    expect(mergeWelcome([], [{ role: "assistant", text: "  " }])).toEqual([]);
  });

  test("pure: the input list is not mutated by an upgrade", () => {
    const partial = answer("part", true);
    const items = [partial];
    mergeWelcome(items, [{ role: "assistant", text: "partial and more" }]);
    expect(items[0]).toBe(partial);
    expect(partial.streaming).toBe(true);
  });
});

describe("pruneForCache", () => {
  test("drops live snapshots and preview images; keeps the narrative", () => {
    const items: ViewItem[] = [
      user("go"),
      { kind: "fleet-lanes", lanes: [] },
      { kind: "processes", processes: [] },
      { kind: "preview", image: "data:image/png;base64,AAAA", id: "shot-0" },
      { kind: "tool", name: "edit", detail: "foo.ts", path: "foo.ts", add: 3, del: 1 },
      { kind: "thinking", text: "hm" },
      answer("done"),
    ];
    expect(pruneForCache(items)).toEqual([
      user("go"),
      { kind: "tool", name: "edit", detail: "foo.ts", path: "foo.ts", add: 3, del: 1 },
      { kind: "thinking", text: "hm" },
      answer("done"),
    ]);
  });

  test("finalizes a trailing streaming answer so a restore never waits for dead tokens", () => {
    expect(pruneForCache([answer("half", true)])).toEqual([answer("half", false)]);
  });

  test("caps item count (keeps the newest) and clips long text", () => {
    const many: ViewItem[] = Array.from({ length: 250 }, (_, i) => user(`m${i}`));
    const pruned = pruneForCache(many, 200);
    expect(pruned.length).toBe(200);
    expect(pruned[0]).toEqual(user("m50"));
    const clipped = pruneForCache([{ kind: "thinking", text: "y".repeat(9_000) }], 200, 8_000);
    const first = clipped[0];
    if (first?.kind !== "thinking") throw new Error("expected a thinking item");
    expect(first.text.length).toBe(8_001); // 8000 + ellipsis
  });
});

describe("sealCache / openCache", () => {
  const payload = (over: Partial<PwaCachePayload> = {}): PwaCachePayload => ({
    v: PWA_CACHE_VERSION,
    roomId: "room1",
    savedAt: 1_000_000,
    seen: 3,
    items: [user("hello"), answer("world")],
    ...over,
  });

  test("round-trips under the room key", async () => {
    const key = await importRoomKey(generateRoomKey());
    const sealed = await sealCache(key, payload());
    const opened = await openCache(key, sealed, "room1", 1_000_100);
    expect(opened).toEqual(payload());
  });

  test("wrong key yields null, never a throw", async () => {
    const sealed = await sealCache(await importRoomKey(generateRoomKey()), payload());
    expect(await openCache(await importRoomKey(generateRoomKey()), sealed, "room1", 1_000_100)).toBeNull();
  });

  test("a flipped ciphertext byte (tamper) yields null", async () => {
    const key = await importRoomKey(generateRoomKey());
    const sealed = await sealCache(key, payload());
    sealed[sealed.length - 1]! ^= 0x01;
    expect(await openCache(key, sealed, "room1", 1_000_100)).toBeNull();
  });

  test("room mismatch, future timestamp, over-age, and version drift all refuse", async () => {
    const key = await importRoomKey(generateRoomKey());
    expect(await openCache(key, await sealCache(key, payload()), "other-room", 1_000_100)).toBeNull();
    expect(await openCache(key, await sealCache(key, payload()), "room1", 999_999)).toBeNull(); // saved "in the future"
    expect(await openCache(key, await sealCache(key, payload()), "room1", 1_000_000 + PWA_CACHE_MAX_AGE_MS + 1)).toBeNull();
    expect(await openCache(key, await sealCache(key, payload({ v: 99 })), "room1", 1_000_100)).toBeNull();
  });

  test("an invalid item shape refuses the WHOLE payload (fail-closed)", async () => {
    const key = await importRoomKey(generateRoomKey());
    const bad = payload({ items: [user("ok"), { kind: "preview", image: "data:", id: "shot-0" } as ViewItem] });
    expect(await openCache(key, await sealCache(key, bad), "room1", 1_000_100)).toBeNull();
    const negSeen = await openCache(key, await sealCache(key, payload({ seen: -4 })), "room1", 1_000_100);
    expect(negSeen?.seen).toBe(0); // a bad watermark degrades to 0, not to a refusal of the transcript
  });

  test("truncated blobs refuse", async () => {
    const key = await importRoomKey(generateRoomKey());
    expect(await openCache(key, new Uint8Array(4), "room1", 1_000_100)).toBeNull();
  });
});
