// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/viz_worlds.test.ts - P-WORLDS.1 (ADR-0648): the pure rules of the Lucid Agent Worlds registry:
// validation against the contract, option defaults and merging, receipt freshness, access and style ids.

import { describe, expect, test } from "bun:test";
import { WORLD_API_VERSION, type InstalledWorld, type WorldOption } from "./viz_world_api.ts";
import {
  decideWorldAccess, loadWorlds, mergeOptions, optionDefaults, parseStyle, RECEIPT_TTL_MS, RECEIPTS_KEY, receiptFresh, saveOption, loadOptions,
  validateWorld, worldKeyOfStyle, worldStyle, worldAccess, worldUsable, type WorldsDeps,
} from "./viz_worlds.ts";
import { nullProvider, type EntitlementProvider } from "./market_gate.ts";
import type { WorldHost } from "./viz_world_api.ts";

const INST: InstalledWorld = { id: "world-christmas", version: "1.0.0", name: "Christmas", module: "/worlds/world-christmas/1.0.0/world.js", apiVersion: 1, installedAt: "2026-11-01T00:00:00Z" };
const fn = (): null => null;

function goodDef(): Record<string, unknown> {
  return {
    apiVersion: 1, id: "christmas", label: "Christmas", tagline: "Santa runs the workshop",
    throws: [
      { kind: "snowball", label: "Snowball", tip: "A snowball.", icon: "M12 4a8 8 0 1 0 0 16a8 8 0 1 0 0-16z" },
      { kind: "present", label: "Present", tip: "A present.", icon: "M4 9h16v11H4z M12 9v11" },
      { kind: "cocoa", label: "Cocoa", tip: "A mug of cocoa.", icon: "M6 8h10v9a3 3 0 0 1-3 3H9a3 3 0 0 1-3-3z" },
    ],
    storm: { label: "Blizzard", tip: "A blizzard.", icon: "M12 3v18 M3 12h18" },
    options: [
      { key: "hat", label: "Hat color", type: "color", default: "#c8102e" },
      { key: "sled", label: "Sled", type: "select", default: "red", choices: [{ value: "red", label: "Red" }, { value: "gold", label: "Gold" }] },
      { key: "lights", label: "Lights", type: "toggle", default: true },
    ],
    environment: {
      light: true, paintSky: fn, fog: { color: "#dfe8f5", density: 0.01 },
      edges: { style: "fiber", colorA: "#ffffff", colorB: "#c8102e" }, chargeColor: "#ffd166",
    },
    createFigure: fn, createProjectile: fn, createStorm: fn,
  };
}

const errOf = (d: unknown, inst: InstalledWorld = INST): string => { const v = validateWorld(d, inst); return v.ok ? "" : v.error; };

