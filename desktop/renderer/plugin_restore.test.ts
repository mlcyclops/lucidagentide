// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/plugin_restore.test.ts - P-WORLDS.HEAL1: how a purchase the engine could not put back from its
// backup comes back: entitled -> the store reinstalls it; signed out -> sign in; no store -> Retry; not owned any
// more -> said once, never retried automatically; not a store item -> its own file. And the words for each.

import { describe, expect, test } from "bun:test";
import type { Entitlement } from "../../harness/market/entitlement.ts";
import type { PluginRepairView } from "./bridge.ts";
import {
  nameList, newestRepairAt, notEntitledCopy, notInStoreCopy, parseIdList, pendingCopy, planRestore, purchaseNoun, repairedCopy, restorableStoreItem,
  restoredCopy, unseenRepairs, type EntitlementAnswer, type RestoreFacts,
} from "./plugin_restore.ts";

const NOW = "2026-11-23T10:00:00.000Z";
const active = (packId: string, over: Partial<Entitlement> = {}): Entitlement => ({ packId, state: "active", ...over });
const facts = (over: Partial<RestoreFacts> = {}): RestoreFacts => ({
  signedIn: true, storeReachable: true, entitlements: new Map(), nowIso: NOW, givenUp: new Set(), manual: false, ...over,
});
const broken = (...ids: string[]) => ids.map((id) => ({ id, status: "missing" as const }));

describe("planRestore", () => {
  test("an entitled store item reinstalls; a healthy one is left alone", () => {
    const entitlements = new Map<string, EntitlementAnswer>([["world-christmas", active("world-christmas")], ["pathfinder", active("pathfinder")]]);
    const plan = planRestore([...broken("world-christmas", "pathfinder"), { id: "world-golf", status: "ok" }], facts({ entitlements }));
    expect(plan).toEqual({ install: ["world-christmas", "pathfinder"], signin: [], offline: [], notEntitled: [], notInStore: [] });
  });

  test("signed out asks for sign-in; no store or no network, or a failed lookup, is offline (Retry)", () => {
    expect(planRestore(broken("world-christmas"), facts({ signedIn: false })).signin).toEqual(["world-christmas"]);
    expect(planRestore(broken("world-christmas"), facts({ storeReachable: false, signedIn: false })).offline).toEqual(["world-christmas"]);
    expect(planRestore(broken("world-christmas"), facts({ entitlements: new Map<string, EntitlementAnswer>([["world-christmas", "unreachable"]]) })).offline).toEqual(["world-christmas"]);
    // Never asked (no answer at all) is not "not entitled": fail toward asking again, never toward giving up.
    expect(planRestore(broken("world-christmas"), facts()).offline).toEqual(["world-christmas"]);
  });

  test("no entitlement, a lapsed one, or a non-active one is not entitled (fail-closed)", () => {
    const entitlements = new Map<string, EntitlementAnswer>([
      ["world-christmas", null],
      ["world-golf", active("world-golf", { expiresAt: "2026-01-01T00:00:00.000Z" })],
      ["pathfinder", { packId: "pathfinder", state: "expired" }],
    ]);
    expect(planRestore(broken("world-christmas", "world-golf", "pathfinder"), facts({ entitlements })).notEntitled).toEqual(["world-christmas", "world-golf", "pathfinder"]);
  });

  test("an item not sold in the store (a coming-soon card, a pack, an unknown id) is restored only by its own file", () => {
    expect(restorableStoreItem("world-christmas")?.name).toBe("Christmas");
    expect(restorableStoreItem("bundle-sponsor")).toBeNull(); // a pack is sold but has no package to install
    expect(restorableStoreItem("my-private-tool")).toBeNull();
    expect(planRestore(broken("my-private-tool"), facts()).notInStore).toEqual(["my-private-tool"]);
  });

  test("an item already reported is skipped by automatic runs, asked about again by Restore purchases", () => {
    const entitlements = new Map<string, EntitlementAnswer>([["world-christmas", active("world-christmas")]]);
    const givenUp = new Set(["world-christmas"]);
    expect(planRestore(broken("world-christmas"), facts({ entitlements, givenUp }))).toEqual({ install: [], signin: [], offline: [], notEntitled: [], notInStore: [] });
    expect(planRestore(broken("world-christmas"), facts({ entitlements, givenUp, manual: true })).install).toEqual(["world-christmas"]);
  });
});

