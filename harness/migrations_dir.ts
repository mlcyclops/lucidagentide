// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/migrations_dir.ts — resolve a store's migration-SQL directory in BOTH runtimes.
//
// Every DuckDB store applies numbered .sql migrations from a directory (invariant #10), and each one used
// to compute that directory as `join(import.meta.dir, "migrations")`. That is correct for a dev run and for
// tests, and WRONG in the shipped app: packaged builds spawn the `bun build --compile` engine
// (bin/lucid-engine, ADR-0260), where `import.meta.dir` is a VIRTUAL bunfs path and the bundle embeds
// modules, not a directory of .sql files. The migrations then resolve to `B:\~BUN\root\migrations`, which
// does not exist, so opening a store fails with an ENOENT scandir. That is exactly how a bought KG pack was
// rejected at the scan stage with "pack db is not a valid KG store" in an installed build while working
// perfectly from source.
//
// This mirrors engineDesktopDir (ADR-0260): PROBE for a real directory, never guess from a path substring.
// Candidates, in order:
//   1. the module's own `migrations/` — a dev run, a test, or the `bun run dev.ts` fallback;
//   2. `$LUCID_RESOURCES/repo/<repoRelDir>/migrations` — Electron threads LUCID_RESOURCES when packaged;
//   3. `<execPath>/../../<repoRelDir>/migrations` — the compiled engine ships at <repo>/bin/lucid-engine,
//      and the packaged tree carries the repo (with its .sql files) beside it.
// When none exist the first candidate is returned, so the failure still names a path a human recognises
// rather than a virtual one.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export interface MigrationsDirDeps {
  exists?: (p: string) => boolean;
  execPath?: string;
  resources?: string | undefined;
}

/** The on-disk migrations directory for a store. `repoRelDir` is the store's path from the repo root
 *  (e.g. "harness/kb"), needed because the compiled bundle collapses every module to one virtual root. */
export function resolveMigrationsDir(repoRelDir: string, importMetaDir: string, deps: MigrationsDirDeps = {}): string {
  const exists = deps.exists ?? existsSync;
  const execPath = deps.execPath ?? process.execPath;
  const resources = "resources" in deps ? deps.resources : process.env.LUCID_RESOURCES;

  const own = join(importMetaDir, "migrations");
  const candidates = [own];
  if (resources) candidates.push(join(resources, "repo", ...repoRelDir.split("/"), "migrations"));
  candidates.push(join(dirname(dirname(execPath)), ...repoRelDir.split("/"), "migrations"));

  for (const c of candidates) {
    if (exists(c)) return c;
  }
  return own;
}
