// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/vault_routes.ts
//
// P-VAULT-V2.1 (ADR-0474): the engine vault over HTTP. dev.ts dispatches every request here first
// (`const vr = await handleVaultRoutes(req, p, { uiToken: TOKEN }); if (vr) return vr;`); anything
// outside /api/vault/ returns null untouched. Two surfaces:
//
//   UI (Contract B), header UI token only: GET /api/vault/list, POST /api/vault/put|rotate|delete.
//   Main-only, header UI token AND a request MAC keyed by the per-launch vault token Electron main minted
//   (LUCID_VAULT_MAIN_TOKEN, taken out of process.env the moment this module loads, so no omp, fleet or
//   scanner child inherits it and the renderer never receives it): /api/vault/main/status|list|store|
//   rotate|delete|import|shutdown. This is how bridge.cred* (through main's IPC handlers) and the safeStorage
//   migration reach the vault, and how main runs the graceful vault cleanup (vault_lifecycle.ts) before it
//   kills the engine; a headless engine has no main, so these answer 403. Every reply to an
//   authenticated main request carries `x-lucid-vault-mac` (HMAC-SHA256 over the request nonce and the
//   reply body; layout in cred_engine_client.ts), which main verifies before trusting the reply.
//   What the vault token protects is that channel (the migration, which deletes safeStorage sources, and
//   main's file-picker credential path), NOT the ref namespace: the UI routes can write, rotate and delete
//   legacy refs too, and the Settings vault list relies on that.
//
// None of these paths is in dev.ts AGENT_ROUTES or QUERY_TOKEN_ROUTES, and this module re-checks the
// header token itself (a `?t=` query token is never accepted here), so the agent token cannot reach
// them even if a route list were widened by mistake. Responses carry metadata only (VaultEntryMeta,
// CredView, counts): a secret value is accepted on the way in and never written to a response, a log
// line or an event. Shape: `{ ok: true, data }` or `{ ok: false, error }` with a 4xx/5xx status.

import { realpathSync } from "node:fs";
import { hmacSha256, sha256 } from "../harness/crypto/fips_crypto.ts"; // P-FIPS.1 (ADR-0473): Contract A
import {
  VAULT_AUTH_HEADER, VAULT_MAC_HEADER, VAULT_NONCE_HEADER, vaultRequestMac, vaultResponseMac, type MacPrimitives,
} from "./cred_engine_client.ts"; // the one definition of the main <-> engine MAC layout
import { isValidRef } from "./cred_vault.ts";
import { isEnvName, VAULT_KINDS, type VaultKind } from "./engine_vault.ts";
import { mayHoldGlobalEnv } from "./env_name_policy.ts";
import { tokenValid } from "./origin_guard.ts";
import { applyVaultEnv } from "./vault_env.ts";
import { handleVaultDestRoutes } from "./vault_dest_routes.ts"; // P-VAULT-DEST.1 (ADR-0478): /api/vault/destinations*, /push, /pull
import { handleVaultEnvRoutes } from "./vault_env_routes.ts";
import { vaultShutdownCleanup } from "./vault_lifecycle.ts";
import {
  credList, credViewOf, importLegacyCredential, isVaultRef, mintCredRef, vaultDelete, vaultGet, vaultList, vaultPut, vaultRotate,
  vaultStatus, workspaceRef,
} from "./vault_store.ts";

const MAIN_VAULT_TOKEN = process.env.LUCID_VAULT_MAIN_TOKEN ?? "";
delete process.env.LUCID_VAULT_MAIN_TOKEN;

const FIPS_MAC: MacPrimitives = { hmac: hmacSha256, sha256 };
export const VAULT_UI_ROUTES: readonly string[] = ["/api/vault/list", "/api/vault/put", "/api/vault/rotate", "/api/vault/delete"];
export const VAULT_MAIN_ROUTES: readonly string[] = [
  "/api/vault/main/status", "/api/vault/main/list", "/api/vault/main/store", "/api/vault/main/rotate", "/api/vault/main/delete", "/api/vault/main/import",
  "/api/vault/main/shutdown",
];

export interface VaultRouteCtx {
  /** The engine's UI token (dev.ts TOKEN). */
  uiToken: string;
  /** Test seam: the main-only vault token. dev.ts never passes it (the adopted env value is used). */
  mainToken?: string;
}

const reply = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const ok = (data: unknown): Response => reply(200, { ok: true, data });
const fail = (status: number, error: string): Response => reply(status, { ok: false, error });
const errText = (e: unknown): string => String((e as Error)?.message ?? e).slice(0, 240);

