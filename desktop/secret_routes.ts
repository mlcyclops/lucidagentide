// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/secret_routes.ts
//
// P-SECRET-INTAKE.1 (ADR-0476): /api/secret/* over HTTP. dev.ts dispatches every request here once
// (`const sr = await handleSecretRoutes(req, p, {...}); if (sr) return sr;`); any other path returns null.
//
//   Agent (query token = the AGENT token; the only /api/secret route in dev.ts AGENT_ROUTES):
//     POST /api/secret/request        { name, kind, purpose, envName?, workspaceScoped? }   opens a request
//                                     { id }                    polls it      { id, withdraw: true }  Stop
//                                     -> { stored: true, ref, envName } | { stored: false, reason }
//                                        | { pending: true, id } after a SECRET_HOLD_MS hold (poll again)
//   UI (header UI token only; a `?t=` query token is never accepted here):
//     GET  /api/secret/pending        -> { requests: SecretRequestView[] }
//     POST /api/secret/submit         { id, value }      -> stored metadata (ref, kind, label, envName, last4)
//     POST /api/secret/submit-file    { id, path }       -> same; the ENGINE reads the picked file
//     POST /api/secret/cancel         { id }             -> { cancelled }
//     POST /api/secret/fallback       { id }             -> { path } (the user-only text file, now open)
//     POST /api/secret/fallback/wait  { id }             -> stored metadata, once the file was read and wiped
//     GET  /api/secret/manager        -> { enterprise, note, preference }
//     POST /api/secret/manager        { answer, name?, config? } -> SecretManagerOutcome
// A value is accepted on the way in and never written to a response, an event, an audit record or a log.
// Shape: `{ ok: true, data }` or `{ ok: false, error, code? }` with a 4xx/5xx status.

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute } from "node:path";
import { connectorStatus } from "./addon_seam.ts";
import { tokenValid } from "./origin_guard.ts";
import { decodeSecretFile, MAX_SECRET_FILE_BYTES } from "./secret_fallback.ts";
import {
  defaultIntakeDeps, readSecretManagerPreference, recordSecretManager, secretManagerPrefFile, SecretIntake,
  type DestinationStore, type SubmitOutcome,
} from "./secret_intake.ts";
import type { SecretRequestView } from "./secret_intake_view.ts";

export const SECRET_AGENT_ROUTE = "/api/secret/request";
/** How long one agent poll is held before it answers `{ pending: true, id }`. */
export const SECRET_HOLD_MS = 25_000;
export const SECRET_UI_ROUTES: readonly string[] = [
  "/api/secret/pending", "/api/secret/submit", "/api/secret/submit-file", "/api/secret/cancel",
  "/api/secret/fallback", "/api/secret/fallback/wait", "/api/secret/manager",
];

export interface SecretRouteCtx {
  /** dev.ts TOKEN (renderer). */
  uiToken: string;
  /** dev.ts AGENT_TOKEN (the omp child's own token). */
  agentToken: string;
  /** Bun's server, to lift the 60 s idle timeout on /fallback/wait (the renderer waits for the user's save). */
  srv?: { timeout(req: Request, seconds: number): void };
  /** Show the dialog: acp_backend.requestSecretDialog. */
  emit(view: SecretRequestView): void;
  /** P-VAULT-DEST.1's destination store, once wired. */
  destinations?: DestinationStore | null;
  /** Test seam: the intake instance (default: one per engine process). */
  intake?: SecretIntake;
  /** Test seam: the agent poll hold (default SECRET_HOLD_MS). */
  holdMs?: number;
}

let emitTo: ((view: SecretRequestView) => void) | null = null;
let shared: SecretIntake | null = null;
/** The engine's one intake. Its emit goes through the latest ctx, so dev.ts can pass a fresh closure. */
function engineIntake(ctx: SecretRouteCtx): SecretIntake {
  emitTo = ctx.emit;
  shared ??= new SecretIntake(defaultIntakeDeps((view) => emitTo?.(view)));
  return shared;
}

const reply = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const ok = (data: unknown): Response => reply(200, { ok: true, data });
const fail = (status: number, error: string, code?: string): Response => reply(status, { ok: false, error, ...(code ? { code } : {}) });

