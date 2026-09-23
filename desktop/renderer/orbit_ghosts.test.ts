// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/orbit_ghosts.test.ts - P-FLEET.L17: historical spokes. The promise under test:
// every lane the ledger remembers is retrievable forever unless the user DELETED it on purpose;
// ARCHIVE is a reversible tuck-away, never a forget; and no mark ever suppresses activity newer
// than itself - a fresh run always resurfaces the spoke.

import { describe, expect, test } from "bun:test";
import { ghostKey, ghostSpokes } from "./orbit_layout.ts";

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
  test("delete buries history at or before its time, and nothing after", () => {
    const tomb = [{ key: ghostKey("a", "/a"), at: 5 }];
    const buried = ghostSpokes([lane("a", "/a", 5)], [], tomb);
    expect(buried.active).toEqual([]);
    expect(buried.archived).toEqual([]); // deleted is gone EVERYWHERE - the only true forget
    const later = ghostSpokes([lane("a", "/a", 5), lane("a", "/a", 9)], [], tomb);
    expect(later.active.map((g) => g.lastAt)).toEqual([9]); // a new run re-earns its ghost
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
  test("delete beats archive on the same spoke", () => {
    const key = ghostKey("a", "/a");
    const out = ghostSpokes([lane("a", "/a", 5)], [], [{ key, at: 5 }], [{ key, at: 5 }]);
    expect(out.active).toEqual([]);
    expect(out.archived).toEqual([]);
  });
});
