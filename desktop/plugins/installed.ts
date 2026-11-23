// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/plugins/installed.ts - where installed plugins live and how to read one, with nothing heavier
// than node:fs and the manifest schema. Split out of install.ts (ADR-0541) so the `lucid` launcher's
// `lucid herd` can ask "is the Herd add-on installed, and where?" without loading the install gates
// (the scanner, kb_store's DuckDB natives), which `bun build --compile` of the launcher cannot bundle.
// The gated install itself stays in install.ts.

import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import { PLUGIN_MANIFEST, safeRelPath, validatePluginManifest, type PluginManifest } from "../../harness/plugins/package.ts";

export const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The LUCID data root (~/.omp; LUCID_DATA_ROOT overrides). */
export function dataRoot(): string { return process.env.LUCID_DATA_ROOT || join(homedir(), ".omp"); }
/** userData/plugins (LUCID_PLUGINS_DIR overrides, for tests and isolated smoke runs). */
export function pluginsRoot(): string { return process.env.LUCID_PLUGINS_DIR || join(dataRoot(), "plugins"); }
/** userData/plugin-data (LUCID_PLUGIN_DATA_DIR overrides): the plugins data root, one dir per plugin under it. */
export function pluginDataRoot(): string { return process.env.LUCID_PLUGIN_DATA_DIR || join(dataRoot(), "plugin-data"); }
/** userData/plugin-data/<id>: the plugin's writable state, never removed by an update. */
export function pluginDataDir(id: string): string { return join(pluginDataRoot(), id); }

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

// ── Lucid Agent Worlds (ADR-0648) ──────────────────────────────────────────────────────────────────

/** The file name of a world's kept original package (the signed bytes the user exports). */
export function worldPackageName(id: string, version: string): string { return `${id}-${version}.lplugin.zip`; }

/** userData/plugins/<id>/<id>-<version>.lplugin.zip: the original signed package, kept OUTSIDE the version dir
 *  so the installed payload still matches its signed `files` list. */
export function worldPackagePath(id: string, version: string, root = pluginsRoot()): string { return join(root, id, worldPackageName(id, version)); }

/** What GET /api/worlds lists per world; the same shape as desktop/renderer/viz_world_api.ts InstalledWorld. */
export interface InstalledWorldView { id: string; version: string; name: string; module: string; apiVersion: number; installedAt: string }

/** The installed world packages (kind "world"), with the same-origin module URL the engine serves. */
export function listInstalledWorlds(root = pluginsRoot()): InstalledWorldView[] {
  return listInstalled(root).filter((p) => p.manifest.kind === "world").map((p) => {
    const m = p.manifest;
    const entry = m.entry as { module: string };
    return { id: m.id, version: m.version, name: m.name, module: `/worlds/${m.id}/${m.version}/${entry.module}`, apiVersion: Number(m.apiVersion), installedAt: p.installedAt };
  });
}

/** The only file types a world serves, and how. Anything else (LICENSE, signature, the manifest) is not served. */
const WORLD_CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".png": "image/png", ".webp": "image/webp",
  ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".ktx2": "application/octet-stream",
};

/** Map a `/worlds/<id>/<version>/<path>` request path to an installed world's file, or null (404). Only kind world,
 *  only the CURRENT version, only a safe relative path (no `..`, no absolute or drive form, no backslash) that the
 *  signed manifest `files` lists, and only the served content types. */
export function resolveWorldAsset(pathname: string, root = pluginsRoot()): { file: string; contentType: string } | null {
  const m = /^\/worlds\/([a-z0-9][a-z0-9-]{0,63})\/([^/]{1,60})\/(.{1,400})$/.exec(pathname);
  if (!m) return null;
  let rel: string;
  try { rel = decodeURIComponent(m[3]!); } catch { return null; }
  if (!safeRelPath(rel)) return null;
  const contentType = WORLD_CONTENT_TYPES[extname(rel).toLowerCase()];
  if (!contentType) return null;
  const p = readInstalled(m[1]!, root);
  if (!p || p.manifest.kind !== "world" || p.manifest.version !== m[2] || !p.manifest.files || !Object.hasOwn(p.manifest.files, rel)) return null;
  return { file: join(p.dir, rel), contentType };
}
