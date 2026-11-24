// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/plugins/ledger.ts - P-WORLDS.HEAL1: the durable record of what the user bought and installed.
//
// One record per STORE install (source catalog, installPluginFromUrl) and per signed world import
// (installWorldBytes): id, kind, name, version, when, and the sha256 of the signed package as it arrived. Beside
// it, a backup copy of that signed package. Both live in the data root NEXT TO `plugins/`, never inside it, so a
// damaged or deleted plugins tree cannot take them along:
//   <dataRoot>/plugin-ledger.json                        the ledger (temp file + fsync + rename; the previous
//                                                        good copy is kept as plugin-ledger.prev.json)
//   <dataRoot>/plugin-backups/<id>-<version>.lplugin.zip the signed package (older versions pruned on update)
//   <dataRoot>/plugins-quarantine/                       damaged installs and refused backups, moved aside
// <dataRoot> is the parent of pluginsRoot() (so LUCID_PLUGINS_DIR, which tests and isolated smoke runs set,
// keeps all of it in the same scratch folder). A record goes ONLY on an explicit user uninstall
// (install.ts uninstallPlugin). A backup is a convenience, never trusted: a restore re-runs every install gate
// (restore.ts). A package over MAX_BACKUP_BYTES gets no backup (the reason is recorded); the store restores it.
// Pure node:fs, no install gates, so install.ts can record without an import cycle.

import { randomBytes } from "node:crypto";
import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { sha256Bytes } from "../../harness/kb/pack.ts";
import type { PluginKind, PluginManifest } from "../../harness/plugins/package.ts";
import { PLUGIN_ID_RE, pluginsRoot, worldPackageName } from "./installed.ts";

export const LEDGER_FILE = "plugin-ledger.json";
const LEDGER_PREV_FILE = "plugin-ledger.prev.json";
/** A package bigger than this keeps no local backup (disk use stays bounded); the store restores it instead. */
export const MAX_BACKUP_BYTES = 64 * 1024 * 1024;

/** The folder the ledger, the backups and the quarantine live in: the parent of the plugins folder. */
export function ledgerHome(root = pluginsRoot()): string { return dirname(root); }
export function ledgerPath(root = pluginsRoot()): string { return join(ledgerHome(root), LEDGER_FILE); }
export function backupsDir(root = pluginsRoot()): string { return join(ledgerHome(root), "plugin-backups"); }
export function quarantineDir(root = pluginsRoot()): string { return join(ledgerHome(root), "plugins-quarantine"); }

export interface LedgerEntry {
  id: string;
  kind: PluginKind;
  name: string;
  version: string;
  /** When this version was installed (kept across a restore of the same bytes). */
  installedAt: string;
  /** sha256 of the signed package as installed; null for an install adopted without its package. */
  sha256: string | null;
  /** The backup's file name under plugin-backups, or null when there is none. */
  backup: string | null;
  /** Why there is no backup (too big, not writable, adopted without its package, refused on restore). */
  backupSkipped?: string;
  /** The last time the engine reinstalled it from its backup. */
  restoredAt?: string;
  /** Why the last restore from the backup did not happen; cleared once the install is healthy again. */
  restoreProblem?: string;
}

export interface PluginLedger { schema: 1; entries: Record<string, LedgerEntry> }

const KINDS: Readonly<Record<PluginKind, true>> = { web: true, server: true, daemon: true, world: true };

function parseEntry(id: string, v: unknown): LedgerEntry | null {
  if (!PLUGIN_ID_RE.test(id) || !v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>; // a persisted blob: every field read below is type-checked
  if (r.id !== id || typeof r.kind !== "string" || !Object.hasOwn(KINDS, r.kind) || typeof r.version !== "string" || !r.version) return null;
  const str = (x: unknown): string | undefined => (typeof x === "string" && x ? x : undefined);
  const backup = str(r.backup);
  return {
    id, kind: r.kind as PluginKind, name: str(r.name) ?? id, version: r.version, installedAt: str(r.installedAt) ?? "",
    sha256: typeof r.sha256 === "string" && /^[0-9a-f]{64}$/.test(r.sha256) ? r.sha256 : null,
    // Only a plain file name in the backups folder: a path in a damaged ledger must never point elsewhere.
    backup: backup && /^[a-z0-9][a-z0-9-]{0,63}-[^/\\]{1,60}\.lplugin\.zip$/.test(backup) && !backup.includes("..") ? backup : null,
    ...(str(r.backupSkipped) ? { backupSkipped: str(r.backupSkipped) } : {}),
    ...(str(r.restoredAt) ? { restoredAt: str(r.restoredAt) } : {}),
    ...(str(r.restoreProblem) ? { restoreProblem: str(r.restoreProblem) } : {}),
  };
}

function parseLedger(text: string): PluginLedger | null {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return null; }
  if (!raw || typeof raw !== "object" || !("schema" in raw) || raw.schema !== 1 || !("entries" in raw)) return null;
  const entries = raw.entries;
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) return null;
  const out: PluginLedger = { schema: 1, entries: {} };
  for (const [id, v] of Object.entries(entries)) {
    const e = parseEntry(id, v);
    if (e) out.entries[id] = e;
  }
  return out;
}

