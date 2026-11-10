// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-PLUGINS.2 (ADR-0462): the `.lplugin` install gates, pinned by behavior on packages built by the REAL
// packer (tools/build_plugin.ts) and then altered the way an attacker or a broken upload would alter them.
// Every refusal must name its gate and leave nothing installed; a good package installs, updates in place
// and uninstalls while the plugin's data directory survives.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Bytes } from "../../harness/kb/pack.ts";
import { zipEntries } from "../../harness/kb/zip.ts";
import { readAllZipEntries } from "../../harness/personal/unzip.ts";
import { signPluginManifest, type PluginManifest } from "../../harness/plugins/package.ts";
import { authenticodeVerdict } from "./authenticode.ts";
import { CLEAN, buildServerFixture, testKey } from "./fixtures.ts";
import {
  addonsDir, downloadUrlProblem, inspectPluginFile, installOfferedPlugin, installPluginBytes, installPluginFile, installPluginFromUrl,
  pluginLogPath, readOfferedAddons, readPluginLicense, uninstallPlugin, type InstallDeps,
} from "./install.ts";
import { listInstalled, pluginDataDir, readInstalled } from "./installed.ts";
import { PluginRuntime } from "./runtime.ts";

const KEY = testKey();
const ENV_KEYS = ["LUCID_PLUGINS_DIR", "LUCID_PLUGIN_DATA_DIR", "LUCID_PLUGIN_LOG_PATH", "LUCID_PLUGIN_DEV_LOOPBACK", "LUCID_ADDONS_DIR"] as const;
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
    expect(p.source).toBe("catalog");
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

  test("a pointer written before ADR-0505 (no source) reads as a store install", async () => {
    expect((await installPluginBytes(buildServerFixture(KEY), "fixture-server", deps())).ok).toBe(true);
    const ptrPath = join(process.env.LUCID_PLUGINS_DIR!, "fixture-server", "current.json");
    const ptr: Record<string, unknown> = JSON.parse(readFileSync(ptrPath, "utf8"));
    expect(ptr.source).toBe("catalog");
    delete ptr.source;
    writeFileSync(ptrPath, JSON.stringify(ptr));
    expect(readInstalled("fixture-server")?.source).toBe("catalog");
  });
});

