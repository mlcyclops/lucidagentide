// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-PLUGINS.2 (ADR-0462): the `.lplugin` packer and the schema-1 manifest rules it enforces.

import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Bytes } from "../harness/kb/pack.ts";
import { readAllZipEntries } from "../harness/personal/unzip.ts";
import { safeRelPath, validatePluginManifest, verifyPluginEntries } from "../harness/plugins/package.ts";
import { bakePublicKey, buildPlugin, initPublisherKey, loadPrivateKey, parseArgs } from "./build_plugin.ts";

const dirs: string[] = [];
const tmp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const MANIFEST = {
  schema: 1, id: "agentictrade187", name: "AgenticTrade187", version: "0.2.1", publisher: "TECHLEAD 187 LLC",
  license: "LUCID-Premium-Plugin-1.0", tier: "premium", section: "civilian", kind: "server",
  entry: { main: "app/server/index.js", healthPath: "/api/health" },
  mcp: { command: "node", args: ["app/mcp/server.js"] },
  permissions: ["network:loopback", "network:internet", "fs:plugin-data"],
};

function stage(manifest: Record<string, unknown> = MANIFEST): string {
  const src = tmp("stage-");
  mkdirSync(join(src, "app", "server"), { recursive: true });
  mkdirSync(join(src, "app", "mcp"), { recursive: true });
  writeFileSync(join(src, "lucid-plugin.json"), JSON.stringify(manifest));
  writeFileSync(join(src, "LICENSE"), "LUCID Premium Plugin License\n");
  writeFileSync(join(src, "app", "server", "index.js"), "module.exports = 1;\n");
  writeFileSync(join(src, "app", "mcp", "server.js"), "module.exports = 2;\n");
  return src;
}

describe("buildPlugin", () => {
  test("hashes every file, signs the canonical manifest, and names the zip <id>-<version>.lplugin.zip", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const r = buildPlugin({ src: stage(), out: tmp("out-"), privateKey });
    expect(r.zipPath.endsWith("agentictrade187-0.2.1.lplugin.zip")).toBe(true);
    expect(r.signed).toBe(true);
    expect(r.keyId).toMatch(/^lucid-plugin-[0-9a-f]{16}$/);
    const entries = readAllZipEntries(readFileSync(r.zipPath), { maxTotalBytes: 1 << 30 });
    expect(entries.map((e) => e.name).sort()).toEqual(["LICENSE", "app/mcp/server.js", "app/server/index.js", "lucid-plugin.json", "signature"]);
    const m = JSON.parse(entries.find((e) => e.name === "lucid-plugin.json")!.data.toString()) as { files: Record<string, string> };
    expect(m.files["app/server/index.js"]).toBe(sha256Bytes(Buffer.from("module.exports = 1;\n")));
    expect(Object.keys(m.files).sort()).toEqual(["LICENSE", "app/mcp/server.js", "app/server/index.js"]);
    expect(verifyPluginEntries(entries, { expectId: "agentictrade187", trusted: [{ id: "k", key: publicKey }] })).toMatchObject({ ok: true, signed: true, keyId: "k" });
  });

  test("a premium plugin is never built unsigned, and a stale signature/files in the stage is replaced", () => {
    expect(() => buildPlugin({ src: stage(), out: tmp("out-") })).toThrow(/must be signed/);
    const src = stage({ ...MANIFEST, files: { "bogus": "0".repeat(64) } });
    writeFileSync(join(src, "signature"), "stale");
    const { privateKey } = generateKeyPairSync("ed25519");
    const r = buildPlugin({ src, out: tmp("out-"), privateKey });
    expect(Object.keys(r.manifest.files ?? {})).not.toContain("bogus");
  });

  test("an invalid staged manifest is refused with the reason", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    expect(() => buildPlugin({ src: stage({ ...MANIFEST, kind: "plugin" }), out: tmp("out-"), privateKey })).toThrow(/kind/);
    const noLicense = stage();
    rmSync(join(noLicense, "LICENSE"));
    expect(() => buildPlugin({ src: noLicense, out: tmp("out-"), privateKey })).toThrow(/LICENSE/);
  });
});