/** The ledger. A missing one is empty; an unreadable one falls back to the previous good copy, else empty. */
export function readLedger(root = pluginsRoot()): PluginLedger {
  for (const name of [LEDGER_FILE, LEDGER_PREV_FILE]) {
    let text: string;
    try { text = readFileSync(join(ledgerHome(root), name), "utf8"); } catch { continue; }
    const l = parseLedger(text);
    if (l) return l;
  }
  return { schema: 1, entries: {} };
}

/** Write `bytes` to `file` so a reader sees the old file or the whole new one, never half: a temp file in the same
 *  folder, flushed to disk, then renamed over the target. */
export function writeFileAtomic(file: string, bytes: Buffer | string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(tmp, "w");
  try {
    const buf = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;
    let at = 0;
    while (at < buf.length) at += writeSync(fd, buf, at, buf.length - at);
    fsyncSync(fd);
  } catch (e) {
    closeSync(fd);
    rmSync(tmp, { force: true });
    throw e;
  }
  closeSync(fd);
  try { renameSync(tmp, file); } catch (e) { rmSync(tmp, { force: true }); throw e; }
}

export function writeLedger(l: PluginLedger, root = pluginsRoot()): void {
  const path = ledgerPath(root);
  // Keep the last good copy: readLedger falls back to it if the current one is ever damaged outside LUCID.
  if (existsSync(path)) try { copyFileSync(path, join(ledgerHome(root), LEDGER_PREV_FILE)); } catch { /* the atomic write below still holds */ }
  writeFileAtomic(path, JSON.stringify(l, null, 2) + "\n");
}

function rmQuiet(path: string): void { try { rmSync(path, { force: true }); } catch { /* a locked file goes on the next update */ } }

/** The manifest fields a record keeps. */
export type LedgerManifest = Pick<PluginManifest, "id" | "kind" | "name" | "version">;

export interface RecordOptions {
  /** Keep this install time (an install adopted from disk); default: now, unless the same bytes are re-recorded. */
  installedAt?: string;
  /** No package bytes to back up: why (recorded as backupSkipped). */
  noBackupReason?: string;
  now?: Date;
}

/** Record a store install or a world import (and its update): write the backup of the signed package (unless it is
 *  over MAX_BACKUP_BYTES or `bytes` is null), prune the previous version's backup, write the ledger. Returns the new
 *  record; throws only when the ledger itself cannot be written. */
export function recordInstall(m: LedgerManifest, bytes: Buffer | null, root = pluginsRoot(), opts: RecordOptions = {}): LedgerEntry {
  const ledger = readLedger(root);
  const prev = ledger.entries[m.id];
  const sha = bytes ? sha256Bytes(bytes) : null;
  const name = worldPackageName(m.id, m.version);
  let backup: string | null = null;
  let backupSkipped: string | undefined;
  if (!bytes) backupSkipped = opts.noBackupReason ?? "no package to back up";
  else if (bytes.length > MAX_BACKUP_BYTES) backupSkipped = `the package is ${bytes.length} bytes, over the ${MAX_BACKUP_BYTES}-byte backup limit; the LUCID store restores it`;
  else {
    try { writeFileAtomic(join(backupsDir(root), name), bytes); backup = name; }
    catch (e) { backupSkipped = `the backup could not be written: ${(e as Error).message}`; }
  }
  if (prev?.backup && prev.backup !== backup) rmQuiet(join(backupsDir(root), prev.backup));
  // Re-recording the same bytes (a restore from the backup) keeps the original install time.
  const keptAt = prev && prev.version === m.version && sha !== null && prev.sha256 === sha && prev.installedAt ? prev.installedAt : null;
  const entry: LedgerEntry = {
    id: m.id, kind: m.kind, name: m.name, version: m.version,
    installedAt: opts.installedAt ?? keptAt ?? (opts.now ?? new Date()).toISOString(),
    sha256: sha, backup, ...(backupSkipped ? { backupSkipped } : {}),
  };
  ledger.entries[m.id] = entry;
  writeLedger(ledger, root);
  return entry;
}

/** The restore bookkeeping fields; null clears one, absent leaves it. */
export interface LedgerPatch { backup?: string | null; backupSkipped?: string | null; restoredAt?: string | null; restoreProblem?: string | null }

/** Change the restore bookkeeping of one record. False when there is no such record. */
export function updateLedgerEntry(id: string, patch: LedgerPatch, root = pluginsRoot()): boolean {
  const ledger = readLedger(root);
  const cur = ledger.entries[id];
  if (!cur) return false;
  const next: LedgerEntry = { ...cur };
  if (patch.backup !== undefined) next.backup = patch.backup;
  for (const k of ["backupSkipped", "restoredAt", "restoreProblem"] as const) {
    const v = patch[k];
    if (v === null) delete next[k]; else if (v !== undefined) next[k] = v;
  }
  ledger.entries[id] = next;
  writeLedger(ledger, root);
  return true;
}

/** The user uninstalled `id`: drop its record and its backup. True when there was a record. Throws when the ledger
 *  cannot be written (the caller then keeps the package, so the next start never "restores" an uninstall). */
export function forgetInstall(id: string, root = pluginsRoot()): boolean {
  const ledger = readLedger(root);
  const cur = ledger.entries[id];
  if (!cur) return false;
  delete ledger.entries[id];
  writeLedger(ledger, root);
  if (cur.backup) rmQuiet(join(backupsDir(root), cur.backup));
  return true;
}
