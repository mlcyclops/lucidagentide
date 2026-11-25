// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/plugins/restore.ts - P-WORLDS.HEAL1: notice purchased plugins and worlds that went missing or got damaged,
// and put them back from their backup through the FULL install gate.
//
// checkInstalledHealth compares the install ledger (ledger.ts) with the disk. Per recorded id: ok; missing (no package
// folder, or no current.json); broken (readInstalled cannot read it back, or a payload file fails its signed sha256,
// the runtime's installedFilesProblem).
//
// restoreFromBackup puts one back: the backup must hash to the sha256 recorded at install, then the damaged folder is
// moved aside to <dataRoot>/plugins-quarantine/<id>-<stamp> (never deleted), then the bytes go through the same gate
// as a fresh install (a world through installWorldBytes with its id pinned, anything else through installPluginBytes
// with its id pinned and the catalog source): zip, manifest, hashes, signature, authenticode, scan. Nothing is
// trusted for having been on this disk. A backup that fails the recorded sha256 or an integrity gate is moved to the
// quarantine too and never installed; the item is then "needs-store" with the reason recorded, and the renderer
// reinstalls it from the store when the account is still entitled. A transient refusal (a dead scanner, a disk
// error) keeps the backup for the next try.
//
// createPluginHealer is the engine's one instance: startup() adopts installs that predate the ledger, then heals
// every recorded item (dev.ts runs it detached after listen; it never throws and logs one line per item); health()
// and restore() back GET /api/plugins/health and POST /api/plugins/restore. Every pass is serialized, so a restore
// request never races the startup pass, and a second pass over healthy installs changes nothing.

import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { sha256Bytes } from "../../harness/kb/pack.ts";
import type { PluginGate, PluginKind } from "../../harness/plugins/package.ts";
import { installPluginBytes, installWorldBytes, logPluginAttempt, verifyPackageBytes, type InstallDeps } from "./install.ts";
import { listInstalled, pluginsRoot, readInstalled, worldPackagePath } from "./installed.ts";
import { backupsDir, quarantineDir, readLedger, recordInstall, updateLedgerEntry, type LedgerEntry, type LedgerPatch } from "./ledger.ts";
import { installedFilesProblem } from "./runtime.ts";

export type HealthStatus = "ok" | "missing" | "broken";

/** One recorded purchase as GET /api/plugins/health reports it (desktop/renderer/bridge.ts PluginHealthItem). */
export interface HealthItem {
  id: string;
  name: string;
  kind: PluginKind;
  version: string;
  status: HealthStatus;
  /** What is wrong on disk (missing and broken only). */
  problem?: string;
  /** A backup the engine can restore from is present. */
  backup: boolean;
  /** Why the last restore from the backup did not happen (the item then needs the store). */
  restoreProblem?: string;
}

export interface HealthReport { items: HealthItem[]; needsRestore: string[] }

/** Where a recorded item stands on disk. */
export function classifyEntry(e: Pick<LedgerEntry, "id">, root = pluginsRoot()): { status: "ok" } | { status: Exclude<HealthStatus, "ok">; problem: string } {
  const dir = join(root, e.id);
  if (!existsSync(join(dir, "current.json"))) {
    return { status: "missing", problem: existsSync(dir) ? "the package folder has no version pointer (current.json)" : "the package folder is gone" };
  }
  const p = readInstalled(e.id, root);
  if (!p) return { status: "broken", problem: "the installed package does not read back: its current.json or manifest is damaged, or its version folder is gone" };
  const bad = installedFilesProblem(p);
  return bad ? { status: "broken", problem: bad } : { status: "ok" };
}

/** Every recorded purchase against the disk, and the ids that need restoring. Reads only. */
export function checkInstalledHealth(root = pluginsRoot()): HealthReport {
  const items = Object.values(readLedger(root).entries).sort((a, b) => a.id.localeCompare(b.id)).map((e): HealthItem => {
    const c = classifyEntry(e, root);
    return {
      id: e.id, name: e.name, kind: e.kind, version: e.version, status: c.status, backup: !!e.backup && existsSync(join(backupsDir(root), e.backup)),
      ...(c.status === "ok" ? {} : { problem: c.problem, ...(e.restoreProblem ? { restoreProblem: e.restoreProblem } : {}) }),
    };
  });
  return { items, needsRestore: items.filter((i) => i.status !== "ok").map((i) => i.id) };
}

export type RestoreOutcome =
  | { id: string; status: "ok" }
  | { id: string; status: "restored"; name: string; kind: PluginKind; version: string; was: Exclude<HealthStatus, "ok"> }
  | { id: string; status: "needs-store"; name: string; kind: PluginKind; reason: string }
  | { id: string; status: "unknown"; reason: string };

