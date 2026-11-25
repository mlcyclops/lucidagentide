// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/session_transfer_routes.ts
//
// P-SESSXFER.1 (ADR-0682): session history export and import over HTTP (the core is session_transfer.ts). dev.ts
// chains this beside the vault backup routes:
//   const sx = await handleSessionTransferRoutes(req, p, { uiToken: TOKEN, ... }); if (sx) return sx;
//
//   GET  /api/sessions/transfer                                   -> { project, sessions, lanes: [{ id, name, sessions }] }
//   POST /api/sessions/export { scope, marking?, includeImages? } -> { ok, file, filename, payloadSha256, exported, blocked, report } | { ok: false, error }
//        scope = { kind: "project" } | { kind: "lane", laneId } | { kind: "sessions", ids }
//   POST /api/sessions/import { file }                            -> { ok, imported, skipped, conflicts, blocked, failed } | { ok: false, error }
//
// UI token only, header only: none of these paths is in dev.ts AGENT_ROUTES or QUERY_TOKEN_ROUTES, and this module
// re-checks the header token itself, so an agent can neither read the whole history out nor write sessions in.
// Everything is local: no network call, no account. A refusal the user should read (a blocked session, a changed
// file, a dead scanner) is `{ ok: true, data: { ok: false, error } }`, so the renderer's bridge keeps its words.

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { DEFAULT_POLICY, scanAndDecide } from "../harness/security/gate.ts";
import { kbScanner } from "./kb_store.ts";
import { tokenValid } from "./origin_guard.ts";
import { exportHistory, importHistory, MAX_HISTORY_BYTES, SESSION_ID, type Decide, type ExportSource, type HistoryScope } from "./session_transfer.ts";
import { sessionFilePath, sessionsRoot, workspaceChatIds } from "./sessions.ts";
import { APP_VERSION } from "./version.ts";
import { currentWorkspace } from "./workspace.ts";

export const SESSION_TRANSFER_ROUTES: readonly string[] = ["/api/sessions/transfer", "/api/sessions/export", "/api/sessions/import"];
/** The file travels JSON-escaped inside the request body: at most twice its size, plus the envelope. */
const MAX_BODY = 2 * MAX_HISTORY_BYTES + 4096;
const MAX_IDS = 5000;

export interface SessionTransferRouteCtx {
  /** The engine's UI token (dev.ts TOKEN). */
  uiToken: string;
  /** Lift the server's idle timeout for this request (dev.ts srv.timeout(req, 0)): a large export scans for a while. */
  holdOpen?: (req: Request) => void;
  /** The fleet lanes this engine runs now (dev.ts fleet.owners()). */
  lanes: () => readonly { id: string; name: string }[];
  /** Every session a lane ran (the lane-session ledger plus the session it holds now). */
  laneSessionIds: (laneId: string) => string[];
  /** Test seams. */
  root?: string;
  cwd?: () => string;
  decide?: Decide;
  now?: () => string;
}

const reply = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const fail = (status: number, error: string): Response => reply(status, { ok: false, error });

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

/** The ids a scope names, and the scope as the manifest records it. Null = a malformed scope. */
async function scopeIds(v: unknown, ctx: SessionTransferRouteCtx, cwd: string, root: string): Promise<{ ids: string[]; scope: HistoryScope; project: boolean } | null> {
  if (!v || typeof v !== "object" || !("kind" in v)) return null;
  if (v.kind === "project") return { ids: await workspaceChatIds(cwd, root), scope: { kind: "project" }, project: true };
  if (v.kind === "lane" && "laneId" in v && typeof v.laneId === "string" && v.laneId) {
    const laneId = v.laneId;
    const lane = ctx.lanes().find((l) => l.id === laneId);
    return { ids: ctx.laneSessionIds(laneId), scope: { kind: "lane", lane: lane?.name ?? laneId }, project: false };
  }
  if (v.kind === "sessions" && "ids" in v && Array.isArray(v.ids)) {
    const ids = v.ids.filter((x): x is string => typeof x === "string" && SESSION_ID.test(x)).slice(0, MAX_IDS);
    return { ids, scope: { kind: "sessions" }, project: false };
  }
  return null;
}

/** Dispatch the transfer routes. Null for any other path. */
export async function handleSessionTransferRoutes(req: Request, p: string, ctx: SessionTransferRouteCtx): Promise<Response | null> {
  if (!SESSION_TRANSFER_ROUTES.includes(p)) return null;
  if (!tokenValid(req.headers.get("x-lucid-token"), ctx.uiToken)) return fail(403, "forbidden");
  const root = ctx.root ?? sessionsRoot();
  const cwd = (ctx.cwd ?? currentWorkspace)();
  const decide: Decide = ctx.decide ?? ((t: string) => scanAndDecide(kbScanner(), t, DEFAULT_POLICY));

  if (p === "/api/sessions/transfer") {
    if (req.method !== "GET") return fail(405, "method not allowed");
    const lanes = ctx.lanes().map((l) => ({ id: l.id, name: l.name, sessions: ctx.laneSessionIds(l.id).length }));
    return reply(200, { ok: true, data: { project: basename(cwd), sessions: (await workspaceChatIds(cwd, root)).length, lanes } });
  }

  if (req.method !== "POST") return fail(405, "method not allowed");
  ctx.holdOpen?.(req);
  const b = await jsonBody(req);
  if (!b) return fail(400, "a JSON body is required");

  if (p === "/api/sessions/export") {
    const sel = await scopeIds(b.scope, ctx, cwd, root);
    if (!sel) return fail(400, "scope must be { kind: \"project\" }, { kind: \"lane\", laneId } or { kind: \"sessions\", ids }");
    const sources: ExportSource[] = [];
    for (const id of new Set(sel.ids)) {
      const file = sessionFilePath(id, root);
      if (!file) continue;
      try { sources.push({ id, content: readFileSync(file, "utf8") }); } catch { /* unreadable now: it is not in the file */ }
    }
    const r = await exportHistory(sources, {
      createdAt: (ctx.now ?? (() => new Date().toISOString()))(),
      appVersion: APP_VERSION,
      project: basename(cwd),
      scope: sel.scope,
      marking: typeof b.marking === "string" ? b.marking : "",
      includeImages: b.includeImages === true,
      skipThrowaways: sel.project,
      decide,
    });
    return reply(200, { ok: true, data: r });
  }

  const file = typeof b.file === "string" ? b.file : null;
  if (!file) return fail(400, "a history file is required");
  const r = await importHistory(file, { cwd, root, decide, ...(ctx.now ? { now: ctx.now } : {}) });
  return reply(200, { ok: true, data: r });
}
