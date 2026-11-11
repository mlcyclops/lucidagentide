// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/env_name_policy.ts
//
// Wave B security review SECRET-INTAKE-ENVNAME-UNRESTRICTED: the ONE rule for which environment variable
// names a vault secret may take. Every path that turns a vault entry into an environment variable asks
// here: the agent's request_secret (secret_intake.ts parseSecretRequest), the .env import
// (vault_env_import.ts), the workspace session overlay (workspaceSecretEnv), and every engine-side
// `key:<ENV>` refresh (vault_routes.ts afterWrite, the backup restore, the destination pull).
//
// A RESERVED name steers the process itself, the agent runtime, the network path or LUCID: setting it
// would change what runs or where traffic goes, not what a program can reach. NODE_OPTIONS and PATH run
// code, *_PROXY / *_BASE_URL / *_ENDPOINT redirect traffic (with the API key), *_CA_* / SSL_CERT_* trust
// another certificate, GIT_* reconfigures git, LUCID_* / OMP_* / PI_* / BUN_* reconfigure LUCID and its
// agent. Matched case-insensitively (Windows env names are).
//
// The only exception is a name the user configures in Settings > Providers (a provider's key or one of its
// extra fields, e.g. AZURE_OPENAI_BASE_URL or NODE_EXTRA_CA_CERTS): the user typed it there, so the
// engine-side refresh of that `key:<ENV>` slot keeps working. Neither an agent request nor a `.env`
// import can create one of those under a reserved name: an agent may hold a global `key:<ENV>` only for a
// provider's primary key env, and a workspace secret never takes a reserved name.

import { GATEWAY, MAJORS, OTHERS } from "./auth_status.ts";
import { isEnvName } from "./engine_vault.ts";

/** Reserved env names (see the header). Prefixes, exact names, and suffix/infix patterns. */
const RESERVED_ENV_RE = new RegExp(
  "^(" +
    [
      "LUCID_", "OMP_", "PI_", "BUN_", "NODE_", "GIT_", "PYTHON", "SSL_CERT_", "DYLD_", "LD_",
      "NODE_OPTIONS$", "PATH$", "PATHEXT$", "HOME$", "USERPROFILE$", "APPDATA$", "LOCALAPPDATA$", "SYSTEMROOT$",
      "WINDIR$", "COMSPEC$", "TEMP$", "TMP$", "TMPDIR$", "SHELL$", "BASH_ENV$", "ENV$", "PROMPT_COMMAND$", "NO_PROXY$",
    ].join("|") +
    ")|_PROXY$|_BASE_URL$|_ENDPOINT$|_CA_",
  "i",
);

/** True for a name no vault secret may set for a session or the engine (see the header). */
export function isReservedEnvName(name: string): boolean {
  return RESERVED_ENV_RE.test(name);
}

/** The provider key slots (`key:<ENV>`): the primary key env of every provider Settings lists. The only
 *  names an agent's request_secret may store as a global (every workspace) env secret. */
export function providerKeyEnvs(): Set<string> {
  return new Set([...GATEWAY, ...MAJORS, ...OTHERS].map((p) => p.env).filter((e) => !!e));
}

/** Every env name Settings > Providers configures: the primary keys plus each provider's extra fields. */
export function providerConfigEnvs(): Set<string> {
  const out = providerKeyEnvs();
  for (const p of [...GATEWAY, ...MAJORS, ...OTHERS]) for (const f of p.fields ?? []) if (f.env) out.add(f.env);
  return out;
}

/** May the engine put the vault's `key:<name>` value into its own process.env (which every later child
 *  inherits)? A valid name that is not reserved, or one Settings > Providers configures. */
export function mayHoldGlobalEnv(name: string): boolean {
  return isEnvName(name) && (!isReservedEnvName(name) || providerConfigEnvs().has(name));
}

/** May a workspace-scoped secret (`ws:`) be injected into a session's env under `name`? */
export function mayHoldWorkspaceEnv(name: string): boolean {
  return isEnvName(name) && !isReservedEnvName(name);
}
