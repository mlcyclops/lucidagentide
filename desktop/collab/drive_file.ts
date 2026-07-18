// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/collab/drive_file.ts — P-REMOTE.10 (ADR-0233): a tiny Google Drive REST client for the single
// relay-codes file, scoped to `drive.file` (LUCID can touch ONLY files it created/opened — NEVER the rest of
// the user's Drive; Google enforces this). Every call takes an injected `fetch` + a `drive.file` access token,
// so the whole client is unit-tested headless against a mock Drive, and the OAuth token acquisition stays a
// separate seam. Fail-closed: a non-2xx response throws (the caller treats "unavailable" as "no reconnect").

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
export const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";

function authHeaders(token: string, extra?: Record<string, string>): Record<string, string> {
  return { authorization: `Bearer ${token}`, ...(extra ?? {}) };
}

/** The id of the first file in a Drive `files.list` response, or null (unknown-narrowed, no `any`). */
async function firstFileId(resp: Response): Promise<string | null> {
  const body: unknown = await resp.json().catch(() => null);
  if (!body || typeof body !== "object" || !("files" in body)) return null;
  const files = body.files;
  if (!Array.isArray(files) || files.length === 0) return null;
  const f: unknown = files[0];
  return !!f && typeof f === "object" && "id" in f && typeof f.id === "string" ? f.id : null;
}

/** Find the app's relay-codes file (drive.file only sees files WE created). `name` is a fixed constant, not
 *  user input, so the `q` literal carries no injection risk. */
export async function findRelayFile(token: string, name: string, fetchImpl: FetchLike): Promise<string | null> {
  const q = encodeURIComponent(`name='${name}' and trashed=false`);
  const url = `https://www.googleapis.com/drive/v3/files?q=${q}&spaces=drive&fields=files(id,name)&pageSize=5`;
  const resp = await fetchImpl(url, { headers: authHeaders(token) });
  if (!resp.ok) throw new Error(`drive list failed (${resp.status})`);
  return firstFileId(resp);
}

/** Create the relay-codes file in the user's Drive (multipart: metadata + JSON media). Returns its id. */
export async function createRelayFile(token: string, name: string, content: string, fetchImpl: FetchLike): Promise<string> {
  const boundary = `lucidrelay${Math.random().toString(36).slice(2)}`;
  const metadata = JSON.stringify({ name, mimeType: "application/json" });
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`
    + `--${boundary}\r\nContent-Type: application/json\r\n\r\n${content}\r\n--${boundary}--`;
  const resp = await fetchImpl("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id", {
    method: "POST", headers: authHeaders(token, { "content-type": `multipart/related; boundary=${boundary}` }), body,
  });
  if (!resp.ok) throw new Error(`drive create failed (${resp.status})`);
  const j: unknown = await resp.json().catch(() => null);
  if (!!j && typeof j === "object" && "id" in j && typeof j.id === "string") return j.id;
  throw new Error("drive create: response had no file id");
}

export async function readRelayFile(token: string, fileId: string, fetchImpl: FetchLike): Promise<string> {
  const resp = await fetchImpl(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`, { headers: authHeaders(token) });
  if (!resp.ok) throw new Error(`drive read failed (${resp.status})`);
  return resp.text();
}

export async function updateRelayFile(token: string, fileId: string, content: string, fetchImpl: FetchLike): Promise<void> {
  const resp = await fetchImpl(`https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=media&fields=id`, {
    method: "PATCH", headers: authHeaders(token, { "content-type": "application/json" }), body: content,
  });
  if (!resp.ok) throw new Error(`drive update failed (${resp.status})`);
}

/** Grant a teammate access to JUST this one file (Drive-native, per-file, revocable). Default writer so they
 *  can append their own reconnect codes; pass "reader" for read-only. */
export async function shareRelayFile(token: string, fileId: string, email: string, fetchImpl: FetchLike, role: "reader" | "writer" = "writer"): Promise<void> {
  const resp = await fetchImpl(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/permissions?fields=id`, {
    method: "POST", headers: authHeaders(token, { "content-type": "application/json" }),
    body: JSON.stringify({ type: "user", role, emailAddress: email }),
  });
  if (!resp.ok) throw new Error(`drive share failed (${resp.status})`);
}

/** Find-or-create the relay-codes file; returns its id (create uses `initialContent` when it doesn't exist). */
export async function ensureRelayFile(token: string, name: string, initialContent: string, fetchImpl: FetchLike): Promise<string> {
  const existing = await findRelayFile(token, name, fetchImpl);
  return existing ?? createRelayFile(token, name, initialContent, fetchImpl);
}
