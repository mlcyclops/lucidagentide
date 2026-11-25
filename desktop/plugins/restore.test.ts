// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-WORLDS.HEAL1: the install ledger and the self-heal, pinned on packages built by the REAL packer. A store install
// and a world import are recorded with a backup outside the plugins folder; only the user's uninstall forgets them.
// A missing or damaged install is reported, then put back from its backup through EVERY install gate: a backup that
// does not match its record, or fails a gate, is quarantined and never installed. A second pass changes nothing.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Bytes } from "../../harness/kb/pack.ts";
import { zipEntries } from "../../harness/kb/zip.ts";
import { readAllZipEntries } from "../../harness/personal/unzip.ts";
import { buildPlugin } from "../../tools/build_plugin.ts";
import { CLEAN, buildServerFixture, testKey, writeStage } from "./fixtures.ts";
import { installPluginBytes, installPluginFromUrl, installWorldBytes, uninstallPlugin } from "./install.ts";
import { listInstalledWorlds, readInstalled } from "./installed.ts";
import { MAX_BACKUP_BYTES, backupsDir, ledgerPath, quarantineDir, readLedger, recordInstall, writeLedger } from "./ledger.ts";
import { checkInstalledHealth, createPluginHealer, isIntegrityRefusal, restoreFromBackup, selfHeal, type RestoreDeps } from "./restore.ts";

const KEY = testKey();
const ENV_KEYS = ["LUCID_PLUGINS_DIR", "LUCID_PLUGIN_DATA_DIR", "LUCID_PLUGIN_LOG_PATH"] as const;
const NOW = new Date("2026-11-23T10:00:00.000Z");
const STAMP = "2026-11-23T10-00-00-000Z";
let saved: Record<string, string | undefined> = {};
let work = "";
let plugins = "";

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  work = mkdtempSync(join(tmpdir(), "lplugin-restore-"));
  plugins = join(work, "plugins");
  process.env.LUCID_PLUGINS_DIR = plugins;
  process.env.LUCID_PLUGIN_DATA_DIR = join(work, "plugin-data");
  process.env.LUCID_PLUGIN_LOG_PATH = join(work, "lucid-plugins.jsonl");
});
afterEach(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(work, { recursive: true, force: true });
});

const deps = (over: Partial<RestoreDeps> = {}): RestoreDeps => ({ trusted: KEY.trusted, decide: async () => CLEAN, record: () => {}, managedEgress: {}, now: () => NOW, ...over });

const WORLD_JS = "export default (host) => ({ id: 'christmas', label: 'Christmas' });\n";
function buildWorld(over: Record<string, unknown> = {}): Buffer {
  const src = writeStage({ LICENSE: "LUCID Premium Plugin License (test fixture)\n", "world.js": WORLD_JS }, {
    schema: 1, id: "world-christmas", name: "Christmas", version: "1.0.0", publisher: "TECHLEAD 187 LLC",
    license: "LUCID-Premium-Plugin-1.0", tier: "premium", section: "civilian", kind: "world",
    entry: { module: "world.js" }, apiVersion: 1, ...over,
  });
  return readFileSync(buildPlugin({ src, out: mkdtempSync(join(work, "out-")), privateKey: KEY.privateKey }).zipPath);
}

function rezip(zip: Buffer, edit: (e: { name: string; data: Buffer }[]) => { name: string; data: Buffer }[]): Buffer {
  return zipEntries(edit(readAllZipEntries(zip, { maxTotalBytes: 1 << 30 })));
}

const worldDir = (): string => join(plugins, "world-christmas");
const backupFile = (): string => join(backupsDir(), "world-christmas-1.0.0.lplugin.zip");
const quarantined = (): string[] => (existsSync(quarantineDir()) ? readdirSync(quarantineDir()).sort() : []);
const status = (id: string) => checkInstalledHealth().items.find((i) => i.id === id);

async function importWorld(zip = buildWorld()): Promise<Buffer> {
  expect((await installWorldBytes(zip, "world-christmas-1.0.0.lplugin.zip", deps())).ok).toBe(true);
  return zip;
}

