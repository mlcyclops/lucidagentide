// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/vault_dest_routes.ts
//
// P-VAULT-DEST.1 (ADR-0478): the enterprise destinations over HTTP, chained from vault_routes.ts with one
// line (`const dr = await handleVaultDestRoutes(req, p, ctx); if (dr) return dr;`). Every path below is
// UI header token only, exactly like the Contract B vault routes: none is in dev.ts AGENT_ROUTES or
// QUERY_TOKEN_ROUTES and this module re-checks the `x-lucid-token` header itself (a `?t=` query token
// is never accepted), so the agent cannot push, pull or reconfigure destinations.
//
//   GET  /api/vault/destinations                 -> DestinationsView (add-on status + non-secret destinations)
//   POST /api/vault/destinations/save            { id?, name, kind, config, autoBackup? } -> VaultDestination
//   POST /api/vault/destinations/remove          { id } -> { removed }
//   POST /api/vault/destinations/auto-backup     { id, on } -> VaultDestination
//   POST /api/vault/destinations/check           { id } -> { ok, detail }
//   POST /api/vault/destinations/list            { id } -> DestinationListResult (names, refs, dates; no values)
//   POST /api/vault/push                         { id, refs? } -> DestinationPushResult (refs, names, versions)
//   POST /api/vault/pull                         { id, refs? } -> DestinationPullResult (counts, refs)
//
// Without the add-on every write and connector route answers 409 "Enterprise add-on not installed".
// A connector outcome (ok or not) is a 200 with its own `ok` and a value-free `detail`. Shape:
// `{ ok: true, data }` or `{ ok: false, error }`, the vault_routes.ts convention.

import { tokenValid } from "./origin_guard.ts";
import {
  checkDestination, DestinationError, destinationsView, listDestination, pullFromDestination, pushToDestination,
  removeVaultDestination, setVaultDestinationAutoBackup, upsertVaultDestination, validateDestinationInput,
} from "./vault_destinations.ts";
import { connectorStatus } from "./addon_seam.ts";

export const VAULT_DEST_ROUTES: readonly string[] = [
  "/api/vault/destinations", "/api/vault/destinations/save", "/api/vault/destinations/remove", "/api/vault/destinations/auto-backup",
  "/api/vault/destinations/check", "/api/vault/destinations/list", "/api/vault/push", "/api/vault/pull",
];

export interface VaultDestRouteCtx {
  /** The engine's UI token (dev.ts TOKEN). */
  uiToken: string;
}

const reply = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const fail = (status: number, error: string): Response => reply(status, { ok: false, error });

async function body(req: Request): Promise<Record<string, unknown>> {
  const raw: unknown = await req.json().catch(() => null);
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

/** `refs` when the body names some (strings only), else undefined (= every entry). */
function refsOf(b: Record<string, unknown>): string[] | undefined {
  return Array.isArray(b.refs) ? b.refs.filter((r): r is string => typeof r === "string") : undefined;
}

async function route(req: Request, p: string): Promise<Response> {
  if (p === "/api/vault/destinations") {
    if (req.method !== "GET") return fail(405, "method not allowed");
    return reply(200, { ok: true, data: destinationsView() });
  }
  if (req.method !== "POST") return fail(405, "method not allowed");
  const b = await body(req);
  const id = typeof b.id === "string" ? b.id : "";
  const ok = (data: unknown): Response => reply(200, { ok: true, data });
  // Removing a stored (non-secret) destination needs no connector, so it works with the add-on gone.
  if (p === "/api/vault/destinations/remove") return ok({ removed: removeVaultDestination(id) });
  const st = connectorStatus("kms");
  if (!st.installed) return fail(409, `Enterprise add-on not installed: ${st.note}`);
  switch (p) {
    case "/api/vault/destinations/save":
      return ok(upsertVaultDestination(validateDestinationInput(b)));
    case "/api/vault/destinations/auto-backup": {
      const d = setVaultDestinationAutoBackup(id, b.on === true);
      return d ? ok(d) : fail(404, "unknown destination");
    }
    case "/api/vault/destinations/check":
      return ok(await checkDestination(id));
    case "/api/vault/destinations/list":
      return ok(await listDestination(id));
    case "/api/vault/push":
      return ok(await pushToDestination(id, refsOf(b)));
    case "/api/vault/pull":
      return ok(await pullFromDestination(id, refsOf(b)));
    default:
      return fail(404, "not found");
  }
}

/** Dispatch the destination routes. Null for any other path, so vault_routes.ts carries on. */
export async function handleVaultDestRoutes(req: Request, p: string, ctx: VaultDestRouteCtx): Promise<Response | null> {
  if (!VAULT_DEST_ROUTES.includes(p)) return null;
  if (!tokenValid(req.headers.get("x-lucid-token"), ctx.uiToken)) return fail(403, "forbidden");
  try {
    return await route(req, p);
  } catch (e) {
    if (e instanceof DestinationError) return fail(e.status, e.message.slice(0, 400));
    // CodeQL #121 (js/stack-trace-exposure, P-SEC.1): an Error's message only, never the thrown value or stack.
    return fail(500, e instanceof Error ? e.message.slice(0, 300) : "internal error");
  }
}
