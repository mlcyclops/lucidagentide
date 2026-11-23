// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Lucid Agent Worlds: the schema-1 manifest rules for kind "world", and the package gates over a world.

import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { sha256Bytes } from "../kb/pack.ts";
import { PLUGIN_MANIFEST, PLUGIN_SIGNATURE, signPluginManifest, validatePluginManifest, verifyPluginEntries, type PluginManifest } from "./package.ts";

const MODULE = Buffer.from("export default (host) => ({ id: 'christmas' });\n");
const LICENSE = Buffer.from("LUCID Premium Plugin License\n");

const WORLD = {
  schema: 1, id: "world-christmas", name: "Christmas", version: "1.0.0", publisher: "TECHLEAD 187 LLC",
  license: "LUCID-Premium-Plugin-1.0", tier: "premium", section: "civilian", kind: "world",
  entry: { module: "world.js" }, apiVersion: 1,
};
const FILES = { "world.js": sha256Bytes(MODULE), LICENSE: sha256Bytes(LICENSE) };

const staged = (m: Record<string, unknown>) => validatePluginManifest(m, { requireFiles: false });
const full = (m: Record<string, unknown>) => validatePluginManifest(m, { requireFiles: true });

describe("kind world manifest", () => {
  test("a valid world manifest passes staged and installed validation", () => {
    expect(staged(WORLD).ok).toBe(true);
    expect(full({ ...WORLD, files: FILES }).ok).toBe(true);
    expect(staged({ ...WORLD, permissions: [] }).ok).toBe(true);
  });

  test("a world needs entry.module, a .js file listed in files", () => {
    expect(staged({ ...WORLD, entry: {} })).toMatchObject({ ok: false, reason: expect.stringMatching(/entry\.module/) });
    expect(staged({ ...WORLD, entry: { module: "world.ts" } }).ok).toBe(false);
    expect(staged({ ...WORLD, entry: { module: "../world.js" } }).ok).toBe(false);
    expect(full({ ...WORLD, entry: { module: "other.js" }, files: FILES })).toMatchObject({ ok: false, reason: expect.stringMatching(/other\.js is not in the package/) });
  });

  test("a world declares the contract version it was built against", () => {
    expect(staged({ ...WORLD, apiVersion: undefined }).ok).toBe(false);
    expect(staged({ ...WORLD, apiVersion: 0 }).ok).toBe(false);
    expect(staged({ ...WORLD, apiVersion: "1" }).ok).toBe(false);
    expect(staged({ ...WORLD, apiVersion: 2 }).ok).toBe(true);
  });

  test("a world declares no permissions, no csp, no mcp and no ai", () => {
    for (const p of ["network:loopback", "network:internet", "fs:plugin-data"]) {
      expect(staged({ ...WORLD, permissions: [p] })).toMatchObject({ ok: false, reason: expect.stringMatching(/no permissions/) });
    }
    expect(staged({ ...WORLD, csp: { "img-src": ["https://cdn.example"] } }).ok).toBe(false);
    expect(staged({ ...WORLD, mcp: { command: "node" } }).ok).toBe(false);
    expect(staged({ ...WORLD, ai: { provider: "lucid" } }).ok).toBe(false);
  });

  test("the package gates verify a signed world and refuse an unsigned premium world", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const manifest = { ...WORLD, files: FILES } as unknown as PluginManifest;
    const base = [
      { name: PLUGIN_MANIFEST, data: Buffer.from(JSON.stringify(manifest)) },
      { name: "world.js", data: MODULE },
      { name: "LICENSE", data: LICENSE },
    ];
    const trusted = [{ id: "k", key: publicKey }];
    const signed = [...base, { name: PLUGIN_SIGNATURE, data: Buffer.from(signPluginManifest(manifest, privateKey)) }];
    expect(verifyPluginEntries(signed, { expectId: "world-christmas", trusted })).toMatchObject({ ok: true, signed: true, keyId: "k" });
    expect(verifyPluginEntries(base, { expectId: "world-christmas", trusted })).toMatchObject({ ok: false, gate: "signature" });
  });
});
