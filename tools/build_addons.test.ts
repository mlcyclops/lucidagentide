// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// ADR-0541: the build step for offered add-ons. A build without a signing key offers nothing; a signed
// package is indexed with its sha256; a package the shipped IDE would refuse (unsigned, or signed by a key it
// does not trust) fails the build and leaves an empty index.

import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Bytes, type TrustedPackKey } from "../harness/kb/pack.ts";
import { zipEntries } from "../harness/kb/zip.ts";
import { readAllZipEntries } from "../harness/personal/unzip.ts";
import { PLUGIN_MANIFEST, PLUGIN_SIGNATURE, parseOfferedIndex, signPluginManifest, validatePluginManifest } from "../harness/plugins/package.ts";
import { buildAddons, parseAddonsArgs, signCommandArgv, type AddonSpec } from "./build_addons.ts";

const dirs: string[] = [];
const tmp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const HERD: AddonSpec = { id: "herd", stage: "plugins/herd/stage.ts" };
const key = (id: string): { privateKey: KeyObject; trusted: TrustedPackKey[] } => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privateKey, trusted: [{ id, key: publicKey }] };
};

/** What plugins/herd/stage.ts writes: a free server manifest without `files`, LICENSE, server.js, client.js. */
function fakeStage(spec: AddonSpec, dir: string): void {
  writeFileSync(join(dir, PLUGIN_MANIFEST), JSON.stringify({
    schema: 1, id: spec.id, name: "Herd", version: "0.1.0", publisher: "TECHLEAD 187 LLC", license: "LUCID-Free-Add-on-1.0",
    tier: "free", section: "civilian", kind: "server", entry: { main: "server.js", healthPath: "/healthz" },
    permissions: ["network:loopback", "fs:plugin-data"],
  }));
  writeFileSync(join(dir, "LICENSE"), "test license\n");
  writeFileSync(join(dir, "server.js"), "require('http').createServer((q, s) => s.end('ok')).listen(Number(process.env.PORT));\n");
  writeFileSync(join(dir, "client.js"), "console.log('client');\n");
}

/** A sign command's effect: add the publisher signature to the packed file in place. */
function signInPlace(file: string, privateKey: KeyObject): void {
  const entries = readAllZipEntries(readFileSync(file), { maxTotalBytes: 1 << 30 });
  const raw: unknown = JSON.parse(entries.find((e) => e.name === PLUGIN_MANIFEST)?.data.toString("utf8") ?? "null");
  const v = validatePluginManifest(raw, { requireFiles: true });
  if (!v.ok) throw new Error(v.reason);
  writeFileSync(file, zipEntries([...entries, { name: PLUGIN_SIGNATURE, data: Buffer.from(signPluginManifest(v.manifest, privateKey), "utf8") }]));
}

const readIndex = (out: string) => parseOfferedIndex(JSON.parse(readFileSync(join(out, "index.json"), "utf8")));

