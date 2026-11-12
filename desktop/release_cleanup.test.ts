// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// ADR-0542: the first start of a release after a dev build removes the development modules (data kept), once.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLEAN, buildServerFixture, testKey } from "./plugins/fixtures.ts";
import { installPluginBytes, listInstalled, pluginDataDir, type InstalledPlugin } from "./plugins/install.ts";
import {
  MARKER_FILE, acknowledgeReleaseCleanup, developmentModules, isDevVersion, pendingReleaseCleanup, releaseCleanupDue, runReleaseCleanup,
} from "./release_cleanup.ts";

const KEY = testKey();
const ENV_KEYS = ["LUCID_PLUGINS_DIR", "LUCID_PLUGIN_DATA_DIR", "LUCID_PLUGIN_LOG_PATH"] as const;
let saved: Record<string, string | undefined> = {};
let work = "";
const deps = { trusted: KEY.trusted, decide: async () => CLEAN, record: () => {}, managedEgress: {} };
const AT = new Date("2026-11-10T12:00:00.000Z");

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  work = mkdtempSync(join(tmpdir(), "release-cleanup-"));
  process.env.LUCID_PLUGINS_DIR = join(work, "plugins");
  process.env.LUCID_PLUGIN_DATA_DIR = join(work, "plugin-data");
  process.env.LUCID_PLUGIN_LOG_PATH = join(work, "lucid-plugins.jsonl");
});
afterEach(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(work, { recursive: true, force: true });
});

const marker = (version: string): void => writeFileSync(join(work, MARKER_FILE), JSON.stringify({ version }));
const markerVersion = (): unknown => JSON.parse(readFileSync(join(work, MARKER_FILE), "utf8")).version;

describe("version classification", () => {
  test("a prerelease tag starting with dev is a dev build; a release, a beta and garbage are not", () => {
    expect(isDevVersion("2.6.0-dev.3")).toBe(true);
    expect(isDevVersion("2.6.0-dev")).toBe(true);
    expect(isDevVersion("2.6.0")).toBe(false);
    expect(isDevVersion("2.6.0-beta.1")).toBe(false);
    expect(isDevVersion("2.6.0-rc.dev")).toBe(false);
    expect(isDevVersion("dev")).toBe(false);
    expect(isDevVersion("")).toBe(false);
    expect(isDevVersion("v2.6.0-dev.3")).toBe(false);
  });

  test("due only on a move from a dev build to a release", () => {
    expect(releaseCleanupDue("2.6.0-dev.3", "2.6.0")).toBe(true);
    expect(releaseCleanupDue("2.6.0-dev.3", "2.6.0-beta.1")).toBe(true);
    expect(releaseCleanupDue("2.5.2", "2.6.0")).toBe(false);
    expect(releaseCleanupDue("2.6.0-dev.2", "2.6.0-dev.3")).toBe(false);
    expect(releaseCleanupDue("2.6.0", "2.7.0-dev.1")).toBe(false);
    expect(releaseCleanupDue(null, "2.6.0")).toBe(false);
    expect(releaseCleanupDue("2.6.0-dev.3", "garbage")).toBe(false);
  });
});

describe("development modules", () => {
  test("only an unsigned install from a file counts; store installs and signed packages stay", () => {
    const row = (id: string, source: InstalledPlugin["source"], signed: boolean): InstalledPlugin => ({
      manifest: { id } as InstalledPlugin["manifest"], dir: "", installedAt: "", signed, source,
    });
    const picked = developmentModules([row("a", "private", false), row("b", "private", true), row("c", "catalog", true), row("d", "catalog", false)]);
    expect(picked.map((p) => p.manifest.id)).toEqual(["a"]);
  });
});

