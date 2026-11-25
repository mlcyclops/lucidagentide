// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/viz_worlds.test.ts - P-WORLDS.1 (ADR-0648): the pure rules of the Lucid Agent Worlds registry:
// validation against the contract, option defaults and merging, receipt freshness, access and style ids.

import { describe, expect, test } from "bun:test";
import { WORLD_API_VERSION, type InstalledWorld, type WorldDefinition, type WorldOption, type WorldOptionValues } from "./viz_world_api.ts";
import {
  decideWorldAccess, loadWorlds, mergeEnvironment, mergeOptions, optionDefaults, parseStyle, RECEIPT_TTL_MS, RECEIPTS_KEY, receiptFresh, saveOption, loadOptions, savedWorldState,
  validateWorld, worldEnvironment, worldKeyOfStyle, worldStyle, worldAccess, worldUsable, type WorldsDeps,
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

  test("v1 modules still load on the v2 host (ADR-0649)", () => {
    expect(WORLD_API_VERSION).toBe(2);
    expect(validateWorld({ ...goodDef(), apiVersion: 1 }, { ...INST, apiVersion: 1 }).ok).toBe(true);
    expect(validateWorld({ ...goodDef(), apiVersion: 2 }, { ...INST, apiVersion: 2 }).ok).toBe(true);
  });

  test("castRoles: optional, known roles only, human or creature (ADR-0649)", () => {
    expect(validateWorld({ ...goodDef(), apiVersion: 2, castRoles: { subagent: "creature" } }, INST).ok).toBe(true);
    expect(validateWorld({ ...goodDef(), apiVersion: 2, castRoles: { hub: "human", agent: "human", subagent: "creature" } }, INST).ok).toBe(true);
    expect(errOf({ ...goodDef(), castRoles: "creature" })).toContain("castRoles");
    expect(errOf({ ...goodDef(), castRoles: { boss: "human" } })).toContain("unknown role");
    expect(errOf({ ...goodDef(), castRoles: { agent: "robot" } })).toContain("human or creature");
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

  test("reactions (ADR-0690): optional, at most four, one per base, kinds of their own, path icons", () => {
    const r = (kind: string, base: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ kind, base, label: "L", tip: "T", icon: "M4 4h16", ...extra });
    expect(validateWorld(goodDef(), INST).ok).toBe(true); // every world without them still loads
    expect(validateWorld({ ...goodDef(), reactions: [] }, INST).ok).toBe(true);
    expect(validateWorld({ ...goodDef(), reactions: [r("carol", "celebrate"), r("wave", "wave")] }, INST).ok).toBe(true);
    expect(errOf({ ...goodDef(), reactions: "carol" })).toContain("at most four");
    expect(errOf({ ...goodDef(), reactions: [r("a", "celebrate"), r("b", "wave"), r("c", "coffee"), r("d", "dance"), r("e", "dance")] })).toContain("at most four");
    expect(errOf({ ...goodDef(), reactions: [r("carol", "sing")] })).toContain("no base");
    expect(errOf({ ...goodDef(), reactions: [r("carol", "celebrate"), r("toast", "celebrate")] })).toContain("slot");
    expect(errOf({ ...goodDef(), reactions: [r("snowball", "celebrate")] })).toContain("reserved or repeated"); // a throwable's kind
    expect(errOf({ ...goodDef(), reactions: [r("storm", "celebrate")] })).toContain("reserved or repeated");
    expect(errOf({ ...goodDef(), reactions: [r("carol", "celebrate"), r("carol", "wave")] })).toContain("reserved or repeated");
    expect(errOf({ ...goodDef(), reactions: [r("dance", "celebrate")] })).toContain("another slot");
    expect(errOf({ ...goodDef(), reactions: [r("carol", "celebrate", { label: "" })] })).toContain("label or tip");
    expect(errOf({ ...goodDef(), reactions: [r("carol", "celebrate", { icon: "<svg/>" })] })).toContain("SVG path");
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
    expect(errOf({ ...d, environment: { ...env, edges: { style: "neon", colorA: "#fff", colorB: "#000" } } })).toContain("plasma, plasma-light or fiber");
    expect(errOf({ ...d, environment: { ...env, chargeColor: "gold" } })).toContain("chargeColor");
    expect(errOf({ ...d, environment: { ...env, fog: { color: "#fff", density: -1 } } })).toContain("fog");
    expect(errOf({ ...d, environment: { ...env, createAmbient: 3 } })).toContain("createAmbient");
    expect(errOf({ ...d, createFigure: undefined })).toContain("createFigure");
    expect(errOf({ ...d, createStorm: "no" })).toContain("createStorm");
    expect(errOf({ ...d, createStage: 1 })).toContain("createStage");
    expect(errOf(null)).toContain("did not return");
  });

  test("edges: plasma-light and the packet token validate (ADR-0652)", () => {
    const d = goodDef();
    const env = d.environment as Record<string, unknown>;
    const edges = (e: Record<string, unknown>): Record<string, unknown> => ({ ...d, environment: { ...env, edges: { style: "plasma-light", colorA: "#ffd166", colorB: "#2e7d32", ...e } } });
    expect(validateWorld(edges({}), INST).ok).toBe(true);
    for (const token of ["orb", "coin", "petal", "snowflake", "spark"]) expect(validateWorld(edges({ token }), INST).ok).toBe(true);
    expect(validateWorld(edges({ token: "coin", tokenColor: "#f5c542", tokenStamp: fn }), INST).ok).toBe(true);
    expect(validateWorld(edges({ token: "custom", paintToken: fn }), INST).ok).toBe(true);
    expect(errOf(edges({ token: "custom" }))).toContain("custom needs paintToken");
    expect(errOf(edges({ token: "star" }))).toContain("edges.token");
    expect(errOf(edges({ tokenColor: "gold" }))).toContain("tokenColor");
    expect(errOf(edges({ paintToken: "draw" }))).toContain("paintToken");
    expect(errOf(edges({ tokenStamp: 3 }))).toContain("tokenStamp");
    // a v1 world's plasma and fiber edges still pass unchanged
    expect(validateWorld({ ...d, environment: { ...env, edges: { style: "plasma", colorA: "#fff", colorB: "#000" } } }, INST).ok).toBe(true);
  });

  test("environmentFor must be a function whose default patch validates (ADR-0652)", () => {
    const d = goodDef();
    expect(validateWorld({ ...d, environmentFor: () => ({ edges: { colorA: "#00ff00" } }) }, INST).ok).toBe(true);
    expect(validateWorld({ ...d, environmentFor: () => ({}) }, INST).ok).toBe(true);
    expect(errOf({ ...d, environmentFor: { edges: {} } })).toContain("environmentFor is not a function");
    expect(errOf({ ...d, environmentFor: () => { throw new Error("boom"); } })).toContain("environmentFor failed: boom");
    expect(errOf({ ...d, environmentFor: () => ({ edges: { colorA: "green" } }) })).toContain("environmentFor: environment.edges colors");
    expect(errOf({ ...d, environmentFor: () => ({ edges: { style: "neon" } }) })).toContain("environmentFor: environment.edges.style");
    expect(errOf({ ...d, environmentFor: () => 7 })).toContain("did not return an object");
    // it is called with the defaults
    let seen: unknown = null;
    validateWorld({ ...d, environmentFor: (o: unknown) => { seen = o; return {}; } }, INST);
    expect(seen).toEqual({ hat: "#c8102e", sled: "red", lights: true });
  });
});

