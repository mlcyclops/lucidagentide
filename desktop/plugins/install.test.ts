// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-PLUGINS.2 (ADR-0462): the `.lplugin` install gates, pinned by behavior on packages built by the REAL
// packer (tools/build_plugin.ts) and then altered the way an attacker or a broken upload would alter them.
// Every refusal must name its gate and leave nothing installed; a good package installs, updates in place
// and uninstalls while the plugin's data directory survives.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipEntries } from "../../harness/kb/zip.ts";
import { readAllZipEntries } from "../../harness/personal/unzip.ts";
import { signPluginManifest, type PluginManifest } from "../../harness/plugins/package.ts";
import { authenticodeVerdict } from "./authenticode.ts";
import { CLEAN, buildServerFixture, testKey } from "./fixtures.ts";
import {
  downloadUrlProblem, installPluginBytes, installPluginFromUrl, listInstalled, pluginDataDir, pluginLogPath, readInstalled,
  readPluginLicense, uninstallPlugin, type InstallDeps,
} from "./install.ts";

const KEY = testKey();
const ENV_KEYS = ["LUCID_PLUGINS_DIR", "LUCID_PLUGIN_DATA_DIR", "LUCID_PLUGIN_LOG_PATH", "LUCID_PLUGIN_DEV_LOOPBACK"] as const;
let saved: Record<string, string | undefined> = {};
let work = "";

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  work = mkdtempSync(join(tmpdir(), "lplugin-install-"));
  process.env.LUCID_PLUGINS_DIR = join(work, "plugins");
  process.env.LUCID_PLUGIN_DATA_DIR = join(work, "plugin-data");
  process.env.LUCID_PLUGIN_LOG_PATH = join(work, "lucid-plugins.jsonl");
  delete process.env.LUCID_PLUGIN_DEV_LOOPBACK;
});
afterEach(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(work, { recursive: true, force: true });
});

const deps = (over: Partial<InstallDeps> = {}): InstallDeps => ({ trusted: KEY.trusted, decide: async () => CLEAN, record: () => {}, managedEgress: {}, ...over });

/** Rebuild a zip after editing its entries (the packer's output is the starting point). */
function rezip(zip: Buffer, edit: (e: { name: string; data: Buffer }[]) => { name: string; data: Buffer }[]): Buffer {
  return zipEntries(edit(readAllZipEntries(zip, { maxTotalBytes: 1 << 30 })));
}

const nothingInstalled = (): boolean => listInstalled().length === 0 && !existsSync(join(process.env.LUCID_PLUGINS_DIR!, "fixture-server", "current.json"));

