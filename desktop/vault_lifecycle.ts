// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/vault_lifecycle.ts
//
// Wave B security review VAULT-ENV-MATERIALIZE-SYNCED / VAULT-DEST-REQFILE-PERMS-ORPHAN /
// SECRET-FALLBACK-ORPHAN: plaintext the engine wrote for a moment must not outlive the engine. Three kinds:
//   - a `.env` filled in by "write .env temporarily" (vault_env_import.ts, recorded in a journal under
//     the data root);
//   - a destination request dir `lucid-vdest-*` (vault_destinations.ts, the whole vault on a push);
//   - a notepad fallback dir `lucid-secret-*` (secret_fallback.ts, a pasted secret).
// Each one cleans itself up while the engine lives. These two calls cover the engine dying first:
//   - vaultStartupCleanup: dev.ts runs it before anything else (before any env is applied or child spawned):
//     re-blank every journaled `.env`, then wipe and remove leftover temp dirs no live engine owns.
//   - vaultShutdownCleanup: the graceful path. Electron main calls the main-only
//     `/api/vault/main/shutdown` (vault_routes.ts, MAC-authenticated like the other main routes) BEFORE it
//     kills the engine tree on quit, because a Windows kill is TerminateProcess and no exit handler runs.
//     It re-blanks every materialized `.env` and removes this engine's own temp dirs too.
// Neither throws, and neither logs a value: counts only.

import type { VaultCleanupReport } from "./cred_engine_client.ts";
import { FALLBACK_DIR_PREFIX, sweepOrphanTempDirs } from "./secret_fallback.ts";
import { REQUEST_DIR_PREFIX } from "./vault_destinations.ts";
import { reblankMaterializedJournal, unmaterializeAll } from "./vault_env_import.ts";

function cleanup(phase: "startup" | "shutdown"): VaultCleanupReport {
  const env = phase === "startup" ? reblankMaterializedJournal() : unmaterializeAll();
  const temp = sweepOrphanTempDirs([FALLBACK_DIR_PREFIX, REQUEST_DIR_PREFIX], { includeOwn: phase === "shutdown" });
  const report: VaultCleanupReport = { reblanked: env.reblanked, reblankFailed: env.failed, swept: temp.removed, kept: temp.kept };
  if (report.reblanked || report.reblankFailed || report.swept) {
    console.error(`[vault] ${phase} cleanup: ${report.reblanked} .env file(s) blanked again${report.reblankFailed ? ` (${report.reblankFailed} could not be)` : ""}, ${report.swept} leftover temp folder(s) wiped`);
  }
  return report;
}

/** Engine start, before anything else: plaintext a crashed or killed engine left behind. */
export function vaultStartupCleanup(): VaultCleanupReport {
  return cleanup("startup");
}

/** Graceful shutdown (main's `/api/vault/main/shutdown`, then the kill): everything this engine wrote. */
export function vaultShutdownCleanup(): VaultCleanupReport {
  return cleanup("shutdown");
}
