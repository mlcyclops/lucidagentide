// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/release_cleanup.ts - ADR-0536: a release clears what a dev build left behind.
//
// The owner's rule: when a machine that ran a dev build of the IDE (a version like 2.6.0-dev.3) first runs a
// release (2.6.0), every development module is removed, and the developer may reinstall it afterwards. A
// development module is a plugin installed from a file (source "private") that the trusted publisher key did
// not sign. Store installs and signed packages stay. Removal keeps the plugin's data, so a reinstall picks up
// where it left off. A development change is a dev-only environment override (DEV_ONLY_ENV); a release
// ignores it, and the report names the ones still set so the user knows.
//
// `last-run-version.json` in the data root records the version that last ran. The check reads it, then the
// engine rewrites it on every start, so the cleanup runs once per dev-to-release move. No marker (a fresh
// machine, or an IDE from before this rule): write it, clean nothing.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataRoot, listInstalled, logPluginAttempt, uninstallPlugin, type InstalledPlugin } from "./plugins/install.ts";

/** Development environment overrides a plugin sees only under a dev build of the IDE. */
export const DEV_ONLY_ENV = ["LUCID_LICENSE_DEV", "LUCID_LICENSE_DEV_PUB"] as const;

export const MARKER_FILE = "last-run-version.json";
export const REPORT_FILE = "release-cleanup.json";

const VERSION_RE = /^\d+\.\d+\.\d+(?:-([0-9A-Za-z.-]+))?$/;

/** A dev build: a version whose prerelease tag starts with `dev` (2.6.0-dev.3). A release or a beta is not. */
export function isDevVersion(v: string): boolean {
  const m = VERSION_RE.exec(v);
  return !!m?.[1]?.startsWith("dev");
}

/** Due only when the version that last ran here was a dev build and the current one is a valid non-dev version. */
export function releaseCleanupDue(previous: string | null, current: string): boolean {
  return previous !== null && isDevVersion(previous) && VERSION_RE.test(current) && !isDevVersion(current);
}

/** The development modules among the installed plugins: from a file and not signed by the trusted publisher. */
export function developmentModules(installed: readonly InstalledPlugin[]): InstalledPlugin[] {
  return installed.filter((p) => p.source === "private" && !p.signed);
}

export interface ReleaseCleanupReport {
  from: string;
  to: string;
  at: string;
  removed: { id: string; name: string; version: string }[];
  envIgnored: string[];
  /** When the user saw the notice; absent until then. */
  ackedAt?: string;
}

export interface ReleaseCleanupDeps {
  /** Where the marker and the report live (default: the plugin data root). */
  dir?: string;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  installed?: () => InstalledPlugin[];
  uninstall?: (id: string, keepData: boolean) => { ok: true } | { ok: false; error: string };
  log?: (entry: Record<string, unknown>) => void;
}

function writePrivate(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

function readJson(path: string): unknown {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

function readMarker(dir: string): string | null {
  const m = readJson(join(dir, MARKER_FILE));
  return m && typeof m === "object" && "version" in m && typeof m.version === "string" ? m.version : null;
}

/** Run on every engine start, BEFORE any plugin starts. Returns the report when a cleanup ran, else null. */
export function runReleaseCleanup(current: string, deps: ReleaseCleanupDeps = {}): ReleaseCleanupReport | null {
  const dir = deps.dir ?? dataRoot();
  const previous = readMarker(dir);
  let report: ReleaseCleanupReport | null = null;
  if (previous !== null && releaseCleanupDue(previous, current)) {
    const env = deps.env ?? process.env;
    const uninstall = deps.uninstall ?? uninstallPlugin;
    const log = deps.log ?? logPluginAttempt;
    const removed: ReleaseCleanupReport["removed"] = [];
    for (const p of developmentModules((deps.installed ?? listInstalled)())) {
      const { id, name, version } = p.manifest;
      const r = uninstall(id, true);
      log({ action: "release-cleanup", kind: "release-cleanup", id, version, from: previous, to: current, keepData: true, ok: r.ok, ...(r.ok ? {} : { error: r.error }) });
      if (r.ok) removed.push({ id, name, version });
    }
    report = {
      from: previous, to: current, at: (deps.now?.() ?? new Date()).toISOString(), removed,
      envIgnored: DEV_ONLY_ENV.filter((k) => env[k] !== undefined),
    };
    writePrivate(join(dir, REPORT_FILE), report);
  }
  writePrivate(join(dir, MARKER_FILE), { version: current });
  return report;
}

/** The last report, when it has something to say and the user has not seen it yet. */
export function pendingReleaseCleanup(dir = dataRoot()): ReleaseCleanupReport | null {
  const r = readJson(join(dir, REPORT_FILE));
  if (!r || typeof r !== "object" || !("removed" in r) || !("envIgnored" in r) || !Array.isArray(r.removed) || !Array.isArray(r.envIgnored)) return null;
  if ("ackedAt" in r && r.ackedAt) return null;
  if (r.removed.length === 0 && r.envIgnored.length === 0) return null;
  return r as ReleaseCleanupReport;
}

/** Mark the last report seen. */
export function acknowledgeReleaseCleanup(dir = dataRoot(), now = new Date()): boolean {
  const path = join(dir, REPORT_FILE);
  if (!existsSync(path)) return false;
  const r = readJson(path);
  if (!r || typeof r !== "object") return false;
  writePrivate(path, { ...r, ackedAt: now.toISOString() });
  return true;
}