describe("the install gates refuse, name the gate, and install nothing", () => {
  test("a tampered payload file fails the hash gate", async () => {
    const zip = rezip(buildServerFixture(KEY), (es) => es.map((e) => e.name === "app/server.cjs" ? { ...e, data: Buffer.from(e.data.toString() + "\n// injected") } : e));
    const r = await installPluginBytes(zip, "fixture-server", deps());
    expect(r).toMatchObject({ ok: false, gate: "hash" });
    expect(nothingInstalled()).toBe(true);
  });

  test("an extra file the signed list does not name fails the hash gate", async () => {
    const zip = rezip(buildServerFixture(KEY), (es) => [...es, { name: "app/extra.cjs", data: Buffer.from("1") }]);
    expect(await installPluginBytes(zip, "fixture-server", deps())).toMatchObject({ ok: false, gate: "hash" });
  });

  test("a package for a different plugin id fails the manifest gate", async () => {
    const r = await installPluginBytes(buildServerFixture(KEY), "pathfinder", deps());
    expect(r).toMatchObject({ ok: false, gate: "manifest" });
    expect(r.ok ? "" : r.reason).toContain("does not match");
    expect(nothingInstalled()).toBe(true);
  });

  test("an unsigned premium package fails the signature gate", async () => {
    const zip = rezip(buildServerFixture(KEY), (es) => es.filter((e) => e.name !== "signature"));
    const r = await installPluginBytes(zip, "fixture-server", deps());
    expect(r).toMatchObject({ ok: false, gate: "signature" });
    expect(nothingInstalled()).toBe(true);
  });

  test("a signature from an untrusted key fails the signature gate", async () => {
    const r = await installPluginBytes(buildServerFixture(testKey("stranger")), "fixture-server", deps());
    expect(r).toMatchObject({ ok: false, gate: "signature" });
  });

  test("a manifest edited after signing fails the signature gate", async () => {
    const zip = rezip(buildServerFixture(KEY), (es) => es.map((e) => {
      if (e.name !== "lucid-plugin.json") return e;
      const m = JSON.parse(e.data.toString()) as PluginManifest;
      return { ...e, data: Buffer.from(JSON.stringify({ ...m, tier: "premium", name: "Renamed" })) };
    }));
    expect(await installPluginBytes(zip, "fixture-server", deps())).toMatchObject({ ok: false, gate: "signature" });
  });

  test("garbage in the signature file fails the signature gate", async () => {
    const zip = rezip(buildServerFixture(KEY), (es) => es.map((e) => e.name === "signature" ? { ...e, data: Buffer.from("not base64 !!") } : e));
    expect(await installPluginBytes(zip, "fixture-server", deps())).toMatchObject({ ok: false, gate: "signature" });
  });

  test("with no trusted publisher key baked in, a signed premium package is refused (fail-closed)", async () => {
    expect(await installPluginBytes(buildServerFixture(KEY), "fixture-server", deps({ trusted: [] }))).toMatchObject({ ok: false, gate: "signature" });
  });

  test("path traversal in the zip fails the manifest gate before anything is written", async () => {
    for (const evil of ["../evil.cjs", "app/../../evil.cjs", "/abs.cjs", "C:/win.cjs", "app\\..\\evil.cjs", "app/CON.txt"]) {
      const zip = rezip(buildServerFixture(KEY), (es) => [...es, { name: evil, data: Buffer.from("x") }]);
      const r = await installPluginBytes(zip, "fixture-server", deps());
      expect(r).toMatchObject({ ok: false, gate: "manifest" });
    }
    expect(existsSync(join(work, "evil.cjs"))).toBe(false);
    expect(nothingInstalled()).toBe(true);
  });

  test("a traversal path listed in a correctly SIGNED manifest is still refused", async () => {
    // The publisher key signs whatever it is given; the path rule must hold even for a signed package.
    const zip = rezip(buildServerFixture(KEY), (es) => {
      const manEntry = es.find((e) => e.name === "lucid-plugin.json")!;
      const m = JSON.parse(manEntry.data.toString()) as PluginManifest;
      const files = { ...m.files, "../evil.cjs": "0".repeat(64) };
      const signed = { ...m, files };
      return es.map((e) => e.name === "lucid-plugin.json" ? { ...e, data: Buffer.from(JSON.stringify(signed)) }
        : e.name === "signature" ? { ...e, data: Buffer.from(signPluginManifest(signed, KEY.privateKey)) } : e);
    });
    expect(await installPluginBytes(zip, "fixture-server", deps())).toMatchObject({ ok: false, gate: "manifest" });
  });

  test("a scanner finding, or a dead scanner, fails the scan gate", async () => {
    const zip = buildServerFixture(KEY);
    const flagged = await installPluginBytes(zip, "fixture-server", deps({ decide: async () => ({ ...CLEAN, block: true, reason: "quarantined: 1 finding(s)" }) }));
    expect(flagged).toMatchObject({ ok: false, gate: "scan" });
    const dead = await installPluginBytes(zip, "fixture-server", deps({ decide: async () => { throw new Error("scanner not running"); } }));
    expect(dead).toMatchObject({ ok: false, gate: "scan" });
    expect(dead.ok ? "" : dead.reason).toContain("scanner unavailable");
    expect(nothingInstalled()).toBe(true);
  });

  test("a daemon's unsigned Windows binary fails the authenticode gate", async () => {
    const zip = buildServerFixture(KEY, { kind: "daemon", entry: { exe: "bin/daemon.exe", args: [], healthPath: "/health" }, mcp: undefined }, { "bin/daemon.exe": "MZ fake" });
    const probed: string[] = [];
    const r = await installPluginBytes(zip, "fixture-server", deps({ platform: "win32", authenticode: (p) => { probed.push(p); return { ok: false, reason: "Authenticode status is NotSigned" }; } }));
    expect(r).toMatchObject({ ok: false, gate: "authenticode" });
    expect(probed.length).toBe(1);
    expect(probed[0]!.endsWith("daemon.exe")).toBe(true);
    expect(nothingInstalled()).toBe(true);
  });

  test("the authenticode verdict accepts only Valid + CN=TECHLEAD 187 LLC", () => {
    const ok = JSON.stringify({ status: "Valid", subject: "CN=TECHLEAD 187 LLC, O=TECHLEAD 187 LLC, L=Sun City Center, S=Florida, C=US" });
    expect(authenticodeVerdict(ok).ok).toBe(true);
    expect(authenticodeVerdict(JSON.stringify({ status: "NotSigned", subject: "" })).ok).toBe(false);
    expect(authenticodeVerdict(JSON.stringify({ status: "Valid", subject: "CN=TECHLEAD 187 LLC Evil, O=X" })).ok).toBe(false);
    expect(authenticodeVerdict(JSON.stringify({ status: "HashMismatch", subject: "CN=TECHLEAD 187 LLC" })).ok).toBe(false);
    expect(authenticodeVerdict("garbage").ok).toBe(false);
  });

  test("a non-zip fails the manifest gate", async () => {
    expect(await installPluginBytes(Buffer.from("hello"), "fixture-server", deps())).toMatchObject({ ok: false, gate: "manifest" });
  });
});

