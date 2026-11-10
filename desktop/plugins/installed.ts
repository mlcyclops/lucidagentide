// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/plugins/installed.ts - where installed plugins live and how to read one, with nothing heavier
// than node:fs and the manifest schema. Split out of install.ts (ADR-0535) so the `lucid` launcher's
// `lucid herd` can ask "is the Herd add-on installed, and where?" without loading the install gates
// (the scanner, kb_store's DuckDB natives), which `bun build --compile` of the launcher cannot bundle.
// The gated install itself stays in install.ts.

import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PLUGIN_MANIFEST, validatePluginManifest, type PluginManifest } from "../../harness/plugins/package.ts";

export const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const dataRoot = (): string => process.env.LUCID_DATA_ROOT || join(homedir(), ".omp");
/** userData/plugins (LUCID_PLUGINS_DIR overrides, for tests and isolated smoke runs). */
export function pluginsRoot(): string { return process.env.LUCID_PLUGINS_DIR || join(dataRoot(), "plugins"); }
/** userData/plugin-data/<id>: the plugin's writable state, never removed by an update. */
export function pluginDataDir(id: string): string { return join(process.env.LUCID_PLUGIN_DATA_DIR || join(dataRoot(), "plugin-data"), id); }

/** Where an install came from: the store's signed download, or a file the user picked (ADR-0505). */
export type PluginSource = "catalog" | "private";

export interface InstalledPlugin {
  manifest: PluginManifest;
  /** The installed package folder (read-only to the plugin: LUCID_PLUGIN_ROOT). */
  dir: string;
  installedAt: string;
  signed: boolean;
  keyId?: string;
  source: PluginSource;
}

/** userData/plugins/<id>/current.json, the atomic version pointer install.ts writes. */
export interface CurrentPointer { id: string; version: string; installedAt: string; signed: boolean; keyId?: string; source?: PluginSource }

/** The installed, current version of `id`, or null when absent or unreadable. Re-validates the manifest. */
export function readInstalled(id: string, root = pluginsRoot()): InstalledPlugin | null {
  if (!PLUGIN_ID_RE.test(id)) return null;
  let ptr: CurrentPointer;
  try { ptr = JSON.parse(readFileSync(join(root, id, "current.json"), "utf8")) as CurrentPointer; } catch { return null; }
  if (!ptr || ptr.id !== id || typeof ptr.version !== "string") return null;
  const dir = join(root, id, ptr.version);
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(join(dir, PLUGIN_MANIFEST), "utf8")); } catch { return null; }
  const v = validatePluginManifest(raw, { requireFiles: true });
  if (!v.ok || v.manifest.id !== id || v.manifest.version !== ptr.version) return null;
  // A pointer written before ADR-0505 has no source: the store download was then the only install path.
  return { manifest: v.manifest, dir, installedAt: String(ptr.installedAt ?? ""), signed: !!ptr.signed, keyId: ptr.keyId, source: ptr.source === "private" ? "private" : "catalog" };
}

export function listInstalled(root = pluginsRoot()): InstalledPlugin[] {
  let names: string[];
  try { names = readdirSync(root); } catch { return []; }
  return names.sort().map((n) => readInstalled(n, root)).filter((p): p is InstalledPlugin => !!p);
}
