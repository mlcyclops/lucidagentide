// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-WORLDS.1 (ADR-0648): the Lucid Agent World packer: world.json rules, the staged manifest, the bare-import
// gate, and one real build that the installer's own gate accepts.

import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAllZipEntries } from "../harness/personal/unzip.ts";
import { validatePluginManifest, verifyPluginEntries } from "../harness/plugins/package.ts";
import { PREMIUM_LICENSE_TEXT, buildWorld, findBareImports, parseWorldArgs, parseWorldJson, worldManifest } from "./build_world.ts";

const dirs: string[] = [];
const tmp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const WORLD = { id: "world-christmas", version: "1.0.0", name: "Christmas", description: "Santa's workshop.", apiVersion: 1 };

describe("world.json", () => {
  test("a valid world.json parses; each field is checked", () => {
    expect(parseWorldJson(WORLD)).toEqual(WORLD);
    expect(() => parseWorldJson({ ...WORLD, id: "christmas" })).toThrow(/world-<key>/);
    expect(() => parseWorldJson({ ...WORLD, version: "1.0" })).toThrow(/version/);
    expect(() => parseWorldJson({ ...WORLD, name: " " })).toThrow(/name/);
    expect(() => parseWorldJson({ ...WORLD, description: undefined })).toThrow(/description/);
    expect(() => parseWorldJson({ ...WORLD, apiVersion: 0 })).toThrow(/apiVersion/);
    expect(() => parseWorldJson([])).toThrow();
  });
});

describe("worldManifest", () => {
  test("assembles a premium civilian world manifest the schema accepts", () => {
    const files = { "world.js": "a".repeat(64), LICENSE: "b".repeat(64) };
    const m = worldManifest(WORLD, files);
    expect(m).toMatchObject({
      schema: 1, id: "world-christmas", version: "1.0.0", name: "Christmas", description: "Santa's workshop.",
      tier: "premium", section: "civilian", kind: "world", entry: { module: "world.js" }, apiVersion: 1, files,
      publisher: "TECHLEAD 187 LLC", license: "LUCID-Premium-Plugin-1.0",
    });
    expect(validatePluginManifest(m, { requireFiles: true }).ok).toBe(true);
    expect(m.permissions).toBeUndefined();
  });
});

describe("findBareImports", () => {
  test("finds bare specifiers in static, re-export and dynamic imports, minified or not", () => {
    expect(findBareImports('import*as t from"three";')).toEqual(["three"]);
    expect(findBareImports('import{Vector3 as a,Color as b}from"three";')).toEqual(["three"]);
    expect(findBareImports("import x from 'three/addons/x.js';")).toEqual(["three/addons/x.js"]);
    expect(findBareImports('import"lodash";export*from"zod";')).toEqual(["lodash", "zod"]);
    expect(findBareImports('export{a}from"pkg";')).toEqual(["pkg"]);
    expect(findBareImports('const m=await import("three");')).toEqual(["three"]);
  });

  test("relative, absolute and URL imports, import.meta, and look-alike words are not bare", () => {
    expect(findBareImports('import a from"./a.js";import b from"../b.js";import c from"/c.js";')).toEqual([]);
    expect(findBareImports('import("https://cdn.example/x.js");import d from"data:text/javascript,1";')).toEqual([]);
    expect(findBareImports("const u=import.meta.url;const reimport='x';function important(){return\"three\"}")).toEqual([]);
    expect(findBareImports("export default(h)=>({id:\"christmas\"});")).toEqual([]);
  });
});

describe("parseWorldArgs", () => {
  test("parses the flags and refuses unknown ones", () => {
    expect(parseWorldArgs(["--src", "s", "--out", "o", "--key", "k"])).toEqual({ src: "s", out: "o", key: "k", help: false });
    expect(() => parseWorldArgs(["--bogus"])).toThrow();
    expect(() => parseWorldArgs(["--src"])).toThrow();
  });
});

describe("buildWorld", () => {
  const source = (index: string): string => {
    const dir = tmp("world-src-");
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "assets"), { recursive: true });
    writeFileSync(join(dir, "world.json"), JSON.stringify(WORLD));
    writeFileSync(join(dir, "src", "index.ts"), index);
    writeFileSync(join(dir, "assets", "snow.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"/>");
    return dir;
  };

  test("bundles, copies assets, signs, and the installer gate accepts the zip", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const src = source('import type * as T from "three";\nexport default (host: { THREE: typeof T }) => ({ id: "christmas", rev: host.THREE.REVISION });\n');
    const r = await buildWorld({ src, out: tmp("world-out-"), privateKey });
    expect(r.zipPath.endsWith("world-christmas-1.0.0.lplugin.zip")).toBe(true);
    const entries = readAllZipEntries(readFileSync(r.zipPath), { maxTotalBytes: 1 << 30 });
    expect(entries.map((e) => e.name).sort()).toEqual(["LICENSE", "assets/snow.svg", "lucid-plugin.json", "signature", "world.js"]);
    expect(entries.find((e) => e.name === "LICENSE")!.data.toString()).toBe(PREMIUM_LICENSE_TEXT);
    expect(findBareImports(entries.find((e) => e.name === "world.js")!.data.toString())).toEqual([]);
    expect(verifyPluginEntries(entries, { expectId: "world-christmas", trusted: [{ id: "k", key: publicKey }] })).toMatchObject({ ok: true, signed: true });
    expect(r.manifest).toMatchObject({ kind: "world", entry: { module: "world.js" }, apiVersion: 1 });
  });

  test("a runtime import of three fails the build", async () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const src = source('import * as THREE from "three";\nexport default () => ({ id: "christmas", rev: THREE.REVISION });\n');
    await expect(buildWorld({ src, out: tmp("world-out-"), privateKey })).rejects.toThrow(/"three"/);
  });

  test("a world is premium: no key, no build", async () => {
    await expect(buildWorld({ src: source("export default () => ({});\n"), out: tmp("world-out-") })).rejects.toThrow(/signed/);
  });
});