/** A refusal that says the bytes are bad (quarantine them), not that this attempt could not run (keep them). */
export function isIntegrityRefusal(gate: PluginGate, reason: string): boolean {
  if (gate === "scan") return !reason.startsWith("scanner unavailable");
  if (gate === "manifest") return !/^(could not unpack|install failed)/.test(reason);
  return gate === "hash" || gate === "signature" || gate === "authenticode";
}

/** Move `src` into the quarantine as `<label>-<stamp><ext>` (a counter when that name is taken). Returns the new path. */
function quarantine(src: string, label: string, root: string, now: Date, ext = ""): string {
  const dir = quarantineDir(root);
  mkdirSync(dir, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  let dest = join(dir, `${label}-${stamp}${ext}`);
  for (let n = 2; existsSync(dest); n++) dest = join(dir, `${label}-${stamp}-${n}${ext}`);
  renameSync(src, dest);
  return dest;
}

export interface RestoreDeps extends InstallDeps { now?: () => Date }

/** Put one recorded item back from its backup if it is missing or broken (nothing happens when it is healthy). */
export async function restoreFromBackup(id: string, deps: RestoreDeps = {}): Promise<RestoreOutcome> {
  const root = deps.root ?? pluginsRoot();
  const now = deps.now ?? (() => new Date());
  const e = readLedger(root).entries[id];
  if (!e) return { id, status: "unknown", reason: "LUCID has no record of installing it" };
  const c = classifyEntry(e, root);
  if (c.status === "ok") {
    if (e.restoreProblem) try { updateLedgerEntry(id, { restoreProblem: null }, root); } catch { /* cleared on the next pass */ }
    return { id, status: "ok" };
  }
  const was = c.status;
  const needsStore = (reason: string, patch: LedgerPatch = {}): RestoreOutcome => {
    try { updateLedgerEntry(id, { ...patch, restoreProblem: reason }, root); } catch { /* reported below all the same */ }
    logPluginAttempt({ action: "restore", id, version: e.version, ok: false, was, reason });
    return { id, status: "needs-store", name: e.name, kind: e.kind, reason };
  };
  const backupName = e.backup;
  if (!backupName) return needsStore(e.backupSkipped ? `no backup was kept: ${e.backupSkipped}` : "no backup was kept");
  const backupFile = join(backupsDir(root), backupName);
  let bytes: Buffer;
  try { bytes = readFileSync(backupFile); } catch { return needsStore("the backup is gone", { backup: null, backupSkipped: "the backup is gone" }); }
  const refuseBackup = (reason: string): RestoreOutcome => {
    let where = "";
    try { where = quarantine(backupFile, `${id}-backup`, root, now(), ".lplugin.zip"); } catch { /* left in place; never installed */ }
    return needsStore(reason, { backup: null, backupSkipped: where ? `refused and moved to ${where}` : "refused" });
  };
  if (!e.sha256 || sha256Bytes(bytes) !== e.sha256) return refuseBackup("the backup does not match the package recorded at install");

  // The damaged copy goes aside (stopped first: a running daemon's files cannot move on Windows), never deleted.
  const dir = join(root, id);
  if (existsSync(dir)) {
    try {
      await deps.beforeSwitch?.(id);
      quarantine(dir, id, root, now());
    } catch (err) {
      return needsStore(`the damaged copy could not be moved aside: ${(err as Error).message}`);
    }
  }
  const r = e.kind === "world"
    ? await installWorldBytes(bytes, backupName, deps, id)
    : await installPluginBytes(bytes, id, { ...deps, source: "catalog" });
  if (!r.ok) {
    const reason = `the backup was refused at the ${r.gate} gate: ${r.reason}`;
    return isIntegrityRefusal(r.gate, r.reason) ? refuseBackup(reason) : needsStore(reason);
  }
  try { updateLedgerEntry(id, { restoredAt: now().toISOString(), restoreProblem: null }, root); } catch { /* restored all the same */ }
  logPluginAttempt({ action: "restore", id, version: e.version, ok: true, was, from: "backup" });
  return { id, status: "restored", name: e.name, kind: e.kind, version: e.version, was };
}

/** Record catalog installs that predate the ledger (installed before this build). A world's kept package becomes its
 *  backup when it passes the disk-free gates; any other store plugin is recorded without one (the store restores
 *  it). Only healthy installs are adopted. Returns the adopted ids. */
export function adoptInstalled(deps: InstallDeps = {}): string[] {
  const root = deps.root ?? pluginsRoot();
  const known = readLedger(root).entries;
  const adopted: string[] = [];
  for (const p of listInstalled(root)) {
    const m = p.manifest;
    if (p.source !== "catalog" || known[m.id] || installedFilesProblem(p)) continue;
    let bytes: Buffer | null = null;
    let why = "installed before LUCID kept backups; the LUCID store restores it";
    if (m.kind === "world") {
      try {
        const kept = readFileSync(worldPackagePath(m.id, m.version, root));
        const v = verifyPackageBytes(kept, m.id, deps);
        if (v.ok && v.check.manifest.version === m.version) bytes = kept;
        else why = `its kept package did not verify${v.ok ? " (another version)" : `: ${v.reason}`}`;
      } catch { why = "its kept package is gone"; }
    }
    recordInstall(m, bytes, root, { installedAt: p.installedAt || undefined, noBackupReason: why });
    adopted.push(m.id);
  }
  return adopted;
}

/** One reinstall from a backup, for the renderer's "Repaired" notice. */
export interface RepairRecord { id: string; name: string; kind: PluginKind; version: string; at: string }

export interface HealReport { adopted: string[]; outcomes: RestoreOutcome[] }

/** Adopt, then restore every recorded item that is missing or broken. Never throws; one log line per item. */
export async function selfHeal(deps: RestoreDeps = {}, log: (line: string) => void = console.log): Promise<HealReport> {
  let adopted: string[] = [];
  try { adopted = adoptInstalled(deps); } catch (e) { log(`[plugins] adopting existing installs failed: ${(e as Error).message}`); }
  for (const id of adopted) log(`[plugins] ${id}: recorded in the install ledger`);
  const outcomes: RestoreOutcome[] = [];
  let ids: string[] = [];
  try { ids = Object.keys(readLedger(deps.root ?? pluginsRoot()).entries).sort(); } catch (e) { log(`[plugins] the install ledger could not be read: ${(e as Error).message}`); }
  for (const id of ids) {
    let o: RestoreOutcome;
    try { o = await restoreFromBackup(id, deps); }
    catch (e) { o = { id, status: "unknown", reason: `the restore failed: ${(e as Error).message}` }; }
    outcomes.push(o);
    if (o.status === "restored") log(`[plugins] ${id}: was ${o.was}, restored ${o.version} from its backup`);
    else if (o.status === "needs-store") log(`[plugins] ${id}: needs the store: ${o.reason}`);
    else if (o.status === "unknown") log(`[plugins] ${id}: ${o.reason}`);
    await Bun.sleep(0); // let requests through between items: hashing an install is synchronous
  }
  return { adopted, outcomes };
}

/** What GET /api/plugins/health and POST /api/plugins/restore answer (bridge.ts PluginHealthView). */
export interface HealthView extends HealthReport {
  /** Every reinstall from a backup since the engine started, oldest first. */
  repairs: RepairRecord[];
}

export interface PluginHealer {
  /** The startup pass: adopt, then heal everything. Never throws. */
  startup(): Promise<HealReport>;
  /** The health report, after any pass in flight finishes. */
  health(): Promise<HealthView>;
  /** Heal one recorded id, or (no id) run a full pass; then the health report with this pass's outcomes. */
  restore(id?: string): Promise<HealthView & { outcomes: RestoreOutcome[] }>;
}

export function createPluginHealer(deps: RestoreDeps = {}, log: (line: string) => void = console.log): PluginHealer {
  const root = deps.root ?? pluginsRoot();
  const now = deps.now ?? (() => new Date());
  const repairs: RepairRecord[] = [];
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };
  const noteRepairs = (outcomes: readonly RestoreOutcome[]): void => {
    const at = now().toISOString();
    for (const o of outcomes) if (o.status === "restored") repairs.push({ id: o.id, name: o.name, kind: o.kind, version: o.version, at });
  };
  const view = (): HealthView => ({ ...checkInstalledHealth(root), repairs: [...repairs] });
  return {
    startup: () => serial(async () => {
      const r = await selfHeal(deps, log);
      noteRepairs(r.outcomes);
      return r;
    }).catch((e: unknown): HealReport => { log(`[plugins] self-heal failed: ${e instanceof Error ? e.message : String(e)}`); return { adopted: [], outcomes: [] }; }),
    health: async () => { await chain; return view(); },
    restore: (id) => serial(async () => {
      const outcomes = id ? [await restoreFromBackup(id, deps)] : (await selfHeal(deps, log)).outcomes;
      noteRepairs(outcomes);
      return { ...view(), outcomes };
    }),
  };
}
