// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/synced_path.ts
//
// P-SECRET-INTAKE.1 (ADR-0476): is a path inside a folder a cloud client syncs (OneDrive, Dropbox,
// iCloud Drive, Google Drive, Box, ...) or a roaming profile? A secret written there, even for a second,
// can be uploaded, versioned and kept in a recycle bin LUCID cannot reach, so the notepad fallback refuses
// any such directory. The repo had no helper for this (the OneDrive notes elsewhere are about stalls, not
// confidentiality), so this is the one place that answers it.
//
// Two independent signals, either is enough:
//   1. The sync roots the OS and the clients announce: the OneDrive env vars on Windows, %APPDATA% (the
//      roaming profile, copied to the domain server at sign-out), and the conventional client folders
//      under the home directory (~/Dropbox, ~/iCloudDrive, ~/Library/Mobile Documents,
//      ~/Library/CloudStorage, ~/Google Drive, ~/Box).
//   2. A path SEGMENT named like a sync client's folder anywhere in the path ("OneDrive - Contoso",
//      "Dropbox (Team)", "iCloud Drive", "Google Drive", "My Drive", "Box Sync", ...), which catches
//      Known Folder Move, a relocated client folder and a network-mapped copy.
// Pure: the env, the home directory and the platform are parameters, so the tests pin every rule.

import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

export interface SyncedPathEnv {
  env?: Readonly<Record<string, string | undefined>>;
  home?: string;
  platform?: NodeJS.Platform;
}

/** Folder names sync clients create. Matched per path segment, case-insensitively. */
const SYNCED_SEGMENTS: readonly RegExp[] = [
  /^onedrive( - .+)?$/i,           // OneDrive, "OneDrive - Contoso" (business)
  /^dropbox( \(.+\))?$/i,          // Dropbox, "Dropbox (Team)"
  /^icloud ?drive$/i,              // Windows iCloud: iCloudDrive / "iCloud Drive"
  /^mobile documents$/i,           // macOS iCloud: ~/Library/Mobile Documents
  /^cloudstorage$/i,               // macOS File Provider root: ~/Library/CloudStorage/<client>
  /^google ?drive$/i,              // Google Drive for desktop
  /^my drive$/i,                   // Google Drive's mounted "My Drive"
  /^box( sync)?$/i,                // Box Drive, Box Sync
  /^pcloud ?drive$/i,
  /^sync\.com$/i,
  /^nextcloud$/i,
  /^owncloud$/i,
  /^mega$/i,
];

/** The sync roots this machine announces (absolute, deduplicated). */
export function syncedRoots(opts: SyncedPathEnv = {}): string[] {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const platform = opts.platform ?? process.platform;
  const roots: string[] = [];
  const add = (p: string | undefined) => { if (p && isAbsolute(p)) roots.push(resolve(p)); };
  add(env.OneDrive);
  add(env.OneDriveCommercial);
  add(env.OneDriveConsumer);
  if (platform === "win32") add(env.APPDATA); // the roaming profile (AppData\Roaming)
  for (const name of ["OneDrive", "Dropbox", "iCloudDrive", "iCloud Drive", "Google Drive", "Box", "Box Sync"]) add(join(home, name));
  if (platform === "darwin") {
    add(join(home, "Library", "Mobile Documents"));
    add(join(home, "Library", "CloudStorage"));
  }
  return [...new Set(roots)];
}

const norm = (p: string, platform: NodeJS.Platform): string => {
  const r = resolve(p);
  return platform === "win32" || platform === "darwin" ? r.toLowerCase() : r;
};

/** True when `p` is inside a synced folder by either signal. A relative path is judged as resolved. */
export function isSyncedPath(p: string, opts: SyncedPathEnv = {}): boolean {
  const platform = opts.platform ?? process.platform;
  const target = norm(p, platform);
  for (const root of syncedRoots(opts)) {
    const r = norm(root, platform);
    if (target === r || target.startsWith(r.endsWith(sep) ? r : r + sep)) return true;
  }
  return resolve(p).split(/[\\/]+/).some((seg) => SYNCED_SEGMENTS.some((re) => re.test(seg)));
}
