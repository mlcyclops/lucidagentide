// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/collab/pwa_history.test.ts - P-REMOTE.16 (ADR-0431): the phone's on-device settled history.
//
// Pure serialize/parse pair, proven headless: the CUI fail-closed gate, settled-only persistence, the size
// budget (shed code bodies oldest-first, then drop oldest items), the round trip, and envelope rejection.

import { describe, expect, it } from "bun:test";
import { HISTORY_MAX_BYTES, HISTORY_VERSION, parseHistory, serializeHistory } from "./pwa_history.ts";
import type { ViewItem } from "./pwa_view.ts";

const OPEN = { cui: false, lockdown: false };
const ROOM = "room-abc";

const ITEMS: ViewItem[] = [
  { kind: "user", seq: 1, text: "fix the guard" },
  { kind: "thinking", seq: 2, text: "look at auth first" },
  { kind: "tool", seq: 2, id: "c1", name: "edit", detail: "auth.ts", path: "auth.ts", add: 2, del: 1, code: { path: "auth.ts", oldText: "a\nb", newText: "a\nc\nd" }, ok: true, elapsedMs: 900 },
  { kind: "answer", seq: 2, text: "Done.", streaming: false },
  { kind: "fleet-lanes", lanes: [] },
  { kind: "user", seq: 3, text: "and the tests?" },
  { kind: "answer", seq: 4, text: "streaming now", streaming: true }, // newer than since: not settled
  { kind: "user", text: "local echo" }, // no seq: never journaled
  { kind: "preview", seq: 2, image: "data:image/png;base64,AAAA", id: "shot-0" },
];

describe("pwa_history: the CUI gate is fail-closed", () => {
  it("stores nothing unless the posture says cui === false explicitly", () => {
    expect(serializeHistory(ROOM, ITEMS, 3, { cui: true, lockdown: false })).toBeNull();
    expect(serializeHistory(ROOM, ITEMS, 3, { cui: true, lockdown: true })).toBeNull();
    expect(serializeHistory(ROOM, ITEMS, 3, null)).toBeNull();
    expect(serializeHistory(ROOM, ITEMS, 3, undefined)).toBeNull();
    expect(serializeHistory(ROOM, ITEMS, 3, {} as { cui: boolean; lockdown: boolean })).toBeNull();
    expect(serializeHistory(ROOM, ITEMS, 3, OPEN)).not.toBeNull();
  });

  it("stores nothing without a room, a positive cursor, or any settled item", () => {
    expect(serializeHistory("", ITEMS, 3, OPEN)).toBeNull();
    expect(serializeHistory(ROOM, ITEMS, 0, OPEN)).toBeNull();
    expect(serializeHistory(ROOM, ITEMS, NaN, OPEN)).toBeNull();
    expect(serializeHistory(ROOM, [{ kind: "user", text: "unjournaled" }], 3, OPEN)).toBeNull();
  });
});

describe("pwa_history: round trip keeps exactly the settled transcript", () => {
  it("persists settled items only (seq <= since), drops snapshots/previews/local folds, keeps thinking + code", () => {
    const raw = serializeHistory(ROOM, ITEMS, 3, OPEN)!;
    const env = JSON.parse(raw) as { v: number; roomId: string; since: number; savedAt: number; items: ViewItem[] };
    expect(env.v).toBe(HISTORY_VERSION);
    expect(env.roomId).toBe(ROOM);
    expect(env.since).toBe(3);
    expect(typeof env.savedAt).toBe("number");
    const back = parseHistory(raw, ROOM)!;
    expect(back.since).toBe(3);
    expect(back.items).toEqual(ITEMS.slice(0, 4).concat([ITEMS[5]!]));
    expect(back.items.some((i) => i.kind === "thinking")).toBe(true);
    const tool = back.items[2]!;
    if (tool.kind !== "tool") throw new Error("expected the tool item");
    expect(tool.code?.newText).toBe("a\nc\nd");
  });
});