describe("the install ledger", () => {
  test("a world import is recorded with a byte-exact backup outside the plugins folder", async () => {
    const zip = await importWorld();
    expect(ledgerPath()).toBe(join(work, "plugin-ledger.json"));
    const e = readLedger().entries["world-christmas"];
    expect(e).toMatchObject({ id: "world-christmas", kind: "world", name: "Christmas", version: "1.0.0", sha256: sha256Bytes(zip), backup: "world-christmas-1.0.0.lplugin.zip" });
    expect(e?.installedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(Buffer.compare(readFileSync(backupFile()), zip)).toBe(0);
    // Written by temp file and rename: nothing half-written is left behind.
    expect(readdirSync(work).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    expect(readdirSync(backupsDir()).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  test("a store install and its update are recorded; the update prunes the old backup", async () => {
    let zip = buildServerFixture(KEY);
    const fetchImpl = (async () => new Response(zip)) as unknown as typeof fetch;
    expect(await installPluginFromUrl("https://cdn.example/fixture-server.lplugin.zip", "fixture-server", deps({ fetchImpl }))).toMatchObject({ ok: true });
    expect(readLedger().entries["fixture-server"]).toMatchObject({ kind: "server", version: "0.1.0", sha256: sha256Bytes(zip) });
    zip = buildServerFixture(KEY, { version: "0.2.0" });
    expect(await installPluginFromUrl("https://cdn.example/fixture-server.lplugin.zip", "fixture-server", deps({ fetchImpl }))).toMatchObject({ ok: true, version: "0.2.0" });
    expect(readLedger().entries["fixture-server"]).toMatchObject({ version: "0.2.0", sha256: sha256Bytes(zip), backup: "fixture-server-0.2.0.lplugin.zip" });
    expect(readdirSync(backupsDir())).toEqual(["fixture-server-0.2.0.lplugin.zip"]);
  });

  test("a private install is never recorded", async () => {
    expect((await installPluginBytes(buildServerFixture(KEY, { tier: "free" }), "fixture-server", deps({ source: "private" }))).ok).toBe(true);
    expect(readLedger().entries).toEqual({});
    expect(existsSync(backupsDir())).toBe(false);
  });

  test("only the user's uninstall removes the record and the backup; a recorded item already gone is just forgotten", async () => {
    await importWorld();
    expect(uninstallPlugin("world-christmas", false)).toEqual({ ok: true });
    expect(readLedger().entries).toEqual({});
    expect(existsSync(backupFile())).toBe(false);
    await importWorld();
    rmSync(worldDir(), { recursive: true, force: true });
    expect(uninstallPlugin("world-christmas", false)).toEqual({ ok: true });
    expect(readLedger().entries).toEqual({});
    expect(uninstallPlugin("world-christmas", false)).toMatchObject({ ok: false });
  });

  test("a damaged ledger falls back to the previous good copy", async () => {
    await importWorld();
    // A second write keeps the first as plugin-ledger.prev.json.
    writeLedger(readLedger());
    writeFileSync(ledgerPath(), "{ half-writ");
    expect(readLedger().entries["world-christmas"]?.version).toBe("1.0.0");
  });

  test("a package over the backup limit is recorded without a backup, with the reason", () => {
    const e = recordInstall({ id: "big-world", kind: "world", name: "Big", version: "1.0.0" }, Buffer.alloc(MAX_BACKUP_BYTES + 1));
    expect(e.backup).toBeNull();
    expect(e.backupSkipped).toContain("backup limit");
    expect(existsSync(join(backupsDir(), "big-world-1.0.0.lplugin.zip"))).toBe(false);
    expect(readLedger().entries["big-world"]?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("checkInstalledHealth", () => {
  test("ok, then missing, a corrupt current.json, a half-written folder and a tampered payload are each reported", async () => {
    await importWorld();
    expect(checkInstalledHealth()).toEqual({ items: [{ id: "world-christmas", name: "Christmas", kind: "world", version: "1.0.0", status: "ok", backup: true }], needsRestore: [] });

    writeFileSync(join(worldDir(), "current.json"), "{ not json");
    expect(status("world-christmas")).toMatchObject({ status: "broken", problem: expect.stringContaining("current.json") });
    expect(checkInstalledHealth().needsRestore).toEqual(["world-christmas"]);
    // The world vanished from the list the Visualize view reads: the health report is what still names it.
    expect(listInstalledWorlds()).toEqual([]);

    await importWorld();
    writeFileSync(join(worldDir(), "1.0.0", "world.js"), WORLD_JS + "// changed on disk\n");
    expect(status("world-christmas")).toMatchObject({ status: "broken", problem: expect.stringContaining("world.js") });

    await importWorld();
    rmSync(join(worldDir(), "current.json"));
    expect(status("world-christmas")).toMatchObject({ status: "missing", problem: expect.stringContaining("current.json") });

    rmSync(worldDir(), { recursive: true, force: true });
    expect(status("world-christmas")).toMatchObject({ status: "missing", problem: "the package folder is gone" });
  });
});

describe("restore from the backup", () => {
  test("a corrupt current.json is restored at the startup pass, the damaged folder kept in quarantine; a second pass changes nothing", async () => {
    await importWorld();
    writeFileSync(join(worldDir(), "current.json"), "{ not json");
    const lines: string[] = [];
    const first = await selfHeal(deps(), (l) => lines.push(l));
    expect(first.outcomes).toEqual([{ id: "world-christmas", status: "restored", name: "Christmas", kind: "world", version: "1.0.0", was: "broken" }]);
    expect(lines).toEqual(["[plugins] world-christmas: was broken, restored 1.0.0 from its backup"]);
    expect(listInstalledWorlds().map((w) => w.id)).toEqual(["world-christmas"]);
    expect(status("world-christmas")?.status).toBe("ok");
    expect(quarantined()).toEqual([`world-christmas-${STAMP}`]);
    expect(readFileSync(join(quarantineDir(), `world-christmas-${STAMP}`, "current.json"), "utf8")).toBe("{ not json");
    expect(readLedger().entries["world-christmas"]?.restoredAt).toBe(NOW.toISOString());

    const ledgerBefore = readFileSync(ledgerPath(), "utf8");
    const again: string[] = [];
    const second = await selfHeal(deps(), (l) => again.push(l));
    expect(second).toEqual({ adopted: [], outcomes: [{ id: "world-christmas", status: "ok" }] });
    expect(again).toEqual([]);
    expect(readFileSync(ledgerPath(), "utf8")).toBe(ledgerBefore);
    expect(quarantined()).toEqual([`world-christmas-${STAMP}`]);
  });

  test("a deleted package folder comes back; a store plugin comes back through the catalog gate", async () => {
    await importWorld();
    expect((await installPluginBytes(buildServerFixture(KEY), "fixture-server", deps())).ok).toBe(true);
    rmSync(worldDir(), { recursive: true, force: true });
    writeFileSync(join(plugins, "fixture-server", "0.1.0", "app", "server.cjs"), "// replaced\n");
    const stopped: string[] = [];
    const r = await selfHeal(deps({ beforeSwitch: async (id) => { stopped.push(id); } }), () => {});
    expect(r.outcomes.map((o) => [o.id, o.status])).toEqual([["fixture-server", "restored"], ["world-christmas", "restored"]]);
    expect(readInstalled("fixture-server")).toMatchObject({ source: "catalog", signed: true });
    expect(checkInstalledHealth().needsRestore).toEqual([]);
    // The running copy of the damaged plugin is stopped before its folder moves aside.
    expect(stopped).toContain("fixture-server");
  });

  test("a tampered backup is refused and quarantined, never installed", async () => {
    const zip = await importWorld();
    writeFileSync(backupFile(), rezip(zip, (es) => es.map((e) => e.name === "world.js" ? { ...e, data: Buffer.from(WORLD_JS + "fetch('https://evil.example');\n") } : e)));
    writeFileSync(join(worldDir(), "current.json"), "{ not json");
    const o = await restoreFromBackup("world-christmas", deps());
    expect(o).toMatchObject({ status: "needs-store", reason: "the backup does not match the package recorded at install" });
    expect(listInstalledWorlds()).toEqual([]);
    expect(existsSync(backupFile())).toBe(false);
    expect(quarantined()).toEqual([`world-christmas-backup-${STAMP}.lplugin.zip`]);
    expect(readLedger().entries["world-christmas"]).toMatchObject({ backup: null, restoreProblem: o.status === "needs-store" ? o.reason : "" });
    expect(status("world-christmas")).toMatchObject({ status: "broken", backup: false, restoreProblem: expect.stringContaining("does not match") });
  });

  test("a tampered backup whose recorded sha256 was forged to match still fails the hash gate and is quarantined", async () => {
    const zip = await importWorld();
    const evil = rezip(zip, (es) => es.map((e) => e.name === "world.js" ? { ...e, data: Buffer.from(WORLD_JS + "fetch('https://evil.example');\n") } : e));
    writeFileSync(backupFile(), evil);
    const l = readLedger();
    l.entries["world-christmas"]!.sha256 = sha256Bytes(evil);
    writeLedger(l);
    rmSync(worldDir(), { recursive: true, force: true });
    const o = await restoreFromBackup("world-christmas", deps());
    expect(o).toMatchObject({ status: "needs-store", reason: expect.stringContaining("hash gate") });
    expect(listInstalledWorlds()).toEqual([]);
    expect(existsSync(worldDir()) && readdirSync(worldDir()).some((n) => n === "current.json")).toBe(false);
    expect(quarantined()).toEqual([`world-christmas-backup-${STAMP}.lplugin.zip`]);
  });

  test("a dead scanner keeps the backup for the next try instead of quarantining it", async () => {
    await importWorld();
    rmSync(worldDir(), { recursive: true, force: true });
    const o = await restoreFromBackup("world-christmas", deps({ decide: async () => { throw new Error("sidecar down"); } }));
    expect(o).toMatchObject({ status: "needs-store", reason: expect.stringContaining("scanner unavailable") });
    expect(existsSync(backupFile())).toBe(true);
    expect(await restoreFromBackup("world-christmas", deps())).toMatchObject({ status: "restored", was: "missing" });
    expect(readLedger().entries["world-christmas"]?.restoreProblem).toBeUndefined();
  });

  test("an install from before the ledger is adopted (a world's kept package becomes its backup) and then restorable", async () => {
    await importWorld();
    rmSync(ledgerPath(), { force: true });
    rmSync(join(work, "plugin-ledger.prev.json"), { force: true });
    rmSync(backupsDir(), { recursive: true, force: true });
    const r = await selfHeal(deps(), () => {});
    expect(r.adopted).toEqual(["world-christmas"]);
    expect(existsSync(backupFile())).toBe(true);
    rmSync(join(worldDir(), "1.0.0"), { recursive: true, force: true });
    expect((await selfHeal(deps(), () => {})).outcomes).toEqual([expect.objectContaining({ id: "world-christmas", status: "restored", was: "broken" })]);
  });

  test("the healer serializes passes, reports repairs once each and answers health after a pass in flight", async () => {
    await importWorld();
    writeFileSync(join(worldDir(), "current.json"), "{ not json");
    const healer = createPluginHealer(deps(), () => {});
    const startup = healer.startup();
    const health = await healer.health();
    expect(health.needsRestore).toEqual([]);
    expect(health.repairs).toEqual([{ id: "world-christmas", name: "Christmas", kind: "world", version: "1.0.0", at: NOW.toISOString() }]);
    await startup;
    const again = await healer.restore("world-christmas");
    expect(again.outcomes).toEqual([{ id: "world-christmas", status: "ok" }]);
    expect(again.repairs).toHaveLength(1);
    expect((await healer.restore("not-recorded")).outcomes).toEqual([{ id: "not-recorded", status: "unknown", reason: "LUCID has no record of installing it" }]);
  });

  test("which refusals quarantine a backup", () => {
    expect(isIntegrityRefusal("hash", "x")).toBe(true);
    expect(isIntegrityRefusal("signature", "x")).toBe(true);
    expect(isIntegrityRefusal("scan", "world.js flagged: exfiltration")).toBe(true);
    expect(isIntegrityRefusal("scan", "scanner unavailable: down")).toBe(false);
    expect(isIntegrityRefusal("manifest", "install failed: EBUSY")).toBe(false);
    expect(isIntegrityRefusal("manifest", "not a valid .lplugin.zip: bad header")).toBe(true);
  });
});
