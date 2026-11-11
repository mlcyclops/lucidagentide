// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/vault_backup_routes.ts
//
// P-VAULT-UI.1 (ADR-0475): encrypted backup and restore of the engine vault over HTTP. dev.ts chains this
// right after handleVaultRoutes (which answers null for these paths):
//   const vb = await handleVaultBackupRoutes(req, p, { uiToken: TOKEN }); if (vb) return vb;
//
//   POST /api/vault/backup  { passphrase }        -> { file: <.lucidvault JSON text>, filename, count }
//   POST /api/vault/restore { passphrase, file }  -> { added, updated, skipped }
//
// UI token only, header only: neither path is in dev.ts AGENT_ROUTES or QUERY_TOKEN_ROUTES, and this
// module re-checks the header token itself, so the agent token or a `?t=` query token never reaches them.
// The backup reply is CIPHERTEXT (vault_backup.ts envelope), the restore reply is counts: no plaintext
// value is ever written to a response, a log line or an event. The passphrase is accepted on the way in
// and never echoed. Shape: `{ ok: true, data }` or `{ ok: false, error }`, like vault_routes.ts.

import { mayHoldGlobalEnv } from "./env_name_policy.ts";
import { tokenValid } from "./origin_guard.ts";
import { backupFileName, createVaultBackup, restoreVaultBackup, VaultBackupError } from "./vault_backup.ts";
import { applyVaultEnv } from "./vault_env.ts";
import { vaultGet } from "./vault_store.ts";

export const VAULT_BACKUP_ROUTES: readonly string[] = ["/api/vault/backup", "/api/vault/restore"];
/** A backup of a few thousand entries is well under this; anything larger is not ours. */
const MAX_BODY = 16 * 1024 * 1024;

export interface VaultBackupRouteCtx {
  /** The engine's UI token (dev.ts TOKEN). */
  uiToken: string;
}

const reply = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const fail = (status: number, error: string): Response => reply(status, { ok: false, error });
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 240);

/** The HTTP status of a refusal: the user's input (400) or the engine (500). Messages are fixed text or a
 *  thrown error's message (vault_store / fips_crypto refusals), never a value. */
function refusal(e: unknown, what: string): Response {
  if (e instanceof VaultBackupError) return fail(e.code === "weak-passphrase" ? 400 : 422, e.message);
  return fail(500, `${what}: ${errText(e)}`);
}

/** After a restore: keep restored settings-style `key:<ENV>` refs live in process.env (as vault_routes.ts
 *  does after a write; a reserved name per env_name_policy.ts is skipped) and re-resolve the engine-side
 *  credential env. Never fails the restore. */
function refreshEnv(refs: string[]): void {
  try {
    for (const ref of refs) {
      if (!ref.startsWith("key:") || !mayHoldGlobalEnv(ref.slice(4))) continue;
      const v = vaultGet(ref);
      if (v) process.env[ref.slice(4)] = v;
    }
    applyVaultEnv();
  } catch (e) {
    console.error(`[vault] env refresh after a restore failed: ${errText(e)}`);
  }
}

async function jsonBody(req: Request): Promise<Record<string, unknown> | null> {
  const text = await req.text().catch(() => "");
  if (!text || text.length > MAX_BODY) return null;
  try {
    const raw: unknown = JSON.parse(text);
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Dispatch the backup/restore routes. Null for any other path. */
export async function handleVaultBackupRoutes(req: Request, p: string, ctx: VaultBackupRouteCtx): Promise<Response | null> {
  if (!VAULT_BACKUP_ROUTES.includes(p)) return null;
  if (!tokenValid(req.headers.get("x-lucid-token"), ctx.uiToken)) return fail(403, "forbidden");
  if (req.method !== "POST") return fail(405, "method not allowed");
  const b = await jsonBody(req);
  if (!b) return fail(400, "a JSON body is required");
  const passphrase = typeof b.passphrase === "string" ? b.passphrase : "";
  if (!passphrase) return fail(400, "a passphrase is required");

  if (p === "/api/vault/backup") {
    try {
      const { envelope, count } = createVaultBackup(passphrase);
      return reply(200, { ok: true, data: { file: JSON.stringify(envelope, null, 2), filename: backupFileName(), count } });
    } catch (e) { return refusal(e, "the backup was not made"); }
  }

  const file = typeof b.file === "string" || (b.file && typeof b.file === "object") ? b.file : null;
  if (!file) return fail(400, "a backup file is required");
  try {
    const { added, updated, skipped, refs } = restoreVaultBackup(file, passphrase);
    if (added + updated > 0) refreshEnv(refs);
    return reply(200, { ok: true, data: { added, updated, skipped } });
  } catch (e) { return refusal(e, "nothing was restored"); }
}