describe("buildAddons", () => {
  test("no key and no sign command: an empty index, no package, and stale packages are cleared", () => {
    const out = tmp("addons-");
    writeFileSync(join(out, "herd-0.0.1.lplugin.zip"), "stale");
    let staged = false;
    const r = buildAddons({ out, addons: [HERD], stage: () => { staged = true; } });
    expect(r.index).toEqual([]);
    expect(r.skipped).toContain("no publisher key");
    expect(staged).toBe(false);
    expect(JSON.parse(readFileSync(join(out, "index.json"), "utf8"))).toEqual([]);
    expect(readdirSync(out)).toEqual(["index.json"]);
  });

  test("signed with a key the IDE trusts: the package is indexed with its sha256", () => {
    const out = tmp("addons-");
    const k = key("trusted");
    const r = buildAddons({ out, addons: [HERD], stage: fakeStage, privateKey: k.privateKey, trusted: k.trusted });
    expect(r.skipped).toBeNull();
    const file = "herd-0.1.0.lplugin.zip";
    expect(r.index).toEqual([{ id: "herd", version: "0.1.0", file, sha256: sha256Bytes(readFileSync(join(out, file))) }]);
    expect(readIndex(out)).toEqual(r.index);
  });

  test("signed by a key the shipped IDE does not trust: the build fails and the index stays empty", () => {
    const out = tmp("addons-");
    const dev = key("dev"), shipped = key("shipped");
    expect(() => buildAddons({ out, addons: [HERD], stage: fakeStage, privateKey: dev.privateKey, trusted: shipped.trusted })).toThrow(/signature/);
    expect(readIndex(out)).toEqual([]);
  });

  test("a sign command signs the packed file in place; one that leaves it unsigned or fails stops the build", () => {
    const k = key("trusted");
    const signed = tmp("addons-");
    const seen: string[][] = [];
    const r = buildAddons({
      out: signed, addons: [HERD], stage: fakeStage, signCmd: "powershell -File \"C:/addon repo/root.ps1\" sign {file}", trusted: k.trusted,
      run: (argv) => { seen.push(argv); signInPlace(argv[argv.length - 1]!, k.privateKey); return 0; },
    });
    expect(seen).toEqual([["powershell", "-File", "C:/addon repo/root.ps1", "sign", join(signed, "herd-0.1.0.lplugin.zip")]]);
    expect(r.index.map((x) => x.id)).toEqual(["herd"]);
    expect(r.index[0]!.sha256).toBe(sha256Bytes(readFileSync(join(signed, "herd-0.1.0.lplugin.zip"))));

    const unsigned = tmp("addons-");
    expect(() => buildAddons({ out: unsigned, addons: [HERD], stage: fakeStage, signCmd: "sign {file}", trusted: k.trusted, run: () => 0 })).toThrow(/not signed/);
    expect(readIndex(unsigned)).toEqual([]);

    const failed = tmp("addons-");
    expect(() => buildAddons({ out: failed, addons: [HERD], stage: fakeStage, signCmd: "sign", trusted: k.trusted, run: () => 1 })).toThrow(/exited with 1/);
    expect(readIndex(failed)).toEqual([]);
  });

  test("a stage that writes another id is refused", () => {
    const out = tmp("addons-");
    const k = key("trusted");
    const wrong = (_spec: AddonSpec, dir: string): void => fakeStage({ id: "not-herd", stage: "" }, dir);
    expect(() => buildAddons({ out, addons: [HERD], stage: wrong, privateKey: k.privateKey, trusted: k.trusted })).toThrow(/not-herd/);
    expect(existsSync(join(out, "index.json"))).toBe(true);
    expect(readIndex(out)).toEqual([]);
  });
});

describe("arguments", () => {
  test("flags parse; --key and --sign-cmd are exclusive; unknown flags throw", () => {
    expect(parseAddonsArgs(["--out", "d", "--sign-cmd", "x {file}"])).toEqual({ help: false, out: "d", signCmd: "x {file}" });
    expect(parseAddonsArgs(["--key", "k"])).toEqual({ help: false, key: "k" });
    expect(() => parseAddonsArgs(["--key", "k", "--sign-cmd", "x"])).toThrow(/one/);
    expect(() => parseAddonsArgs(["--nope"])).toThrow(/unknown/);
    expect(() => parseAddonsArgs(["--out"])).toThrow(/needs a value/);
  });

  test("a sign command splits on spaces, keeps quoted groups, and gets the file appended when it has no {file}", () => {
    expect(signCommandArgv("signer --in {file} --out {file}.tmp", "/p/a.zip")).toEqual(["signer", "--in", "/p/a.zip", "--out", "/p/a.zip.tmp"]);
    expect(signCommandArgv("  \"C:/Program Files/sign.exe\"   now ", "a.zip")).toEqual(["C:/Program Files/sign.exe", "now", "a.zip"]);
    expect(() => signCommandArgv("\"open", "a.zip")).toThrow(/unclosed/);
    expect(() => signCommandArgv("   ", "a.zip")).toThrow(/empty/);
  });
});
