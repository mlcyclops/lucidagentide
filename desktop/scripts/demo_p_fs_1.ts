// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_fs_1.ts
//
// Increment P-FS.1 (ADR-0103) — full-tree workspace folder browser (supersedes ADR-0022 M1's home
// confinement). Proves: (1) the browser can navigate ABOVE the user's home toward the filesystem root
// (the lock the user hit); (2) parent of the FS root is null (top of the tree); (3) an org's managed
// `workspaceRoots` re-confines the browser and never offers a parent above the allowed root (ADR-0068
// "only tightens"); (4) the Windows "computer" level enumerates drives (injected, so it runs on POSIX CI).

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { COMPUTER, listDir } from "../fs_browse.ts";

const fail = (msg: string): never => { console.error(`FAIL: ${msg}`); process.exit(1); };
const ok = (msg: string): void => console.log(`   ${msg} ✓`);

console.log("== P-FS.1 — full-tree workspace folder browser ==");

const TMP = mkdtempSync(join(tmpdir(), "demo-fs-"));
try {
  const ROOT = join(TMP, "root");
  const HOME = join(ROOT, "home");
  mkdirSync(join(HOME, "proj"), { recursive: true });
  mkdirSync(join(ROOT, "sibling"), { recursive: true });

  // 1. Navigate above home — the whole point of the fix.
  const atHome = listDir(null, { home: HOME, platform: "linux" });
  if (atHome.path !== resolve(HOME)) fail(`expected to land at home, got ${atHome.path}`);
  if (atHome.parent !== resolve(ROOT)) fail(`home must offer a parent ABOVE it, got ${atHome.parent}`);
  ok("lands at home AND can navigate up past it (no home confinement)");

  const atRoot = listDir(ROOT, { home: HOME, platform: "linux" });
  if (!atRoot.dirs.some((d) => d.name === "sibling")) fail("could not see a sibling of home from the parent");
  ok("can list directories outside the home subtree");

  // 2. Parent of the filesystem root is null.
  if (listDir("/", { home: HOME, platform: "linux" }).parent !== null) fail("FS root should have no parent");
  ok("filesystem root is the top (parent = null)");

  // 3. Managed workspaceRoots re-confine (only tightens).
  const confined = listDir("/etc", { home: HOME, platform: "linux", allowedRoots: [HOME] });
  if (confined.path !== resolve(HOME)) fail("a target outside the managed roots must snap back into a root");
  if (listDir(HOME, { home: HOME, platform: "linux", allowedRoots: [HOME] }).parent !== null)
    fail("managed root must not offer a parent above itself");
  ok("managed workspaceRoots re-confine the browser (no parent above the root)");

  // 4. Windows drive (computer) level, injected so it runs on POSIX CI.
  const win = listDir(COMPUTER, {
    platform: "win32", home: "C:\\Users\\me",
    drives: () => ["C:\\", "D:\\"], exists: () => true, isDir: () => true, readdir: () => [],
  });
  if (win.dirs.map((d) => d.path).sort().join(",") !== "C:\\,D:\\") fail("computer level must enumerate drives");
  ok("Windows computer level enumerates drives");

  console.log("PASS: full-tree browser, root clamp, managed confinement, and Windows drives all hold.");
} finally {
  rmSync(TMP, { recursive: true, force: true });
}