describe("environmentFor: the environment follows the options (ADR-0652)", () => {
  const sky = (): void => {};
  function teamWorld(): WorldDefinition {
    const d = goodDef();
    return {
      ...d,
      environmentFor: (o: WorldOptionValues) => ({
        edges: { style: "plasma-light", colorA: o.hat as string, colorB: o.sled === "gold" ? "#f5c542" : "#c8102e", token: o.lights ? "coin" : "orb" },
        chargeColor: o.hat as string,
        fog: { color: o.lights ? "#ffffff" : "#203040" },
        light: o.lights as boolean,
        paintSky: sky,
      }),
    } as unknown as WorldDefinition;
  }

  test("each option change re-resolves sky, fog, edges and charge over the base environment", () => {
    const def = teamWorld();
    const a = worldEnvironment(def, { hat: "#112233", sled: "red", lights: true });
    expect(a.edges).toEqual({ style: "plasma-light", colorA: "#112233", colorB: "#c8102e", token: "coin" });
    expect(a.chargeColor).toBe("#112233");
    expect(a.fog).toEqual({ color: "#ffffff", density: 0.01 }); // merged field by field: the base density stays
    expect(a.paintSky).toBe(sky);
    expect(a.light).toBe(true);
    const b = worldEnvironment(def, { hat: "#445566", sled: "gold", lights: false });
    expect(b.edges.colorA).toBe("#445566");
    expect(b.edges.colorB).toBe("#f5c542");
    expect(b.edges.token).toBe("orb");
    expect(b.chargeColor).toBe("#445566");
    expect(b.fog.color).toBe("#203040");
    expect(b.light).toBe(false);
    // the base environment is never mutated
    expect(def.environment.edges.style).toBe("fiber");
    expect(def.environment.chargeColor).toBe("#ffd166");
  });

  test("no environmentFor, a throwing one, or a bad patch for these values leaves the base environment", () => {
    const base = goodDef() as unknown as WorldDefinition;
    expect(worldEnvironment(base, {})).toBe(base.environment);
    const throws = { ...base, environmentFor: () => { throw new Error("x"); } } as WorldDefinition;
    expect(worldEnvironment(throws, {})).toBe(base.environment);
    const bad = { ...base, environmentFor: (o: WorldOptionValues) => ({ chargeColor: o.hat === "#000000" ? "black" : "#ffffff" }) } as WorldDefinition;
    expect(worldEnvironment(bad, { hat: "#000000" })).toBe(base.environment);
    expect(worldEnvironment(bad, { hat: "#123456" }).chargeColor).toBe("#ffffff");
  });

  test("mergeEnvironment takes only the patchable keys", () => {
    const base = (goodDef() as unknown as WorldDefinition).environment;
    const amb = (): never => { throw new Error("not this"); };
    const m = mergeEnvironment(base, { createAmbient: amb, edges: { tokenColor: "#f5c542" } });
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    expect(m.env.createAmbient).toBe(base.createAmbient);
    expect(m.env.edges).toEqual({ ...base.edges, tokenColor: "#f5c542" });
    expect(mergeEnvironment(base, null)).toEqual({ ok: true, env: base });
    expect(mergeEnvironment(base, { fog: 3 }).ok).toBe(false);
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

describe("swatch options (ADR-0650)", () => {
  const swatches = [{ value: "#1d4ed8", label: "Royal" }, { value: "#0f766e", label: "Teal" }, { value: "#b91c1c", label: "Crimson" }];
  const swatch: WorldOption = { key: "kit", label: "Kit shade", type: "swatch", default: "#1d4ed8", swatches };
  const withSwatch = (o: unknown): Record<string, unknown> => ({ ...goodDef(), apiVersion: 2, options: [o] });

  test("a named ramp of #rrggbb swatches with a default among them passes", () => {
    expect(validateWorld(withSwatch(swatch), INST).ok).toBe(true);
  });

  test("validation: swatches present, each a color with a label, unique, the default one of them", () => {
    expect(errOf(withSwatch({ ...swatch, swatches: [] }))).toContain("no swatches");
    expect(errOf(withSwatch({ ...swatch, swatches: undefined }))).toContain("no swatches");
    expect(errOf(withSwatch({ ...swatch, swatches: [{ value: "blue", label: "Blue" }] }))).toContain("malformed swatch");
    expect(errOf(withSwatch({ ...swatch, swatches: [{ value: "#1d4ed8", label: "" }] }))).toContain("malformed swatch");
    expect(errOf(withSwatch({ ...swatch, swatches: [{ value: "#1d4ed8", label: "A" }, { value: "#1d4ed8", label: "B" }] }))).toContain("repeats the swatch");
    expect(errOf(withSwatch({ ...swatch, default: "#000000" }))).toContain("not one of its swatches");
    expect(errOf(withSwatch({ ...swatch, choices: swatches, swatches: undefined }))).toContain("no swatches");
  });

  test("defaults and merge: a saved swatch still offered is kept, anything else falls back", () => {
    expect(optionDefaults([swatch])).toEqual({ kit: "#1d4ed8" });
    expect(mergeOptions([swatch], { kit: "#0f766e" })).toEqual({ kit: "#0f766e" });
    expect(mergeOptions([swatch], { kit: "#123456" })).toEqual({ kit: "#1d4ed8" });
    expect(mergeOptions([swatch], { kit: true })).toEqual({ kit: "#1d4ed8" });
  });

  test("save and load round trip", () => {
    const mem = new Map<string, string>();
    const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    const v = validateWorld(withSwatch(swatch), INST);
    if (!v.ok) throw new Error(v.error);
    expect(saveOption(storage, v.def, "kit", "#b91c1c")).toEqual({ kit: "#b91c1c" });
    expect(loadOptions(storage, v.def)).toEqual({ kit: "#b91c1c" });
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

  // P-WORLDS.HEAL1: the Worlds menu says why a saved world is not drawn, and the saved style is never dropped for it.
  test("a saved world that is not installed is pending while its restore is pending, else missing", () => {
    expect(savedWorldState("world:christmas", [], ["world-christmas"])).toBe("pending");
    expect(savedWorldState("world:christmas", [], ["world-golf"])).toBe("missing");
    expect(savedWorldState("world:christmas", [], [])).toBe("missing");
    expect(savedWorldState("world:christmas", ["world:christmas"], ["world-christmas"])).toBeNull();
    expect(savedWorldState("anime", [], ["world-christmas"])).toBeNull();
    expect(savedWorldState("professional", [], [])).toBeNull();
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