describe("validateWorld", () => {
  test("a well-formed world passes", () => {
    const v = validateWorld(goodDef(), INST);
    expect(v.ok).toBe(true);
  });

  test("the api version gates on the package and on the module", () => {
    expect(errOf(goodDef(), { ...INST, apiVersion: WORLD_API_VERSION + 1 })).toContain("newer");
    expect(errOf({ ...goodDef(), apiVersion: WORLD_API_VERSION + 1 })).toContain("newer");
    expect(errOf({ ...goodDef(), apiVersion: undefined })).toContain("apiVersion");
  });

  test("the id must match the package id's key", () => {
    expect(errOf({ ...goodDef(), id: "valentines" })).toContain("does not match");
    expect(errOf(goodDef(), { ...INST, id: "plugin-christmas" })).toContain("not a world package id");
  });

  test("exactly three throwables, unique kinds, plain path icons", () => {
    const d = goodDef();
    const throws = d.throws as Record<string, unknown>[];
    expect(errOf({ ...d, throws: throws.slice(0, 2) })).toContain("exactly three");
    expect(errOf({ ...d, throws: [throws[0], throws[0], throws[2]] })).toContain("repeated");
    expect(errOf({ ...d, throws: [{ ...throws[0], kind: "storm" }, throws[1], throws[2]] })).toContain("reserved");
    expect(errOf({ ...d, throws: [{ ...throws[0], icon: "<script>alert(1)</script>" }, throws[1], throws[2]] })).toContain("SVG path");
    expect(errOf({ ...d, throws: [{ ...throws[0], icon: "" }, throws[1], throws[2]] })).toContain("SVG path");
    expect(errOf({ ...d, throws: [{ ...throws[0], icon: "M1e5 0" }, throws[1], throws[2]] })).toContain("SVG path");
  });

  test("the storm must be present with a path icon", () => {
    expect(errOf({ ...goodDef(), storm: undefined })).toContain("storm");
    expect(errOf({ ...goodDef(), storm: { label: "B", tip: "t", icon: "url(x)" } })).toContain("storm icon");
  });

  test("options: unique keys and valid defaults", () => {
    const d = goodDef();
    const opts = d.options as WorldOption[];
    expect(errOf({ ...d, options: [opts[0], opts[0]] })).toContain("repeated");
    expect(errOf({ ...d, options: [{ ...opts[0], default: "red" }] })).toContain("color");
    expect(errOf({ ...d, options: [{ ...opts[1], default: "blue" }] })).toContain("choices");
    expect(errOf({ ...d, options: [{ ...opts[2], default: "yes" }] })).toContain("true or false");
    expect(errOf({ ...d, options: [{ key: "x", label: "X", type: "slider", default: 1 }] })).toContain("unknown type");
  });

  test("the environment and the factories must be present", () => {
    const d = goodDef();
    const env = d.environment as Record<string, unknown>;
    expect(errOf({ ...d, environment: { ...env, paintSky: undefined } })).toContain("paintSky");
    expect(errOf({ ...d, environment: { ...env, edges: { style: "neon", colorA: "#fff", colorB: "#000" } } })).toContain("plasma or fiber");
    expect(errOf({ ...d, environment: { ...env, chargeColor: "gold" } })).toContain("chargeColor");
    expect(errOf({ ...d, environment: { ...env, fog: { color: "#fff", density: -1 } } })).toContain("fog");
    expect(errOf({ ...d, environment: { ...env, createAmbient: 3 } })).toContain("createAmbient");
    expect(errOf({ ...d, createFigure: undefined })).toContain("createFigure");
    expect(errOf({ ...d, createStorm: "no" })).toContain("createStorm");
    expect(errOf({ ...d, createStage: 1 })).toContain("createStage");
    expect(errOf(null)).toContain("did not return");
  });
});

describe("options", () => {
  const opts = goodDef().options as WorldOption[];

  test("defaults", () => {
    expect(optionDefaults(opts)).toEqual({ hat: "#c8102e", sled: "red", lights: true });
  });

  test("merge keeps valid saved values, falls back to defaults and drops unknown keys", () => {
    expect(mergeOptions(opts, { hat: "#00ff00", sled: "gold", lights: false, extra: 1 })).toEqual({ hat: "#00ff00", sled: "gold", lights: false });
    expect(mergeOptions(opts, { hat: "green", sled: "purple", lights: "no" })).toEqual({ hat: "#c8102e", sled: "red", lights: true });
    expect(mergeOptions(opts, null)).toEqual({ hat: "#c8102e", sled: "red", lights: true });
  });

  test("save and load per world id", () => {
    const mem = new Map<string, string>();
    const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    const v = validateWorld(goodDef(), INST);
    if (!v.ok) throw new Error(v.error);
    expect(saveOption(storage, v.def, "sled", "gold")).toEqual({ hat: "#c8102e", sled: "gold", lights: true });
    expect(loadOptions(storage, v.def)).toEqual({ hat: "#c8102e", sled: "gold", lights: true });
    expect(saveOption(storage, v.def, "sled", "nope").sled).toBe("red");
  });
});