async function body(req: Request): Promise<Record<string, unknown>> {
  const raw: unknown = await req.json().catch(() => null);
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const kindOf = (v: unknown): VaultKind | null => VAULT_KINDS.find((k) => k === v) ?? null;

/** After a write: re-resolve the engine-side credential env (vault_env.ts), and keep a settings-style
 *  `key:<ENV>` ref live in process.env the way settings_store.setKey does, unless the name is reserved
 *  (env_name_policy.ts: a reserved name is neither set nor unset here). Never fails the write. */
export function afterWrite(ref: string): void {
  try {
    if (ref.startsWith("key:") && mayHoldGlobalEnv(ref.slice(4))) {
      const v = vaultGet(ref);
      if (v) process.env[ref.slice(4)] = v;
      else delete process.env[ref.slice(4)];
    }
    applyVaultEnv();
  } catch (e) {
    console.error(`[vault] env refresh after a vault write failed: ${errText(e)}`);
  }
}

/** The ref a UI put lands under when it names none: `key:<ENV>` (or the workspace-scoped `ws:` ref) for
 *  an env name, else `secret:<label slug>`, suffixed until it is free (a label never clobbers an entry). */
export function derivedRef(envName: string, workspace: string | undefined, label: string): string {
  if (envName) return workspace ? workspaceRef(workspace, envName) : `key:${envName}`;
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "secret";
  const taken = new Set(vaultList().map((m) => m.ref));
  let ref = `secret:${slug}`;
  for (let n = 2; taken.has(ref); n++) ref = `secret:${slug}_${n}`;
  return ref;
}

async function uiRoute(req: Request, p: string): Promise<Response | null> {
  if (p === "/api/vault/list") {
    if (req.method !== "GET") return fail(405, "method not allowed");
    return ok({ status: vaultStatus(), entries: vaultList() });
  }
  if (p === "/api/vault/put") {
    if (req.method !== "POST") return fail(405, "method not allowed");
    const b = await body(req);
    const value = str(b.value);
    const kind = kindOf(b.kind);
    const envName = str(b.envName).trim();
    const label = str(b.label).trim();
    if (!value) return fail(400, "a value is required");
    if (!kind) return fail(400, "unknown secret kind");
    if (envName && !isEnvName(envName)) return fail(400, "invalid environment variable name");
    if (!str(b.ref) && !envName && !label) return fail(400, "a ref, an env name or a label is required");
    let workspace: string | undefined;
    if (str(b.workspace)) {
      try { workspace = realpathSync(str(b.workspace)); } catch { return fail(400, "the workspace folder does not exist"); }
    }
    const ref = str(b.ref) || derivedRef(envName, workspace, label);
    if (!isVaultRef(ref)) return fail(400, "invalid vault ref");
    try {
      const meta = vaultPut({
        ref, value, kind, label: label || envName || undefined, source: "typed",
        scope: workspace ? { workspace } : undefined, envName: envName || undefined,
        expiresAt: num(b.expiresAt), rotationIntervalDays: num(b.rotationIntervalDays),
      });
      afterWrite(ref);
      return ok(meta);
    } catch (e) { return fail(500, `the secret was not stored: ${errText(e)}`); }
  }
  if (p === "/api/vault/rotate") {
    if (req.method !== "POST") return fail(405, "method not allowed");
    const b = await body(req);
    const ref = str(b.ref);
    if (!isVaultRef(ref)) return fail(400, "invalid vault ref");
    if (!str(b.value)) return fail(400, "a value is required");
    try {
      const meta = vaultRotate(ref, str(b.value), { expiresAt: num(b.expiresAt) });
      if (!meta) return fail(404, "not-found");
      afterWrite(ref);
      return ok(meta);
    } catch (e) { return fail(500, `the secret was not rotated: ${errText(e)}`); }
  }
  if (p === "/api/vault/delete") {
    if (req.method !== "POST") return fail(405, "method not allowed");
    const ref = str((await body(req)).ref);
    if (!isVaultRef(ref)) return fail(400, "invalid vault ref");
    try {
      const deleted = vaultDelete(ref);
      if (deleted) afterWrite(ref);
      return ok({ deleted });
    } catch (e) { return fail(500, `the secret was not deleted: ${errText(e)}`); }
  }
  return null;
}

/** `b` is the request body, already read (and covered by the verified request MAC). */
function mainRoute(req: Request, p: string, b: Record<string, unknown>): Response | null {
  if (p === "/api/vault/main/status") {
    const s = vaultStatus();
    return ok({ available: s.state === "ok", custody: s.custody, state: s.state, fips: s.crypto.fips, entries: s.entries });
  }
  if (p === "/api/vault/main/list") return ok(credList());
  if (req.method !== "POST") return VAULT_MAIN_ROUTES.includes(p) ? fail(405, "method not allowed") : null;
  if (p === "/api/vault/main/store") {
    const secret = str(b.secret);
    if (!secret) return fail(400, "empty-secret");
    const kind = kindOf(b.kind) ?? "other";
    const ref = str(b.ref) || mintCredRef(kind);
    if (!isValidRef(ref)) return fail(400, "invalid-ref");
    try {
      const meta = vaultPut({ ref, value: secret, kind, label: str(b.label) || undefined, source: "typed", expiresAt: num(b.expiresAt), rotationIntervalDays: num(b.rotationIntervalDays) });
      afterWrite(ref);
      return ok(credViewOf(meta));
    } catch (e) { return fail(500, errText(e)); }
  }
  if (p === "/api/vault/main/rotate") {
    const ref = str(b.ref);
    if (!isValidRef(ref)) return fail(404, "not-found");
    if (!str(b.secret)) return fail(400, "empty-secret");
    try {
      const meta = vaultRotate(ref, str(b.secret), { expiresAt: num(b.expiresAt) });
      if (!meta) return fail(404, "not-found");
      afterWrite(ref);
      return ok(credViewOf(meta));
    } catch (e) { return fail(500, errText(e)); }
  }
  if (p === "/api/vault/main/delete") {
    const ref = str(b.ref);
    if (!isValidRef(ref)) return ok({ deleted: false });
    try {
      const deleted = vaultDelete(ref);
      if (deleted) afterWrite(ref);
      return ok({ deleted });
    } catch (e) { return fail(500, errText(e)); }
  }
  // Security review VAULT-ENV-MATERIALIZE-SYNCED: main calls this before it kills the engine on quit (a
  // Windows kill runs no exit handler), so temporarily written `.env` values and temp dirs go first.
  if (p === "/api/vault/main/shutdown") return ok(vaultShutdownCleanup());
  if (p === "/api/vault/main/import") {
    const ref = str(b.ref);
    const value = str(b.value);
    if (!isValidRef(ref) || !value) return fail(400, "a valid ref and a value are required");
    const meta = b.meta && typeof b.meta === "object" ? (b.meta as Record<string, unknown>) : {};
    try {
      const r = importLegacyCredential(ref, value, meta);
      afterWrite(ref);
      return ok({ ref, outcome: r.outcome, verified: true });
    } catch (e) { return fail(500, errText(e)); }
  }
  return null;
}

/** Dispatch `/api/vault/*`. Null for any other path (and for an unknown /api/vault/ path, so a later
 *  slice's own module can serve it). */
export async function handleVaultRoutes(req: Request, p: string, ctx: VaultRouteCtx): Promise<Response | null> {
  if (!p.startsWith("/api/vault/")) return null;
  const dr = await handleVaultDestRoutes(req, p, ctx); if (dr) return dr; // P-VAULT-DEST.1 (ADR-0478)
  const envRoute = await handleVaultEnvRoutes(req, p, ctx); if (envRoute) return envRoute; // P-VAULT-ENV.1 (ADR-0477)
  const isMain = p.startsWith("/api/vault/main/");
  if (!isMain && !VAULT_UI_ROUTES.includes(p)) return null;
  if (!tokenValid(req.headers.get("x-lucid-token"), ctx.uiToken)) return fail(403, "forbidden");
  if (!isMain) {
    try { return await uiRoute(req, p); } catch (e) { return fail(500, errText(e)); }
  }
  // Main-only (security review VAULT-TRANSPORT-LOCALHOST): the request must carry a fresh nonce and a MAC
  // under the vault token (the token itself is never sent), and every reply to it is signed, so Electron
  // main can tell this engine's answer from any other peer's. A request that fails here gets an unsigned
  // 403, which main treats as a refusal.
  const token = ctx.mainToken ?? MAIN_VAULT_TOKEN;
  const nonceHex = req.headers.get(VAULT_NONCE_HEADER) ?? "";
  if (!token || !/^[0-9a-f]{64}$/.test(nonceHex)) return fail(403, "forbidden");
  const nonce = Buffer.from(nonceHex, "hex");
  let raw: Buffer;
  try { raw = Buffer.from(await req.arrayBuffer()); } catch { return fail(400, "unreadable request body"); }
  let res: Response | null;
  try {
    const expected = vaultRequestMac(FIPS_MAC, token, req.method, p, nonce, raw).toString("hex");
    if (!tokenValid(req.headers.get(VAULT_AUTH_HEADER), expected)) return fail(403, "forbidden");
    let parsed: unknown = null;
    try { parsed = raw.length ? JSON.parse(raw.toString("utf8")) : null; } catch { /* not JSON: treated as an empty body */ }
    const b = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    res = mainRoute(req, p, b);
  } catch (e) {
    res = fail(500, errText(e));
  }
  if (!res) return null;
  try {
    const out = Buffer.from(await res.arrayBuffer());
    const headers = new Headers(res.headers);
    headers.set(VAULT_MAC_HEADER, vaultResponseMac(FIPS_MAC, token, nonce, out).toString("hex"));
    return new Response(new Uint8Array(out), { status: res.status, headers });
  } catch (e) {
    return fail(500, `the reply could not be signed: ${errText(e)}`); // unsigned: main refuses it (fail-closed)
  }
}
