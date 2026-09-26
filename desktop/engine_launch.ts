// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/engine_launch.ts - P-WINBOOT.2 (ADR-0260): the permanent fix for the Program Files brick.
//
// P-WINBOOT.1 (ADR-0259) stopped NEW installs from reaching a protected dir and made the failure
// legible. The root cause remained: main.ts ran `bun run desktop/dev.ts` from <resources>/repo, and
// Bun's module loader EPERMs loading TypeScript out of an ACL-protected tree (Program Files). The
// permanent fix ships the engine as a `bun build --compile` standalone binary (bin/lucid-engine):
// dev.ts + every statically-imported module is EMBEDDED in the binary, so Bun never module-loads a .ts
// off the protected disk. Native addons (DuckDB etc.) are the ONLY --external, loaded via the OS
// loader (LoadLibrary), which works from Program Files; and the renderer is prebuilt at package time
// (build-renderer) so there is no runtime Bun.build of .ts from the install dir either.
//
// This module holds the two PURE decisions that seam: which base dir the engine resolves its on-disk
// assets from (import.meta.dir is VIRTUALIZED to a bunfs path in a compiled binary, so the compiled
// engine derives the real dir from process.execPath), and which command main.ts spawns.

import { dirname, join } from "node:path";

/** The exe suffix for a native binary on this platform. */
export const engineExeName = (platform: NodeJS.Platform): string => `lucid-engine${platform === "win32" ? ".exe" : ""}`;

/**
 * The real on-disk `desktop/` directory the engine resolves renderer/monaco/templates/repo assets
 * from. In a dev run (or the `bun run dev.ts` fallback) this module's `import.meta.dir` IS that dir.
 * In a `bun build --compile` binary import.meta.dir is a virtual bunfs path with no `renderer/` on
 * disk, so we derive it from the on-disk binary, which ships at <repo>/bin/lucid-engine[.exe] ->
 * <repo>/desktop. The `exists` probe (never a substring guess) is what distinguishes the two.
 */
export function engineDesktopDir(importMetaDir: string, execPath: string, exists: (p: string) => boolean): string {
  if (exists(join(importMetaDir, "renderer"))) return importMetaDir;
  return join(dirname(execPath), "..", "desktop");
}

export interface EngineSpawn {
  cmd: string;
  args: string[];
  /** True when we resolved the compiled binary (vs the `bun run dev.ts` fallback). */
  compiled: boolean;
}

/**
 * Which command boots the engine. Packaged: prefer the compiled `bin/lucid-engine` (embeds dev.ts, so
 * Bun never loads a .ts from the protected install dir - the P-WINBOOT.1 EPERM brick is impossible).
 * Falls back to `bun run desktop/dev.ts` when the binary is absent (a dev run, or an older package cut
 * before compile-engine ran) so the app still starts. `exists` + `bun` are injected for testability.
 */
export function resolveEngineSpawn(o: {
  packaged: boolean;
  repoRoot: string;
  bun: string;
  exists: (p: string) => boolean;
  platform: NodeJS.Platform;
}): EngineSpawn {
  if (o.packaged) {
    const exe = join(o.repoRoot, "bin", engineExeName(o.platform));
    if (o.exists(exe)) return { cmd: exe, args: [], compiled: true };
  }
  return { cmd: o.bun, args: ["run", "desktop/dev.ts"], compiled: false };
}