describe("the download gate", () => {
  test("https only; loopback http only under the smoke switch", () => {
    expect(downloadUrlProblem("https://storage.googleapis.com/x?sig=1")).toBeNull();
    expect(downloadUrlProblem("http://example.com/x.zip")).toContain("https");
    expect(downloadUrlProblem("http://127.0.0.1:8000/x.zip")).toContain("https");
    expect(downloadUrlProblem("https://user:pw@example.com/x")).not.toBeNull();
    process.env.LUCID_PLUGIN_DEV_LOOPBACK = "1";
    expect(downloadUrlProblem("http://127.0.0.1:8000/x.zip")).toBeNull();
    expect(downloadUrlProblem("http://example.com/x.zip")).toContain("https");
  });

  test("an oversized download, an http URL and a managed-denied host are refused and logged without the query", async () => {
    const zip = buildServerFixture(KEY);
    const fetchImpl = (async () => new Response(zip)) as unknown as typeof fetch;
    const big = await installPluginFromUrl("https://cdn.example/p.zip?X-Goog-Signature=SECRET", "fixture-server", deps({ fetchImpl, maxDownloadBytes: 10 }));
    expect(big).toMatchObject({ ok: false, gate: "download" });
    expect(await installPluginFromUrl("http://cdn.example/p.zip", "fixture-server", deps({ fetchImpl }))).toMatchObject({ ok: false, gate: "download" });
    expect(await installPluginFromUrl("https://cdn.example/p.zip", "fixture-server", deps({ fetchImpl, managedEgress: { deniedHosts: ["cdn.example"] } }))).toMatchObject({ ok: false, gate: "download" });
    const log = readFileSync(pluginLogPath(), "utf8");
    expect(log.trim().split("\n").length).toBe(3);
    expect(log).not.toContain("SECRET");
  });
});

