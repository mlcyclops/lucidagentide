// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/fs_browse.ts — P-FS.1 (ADR-0103): the in-app folder browser's directory lister.
//
// Supersedes ADR-0022 M1's home-subtree confinement. A desktop IDE legitimately needs to open a
// workspace ANYWHERE on the machine (like VS Code), so the browser now traverses the full filesystem
// (root `/` on POSIX, per-drive on Windows). This is safe because the ONLY caller is the local,
// authenticated user inside the Electron app: /api/fs/list sits behind ADR-0022's still-intact transport
// gates — loopback-only bind (H1), the Origin/Host/CSRF + token gate (H2). The directory-listing-oracle
// threat M1 addressed is moot for the sole legitimate local caller browsing their own machine.
//
// Two things are PRESERVED from M1, and one is ADDED:
//  - canonicalization (`resolve` collapses `..`/relative segments) — paths are still normalized.
//  - an OPTIONAL managed-config root allowlist (`workspaceRoots`, ADR-0068 "only tightens"): when an org
//    sets it, the browser is re-confined to those roots and never offers a parent above them.
//
// Pure + dependency-injected so the path logic is unit-tested without a server, and the Windows drive
// path is testable on a POSIX CI by injecting `platform: "win32"` — we select the matching path module
// (`path.win32`/`path.posix`) so Windows path semantics are exercised even on a Linux host. At real
// runtime `platform === process.platform`, so the selected module is always the native one.

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** Sentinel `path` value meaning "the computer level" — list drives (Windows only). Round-trips through
 *  the renderer's `parent`/`data-go` as an opaque string, so it must be non-empty and URL-safe. */
export const COMPUTER = "computer:";

export interface FsEntry {
  name: string;
  path: string;
  isGit: boolean;
}
export interface FsListing {
  /** The directory being listed (or the COMPUTER sentinel at the Windows drive level). */
  path: string;
  /** Parent to navigate "up" to, or null when already at the top (FS root / computer / an allowed root). */
  parent: string | null;
  home: string;
  isGit: boolean;
  dirs: FsEntry[];
}

export interface FsDeps {
  platform?: NodeJS.Platform;
  home?: string;
  exists?: (p: string) => boolean;
  isDir?: (p: string) => boolean;
  readdir?: (p: string) => string[];
  /** Existing drive roots on Windows, e.g. ["C:\\","D:\\"]. Injected for tests. */
  drives?: () => string[];
}

type PathMod = typeof path.posix;

const defaults = {
  exists: (p: string) => existsSync(p),
  isDir: (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } },
  readdir: (p: string) => readdirSync(p),
  drives: probeWindowsDrives,
};

function probeWindowsDrives(): string[] {
  const out: string[] = [];
  for (let c = 67 /* C */; c <= 90 /* Z */; c++) {
    const root = `${String.fromCharCode(c)}:\\`;
    try { if (existsSync(root)) out.push(root); } catch { /* skip */ }
  }
  return out;
}

/** A drive root like `C:\` or `C:/` — detected by shape so it works regardless of the HOST platform. */
function isWindowsDriveRoot(p: string): boolean {
  return /^[A-Za-z]:[\\/]?$/.test(p);
}

/** `cand` is inside (or equal to) `root`, using the given path module + separator-aware prefix match
 *  (avoids the `/home/user` vs `/home/user-evil` sibling-prefix bypass). */
function within(pp: PathMod, root: string, cand: string): boolean {
  const r = pp.resolve(root);
  const c = pp.resolve(cand);
  return c === r || c.startsWith(r + pp.sep);
}

/** Normalize an allowlist to canonical absolute roots, or null when unmanaged (full-FS browsing). */
function normalizeRoots(pp: PathMod, roots: string[] | null | undefined): string[] | null {
  if (!Array.isArray(roots) || roots.length === 0) return null;
  return roots.map((r) => pp.resolve(r));
}

/**
 * List the directory `want` for the folder browser.
 * - `want` null/empty → start at home (familiar landing), but the user can navigate up from there.
 * - `want === COMPUTER` on Windows → enumerate drives (or the allowed roots, when managed).
 * - `allowedRoots` non-empty (managed) → confine to those roots; otherwise browse the whole filesystem.
 */
export function listDir(want: string | null, opts: { allowedRoots?: string[] | null } & FsDeps = {}): FsListing {
  const platform = opts.platform ?? process.platform;
  const pp: PathMod = platform === "win32" ? path.win32 : path.posix;
  const home = opts.home ?? homedir();
  const exists = opts.exists ?? defaults.exists;
  const isDir = opts.isDir ?? defaults.isDir;
  const readdir = opts.readdir ?? defaults.readdir;
  const drives = opts.drives ?? defaults.drives;
  const roots = normalizeRoots(pp, opts.allowedRoots);

  // Windows "computer" level → the set of drive roots (or the allowed roots, when managed).
  if (platform === "win32" && want === COMPUTER) {
    const entries = (roots ?? drives()).filter((d) => exists(d) && isDir(d));
    return {
      path: COMPUTER,
      parent: null,
      home,
      isGit: false,
      dirs: entries
        .map((d) => ({ name: d.replace(/[\\/]+$/, "") || d, path: d, isGit: exists(pp.join(d, ".git")) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  // Resolve the base directory. `roots` is non-empty when non-null (normalizeRoots guarantees it).
  const firstRoot = roots ? pp.resolve(roots[0]!) : pp.resolve(home);
  // null/empty `want` → land at home (familiar), or the first allowed root when managed.
  let base = want ? pp.resolve(want) : roots ? firstRoot : pp.resolve(home);
  // Managed confinement: a base outside every allowed root snaps back to the first root.
  if (roots && !roots.some((r) => within(pp, r, base))) base = firstRoot;
  // Fall back to home (or the first allowed root) if the target isn't a readable directory.
  if (!exists(base) || !isDir(base)) base = roots ? firstRoot : pp.resolve(home);

  const dirs: FsEntry[] = [];
  try {
    for (const name of readdir(base)) {
      if (name.startsWith(".")) continue; // hide dotfiles (noise; unchanged from M1)
      const full = pp.join(base, name);
      if (isDir(full)) dirs.push({ name, path: full, isGit: exists(pp.join(full, ".git")) });
    }
  } catch { /* unreadable dir → empty listing, never throw */ }
  dirs.sort((a, b) => a.name.localeCompare(b.name));

  return { path: base, parent: parentOf(pp, base, { platform, roots }), home, isGit: exists(pp.join(base, ".git")), dirs };
}

/** The "up" target for `base`, clamped to the top: null at FS root / an allowed root; the COMPUTER
 *  sentinel above a Windows drive root. */
function parentOf(pp: PathMod, base: string, ctx: { platform: NodeJS.Platform; roots: string[] | null }): string | null {
  // Managed: never offer a parent above (or outside) the allowed roots.
  if (ctx.roots) {
    if (ctx.roots.some((r) => pp.resolve(r) === base)) return null;
    const up = pp.dirname(base);
    return up !== base && ctx.roots.some((r) => within(pp, r, up)) ? up : null;
  }
  if (ctx.platform === "win32" && isWindowsDriveRoot(base)) return COMPUTER;
  const up = pp.dirname(base);
  return up === base ? null : up; // dirname("/") === "/" → top of the tree
}