// P-PLUGINS.7 (ADR-0505): a private install from a file the user picked. Same gates and runtime as a store
// install; only the explicit two-step path installs it, the reviewed bytes are pinned by sha256, an unsigned
// package needs the unsigned acceptance, and the store's Premium/Free and Civilian/Government rules hold.
describe("private install from a file", () => {
  const onDisk = (zip: Buffer, name = "fixture-server-0.1.0.lplugin.zip"): string => { const p = join(work, name); writeFileSync(p, zip); return p; };
  const inspected = (path: string) => {
    const v = inspectPluginFile(path, deps());
    if (!v.ok) throw new Error(`inspect refused at ${v.gate}: ${v.reason}`);
    return v;
  };

  test("an unsigned plugin installs only through the explicit path, shows as unsigned, opens through the runtime, and uninstalls", async () => {
    const zip = buildServerFixture(null, { tier: "free" });
    const path = onDisk(zip);

    const v = inspected(path);
    expect(v).toMatchObject({ id: "fixture-server", name: "Fixture Server", version: "0.1.0", kind: "server", signed: false, hasMcp: true, replaces: null, sha256: sha256Bytes(zip) });
    expect(v.permissions).toEqual(["network:loopback", "fs:plugin-data"]);
    expect(nothingInstalled()).toBe(true); // inspecting installs nothing

    expect(await installPluginFile(path, { sha256: v.sha256, acceptUnsigned: false }, deps())).toMatchObject({ ok: false, gate: "signature" });
    expect(await installPluginFile(path, { sha256: "", acceptUnsigned: true }, deps())).toMatchObject({ ok: false, gate: "private" });
    expect(nothingInstalled()).toBe(true);

    expect(await installPluginFile(path, { sha256: v.sha256, acceptUnsigned: true }, deps())).toMatchObject({ ok: true, id: "fixture-server", version: "0.1.0", signed: false });
    expect(readInstalled("fixture-server")).toMatchObject({ source: "private", signed: false });

    const rt = new PluginRuntime({ nodeExe: () => process.execPath, agentBin: () => "C:/lucid/omp.exe", onMcpChange: () => {} });
    try {
      expect(rt.list()).toMatchObject([{ id: "fixture-server", source: "private", signed: false, state: "installed" }]);
      const started = await rt.start("fixture-server");
      if (!started.ok) throw new Error(started.error);
      expect(new URL(started.url).hostname).toMatch(/^(localhost|127\.0\.0\.1)$/);
      const health = await (await fetch(`http://127.0.0.1:${new URL(started.url).port}/api/health`)).json() as Record<string, unknown>;
      expect(health).toMatchObject({ ok: true, id: "fixture-server", agent: "C:/lucid/omp.exe" });
      expect(await rt.stop("fixture-server")).toEqual({ ok: true });
    } finally { await rt.stopAll(); }

    expect(uninstallPlugin("fixture-server", true)).toEqual({ ok: true });
    expect(nothingInstalled()).toBe(true);
    const actions = readFileSync(pluginLogPath(), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { action: string; ok: boolean; gate?: string });
    expect(actions.filter((a) => a.action === "install-file" || a.action === "uninstall").map((a) => `${a.action}:${a.ok ? "ok" : a.gate}`)).toEqual(["install-file:signature", "install-file:private", "install-file:ok", "uninstall:ok"]);
  }, 60_000);

  test("a tampered package is refused at inspect and at install, and nothing installs", async () => {
    const tampered = rezip(buildServerFixture(null, { tier: "free" }), (es) => es.map((e) => e.name === "app/server.cjs" ? { ...e, data: Buffer.from(e.data.toString() + "\n// injected") } : e));
    const path = onDisk(tampered);
    expect(inspectPluginFile(path, deps())).toMatchObject({ ok: false, gate: "hash" });
    expect(await installPluginFile(path, { sha256: sha256Bytes(tampered), acceptUnsigned: true }, deps())).toMatchObject({ ok: false, gate: "hash" });
    // A signature that does not verify is refused, never shown as "unsigned".
    const stranger = onDisk(buildServerFixture(testKey("stranger"), { tier: "free" }), "stranger.lplugin.zip");
    expect(inspectPluginFile(stranger, deps())).toMatchObject({ ok: false, gate: "signature" });
    expect(nothingInstalled()).toBe(true);
  });

  test("the file the user reviewed is the file that installs", async () => {
    const path = onDisk(buildServerFixture(null, { tier: "free" }));
    const v = inspected(path);
    writeFileSync(path, buildServerFixture(null, { tier: "free", version: "0.2.0" }));
    const r = await installPluginFile(path, { sha256: v.sha256, acceptUnsigned: true }, deps());
    expect(r).toMatchObject({ ok: false, gate: "private" });
    expect(r.ok ? "" : r.reason).toContain("changed");
    expect(nothingInstalled()).toBe(true);
  });

  test("the store's rules hold: no premium, no Government, no on-sale store id, never over a store install", async () => {
    const premium = onDisk(buildServerFixture(KEY), "premium.lplugin.zip"); // signed by the trusted key, still premium
    expect(inspectPluginFile(premium, deps())).toMatchObject({ ok: false, gate: "private" });
    const gov = onDisk(buildServerFixture(null, { tier: "free", section: "government" }), "gov.lplugin.zip");
    expect(inspectPluginFile(gov, deps())).toMatchObject({ ok: false, gate: "private" });
    const onSale = onDisk(buildServerFixture(null, { tier: "free", id: "pathfinder" }), "pathfinder.lplugin.zip");
    expect(inspectPluginFile(onSale, deps())).toMatchObject({ ok: false, gate: "private" });
    // A coming-soon card's id is open to a private build until it goes on sale.
    expect(inspectPluginFile(onDisk(buildServerFixture(null, { tier: "free", id: "remote-spokes" }), "remote-spokes.lplugin.zip"), deps())).toMatchObject({ ok: true, id: "remote-spokes", signed: false });

    expect((await installPluginBytes(buildServerFixture(KEY), "fixture-server", deps())).ok).toBe(true); // a store install
    const over = onDisk(buildServerFixture(null, { tier: "free" }));
    const r = inspectPluginFile(over, deps());
    expect(r).toMatchObject({ ok: false, gate: "private" });
    expect(r.ok ? "" : r.reason).toContain("remove it");
    expect(readInstalled("fixture-server")).toMatchObject({ source: "catalog", signed: true });

    for (const bad of ["", "relative/p.lplugin.zip", join(work, "missing.lplugin.zip"), join(work, "notes.txt")]) {
      expect(inspectPluginFile(bad, deps())).toMatchObject({ ok: false, gate: "private" });
    }
  });

  test("a signed free plugin shows as signed; a newer file replaces the private copy and keeps its data", async () => {
    const first = onDisk(buildServerFixture(KEY, { tier: "free" }));
    const v = inspected(first);
    expect(v).toMatchObject({ signed: true, keyId: "test-publisher" });
    expect(await installPluginFile(first, { sha256: v.sha256, acceptUnsigned: false }, deps())).toMatchObject({ ok: true, signed: true });
    writeFileSync(join(pluginDataDir("fixture-server"), "state.json"), "{\"kept\":true}");

    const next = onDisk(buildServerFixture(KEY, { tier: "free", version: "0.2.0" }), "fixture-server-0.2.0.lplugin.zip");
    const v2 = inspected(next);
    expect(v2.replaces).toBe("0.1.0");
    expect(await installPluginFile(next, { sha256: v2.sha256, acceptUnsigned: false }, deps())).toMatchObject({ ok: true, version: "0.2.0" });
    expect(readInstalled("fixture-server")).toMatchObject({ source: "private", signed: true, manifest: { version: "0.2.0" } });
    expect(readFileSync(join(pluginDataDir("fixture-server"), "state.json"), "utf8")).toBe("{\"kept\":true}");
  });
});

