// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/vault_env.ts
//
// P-VAULT-V2.1 (ADR-0474): engine-side resolution of the credential env. Until this slice Electron main
// decrypted safeStorage credentials and injected them into the engine at spawn, so a headless engine had
// none and a credential saved mid-session waited for a relaunch. Now the credentials live in the engine
// vault and the engine resolves them itself, with the SAME env names and semantics (cred_env.ts is the
// one plan both sides run):
//   - credEnvPlan: LUCID_FIGMA_TOKEN, LUCID_GIT_PAT, LUCID_GIT_PAT_<HOST_SLUG>, LUCID_EMBEDDINGS_KEY;
//   - the Meeting Hub bearer goes into meetings_hub.ts module state, never into process.env (P-MEET.1:
//     no omp, fleet or scanner child may inherit it);
//   - Local Providers: models.yml is rewritten (materializeLocalProviders) and LUCID_LP_<ID>_KEY set;
//   - Creator endpoints and remote targets: LUCID_CREATOR_TARGET_<REF>, the names dev.ts reads.
// Main keeps injecting whatever is still in safeStorage (first boot, or an entry not yet migrated); a
// name main injected is never removed here, and an engine-vault value for the same name replaces it
// (after migration both hold the same value; after a later rotation the vault holds the newer one).
// Values never reach a log line: only env NAMES are logged.

import { creatorTargetEnvName, credEnvPlan, MEETING_HUB_ENV } from "./cred_env.ts";
import { readVault } from "./engine_vault.ts";
import { providerEnvVar } from "./local_providers.ts";
import { materializeLocalProviders } from "./local_providers_runtime.ts";
import { meetingHubToken, setMeetingHubToken } from "./meetings_hub.ts";
import { embeddingsConfig, keyVaultDir, listCreatorEndpoints, listCreatorTargets, listLocalProviders } from "./settings_store.ts";

export interface VaultEnvReport {
  /** Env names this engine now sets from its vault (sorted; never values). */
  names: string[];
  /** The Meeting Hub bearer came from the vault (held in module state, not in process.env). */
  meetingHub: boolean;
  /** Local Providers routed by the models.yml written now. */
  localProviders: string[];
  /** Set when the vault is unreadable: nothing was changed. */
  problem?: string;
}

/** name -> value this module set, so a later run removes only what it set (never main's injection). */
const applied = new Map<string, string>();
/** The Meeting Hub bearer last taken from the vault. */
let hubFromVault = "";
let lastNote = "";

/** Resolve the credential env from the engine vault and apply it to process.env. Called at engine
 *  startup (before any omp child spawns) and after every vault write. Never throws for a vault problem:
 *  an unreadable vault changes nothing (main's injected env stays). */
export function applyVaultEnv(): VaultEnvReport {
  const vault = readVault(keyVaultDir());
  if (vault.problem) {
    const note = `problem:${vault.problem}`;
    if (note !== lastNote) { lastNote = note; console.error(`[vault] engine-side credentials not applied: ${vault.problem}`); }
    return { names: [], meetingHub: false, localProviders: [], problem: vault.problem };
  }
  const secrets = vault.secrets;
  const env = credEnvPlan({ refs: () => Object.keys(secrets), read: (ref) => secrets[ref] ?? null }, embeddingsConfig());

  const hub = env[MEETING_HUB_ENV] ?? "";
  delete env[MEETING_HUB_ENV];
  const held = meetingHubToken();
  if (hub && hub !== held && (!held || held === hubFromVault)) setMeetingHubToken(hub);
  else if (!hub && hubFromVault && held === hubFromVault) setMeetingHubToken(""); // deleted from the vault
  hubFromVault = hub;

  for (const def of [...listCreatorEndpoints(), ...listCreatorTargets()]) {
    const value = def.vaultRef ? secrets[def.vaultRef] : undefined;
    if (def.vaultRef && value) env[creatorTargetEnvName(def.vaultRef)] = value;
  }

  let localProviders: string[] = [];
  const defs = listLocalProviders();
  if (defs.length) {
    // A provider whose credential is still in safeStorage arrives as main's injected LUCID_LP_* value:
    // keep routing it (a value this module set itself is not a second source).
    const injected = (ref: string): string | null => {
      for (const d of defs) {
        if (d.vaultRef !== ref) continue;
        const name = providerEnvVar(d);
        const v = process.env[name];
        if (v && applied.get(name) !== v) return v;
      }
      return null;
    };
    try {
      const r = materializeLocalProviders({ defs, readSecret: (ref) => secrets[ref] ?? injected(ref) });
      Object.assign(env, r.childEnv);
      localProviders = r.included;
    } catch (e) {
      console.error(`[vault] local providers not materialized: ${String((e as Error)?.message ?? e).slice(0, 160)}`);
    }
  }

  for (const [name, value] of applied) if (!(name in env) && process.env[name] === value) delete process.env[name];
  applied.clear();
  for (const [name, value] of Object.entries(env)) { process.env[name] = value; applied.set(name, value); }
  const names = Object.keys(env).sort();
  const note = `names:${names.join(",")}|hub:${hub ? 1 : 0}`;
  if (note !== lastNote) {
    lastNote = note;
    console.error(`[vault] engine-side credentials: ${names.length ? names.join(", ") : "none"}${hub ? " + Meeting Hub bearer" : ""}`);
  }
  return { names, meetingHub: !!hub, localProviders };
}

/** Test-only: forget what this module applied (does not touch process.env). */
export function _resetVaultEnvForTest(): void {
  applied.clear();
  hubFromVault = "";
  lastNote = "";
}