describe("the restore copy", () => {
  test("worlds, plugins and a mix are named for what they are", () => {
    expect(purchaseNoun(["world"])).toBe("Lucid Agent World");
    expect(purchaseNoun(["world", "world"])).toBe("Lucid Agent Worlds");
    expect(purchaseNoun(["server", "web"])).toBe("plugins");
    expect(purchaseNoun(["world", "server"])).toBe("purchases");
    expect(nameList(["A"])).toBe("A");
    expect(nameList(["A", "B"])).toBe("A and B");
    expect(nameList(["A", "B", "C"])).toBe("A, B and C");
    expect(nameList(["A", "B", "C", "D", "E"])).toBe("A, B, C and 2 more");
  });

  test("restored, repaired, pending, not entitled and not in the store", () => {
    expect(restoredCopy([{ name: "Christmas", kind: "world" }, { name: "Golf", kind: "world" }]).title).toBe("Restored 2 Lucid Agent Worlds");
    expect(restoredCopy([{ name: "Christmas", kind: "world" }, { name: "Golf", kind: "world" }]).desc).toContain("Christmas and Golf");
    expect(repairedCopy([{ name: "Christmas", kind: "world" }, { name: "Golf", kind: "world" }]).title).toBe("Repaired 2 Lucid Agent Worlds after an update");
    expect(repairedCopy([{ name: "Pathfinder", kind: "server" }]).title).toBe("Repaired 1 plugin after an update");
    expect(pendingCopy(["Christmas", "Golf"], true)).toMatchObject({ title: "2 purchased items need restoring", desc: expect.stringContaining("Sign in") });
    expect(pendingCopy(["Christmas"], false)).toMatchObject({ title: "1 purchased item needs restoring", desc: expect.stringContaining("Retry") });
    expect(notEntitledCopy(["Christmas"]).title).toBe("Christmas is no longer on your account");
    expect(notEntitledCopy(["Christmas"]).desc).toContain("will not keep trying");
    expect(notInStoreCopy(["My World"]).desc).toContain("Import");
    for (const c of [restoredCopy([{ name: "X", kind: "web" }]), repairedCopy([{ name: "X", kind: "web" }]), pendingCopy(["X"], true), notEntitledCopy(["X", "Y"]), notInStoreCopy(["X"])]) {
      expect(`${c.title} ${c.desc}`).not.toContain("\u2014");
    }
  });
});

describe("announcing the engine's repairs once", () => {
  const rep = (id: string, at: string): PluginRepairView => ({ id, name: id, kind: "world", version: "1.0.0", at });
  test("only repairs newer than the stored marker are new, and the marker moves to the newest", () => {
    const list = [rep("world-a", "2026-11-23T10:00:00.000Z"), rep("world-b", "2026-11-23T10:05:00.000Z")];
    expect(unseenRepairs(list, null)).toHaveLength(2);
    expect(unseenRepairs(list, "2026-11-23T10:00:00.000Z").map((r) => r.id)).toEqual(["world-b"]);
    expect(unseenRepairs(list, "2026-11-23T10:05:00.000Z")).toEqual([]);
    expect(newestRepairAt(list, null)).toBe("2026-11-23T10:05:00.000Z");
    expect(newestRepairAt([], "2026-11-23T09:00:00.000Z")).toBe("2026-11-23T09:00:00.000Z");
  });

  test("a stored id list is read defensively", () => {
    expect([...parseIdList('["world-christmas","pathfinder"]')]).toEqual(["world-christmas", "pathfinder"]);
    expect([...parseIdList('["../evil", 3, "ok-id"]')]).toEqual(["ok-id"]);
    expect(parseIdList("{not json").size).toBe(0);
    expect(parseIdList(null).size).toBe(0);
  });
});