describe("install, update and uninstall", () => {
  test("installs from a URL, logs the attempt, and lays out plugins/<id>/<version> + plugin-data/<id>", async () => {
    const zip = buildServerFixture(KEY);
    const fetchImpl = (async () => new Response(zip)) as unknown as typeof fetch;
    const r = await installPluginFromUrl("https://cdn.example/fixture-server.lplugin.zip?sig=1", "fixture-server", deps({ fetchImpl }));
    expect(r).toEqual({ ok: true, id: "fixture-server", version: "0.1.0", signed: true, keyId: "test-publisher" });
    const p = readInstalled("fixture-server")!;
    expect(p.dir).toBe(join(process.env.LUCID_PLUGINS_DIR!, "fixture-server", "0.1.0"));
    expect(existsSync(join(p.dir, "app", "server.cjs"))).toBe(true);
    expect(existsSync(join(p.dir, "signature"))).toBe(true);
    expect(existsSync(pluginDataDir("fixture-server"))).toBe(true);
    expect(readPluginLicense("fixture-server")).toMatchObject({ ok: true, text: "LUCID Premium Plugin License (test fixture)\n" });
    const line = JSON.parse(readFileSync(pluginLogPath(), "utf8").trim()) as Record<string, unknown>;
    expect(line).toMatchObject({ action: "install", ok: true, id: "fixture-server", version: "0.1.0", source: "https://cdn.example/fixture-server.lplugin.zip" });
  });

  test("an update switches the version, drops the old one, and keeps the data dir; uninstall keeps data unless asked", async () => {
    expect((await installPluginBytes(buildServerFixture(KEY), "fixture-server", deps())).ok).toBe(true);
    writeFileSync(join(pluginDataDir("fixture-server"), "state.json"), "{\"saved\":true}");
    const switched: string[] = [];
    const up = await installPluginBytes(buildServerFixture(KEY, { version: "0.2.0" }), "fixture-server", deps({ beforeSwitch: async (id) => { switched.push(id); } }));
    expect(up).toMatchObject({ ok: true, version: "0.2.0" });
    expect(switched).toEqual(["fixture-server"]);
    expect(readInstalled("fixture-server")?.manifest.version).toBe("0.2.0");
    expect(readdirSync(join(process.env.LUCID_PLUGINS_DIR!, "fixture-server")).sort()).toEqual(["0.2.0", "current.json"]);
    expect(readFileSync(join(pluginDataDir("fixture-server"), "state.json"), "utf8")).toBe("{\"saved\":true}");

    // Reinstalling the same version replaces it in place.
    expect((await installPluginBytes(buildServerFixture(KEY, { version: "0.2.0" }), "fixture-server", deps())).ok).toBe(true);

    expect(uninstallPlugin("fixture-server", true)).toEqual({ ok: true });
    expect(readInstalled("fixture-server")).toBeNull();
    expect(existsSync(join(process.env.LUCID_PLUGINS_DIR!, "fixture-server"))).toBe(false);
    expect(readFileSync(join(pluginDataDir("fixture-server"), "state.json"), "utf8")).toBe("{\"saved\":true}");

    expect((await installPluginBytes(buildServerFixture(KEY), "fixture-server", deps())).ok).toBe(true);
    expect(uninstallPlugin("fixture-server", false)).toEqual({ ok: true });
    expect(existsSync(pluginDataDir("fixture-server"))).toBe(false);
    expect(uninstallPlugin("fixture-server", true)).toMatchObject({ ok: false });
  });

  test("a free plugin may be unsigned; when it IS signed the signature must still verify", async () => {
    expect(await installPluginBytes(buildServerFixture(null, { tier: "free" }), "fixture-server", deps())).toMatchObject({ ok: true, signed: false });
    expect(await installPluginBytes(buildServerFixture(testKey("stranger"), { tier: "free" }), "fixture-server", deps())).toMatchObject({ ok: false, gate: "signature" });
  });
});
