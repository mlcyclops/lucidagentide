// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/cred_env.ts
//
// P-VAULT-V2.1 (ADR-0474): which stored credential becomes which engine env var. One pure plan, used by
// BOTH sides of the safeStorage -> engine vault migration so they cannot drift:
//   - Electron main (main.ts prepareCredEnv) runs it over the credentials still in safeStorage and injects
//     the result into the engine it spawns (first boot after the upgrade, and any entry not yet migrated);
//   - the engine (vault_env.ts) runs it over its own vault at startup and after every vault change.
// Node-safe: no Bun, no Electron, no fs. Values pass through; nothing here logs or stores them.
//
//   figma_pat                      -> LUCID_FIGMA_TOKEN        (P-FIGMA.1, ADR-0154)
//   git_pat                        -> LUCID_GIT_PAT            (ADR-0216, the host-agnostic fallback)
//   git_pat_<host_slug>            -> LUCID_GIT_PAT_<HOST_SLUG> (P-FLEET.L2, one per saved host)
//   settings.embeddings.vaultRef   -> LUCID_EMBEDDINGS_KEY     (ADR-0221; enabled bearer/apikey only)
//   meeting_hub_token              -> LUCID_MEETING_HUB_TOKEN  (P-MEET.1; the engine keeps it in module
//                                                               state, never in its own process.env)

import { GIT_CRED_LEGACY_REF, gitEnvNameFromRef } from "./git_url.ts";
import { MEETING_HUB_CRED_REF } from "./meetings_hub.ts";

export const FIGMA_PAT_REF = "figma_pat";
export const MEETING_HUB_ENV = "LUCID_MEETING_HUB_TOKEN";

/** A credential store seen through the two operations the plan needs. `read` may throw or return null
 *  for a ref it cannot open; the plan treats both as "absent" (best-effort, never blocks a launch). */
export interface CredSource { refs(): readonly string[]; read(ref: string): string | null }
/** The non-secret embeddings settings that decide whether its key is injected. */
export interface EmbeddingsAuth { enabled: boolean; authKind: string; vaultRef?: string }

export function credEnvPlan(src: CredSource, embeddings: EmbeddingsAuth | null): Record<string, string> {
  const read = (ref: string): string | null => { try { return src.read(ref) || null; } catch { return null; } };
  const env: Record<string, string> = {};
  const figma = read(FIGMA_PAT_REF);
  if (figma) env.LUCID_FIGMA_TOKEN = figma;
  const git = read(GIT_CRED_LEGACY_REF);
  if (git) env.LUCID_GIT_PAT = git;
  let refs: readonly string[] = [];
  try { refs = src.refs(); } catch { /* best-effort: no host-scoped tokens */ }
  for (const ref of refs) {
    const name = gitEnvNameFromRef(ref);
    if (!name) continue;
    const tok = read(ref);
    if (tok) env[name] = tok;
  }
  if (embeddings?.enabled && embeddings.vaultRef && (embeddings.authKind === "bearer" || embeddings.authKind === "apikey")) {
    const key = read(embeddings.vaultRef);
    if (key) env.LUCID_EMBEDDINGS_KEY = key;
  }
  const hub = read(MEETING_HUB_CRED_REF);
  if (hub) env[MEETING_HUB_ENV] = hub;
  return env;
}

/** CREATOR-0: the env var a Creator endpoint / remote target credential is read from (dev.ts
 *  creatorEndpointToken and the remote-target probe read exactly this name). */
export function creatorTargetEnvName(vaultRef: string): string {
  return `LUCID_CREATOR_TARGET_${vaultRef.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}`;
}
