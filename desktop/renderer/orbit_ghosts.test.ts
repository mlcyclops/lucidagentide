// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/orbit_ghosts.test.ts - P-FLEET.L17: historical spokes. The promise under test:
// every lane the ledger remembers is retrievable forever; HIDE and ARCHIVE are reversible view marks,
// never a forget; no mark ever suppresses activity newer than itself - a fresh run always resurfaces
// the spoke; and recovery reads the WHOLE ledger, not its first page.

import { describe, expect, test } from "bun:test";
import { ghostKey, ghostSpokes, readAllPages } from "./orbit_layout.ts";

const lane = (laneName: string, cwd: string, updatedAt: number, over?: object) =>
  ({ kind: "lane", laneId: `id-${laneName}-${updatedAt}`, laneName, cwd, model: "m", turns: 3, updatedAt, ...over });

describe("ghostSpokes", () => {
  test("only lane entries ghost; chats and ingests never do", () => {
    const out = ghostSpokes([lane("a", "/a", 5), { ...lane("b", "/b", 5), kind: "chat" }], [], []);
    expect(out.active.map((g) => g.name)).toEqual(["a"]);
  });
  test("many runs of one logical spoke collapse to the LATEST, newest ghost first", () => {
    const out = ghostSpokes([lane("a", "/a", 1), lane("a", "/a", 9), lane("b", "/b", 5)], [], []);
    expect(out.active.map((g) => [g.name, g.lastAt])).toEqual([["a", 9], ["b", 5]]);
  });
  test("a spoke alive in the fleet right now is not a ghost", () => {
    expect(ghostSpokes([lane("a", "/a", 5)], [{ name: "a", cwd: "/a" }], []).active).toEqual([]);
  });
  test("same name in a DIFFERENT folder is a different spoke", () => {
    expect(ghostSpokes([lane("a", "/x", 5)], [{ name: "a", cwd: "/y" }], []).active.length).toBe(1);
  });
  test("hide moves history at or before its time to the hidden list, and nothing after", () => {
    const hide = [{ key: ghostKey("a", "/a"), at: 5 }];
    const hid = ghostSpokes([lane("a", "/a", 5)], [], hide);
    expect(hid.active).toEqual([]);
    expect(hid.archived).toEqual([]);
    expect(hid.hidden.map((g) => g.name)).toEqual(["a"]); // off the recover list, never forgotten
    const later = ghostSpokes([lane("a", "/a", 5), lane("a", "/a", 9)], [], hide);
    expect(later.active.map((g) => g.lastAt)).toEqual([9]); // a new run resurfaces it
    expect(later.hidden).toEqual([]);
  });
  test("archive tucks a spoke away without forgetting it", () => {
    const arch = [{ key: ghostKey("a", "/a"), at: 5 }];
    const out = ghostSpokes([lane("a", "/a", 5), lane("b", "/b", 4)], [], [], arch);
    expect(out.active.map((g) => g.name)).toEqual(["b"]);
    expect(out.archived.map((g) => g.name)).toEqual(["a"]); // still listed, still recoverable
  });
  test("a fresh run resurfaces an archived spoke as active", () => {
    const arch = [{ key: ghostKey("a", "/a"), at: 5 }];
    const out = ghostSpokes([lane("a", "/a", 9)], [], [], arch);
    expect(out.active.map((g) => g.lastAt)).toEqual([9]);
    expect(out.archived).toEqual([]);
  });
  test("hide beats archive on the same spoke", () => {
    const key = ghostKey("a", "/a");
    const out = ghostSpokes([lane("a", "/a", 5)], [], [{ key, at: 5 }], [{ key, at: 5 }]);
    expect(out.active).toEqual([]);
    expect(out.archived).toEqual([]);
    expect(out.hidden.map((g) => g.name)).toEqual(["a"]);
  });
});

describe("readAllPages", () => {
  // A ledger bigger than two pages, newest first; the one run of "old" sits on the LAST page.
  const ledger = [...Array.from({ length: 1202 }, (_, i) => lane("busy", "/b", 5000 - i)), lane("old", "/o", 1)];
  const pager = (rows: typeof ledger, failAt = -1) => {
    const offsets: number[] = [];
    const fetchPage = async (limit: number, offset: number) => {
      offsets.push(offset);
      if (offset === failAt) return null;
      return { entries: rows.slice(offset, offset + Math.min(limit, 500)), total: rows.length };
    };
    return { offsets, fetchPage };
  };

  test("reads past the first page, so a spoke whose only run is old stays recoverable", async () => {
    const p = pager(ledger);
    const rows = await readAllPages(p.fetchPage);
    expect(p.offsets).toEqual([0, 500, 1000]);
    expect(rows?.length).toBe(ledger.length);
    expect(ghostSpokes(rows ?? [], [], []).active.map((g) => g.name)).toEqual(["busy", "old"]);
  });
  test("an exact multiple of the page size stops at total instead of asking for an empty page", async () => {
    const p = pager(ledger.slice(0, 1000));
    expect((await readAllPages(p.fetchPage))?.length).toBe(1000);
    expect(p.offsets).toEqual([0, 500]);
  });
  test("a failed page fails the read rather than returning a partial ledger", async () => {
    expect(await readAllPages(pager(ledger, 500).fetchPage)).toBeNull();
  });
});