describe("publisher key", () => {
  test("--init-key creates the key once, never overwrites it, and bakes its public half", () => {
    const dir = tmp("keys-");
    const keyPath = join(dir, "keys", "lucid-plugin-publisher.key");
    const bake = join(dir, "publisher_key.ts");
    writeFileSync(bake, 'export const PLUGIN_PUBLISHER_SPKI_B64 = "";\n');
    const a = initPublisherKey(keyPath, bake);
    expect(a.created).toBe(true);
    expect(existsSync(keyPath)).toBe(true);
    expect(readFileSync(bake, "utf8")).toContain(`PLUGIN_PUBLISHER_SPKI_B64: string = "${a.spkiB64}"`);
    const pem = readFileSync(keyPath, "utf8");
    const b = initPublisherKey(keyPath, bake);
    expect(b.created).toBe(false);
    expect(b.keyId).toBe(a.keyId);
    expect(readFileSync(keyPath, "utf8")).toBe(pem);
    expect(loadPrivateKey(keyPath).asymmetricKeyType).toBe("ed25519");
  });

  test("bakePublicKey refuses a file without the constant", () => {
    expect(() => bakePublicKey("export const X = 1;", "AAAA")).toThrow();
    expect(bakePublicKey('export const PLUGIN_PUBLISHER_SPKI_B64 = "old";', "NEW=")).toBe('export const PLUGIN_PUBLISHER_SPKI_B64: string = "NEW=";');
    expect(bakePublicKey('export const PLUGIN_PUBLISHER_SPKI_B64: string = "NEW=";', "B")).toBe('export const PLUGIN_PUBLISHER_SPKI_B64: string = "B";');
  });

  test("parseArgs", () => {
    expect(parseArgs(["--src", "s", "--out", "o", "--key", "k"])).toEqual({ src: "s", out: "o", key: "k", initKey: false, help: false });
    expect(parseArgs(["--init-key"]).initKey).toBe(true);
    expect(() => parseArgs(["--bogus"])).toThrow();
    expect(() => parseArgs(["--src"])).toThrow();
  });
});

describe("schema 1 manifest rules", () => {
  const ok = (m: Record<string, unknown>) => validatePluginManifest(m, { requireFiles: false }).ok;
  test("ai is optional; when present it must be exactly { provider: lucid }", () => {
    expect(ok(MANIFEST)).toBe(true);
    expect(ok({ ...MANIFEST, ai: { provider: "lucid" } })).toBe(true);
    expect(ok({ ...MANIFEST, ai: { provider: "gemini" } })).toBe(false);
    expect(ok({ ...MANIFEST, ai: { provider: "lucid", key: "x" } })).toBe(false);
  });
  test("unknown permissions, csp without network:internet, and csp on non-web kinds are refused", () => {
    expect(ok({ ...MANIFEST, permissions: ["fs:everything"] })).toBe(false);
    const web = { ...MANIFEST, kind: "web", entry: { root: "web", index: "index.html" }, mcp: undefined };
    expect(ok({ ...web, permissions: ["network:internet"], csp: { "media-src": ["https://storage.googleapis.com"] } })).toBe(true);
    expect(ok({ ...web, permissions: [], csp: { "media-src": ["https://storage.googleapis.com"] } })).toBe(false);
    expect(ok({ ...web, permissions: ["network:internet"], csp: { "script-src": ["https://cdn.example"] } })).toBe(false);
    expect(ok({ ...web, permissions: ["network:internet"], csp: { "img-src": ["https://cdn.example/path"] } })).toBe(false);
    expect(ok({ ...MANIFEST, csp: { "img-src": ["https://cdn.example"] } })).toBe(false);
  });
  test("mcp.command is node or a package path; entry paths must be safe", () => {
    expect(ok({ ...MANIFEST, mcp: { command: "C:\\Windows\\cmd.exe" } })).toBe(false);
    expect(ok({ ...MANIFEST, mcp: { command: "bin/tool.exe" } })).toBe(true);
    expect(ok({ ...MANIFEST, entry: { main: "../x.js", healthPath: "/h" } })).toBe(false);
    expect(ok({ ...MANIFEST, entry: { main: "x.js", healthPath: "h" } })).toBe(false);
    expect(ok({ ...MANIFEST, id: "Bad_Id" })).toBe(false);
    expect(ok({ ...MANIFEST, version: "1.0" })).toBe(false);
  });
  test("safeRelPath", () => {
    for (const good of ["LICENSE", "app/server/index.js", "web/assets/a-b_c.v2.js"]) expect(safeRelPath(good)).toBe(true);
    for (const bad of ["", "/abs", "../x", "a/../b", "a//b", "a\\b", "C:/x", "a/./b", "x.", "a/nul", "a/com1.txt", "ads:stream"]) expect(safeRelPath(bad)).toBe(false);
  });
});