// ADR-0541: an add-on the build OFFERS (desktop/addons, index.json). It installs only through install-offered,
// only for an id the index names, only the bytes its sha256 names, and only signed.
describe("offered add-ons", () => {
  const FILE = "fixture-server-0.1.0.lplugin.zip";
  /** Lay out `<work>/addons` the way tools/build_addons.ts does: the package beside its index. */
  const offer = (zip: Buffer, index: unknown = [{ id: "fixture-server", version: "0.1.0", file: FILE, sha256: sha256Bytes(zip) }]): string => {
    const dir = join(work, "addons");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, FILE), zip);
    writeFileSync(join(dir, "index.json"), JSON.stringify(index));
    return dir;
  };
  const offeredActions = (): string[] => readFileSync(pluginLogPath(), "utf8").trim().split("\n")
    .map((l) => JSON.parse(l) as { action: string; ok: boolean; gate?: string })
    .filter((a) => a.action === "install-offered").map((a) => (a.ok ? "ok" : a.gate ?? ""));

  test("a signed offered package installs as a private signed install", async () => {
    const dir = offer(buildServerFixture(KEY, { tier: "free" }));
    expect(readOfferedAddons(dir)).toEqual([{ id: "fixture-server", version: "0.1.0", file: FILE, sha256: expect.any(String) }]);
    expect(await installOfferedPlugin("fixture-server", dir, deps())).toMatchObject({ ok: true, id: "fixture-server", version: "0.1.0", signed: true });
    expect(readInstalled("fixture-server")).toMatchObject({ source: "private", signed: true });
    expect(offeredActions()).toEqual(["ok"]);
  });

  test("an id the index does not name is refused, even when a package for it sits in the folder", async () => {
    const dir = offer(buildServerFixture(KEY, { tier: "free" }), []);
    expect(readOfferedAddons(dir)).toEqual([]);
    const r = await installOfferedPlugin("fixture-server", dir, deps());
    expect(r).toMatchObject({ ok: false, gate: "private" });
    expect(r.ok ? "" : r.reason).toContain("not an add-on this build offers");
    expect(await installOfferedPlugin("herd", offer(buildServerFixture(KEY, { tier: "free" })), deps())).toMatchObject({ ok: false, gate: "private" });
    expect(nothingInstalled()).toBe(true);
  });

  test("a package that does not match the index sha256 is refused", async () => {
    const zip = buildServerFixture(KEY, { tier: "free" });
    const dir = offer(zip, [{ id: "fixture-server", version: "0.1.0", file: FILE, sha256: "0".repeat(64) }]);
    const r = await installOfferedPlugin("fixture-server", dir, deps());
    expect(r).toMatchObject({ ok: false, gate: "private" });
    expect(r.ok ? "" : r.reason).toContain("add-on index");
    expect(nothingInstalled()).toBe(true);
  });

  test("an unsigned offered package is refused, with no unsigned acceptance to give", async () => {
    const dir = offer(buildServerFixture(null, { tier: "free" }));
    expect(await installOfferedPlugin("fixture-server", dir, deps())).toMatchObject({ ok: false, gate: "signature" });
    expect(nothingInstalled()).toBe(true);
    expect(offeredActions()).toEqual(["signature"]);
  });

  test("a package whose id differs from its index row is refused", async () => {
    const zip = buildServerFixture(KEY, { tier: "free", id: "other-addon" });
    const dir = join(work, "addons");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "herd-0.1.0.lplugin.zip"), zip);
    writeFileSync(join(dir, "index.json"), JSON.stringify([{ id: "herd", version: "0.1.0", file: "herd-0.1.0.lplugin.zip", sha256: sha256Bytes(zip) }]));
    expect(await installOfferedPlugin("herd", dir, deps())).toMatchObject({ ok: false, gate: "manifest" });
    expect(listInstalled()).toEqual([]);
  });

  test("a missing or malformed index offers nothing; a row naming a path is dropped", () => {
    expect(readOfferedAddons(join(work, "no-such-addons"))).toEqual([]);
    const zip = buildServerFixture(KEY, { tier: "free" });
    expect(readOfferedAddons(offer(zip, { id: "fixture-server" }))).toEqual([]);
    const sha256 = sha256Bytes(zip);
    const rows = [
      { id: "fixture-server", version: "0.1.0", file: "../fixture-server-0.1.0.lplugin.zip", sha256 },
      { id: "fixture-server", version: "0.1.0", file: "sub/fixture-server-0.1.0.lplugin.zip", sha256 },
      { id: "Fixture", version: "0.1.0", file: "Fixture-0.1.0.lplugin.zip", sha256 },
      { id: "fixture-server", version: "0.1.0", file: FILE, sha256: "not-a-sha" },
    ];
    expect(readOfferedAddons(offer(zip, rows))).toEqual([]);
  });

  test("the add-ons folder sits beside the app resources unless LUCID_ADDONS_DIR overrides it", () => {
    delete process.env.LUCID_ADDONS_DIR;
    expect(addonsDir(join(work, "resources"))).toBe(join(work, "resources", "addons"));
    process.env.LUCID_ADDONS_DIR = join(work, "elsewhere");
    expect(addonsDir(join(work, "resources"))).toBe(join(work, "elsewhere"));
  });
});
