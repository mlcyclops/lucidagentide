// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/vault_env_routes.ts
//
// P-VAULT-ENV.1 (ADR-0477): `.env` import over HTTP. Chained from vault_routes.ts handleVaultRoutes (one
// line), so the dispatch, the `{ ok, data }` / `{ ok: false, error }` shape and the token rule are V2's:
// the header UI token only (never a `?t=` query token, never in dev.ts AGENT_ROUTES). Every route works on
// the CURRENT workspace (workspace.ts currentWorkspace()), never on a path the request names, and reads
// only `.env` / `.env.<suffix>` directly in it.
//
//   POST /api/vault/env/scan           { file? }                          -> EnvScan (names, slots, last-4; no values)
//   POST /api/vault/env/import         { file?, names?, confirmReplace?, blank?, gitignore? } -> EnvImportResult (names and refs)
//                                      confirmReplace: the names the user confirmed may replace a saved global key
//   POST /api/vault/env/materialize    { file?, minutes? }                -> { path, names, until }
//   POST /api/vault/env/unmaterialize  { file? }                          -> { blanked, names }

import { tokenValid } from "./origin_guard.ts";
import {
  DEFAULT_ENV_FILE, importEnvFile, materializeEnvFile, scanEnvFile, unmaterializeEnvFile,
} from "./vault_env_import.ts";
import type { VaultRouteCtx } from "./vault_routes.ts";
import { currentWorkspace } from "./workspace.ts";

export const VAULT_ENV_ROUTES: readonly string[] = [
  "/api/vault/env/scan", "/api/vault/env/import", "/api/vault/env/materialize", "/api/vault/env/unmaterialize",
];

const reply = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

/** `/api/vault/env/*`, or null for any other path. */
export async function handleVaultEnvRoutes(req: Request, p: string, ctx: VaultRouteCtx): Promise<Response | null> {
  if (!VAULT_ENV_ROUTES.includes(p)) return null;
  if (!tokenValid(req.headers.get("x-lucid-token"), ctx.uiToken)) return reply(403, { ok: false, error: "forbidden" });
  if (req.method !== "POST") return reply(405, { ok: false, error: "method not allowed" });
  const raw: unknown = await req.json().catch(() => null);
  const b = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const file = typeof b.file === "string" && b.file ? b.file : DEFAULT_ENV_FILE;
  const ws = currentWorkspace();
  try {
    if (p === "/api/vault/env/scan") return reply(200, { ok: true, data: scanEnvFile(ws, file) });
    if (p === "/api/vault/env/import") {
      const strings = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((n): n is string => typeof n === "string") : undefined);
      const opts = { names: strings(b.names), confirmReplace: strings(b.confirmReplace), blank: b.blank === true, gitignore: b.gitignore === true };
      return reply(200, { ok: true, data: importEnvFile(ws, file, opts) });
    }
    if (p === "/api/vault/env/materialize") {
      const minutes = typeof b.minutes === "number" ? b.minutes : undefined;
      return reply(200, { ok: true, data: materializeEnvFile(ws, file, minutes) });
    }
    return reply(200, { ok: true, data: unmaterializeEnvFile(ws, file) });
  } catch (e) {
    return reply(400, { ok: false, error: String((e as Error)?.message ?? e).slice(0, 240) });
  }
}