async function body(req: Request): Promise<Record<string, unknown>> {
  const raw: unknown = await req.json().catch(() => null);
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Metadata the dialog may show after a store: never the value (last-4 is the UI-only hint). */
function stored(s: SubmitOutcome): Response {
  if (s.ok) return ok({ stored: true, ref: s.meta.ref, kind: s.meta.kind, label: s.meta.label, envName: s.meta.envName ?? null, last4: s.meta.last4 ?? null });
  return fail(s.code === "not-found" ? 404 : s.code === "empty" ? 400 : 500, s.error, s.code);
}

/** Read a file the user picked, straight into memory for the vault: absolute path, a regular file, at most
 *  MAX_SECRET_FILE_BYTES. The buffer is zeroed after decoding. `{ error }` when refused. */
export function readPickedSecretFile(path: string): { text: string } | { error: string } {
  if (!path || !isAbsolute(path)) return { error: "pick a file" };
  let fd: number;
  try { fd = openSync(path, "r"); } catch { return { error: "the file could not be opened" }; }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { error: "that is not a file" };
    if (st.size > MAX_SECRET_FILE_BYTES) return { error: "the file is larger than a secret should be" };
    const buf = Buffer.alloc(st.size);
    let at = 0;
    while (at < buf.length) {
      const n = readSync(fd, buf, at, buf.length - at, at);
      if (n <= 0) break;
      at += n;
    }
    const text = decodeSecretFile(buf.subarray(0, at));
    buf.fill(0);
    return { text };
  } catch {
    return { error: "the file could not be read" };
  } finally {
    closeSync(fd);
  }
}

/** Dispatch `/api/secret/*`. Null for any other path. */
export async function handleSecretRoutes(req: Request, p: string, ctx: SecretRouteCtx): Promise<Response | null> {
  if (!p.startsWith("/api/secret/")) return null;
  const intake = ctx.intake ?? engineIntake(ctx);
  if (p === SECRET_AGENT_ROUTE) {
    if (!tokenValid(new URL(req.url).searchParams.get("t"), ctx.agentToken)) return fail(403, "forbidden");
    if (req.method !== "POST") return fail(405, "method not allowed");
    const b = await body(req);
    let id = str(b.id);
    if (id && b.withdraw === true) { intake.withdraw(id); return ok({ stored: false, reason: "cancelled" }); }
    if (!id) {
      const opened = intake.open(b);
      if ("result" in opened) return ok(opened.result);
      id = opened.id;
    }
    // One short hold (below Bun's 60 s idle limit and any fetch timeout); the tool polls again on `pending`.
    return ok((await intake.wait(id, ctx.holdMs ?? SECRET_HOLD_MS)) ?? { pending: true, id });
  }
  if (!SECRET_UI_ROUTES.includes(p)) return null;
  if (!tokenValid(req.headers.get("x-lucid-token"), ctx.uiToken)) return fail(403, "forbidden");
  try {
    if (p === "/api/secret/pending") return ok({ requests: intake.pending() });
    if (p === "/api/secret/manager" && req.method === "GET") {
      const kms = connectorStatus("kms");
      return ok({ enterprise: kms.installed, note: kms.note, preference: readSecretManagerPreference() });
    }
    if (req.method !== "POST") return fail(405, "method not allowed");
    const b = await body(req);
    const id = str(b.id);
    if (p === "/api/secret/submit") return stored(intake.submit(id, str(b.value), "dialog"));
    if (p === "/api/secret/submit-file") {
      const r = readPickedSecretFile(str(b.path));
      if ("error" in r) return fail(400, r.error, "file");
      return stored(intake.submit(id, r.text, "file"));
    }
    if (p === "/api/secret/cancel") return ok({ cancelled: intake.cancel(id) });
    if (p === "/api/secret/fallback") {
      const r = intake.startFallback(id);
      return r.ok ? ok({ path: r.path }) : fail(409, r.error, "fallback");
    }
    if (p === "/api/secret/fallback/wait") {
      ctx.srv?.timeout(req, 0);
      const r = await intake.awaitFallback(id);
      return r.ok ? stored(r) : fail(409, r.error, "fallback");
    }
    if (p === "/api/secret/manager") {
      return ok(recordSecretManager(b, { kmsInstalled: connectorStatus("kms").installed, store: ctx.destinations ?? null, file: secretManagerPrefFile(), now: Date.now() }));
    }
    return null;
  } catch (e) {
    return fail(500, String((e as Error)?.message ?? e).slice(0, 240));
  }
}
