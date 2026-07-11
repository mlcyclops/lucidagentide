// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// tools/build_kg_pack.test.ts — ADR-0207: the headless pack builder's PURE surface (arg parsing, catalog
// resolution, slug prediction, metadata overrides). No KB/model modules are imported, so this runs fast and
// never spawns omp — the model-driven build path is proven separately by a --limit smoke run.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseArgs, resolveTarget, withOverrides, predictSlug, defaultRoot, PACK_CATALOG } from "./build_kg_pack.ts";

describe("predictSlug", () => {
  test("matches the kb_pack slug rule (lowercase, hyphenate, trim, cap 60)", () => {
    expect(predictSlug("Business Development Capture Manager")).toBe("business-development-capture-manager");
    expect(predictSlug("CMMC & RMF Security Lead")).toBe("cmmc-rmf-security-lead");
    expect(predictSlug("  --weird!! name -- ")).toBe("weird-name");
  });
});

describe("PACK_CATALOG", () => {
  test("keys + ids are unique and every entry has a folder", () => {
    expect(new Set(PACK_CATALOG.map((e) => e.key)).size).toBe(PACK_CATALOG.length);
    expect(new Set(PACK_CATALOG.map((e) => e.id)).size).toBe(PACK_CATALOG.length);
    expect(PACK_CATALOG.every((e) => e.folder.length > 0)).toBe(true);
  });
  test("the BD Capture Manager maps to the AI TECH BD folder", () => {
    const bd = PACK_CATALOG.find((e) => e.key === "bd")!;
    expect(bd.folder).toBe("DoW Business Dev/AI TECH BD");
    expect(bd.name).toBe("Business Development Capture Manager");
  });
  test("catalog ids line up with the storefront ids that already exist", () => {
    // these five have a storefront row (desktop/renderer/kg_packs.ts) — the ids must match or the marketplace
    // object path (packs/<id>.lkgpack.zip) won't line up with what the builder writes.
    for (const id of ["capture-proposal-manager", "govcon-contracts-officer", "cmmc-rmf-security-lead", "program-manager-evm", "cleared-software-engineer"])
      expect(PACK_CATALOG.some((e) => e.id === id)).toBe(true);
  });
});

describe("parseArgs", () => {
  test("defaults + a bare target", () => {
    const a = parseArgs(["bd"], "/repo");
    expect(a.target).toBe("bd");
    expect(a.dryRun).toBe(false);
    expect(a.version).toBe("1.0.0");
    expect(a.author).toBe("TechLead 187 LLC");
    expect(a.root).toBe(defaultRoot("/repo"));
  });
  test("flags: limit/model/dest/licensing/dry-run/all", () => {
    const a = parseArgs(["ml", "--limit", "3", "--model", "claude-haiku-4-5", "--dest", "out", "--licensing", "subscription", "--dry-run"], "/repo");
    expect({ t: a.target, limit: a.limit, model: a.model, lic: a.licensing, dry: a.dryRun }).toEqual({ t: "ml", limit: 3, model: "claude-haiku-4-5", lic: "subscription", dry: true });
    expect(parseArgs(["--all"], "/repo").all).toBe(true);
  });
  test("rejects unknown flags + bad values (fail loud)", () => {
    expect(() => parseArgs(["bd", "--nope"], "/repo")).toThrow(/unknown flag/);
    expect(() => parseArgs(["bd", "--limit", "0"], "/repo")).toThrow(/positive/);
    expect(() => parseArgs(["bd", "--licensing", "free"], "/repo")).toThrow(/one-time\|subscription/);
    expect(() => parseArgs(["bd", "--model"], "/repo")).toThrow(/needs a value/);
    expect(() => parseArgs(["bd", "extra"], "/repo")).toThrow(/extra argument/);
  });
});

describe("resolveTarget", () => {
  test("by key, by folder name, and by full relative folder", () => {
    expect(resolveTarget("bd", "/root").entry.id).toBe("dow-dod-business-development");
    expect(resolveTarget("AI TECH BD", "/root").entry.key).toBe("bd");            // basename of the folder
    expect(resolveTarget("DoW Business Dev/AI TECH BD", "/root").entry.key).toBe("bd");
  });
  test("an unknown path synthesizes a buildable entry from the basename", () => {
    const r = resolveTarget("Some New Role", "/root");
    expect(r.entry.name).toBe("Some New Role");
    expect(r.entry.id).toBe("some-new-role");
    expect(r.folder).toBe(join("/root", "Some New Role"));
  });
});

describe("withOverrides", () => {
  test("per-run flags win over the catalog", () => {
    const base = PACK_CATALOG.find((e) => e.key === "bd")!;
    const a = parseArgs(["bd", "--name", "BD Capture Lead", "--id", "bd-lead", "--licensing", "subscription"], "/repo");
    const m = withOverrides(base, a);
    expect({ name: m.name, id: m.id, lic: m.licensing, role: m.role }).toEqual({ name: "BD Capture Lead", id: "bd-lead", lic: "subscription", role: base.role });
  });
});
