// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// tools/omp_auth_reenable.ts
//
// One-shot repair for the "I logged in but it didn't save" OAuth bug: omp's `auth-broker login` writes
// a fresh token but does not clear a stale `disabled_cause` left by a previous `auth-broker logout`, so
// omp keeps treating the provider as logged out. This clears ONLY that flag (the token blob is left
// exactly as omp wrote it), re-enabling the credential. Restart the app afterwards so its omp child
// re-reads the vault.
//
//   bun run tools/omp_auth_reenable.ts openai-codex          # re-enable OpenAI / ChatGPT
//   bun run tools/omp_auth_reenable.ts anthropic             # any provider id (see `omp auth-broker list`)
//   bun run tools/omp_auth_reenable.ts openai-codex /path/to/agent.db
//
// Pairs with tools/omp_auth_status.ts (read-only check of what's active). Best-effort and non-throwing.
// P-VAULT-KEYS.2 (ADR-0480): without an explicit .db path, and with the OAuth vault on, the credential
// rows live sealed in the engine vault; the repair is applied there (a running engine adopts it within a
// second and pushes it to its omp children).

import { clearDisabledCredential } from "../desktop/auth_vault.ts";
import { openOfflineOauthRows } from "../desktop/oauth_vault_store.ts";

const args = process.argv.slice(2);
const provider = args.find((a) => !a.startsWith("--") && !a.toLowerCase().endsWith(".db"));
const dbPath = args.find((a) => a.toLowerCase().endsWith(".db"));

if (!provider) {
  console.error("usage: bun run tools/omp_auth_reenable.ts <provider-id> [path/to/agent.db]");
  console.error("       e.g. openai-codex  (run `omp auth-broker list` for ids)");
  process.exit(2);
}

const vault = dbPath ? null : openOfflineOauthRows();
const r = clearDisabledCredential(provider, dbPath);
vault?.close();
if (r.cleared > 0) {
  console.log(`[ OK ]  re-enabled ${provider}${r.identity ? `  (${r.identity})` : ""} — restart the app to use it`);
  process.exit(0);
}
console.log(`[ -- ]  nothing changed for ${provider}: ${r.reason ?? "no disabled credential"}`);
process.exit(0);