describe("runReleaseCleanup", () => {
  async function installThree(): Promise<void> {
    expect((await installPluginBytes(buildServerFixture(null, { tier: "free", id: "dev-mod", name: "Dev Mod" }), "dev-mod", { ...deps, source: "private" })).ok).toBe(true);
    expect((await installPluginBytes(buildServerFixture(KEY, { tier: "free", id: "signed-mod" }), "signed-mod", { ...deps, source: "private" })).ok).toBe(true);
    expect((await installPluginBytes(buildServerFixture(KEY), "fixture-server", deps)).ok).toBe(true);
    mkdirSync(pluginDataDir("dev-mod"), { recursive: true });
  }

  test("no marker: writes it and removes nothing", async () => {
    await installThree();
    expect(runReleaseCleanup("2.6.0", { dir: work, env: {} })).toBeNull();
    expect(markerVersion()).toBe("2.6.0");
    expect(listInstalled().map((p) => p.manifest.id)).toContain("dev-mod");
  }, 60_000);

  test("release to release and dev to dev remove nothing but move the marker", async () => {
    await installThree();
    marker("2.5.2");
    expect(runReleaseCleanup("2.6.0", { dir: work, env: {} })).toBeNull();
    marker("2.6.0-dev.2");
    expect(runReleaseCleanup("2.6.0-dev.3", { dir: work, env: {} })).toBeNull();
    expect(markerVersion()).toBe("2.6.0-dev.3");
    expect(listInstalled()).toHaveLength(3);
    expect(pendingReleaseCleanup(work)).toBeNull();
  }, 60_000);

  test("dev to release removes only the development module, keeps its data, logs it, and reports once until acknowledged", async () => {
    await installThree();
    writeFileSync(join(pluginDataDir("dev-mod"), "keys.json"), "{\"k\":1}");
    marker("2.6.0-dev.3");
    const r = runReleaseCleanup("2.6.0", { dir: work, env: { LUCID_LICENSE_DEV: "1" }, now: () => AT });
    expect(r).toEqual({ from: "2.6.0-dev.3", to: "2.6.0", at: AT.toISOString(), removed: [{ id: "dev-mod", name: "Dev Mod", version: "0.1.0" }], envIgnored: ["LUCID_LICENSE_DEV"] });
    expect(listInstalled().map((p) => p.manifest.id).sort()).toEqual(["fixture-server", "signed-mod"]);
    expect(readFileSync(join(pluginDataDir("dev-mod"), "keys.json"), "utf8")).toBe("{\"k\":1}");
    const log = readFileSync(join(work, "lucid-plugins.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(log.some((e) => e.kind === "release-cleanup" && e.id === "dev-mod" && e.ok === true)).toBe(true);
    expect(markerVersion()).toBe("2.6.0");

    // Once per move: the next start of the same release does nothing, and a reinstall stays.
    expect(await installPluginBytes(buildServerFixture(null, { tier: "free", id: "dev-mod", name: "Dev Mod" }), "dev-mod", { ...deps, source: "private" })).toMatchObject({ ok: true });
    expect(runReleaseCleanup("2.6.0", { dir: work, env: {} })).toBeNull();
    expect(listInstalled().map((p) => p.manifest.id)).toContain("dev-mod");

    expect(pendingReleaseCleanup(work)?.removed).toHaveLength(1);
    expect(acknowledgeReleaseCleanup(work, AT)).toBe(true);
    expect(pendingReleaseCleanup(work)).toBeNull();
  }, 60_000);

  test("a removal that fails is tried again at the next start; the move ends when nothing is left", async () => {
    await installThree();
    marker("2.6.0-dev.3");
    const locked = () => ({ ok: false as const, error: "EBUSY: the package is in use" });
    expect(runReleaseCleanup("2.6.0", { dir: work, env: {}, uninstall: locked })?.removed).toEqual([]);
    expect(markerVersion()).toBe("2.6.0-dev.3"); // the move is still due
    expect(listInstalled().map((p) => p.manifest.id)).toContain("dev-mod");
    expect(pendingReleaseCleanup(work)).toBeNull(); // nothing was removed, so there is nothing to announce

    const r = runReleaseCleanup("2.6.0", { dir: work, env: {}, now: () => AT });
    expect(r?.removed).toEqual([{ id: "dev-mod", name: "Dev Mod", version: "0.1.0" }]);
    expect(listInstalled().map((p) => p.manifest.id).sort()).toEqual(["fixture-server", "signed-mod"]);
    expect(markerVersion()).toBe("2.6.0");
    expect(pendingReleaseCleanup(work)?.removed).toHaveLength(1);
    expect(runReleaseCleanup("2.6.0", { dir: work, env: {} })).toBeNull(); // finished: once per move
  }, 60_000);

  test("a release start with nothing to remove leaves no notice", () => {
    marker("2.6.0-dev.3");
    expect(runReleaseCleanup("2.6.0", { dir: work, env: {} })?.removed).toEqual([]);
    expect(pendingReleaseCleanup(work)).toBeNull();
    expect(existsSync(join(work, MARKER_FILE))).toBe(true);
  });
});