describe("receipts and access", () => {
  const now = Date.parse("2026-11-21T12:00:00Z");

  test("a receipt is fresh for 30 days, never from the future", () => {
    expect(receiptFresh({ at: now - 1000 }, now)).toBe(true);
    expect(receiptFresh({ at: now - RECEIPT_TTL_MS + 1 }, now)).toBe(true);
    expect(receiptFresh({ at: now - RECEIPT_TTL_MS }, now)).toBe(false);
    expect(receiptFresh({ at: now + 60_000 }, now)).toBe(false);
    expect(receiptFresh({ at: "x" }, now)).toBe(false);
    expect(receiptFresh(undefined, now)).toBe(false);
  });

  test("the access decision", () => {
    const active = { packId: "world-christmas", state: "active" as const };
    expect(decideWorldAccess(false, null, null, null, now)).toBe("allowed");
    expect(decideWorldAccess(true, { at: now - 5 }, null, null, now)).toBe("allowed");
    expect(decideWorldAccess(true, null, { signedIn: false }, null, now)).toBe("signin");
    expect(decideWorldAccess(true, null, { signedIn: true }, null, now)).toBe("checkout");
    expect(decideWorldAccess(true, null, { signedIn: true }, active, now)).toBe("allowed");
  });

  test("an active entitlement writes a receipt, which answers next time without asking", async () => {
    const mem = new Map<string, string>();
    const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    let asked = 0;
    const provider: EntitlementProvider = {
      ...nullProvider, configured: () => true, auth: async () => ({ signedIn: true }),
      entitlement: async (id) => { asked++; return { packId: id, state: "active" }; },
    };
    expect(await worldAccess("world-christmas", provider, storage, now)).toBe("allowed");
    expect(JSON.parse(mem.get(RECEIPTS_KEY)!)["world-christmas"].at).toBe(now);
    expect(await worldAccess("world-christmas", { ...provider, auth: async () => { throw new Error("offline"); } }, storage, now + 1000)).toBe("allowed");
    expect(asked).toBe(1);
    expect(await worldAccess("world-christmas", { ...provider, entitlement: async () => null }, storage, now + RECEIPT_TTL_MS + 1)).toBe("checkout");
  });
});

describe("style ids", () => {
  test("parse and build", () => {
    expect(worldStyle("christmas")).toBe("world:christmas");
    expect(worldKeyOfStyle("world:christmas")).toBe("christmas");
    expect(worldKeyOfStyle("world:")).toBeNull();
    expect(worldKeyOfStyle("world:Bad Key")).toBeNull();
    expect(worldKeyOfStyle("anime")).toBeNull();
    expect(parseStyle("professional")).toBe("professional");
    expect(parseStyle("world:football")).toBe("world:football");
    expect(parseStyle("world:<x>")).toBe("anime");
    expect(parseStyle(42)).toBe("anime");
  });
});

describe("loadWorlds", () => {
  const host = { THREE: {}, apiVersion: 1, kit: {} } as unknown as WorldHost; // the world under test never touches them
  const deps = (over: Partial<WorldsDeps>): WorldsDeps => ({
    list: async () => [INST], importModule: async () => ({ default: () => goodDef() }), host, provider: nullProvider,
    storage: { getItem: () => null, setItem: () => {} }, now: () => 0, ...over,
  });

  test("a valid world loads and is usable without a provider", async () => {
    const [w] = await loadWorlds(deps({}));
    expect(w!.error).toBeNull();
    expect(w!.style).toBe("world:christmas");
    expect(w!.label).toBe("Christmas");
    expect(worldUsable(w!)).toBe(true);
  });

  test("a module that throws or does not validate is listed with its error, never usable", async () => {
    const [a] = await loadWorlds(deps({ importModule: async () => { throw new Error("404"); } }));
    expect(a!.error).toContain("404");
    expect(worldUsable(a!)).toBe(false);
    const [b] = await loadWorlds(deps({ importModule: async () => ({ default: () => ({ ...goodDef(), throws: [] }) }) }));
    expect(b!.error).toContain("exactly three");
    const [c] = await loadWorlds(deps({ importModule: async () => ({}) }));
    expect(c!.error).toContain("default export");
  });

  test("an unchanged module keeps its definition on a refresh; a new version loads again", async () => {
    let imports = 0;
    const d = deps({ importModule: async () => { imports++; return { default: () => goodDef() }; } });
    const first = await loadWorlds(d);
    const again = await loadWorlds({ ...d, previous: first });
    expect(again[0]!.def).toBe(first[0]!.def);
    expect(imports).toBe(1);
    const next = { ...INST, version: "1.1.0", module: "/worlds/world-christmas/1.1.0/world.js" };
    const bumped = await loadWorlds({ ...d, list: async () => [next], previous: first });
    expect(bumped[0]!.def).not.toBe(first[0]!.def);
    expect(imports).toBe(2);
  });

  test("a failed list is empty", async () => {
    expect(await loadWorlds(deps({ list: async () => { throw new Error("down"); } }))).toEqual([]);
  });
});