describe("pwa_history: the size budget", () => {
  const big = (seq: number, n: number): ViewItem => ({ kind: "tool", seq, name: "write", detail: `f${n}.ts`, path: `f${n}.ts`, add: 1, del: 0, code: { path: `f${n}.ts`, content: "x".repeat(16 * 1024) } });

  it("sheds code bodies OLDEST first (path + diffstat stay) until the envelope fits", () => {
    // 80 x 16 KiB of code = ~1.25 MiB: over budget, but well under once the oldest bodies are shed.
    const items: ViewItem[] = Array.from({ length: 80 }, (_, i) => big(i + 1, i));
    const raw = serializeHistory(ROOM, items, 80, OPEN)!;
    expect(raw.length).toBeLessThanOrEqual(HISTORY_MAX_BYTES);
    const back = parseHistory(raw, ROOM)!;
    expect(back.items).toHaveLength(80); // nothing dropped: shedding was enough
    const first = back.items[0]!, last = back.items[79]!;
    if (first.kind !== "tool" || last.kind !== "tool") throw new Error("expected tool items");
    expect(first.code).toEqual({ path: "f0.ts" }); // oldest: body shed
    expect(first.add).toBe(1); // the precomputed diffstat survives the shed
    expect(last.code?.content?.length).toBe(16 * 1024); // newest: body kept
    // every item still carries its path: a chip never loses its file
    for (const it of back.items) if (it.kind === "tool") expect(it.path).toMatch(/^f\d+\.ts$/);
  });

  it("drops the OLDEST items when shedding code is not enough", () => {
    // 3000 x ~1 KiB of code-less items = ~3 MiB with nothing to shed.
    const items: ViewItem[] = Array.from({ length: 3000 }, (_, i) => ({ kind: "answer", seq: i + 1, text: `${i}:` + "y".repeat(1024), streaming: false }));
    const raw = serializeHistory(ROOM, items, 3000, OPEN)!;
    expect(raw.length).toBeLessThanOrEqual(HISTORY_MAX_BYTES);
    const back = parseHistory(raw, ROOM)!;
    expect(back.items.length).toBeLessThan(3000);
    expect(back.items.length).toBeGreaterThan(0);
    const last = back.items.at(-1)!;
    expect(last.seq).toBe(3000); // the newest always survives
    const first = back.items[0]!;
    expect(first.seq).toBe(3000 - back.items.length + 1); // and what remains is a contiguous newest tail
  });
});

describe("pwa_history: parseHistory rejects anything it cannot trust", () => {
  const good = serializeHistory(ROOM, ITEMS, 3, OPEN)!;

  it("rejects a missing/empty/non-JSON value, another room, a wrong version, non-array items, a bad cursor", () => {
    expect(parseHistory(null, ROOM)).toBeNull();
    expect(parseHistory(undefined, ROOM)).toBeNull();
    expect(parseHistory("", ROOM)).toBeNull();
    expect(parseHistory("{not json", ROOM)).toBeNull();
    expect(parseHistory("42", ROOM)).toBeNull();
    expect(parseHistory(good, "other-room")).toBeNull();
    expect(parseHistory(good, "")).toBeNull();
    const env = JSON.parse(good) as Record<string, unknown>;
    expect(parseHistory(JSON.stringify({ ...env, v: HISTORY_VERSION + 1 }), ROOM)).toBeNull();
    expect(parseHistory(JSON.stringify({ ...env, items: { kind: "user" } }), ROOM)).toBeNull();
    expect(parseHistory(JSON.stringify({ ...env, since: 0 }), ROOM)).toBeNull();
    expect(parseHistory(JSON.stringify({ ...env, since: "3" }), ROOM)).toBeNull();
  });

  it("drops malformed, unknown-kind, seq-less, or newer-than-since entries instead of rendering them", () => {
    const env = JSON.parse(good) as { items: unknown[] };
    const tampered = JSON.stringify({
      ...env,
      items: [
        ...env.items,
        null,
        "string",
        { kind: "fleet-lanes", seq: 1, lanes: [] },
        { kind: "user", text: "no seq" },
        { kind: "user", seq: 99, text: "from the future" },
        { kind: "answer", seq: 1, text: 7, streaming: false },
        { kind: "tool", seq: 1, name: "edit", detail: "x", code: "not an object" },
        { kind: "mystery", seq: 1, text: "?" },
      ],
    });
    const back = parseHistory(tampered, ROOM)!;
    expect(back.items).toEqual(ITEMS.slice(0, 4).concat([ITEMS[5]!]));
  });
});
