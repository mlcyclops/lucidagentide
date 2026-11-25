// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/session_transfer.ts - P-SESSXFER.1 (ADR-0682): session history export and import, offline, in one
// portable file a cross domain solution (CDS) guard can inspect. The routes live in session_transfer_routes.ts.
//
// THE FILE (`<project>-<date>.lucidhistory.json`, format `lucid-history/1`, docs/SESSION-HISTORY-TRANSFER.md):
//   - plain JSON, never compressed or encrypted, every byte printable 7-bit ASCII or LF (non-ASCII is written as
//     \uXXXX escapes, C0/C1 controls other than tab and newline are stripped from text first);
//   - deterministic: keys sorted at every level, sessions sorted by id, no volatile field beyond `created_at`, so the
//     same sessions exported with the same `created_at` give byte-identical files (two-person review, repeatable hash);
//   - an allowlist of content: user and assistant text, thinking text, tool calls (name, arguments as JSON text) and
//     tool results as text (very large results truncated with a marker), timestamps, model ids. Images only when the
//     user turns them on (png, jpeg, webp, size-capped, magic bytes checked); otherwise an `omitted` part;
//   - no absolute home path (the user's home folder becomes `~` in every text) and secrets shaped like keys or tokens
//     are redacted (ask_lucid_screen.redactSecrets); the project is named by its folder's basename only;
//   - integrity: sha256 of each session's canonical JSON in the manifest, and sha256 of the canonical sessions array.
//     No signature: kb_pack's Ed25519 signing is bound to its pack-key set and pack manifest, and a CDS checks
//     content, not origin (ADR-0682).
//
// THE GATES. Export scans every text field with the Unicode scanner: a finding blocks that session, an unreachable
// scanner blocks the export (fail-closed), so a file never carries a payload a guard would reject. Import checks, in
// order: size, ASCII-only bytes, JSON, format and a strict schema (no unknown key anywhere), per-session and payload
// sha256, then the scanner on every text field (a finding quarantines that session and logs it to the Security
// panel; an unreachable scanner imports nothing). Clean sessions are written as NEW omp transcripts in the current
// project's session folder, ids kept (invariant 9): an identical session already present is skipped, a different
// one with the same id is a conflict and is never overwritten. Each written session carries an `untrusted`
// provenance entry (sessions.IMPORTED_SESSION_TYPE), and the sidebar labels it imported.

import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { TrustLabel } from "../harness/contracts.ts";
import type { GateDecision } from "../harness/security/gate.ts";
import { redactSecrets } from "./ask_lucid_screen.ts";
import { isScannerUnavailable } from "./kb_pack.ts";
import { recordBlock } from "./security_log.ts";
import { canonicalModelId, IMPORTED_SESSION_TYPE, isAskLucidPrompt, isIngestPrompt, sessionFilePath, stripInjectedPreamble, typedText, writeNewSessionFile } from "./sessions.ts";

export const HISTORY_FORMAT = "lucid-history/1";
export const HISTORY_EXT = ".lucidhistory.json";
/** Larger than any real project history; the engine refuses bigger files both ways. */
export const MAX_HISTORY_BYTES = 64 * 1024 * 1024;
/** A tool result longer than this keeps its head and says how much was cut. */
export const MAX_TOOL_RESULT_CHARS = 64 * 1024;
/** Per image (decoded) and per session (all images) when images are included. */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAX_SESSION_IMAGE_BYTES = 16 * 1024 * 1024;
export const MAX_MARKING_CHARS = 200;
const IMAGE_MIMES: readonly string[] = ["image/png", "image/jpeg", "image/webp"];
/** Text handed to the scanner per call; long texts are cut with an overlap so no sequence spans a cut unseen. */
const SCAN_CHUNK_CHARS = 256 * 1024;
const SCAN_OVERLAP = 64;
/** Session ids become file names: letters, digits, `_` and `-` only (omp mints UUIDv7). */
export const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const EPOCH = "1970-01-01T00:00:00.000Z";
/** The `api` an imported assistant turn carries: matches no provider, so a resumed model treats it as foreign history. */
const IMPORTED_API = "lucid-history-import";
const UNTRUSTED: TrustLabel = "untrusted";
const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
/** Printable 7-bit ASCII and LF: the only bytes a history file may hold. Built from escapes (no raw controls here). */
const ASCII_FILE = new RegExp("^[\\u0020-\\u007e\\n]*$");
const PRINTABLE_LINE = new RegExp("^[\\u0020-\\u007e]*$");
const CONTROLS = new RegExp("[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f]", "g");
const NON_ASCII = new RegExp("[\\u007f-\\uffff]", "g");

// ── the format ──────────────────────────────────────────────────────────────────────────────────────────────

export type HistoryPart =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_call"; id: string; name: string; arguments: string }
  | { type: "image"; mime: string; data: string }
  | { type: "omitted"; what: "image" };

export type HistoryMessage =
  | { role: "user"; at: string; parts: HistoryPart[] }
  | { role: "assistant"; at: string; model: string; parts: HistoryPart[] }
  | { role: "tool_result"; at: string; tool_call_id: string; tool_name: string; is_error: boolean; parts: HistoryPart[] };

export interface HistorySession { id: string; title: string; created_at: string; model: string; messages: HistoryMessage[] }
export type HistoryScopeKind = "project" | "lane" | "sessions";
export interface HistoryScope { kind: HistoryScopeKind; lane?: string }
export interface HistoryManifestEntry { id: string; sha256: string; messages: number }
export interface HistoryManifest {
  marking: string;
  created_at: string;
  app: string;
  app_version: string;
  project: string;
  scope: HistoryScope;
  include_images: boolean;
  content: string[];
  session_count: number;
  sessions: HistoryManifestEntry[];
  payload_sha256: string;
}
export interface HistoryFile { format: string; manifest: HistoryManifest; sessions: HistorySession[] }

export type Decide = (text: string) => Promise<GateDecision>;
export type BlockRecorder = (b: { tool: string; severity?: string; findings?: string; reason: string; sessionId?: string }) => void;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 240);
const byKey = ([a]: [string, unknown], [b]: [string, unknown]): number => (a < b ? -1 : a > b ? 1 : 0);

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  // fromEntries defines own properties, so a "__proto__" key from a transcript stays data.
  if (isObj(v)) return Object.fromEntries(Object.entries(v).sort(byKey).map(([k, x]) => [k, sortKeys(x)]));
  return v;
}

/** PURE: canonical JSON (keys sorted at every level) with every non-ASCII code unit written as `\uXXXX`. */
export function asciiJson(v: unknown, indent?: number): string {
  return JSON.stringify(sortKeys(v), null, indent).replace(NON_ASCII, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

/** PURE: CRLF and CR become LF; every other C0 and C1 control except tab and newline is removed. */
export function cleanText(s: string): string {
  return s.replace(/\r\n?/g, "\n").replace(CONTROLS, "");
}

/** The user's home folder as `~` in any text: raw, forward-slashed and JSON-escaped spellings, never inside a longer
 *  folder name (`/home/al` leaves `/home/alice` alone). Case-insensitive on Windows. */
export function homeScrubber(home: string = homedir(), platform: string = process.platform): (s: string) => string {
  const h = home.replace(/[\\/]+$/, "");
  if (h.length < 3) return (s) => s;
  const variants = [...new Set([h, h.replace(/\\/g, "/"), h.replace(/\\/g, "\\\\"), h.replace(/\//g, "\\")])].sort((a, b) => b.length - a.length);
  const re = new RegExp(`(?:${variants.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![A-Za-z0-9._-])`, platform === "win32" ? "gi" : "g");
  return (s) => s.replace(re, "~");
}

/** Every text that leaves the machine: controls stripped, home folder scrubbed, secret-shaped values redacted. */
export function exportSanitizer(home: string = homedir(), platform: string = process.platform): (s: string) => string {
  const scrub = homeScrubber(home, platform);
  return (s) => redactSecrets(scrub(cleanText(s)));
}

/** The last millisecond of year 9999: later (or negative) times would not print as `YYYY-MM-DDTHH:MM:SS.sssZ`. */
const MAX_TIME = 253_402_300_799_999;
/** Every timestamp in the file is exactly `YYYY-MM-DDTHH:MM:SS.sssZ`; the import refuses any other spelling, so a
 *  time can never smuggle a path separator into the transcript file name built from it. */
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function iso(v: unknown, fallback: string): string {
  const t = typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) : Number.NaN;
  return Number.isFinite(t) && t >= 0 && t <= MAX_TIME ? new Date(t).toISOString() : fallback;
}

function sanitizeJson(v: unknown, f: (s: string) => string): unknown {
  if (typeof v === "string") return f(v);
  if (Array.isArray(v)) return v.map((x) => sanitizeJson(x, f));
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [f(k), sanitizeJson(x, f)]));
  return typeof v === "number" || typeof v === "boolean" ? v : null;
}

/** Decoded size of an allowlisted image, or null when its type, base64 alphabet, size or magic bytes are wrong. */
export function imageSize(mime: string, data: string): number | null {
  if (!IMAGE_MIMES.includes(mime) || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return null;
  const size = (data.length / 4) * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
  if (size < 12 || size > MAX_IMAGE_BYTES) return null;
  const head = Buffer.from(data.slice(0, 16), "base64");
  const ok = mime === "image/png" ? head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47
    : mime === "image/jpeg" ? head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff
    : head.toString("latin1", 0, 4) === "RIFF" && head.toString("latin1", 8, 12) === "WEBP";
  return ok ? size : null;
}

function truncateResult(t: string): string {
  if (t.length <= MAX_TOOL_RESULT_CHARS) return t;
  return `${t.slice(0, MAX_TOOL_RESULT_CHARS)}\n[truncated by the LUCID history export: ${MAX_TOOL_RESULT_CHARS} of ${t.length} characters kept]`;
}

// ── reading a transcript ────────────────────────────────────────────────────────────────────────────────────

export interface PickedSession { session: HistorySession; throwaway: boolean }

/** PURE: an omp transcript (.jsonl text) as a history session, every text through `sanitize`. Message order is the
 *  file's (what the sidebar transcript shows); user turns lose the injected preamble the transcript view strips too.
 *  Null when the transcript holds no exportable message. */
export function sessionToHistory(content: string, fallbackId: string, opts: { includeImages: boolean; sanitize: (s: string) => string }): PickedSession | null {
  const f = opts.sanitize;
  let header: Obj | null = null;
  const rows: Obj[] = [];
  for (const ln of content.split("\n")) {
    if (!ln.trim()) continue;
    let o: unknown;
    try { o = JSON.parse(ln); } catch { continue; }
    if (!isObj(o)) continue;
    if (o.type === "session" && !header) header = o;
    else rows.push(o);
  }
  const id = cleanText(str(header?.id)) || fallbackId;
  const createdAt = iso(header?.timestamp, EPOCH);
  let model = "";
  let title = "";
  let firstUserRaw: string | null = null;
  let imageBytes = 0;
  const image = (p: Obj): HistoryPart => {
    if (!opts.includeImages) return { type: "omitted", what: "image" };
    const mime = str(p.mimeType), data = str(p.data);
    const size = imageSize(mime, data);
    if (size === null || imageBytes + size > MAX_SESSION_IMAGE_BYTES) return { type: "omitted", what: "image" };
    imageBytes += size;
    return { type: "image", mime, data };
  };
  const messages: HistoryMessage[] = [];
  for (const o of rows) {
    if (o.type === "model_change" && typeof o.model === "string" && o.model) { model = o.model; continue; }
    if (o.type !== "message" || !isObj(o.message)) continue;
    const m = o.message;
    const at = iso(m.timestamp, iso(o.timestamp, createdAt));
    const items: unknown[] = typeof m.content === "string" ? [{ type: "text", text: m.content }] : Array.isArray(m.content) ? m.content : [];
    const parts: HistoryPart[] = [];
    if (m.role === "user") {
      const raw = items.find((p): p is Obj => isObj(p) && p.type === "text" && typeof p.text === "string");
      if (raw && firstUserRaw === null) firstUserRaw = str(raw.text);
      if (raw && !title) title = typedText(str(raw.text)).trim().slice(0, 64);
      for (const p of items) {
        if (!isObj(p)) continue;
        if (p.type === "text" && typeof p.text === "string") { const t = f(stripInjectedPreamble(p.text)); if (t.trim()) parts.push({ type: "text", text: t }); }
        else if (p.type === "image") parts.push(image(p));
      }
      if (parts.length) messages.push({ role: "user", at, parts });
    } else if (m.role === "assistant") {
      for (const p of items) {
        if (!isObj(p)) continue;
        if (p.type === "text" && typeof p.text === "string") { const t = f(p.text); if (t.trim()) parts.push({ type: "text", text: t }); }
        else if (p.type === "thinking" && typeof p.thinking === "string") { const t = f(p.thinking); if (t.trim()) parts.push({ type: "thinking", text: t }); }
        else if (p.type === "toolCall") {
          const args = isObj(p.arguments) ? p.arguments : {};
          parts.push({ type: "tool_call", id: cleanText(str(p.id)).slice(0, 256), name: f(str(p.name)), arguments: JSON.stringify(sortKeys(sanitizeJson(args, f))) });
        }
      }
      if (typeof m.model === "string" && m.model) model = canonicalModelId(m.model, m.provider);
      if (parts.length) messages.push({ role: "assistant", at, model: f(model), parts });
    } else if (m.role === "toolResult") {
      const text = items.filter((p): p is Obj => isObj(p) && p.type === "text" && typeof p.text === "string").map((p) => str(p.text)).join("\n");
      if (text) parts.push({ type: "text", text: truncateResult(f(text)) });
      for (const p of items) if (isObj(p) && p.type === "image") parts.push(image(p));
      messages.push({ role: "tool_result", at, tool_call_id: cleanText(str(m.toolCallId)).slice(0, 256), tool_name: f(str(m.toolName)), is_error: m.isError === true, parts });
    }
  }
  if (!messages.length) return null;
  const throwaway = firstUserRaw !== null && (isIngestPrompt(firstUserRaw) || isAskLucidPrompt(firstUserRaw));
  return { session: { id, title: f(title) || "Untitled session", created_at: createdAt, model: f(model), messages }, throwaway };
}

// ── the scanner ─────────────────────────────────────────────────────────────────────────────────────────────

/** Every text of a session the scanner reads (image data is checked by its base64 alphabet instead). */
export function historyTexts(s: HistorySession): string[] {
  const out = [s.id, s.title, s.model, s.created_at];
  for (const m of s.messages) {
    out.push(m.at);
    if (m.role === "assistant") out.push(m.model);
    if (m.role === "tool_result") out.push(m.tool_call_id, m.tool_name);
    for (const p of m.parts) {
      if (p.type === "text" || p.type === "thinking") out.push(p.text);
      else if (p.type === "tool_call") out.push(p.id, p.name, p.arguments);
      else if (p.type === "image") out.push(p.mime);
    }
  }
  return out;
}

export type ScanOutcome = { ok: true } | { ok: false; unavailable: boolean; reason: string; findings: number };

/** Scan texts in bounded chunks, fail-closed: a throw or a fail-closed decision is the scanner being unavailable
 *  (kb_pack.isScannerUnavailable keeps it apart from a finding); ANY finding, even below the block threshold,
 *  refuses. Always at least one call, so a dead scanner refuses an all-ASCII session too. */
export async function scanTexts(texts: readonly string[], decide: Decide): Promise<ScanOutcome> {
  const chunks: string[] = [];
  let cur = "";
  for (const t of texts) {
    if (!t) continue;
    if (t.length > SCAN_CHUNK_CHARS) {
      if (cur) { chunks.push(cur); cur = ""; }
      for (let i = 0; i < t.length; i += SCAN_CHUNK_CHARS) chunks.push(t.slice(Math.max(0, i - SCAN_OVERLAP), i + SCAN_CHUNK_CHARS));
      continue;
    }
    if (cur && cur.length + t.length + 1 > SCAN_CHUNK_CHARS) { chunks.push(cur); cur = ""; }
    cur = cur ? `${cur}\n${t}` : t;
  }
  if (cur || !chunks.length) chunks.push(cur);
  for (const c of chunks) {
    let d: GateDecision;
    try { d = await decide(c); } catch (e) { return { ok: false, unavailable: true, reason: `scanner unavailable: ${errText(e)}`, findings: 0 }; }
    if (d.failClosed || isScannerUnavailable(d.reason)) return { ok: false, unavailable: true, reason: `scanner unavailable: ${d.reason}`, findings: 0 };
    if (d.block || d.findings.length > 0) return { ok: false, unavailable: false, reason: d.reason, findings: d.findings.length };
  }
  return { ok: true };
}

// ── export ──────────────────────────────────────────────────────────────────────────────────────────────────

export interface ExportSource { id: string; content: string }
export interface ExportOptions {
  createdAt: string;
  appVersion: string;
  /** The project folder's basename (never a path). */
  project: string;
  scope: HistoryScope;
  marking?: string;
  includeImages?: boolean;
  /** Leave Knowledge Graph ingest and Ask Lucid throwaways out (a project export). */
  skipThrowaways?: boolean;
  decide: Decide;
  record?: BlockRecorder;
  home?: string;
  platform?: string;
}
export interface ExportRow { id: string; title: string; status: "exported" | "blocked" | "skipped"; reason?: string }
export interface ExportResult {
  ok: boolean;
  error?: string;
  stage: "marking" | "scanner" | "empty" | "size" | "ok";
  file?: string;
  filename?: string;
  payloadSha256?: string;
  exported: number;
  blocked: number;
  report: ExportRow[];
}

/** The content kinds a file may carry, as its manifest declares them for a guard rule. */
export function contentAllowlist(includeImages: boolean): string[] {
  return ["text", "thinking", "tool_call", "tool_result", "timestamp", "model", ...(includeImages ? ["image"] : [])];
}

export function historyFileName(project: string, createdAt: string): string {
  const slug = project.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 60) || "project";
  return `${slug}-${createdAt.slice(0, 10)}${HISTORY_EXT}`;
}

/** A marking is one line of printable ASCII (`UNCLASSIFIED`, `CUI//SP-PRVCY`), at most MAX_MARKING_CHARS. */
export function validMarking(m: string): boolean {
  return m.length <= MAX_MARKING_CHARS && PRINTABLE_LINE.test(m);
}

/** Build the history file from transcripts. Each session is sanitized, then scanned (a finding blocks it; an
 *  unreachable scanner stops the export). `createdAt` is the only clock: same inputs, same bytes. */
export async function exportHistory(sources: readonly ExportSource[], opts: ExportOptions): Promise<ExportResult> {
  const marking = (opts.marking ?? "").trim();
  if (!validMarking(marking)) return { ok: false, stage: "marking", error: `The marking must be one line of plain ASCII, at most ${MAX_MARKING_CHARS} characters.`, exported: 0, blocked: 0, report: [] };
  const record = opts.record ?? recordBlock;
  const sanitize = exportSanitizer(opts.home, opts.platform);
  const includeImages = opts.includeImages === true;
  const createdAt = iso(opts.createdAt, EPOCH);
  const report: ExportRow[] = [];
  const picked = new Map<string, HistorySession>();
  for (const src of sources) {
    const p = sessionToHistory(src.content, src.id, { includeImages, sanitize });
    if (!p) { report.push({ id: src.id, title: "", status: "skipped", reason: "no messages" }); continue; }
    const s = p.session;
    if (opts.skipThrowaways && p.throwaway) { report.push({ id: s.id, title: s.title, status: "skipped", reason: "a throwaway session" }); continue; }
    if (!SESSION_ID.test(s.id)) { report.push({ id: s.id.slice(0, 64), title: s.title, status: "skipped", reason: "its id is not a portable file name" }); continue; }
    if (picked.has(s.id)) continue;
    const scan = await scanTexts(historyTexts(s), opts.decide);
    if (!scan.ok && scan.unavailable) {
      record({ tool: "session_export", severity: "high", findings: "scanner-unavailable", reason: "History export stopped: scanner unavailable" });
      return { ok: false, stage: "scanner", error: `Nothing was exported: ${scan.reason}`, exported: 0, blocked: 0, report };
    }
    if (!scan.ok) {
      record({ tool: "session_export", severity: "high", findings: String(scan.findings), reason: `History export blocked session ${s.id}: ${scan.reason}`, sessionId: s.id });
      report.push({ id: s.id, title: s.title, status: "blocked", reason: `hidden or deceptive characters (${scan.reason})` });
      continue;
    }
    picked.set(s.id, s);
    report.push({ id: s.id, title: s.title, status: "exported" });
  }
  const sessions = [...picked.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const blocked = report.filter((r) => r.status === "blocked").length;
  report.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (!sessions.length) return { ok: false, stage: "empty", error: blocked ? "Nothing was exported: every session was blocked by the scanner." : "Nothing to export: no session with messages in that scope.", exported: 0, blocked, report };
  const manifest: HistoryManifest = {
    marking,
    created_at: createdAt,
    app: "LUCID Agent IDE",
    app_version: sanitize(opts.appVersion),
    project: sanitize(opts.project) || "project",
    scope: opts.scope.lane !== undefined ? { kind: opts.scope.kind, lane: sanitize(opts.scope.lane) } : { kind: opts.scope.kind },
    include_images: includeImages,
    content: contentAllowlist(includeImages),
    session_count: sessions.length,
    sessions: sessions.map((s) => ({ id: s.id, sha256: sha256(asciiJson(s)), messages: s.messages.length })),
    payload_sha256: sha256(asciiJson(sessions)),
  };
  const file = `${asciiJson({ format: HISTORY_FORMAT, manifest, sessions } satisfies HistoryFile, 2)}\n`;
  if (file.length > MAX_HISTORY_BYTES) return { ok: false, stage: "size", error: `The history is larger than ${MAX_HISTORY_BYTES / 1024 / 1024} MB. Export fewer sessions (one agent at a time), or leave images out.`, exported: 0, blocked, report };
  return { ok: true, stage: "ok", file, filename: historyFileName(manifest.project, createdAt), payloadSha256: manifest.payload_sha256, exported: sessions.length, blocked, report };
}

// ── import: strict validation ───────────────────────────────────────────────────────────────────────────────

const hasExactly = (o: Obj, required: readonly string[], optional: readonly string[] = []): boolean => {
  const keys = Object.keys(o);
  return required.every((k) => keys.includes(k)) && keys.every((k) => required.includes(k) || optional.includes(k));
};
const isIso = (v: unknown): v is string => typeof v === "string" && ISO_UTC.test(v) && Number.isFinite(Date.parse(v));
const isStr = (v: unknown): v is string => typeof v === "string";

function validPart(p: unknown, role: HistoryMessage["role"], includeImages: boolean): p is HistoryPart {
  if (!isObj(p)) return false;
  if (p.type === "text") return hasExactly(p, ["type", "text"]) && isStr(p.text);
  if (p.type === "thinking") return role === "assistant" && hasExactly(p, ["type", "text"]) && isStr(p.text);
  if (p.type === "tool_call") {
    if (role !== "assistant" || !hasExactly(p, ["type", "id", "name", "arguments"]) || !isStr(p.id) || !isStr(p.name) || !isStr(p.arguments)) return false;
    try { return isObj(JSON.parse(p.arguments)); } catch { return false; }
  }
  if (p.type === "image") return role !== "assistant" && includeImages && hasExactly(p, ["type", "mime", "data"]) && isStr(p.mime) && isStr(p.data) && imageSize(p.mime, p.data) !== null;
  if (p.type === "omitted") return role !== "assistant" && hasExactly(p, ["type", "what"]) && p.what === "image";
  return false;
}

function validMessage(m: unknown, includeImages: boolean): m is HistoryMessage {
  if (!isObj(m) || !isIso(m.at) || !Array.isArray(m.parts)) return false;
  const role = m.role;
  if (role !== "user" && role !== "assistant" && role !== "tool_result") return false;
  const shape = role === "user" ? hasExactly(m, ["role", "at", "parts"])
    : role === "assistant" ? hasExactly(m, ["role", "at", "model", "parts"]) && isStr(m.model)
    : hasExactly(m, ["role", "at", "tool_call_id", "tool_name", "is_error", "parts"]) && isStr(m.tool_call_id) && isStr(m.tool_name) && typeof m.is_error === "boolean";
  const parts: unknown[] = m.parts;
  return shape && parts.every((p) => validPart(p, role, includeImages));
}

/** PURE: the parsed file as a HistoryFile, or the reason it is not one. Unknown keys anywhere are refused, so
 *  nothing outside the declared allowlist can ride along. */
export function parseHistoryFile(raw: unknown): HistoryFile | string {
  if (!isObj(raw) || !hasExactly(raw, ["format", "manifest", "sessions"])) return "not a LUCID history file";
  if (raw.format !== HISTORY_FORMAT) return `unsupported format ${JSON.stringify(String(raw.format)).slice(0, 60)} (this LUCID reads ${HISTORY_FORMAT})`;
  const m = raw.manifest;
  if (!isObj(m) || !hasExactly(m, ["marking", "created_at", "app", "app_version", "project", "scope", "include_images", "content", "session_count", "sessions", "payload_sha256"])) return "the manifest has missing or unknown fields";
  if (!isStr(m.marking) || !validMarking(m.marking) || !isIso(m.created_at) || !isStr(m.app) || !isStr(m.app_version) || !isStr(m.project) || typeof m.include_images !== "boolean") return "the manifest has a field of the wrong type";
  const sc = m.scope;
  if (!isObj(sc) || !hasExactly(sc, ["kind"], ["lane"]) || !(sc.kind === "project" || sc.kind === "lane" || sc.kind === "sessions") || (sc.lane !== undefined && !isStr(sc.lane))) return "the manifest scope is malformed";
  if (!Array.isArray(m.content) || !m.content.every((c) => contentAllowlist(true).includes(String(c))) || (!m.include_images && m.content.includes("image"))) return "the manifest declares content outside the allowlist";
  if (typeof m.payload_sha256 !== "string" || !SHA256_HEX.test(m.payload_sha256)) return "the manifest payload hash is malformed";
  if (!Array.isArray(m.sessions) || !m.sessions.every((e) => isObj(e) && hasExactly(e, ["id", "sha256", "messages"]) && isStr(e.id) && isStr(e.sha256) && SHA256_HEX.test(e.sha256) && Number.isInteger(e.messages))) return "the manifest session list is malformed";
  if (!Array.isArray(raw.sessions) || m.session_count !== raw.sessions.length || m.sessions.length !== raw.sessions.length) return "the session count does not match the manifest";
  const seen = new Set<string>();
  for (const s of raw.sessions) {
    if (!isObj(s) || !hasExactly(s, ["id", "title", "created_at", "model", "messages"]) || !isStr(s.id) || !SESSION_ID.test(s.id) || !isStr(s.title) || !isIso(s.created_at) || !isStr(s.model) || !Array.isArray(s.messages)) return "a session is malformed";
    if (seen.has(s.id)) return `session ${s.id} appears twice`;
    seen.add(s.id);
    if (!s.messages.every((x) => validMessage(x, m.include_images === true))) return `session ${s.id} has a message outside the allowlist`;
  }
  // Every shape was checked field by field above; the value is now known to be a HistoryFile.
  const file = raw as unknown as HistoryFile;
  return file;
}

// ── import: writing omp transcripts ─────────────────────────────────────────────────────────────────────────

/** `p` with its nearest existing ancestor's links and short names resolved (a project folder, or a temp folder like
 *  macOS /var -> /private/var, may be spelled differently from its real path). */
function canonicalPath(p: string): string {
  const rest: string[] = [];
  for (let cur = p; ; ) {
    try { return join(realpathSync.native(cur), ...rest.reverse()); } catch { /* not there: try its parent */ }
    const up = dirname(cur);
    if (up === cur) return p;
    rest.push(basename(cur));
    cur = up;
  }
}

/** The folder omp keeps `cwd`'s sessions in, under its sessions root. Mirrors omp's session-paths.ts
 *  (getDefaultSessionDirName): home-relative `-a-b`, temp-relative `-tmp-a-b`, else `--<abs>--`, with `/ \ :` as `-`.
 *  An imported session must sit there or omp cannot load it (SessionManager.list reads only that folder). */
export function ompSessionDirName(cwd: string, home: string = homedir(), temp: string = tmpdir()): string {
  const target = canonicalPath(resolve(cwd));
  const within = (base: string): string | null => {
    const r = relative(canonicalPath(resolve(base)), target);
    return r === "" || (!r.startsWith("..") && !isAbsolute(r)) ? r : null;
  };
  const encode = (prefix: string, r: string): string => {
    const e = r.replace(/[/\\:]/g, "-");
    return e ? (prefix.endsWith("-") ? `${prefix}${e}` : `${prefix}-${e}`) : prefix;
  };
  const h = within(home);
  if (h !== null) return encode("-", h);
  const t = within(temp);
  if (t !== null) return encode("-tmp", t);
  return `--${target.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

const IMAGE_OMITTED_TEXT = "[image not included in this history export]";

function ompContent(parts: readonly HistoryPart[]): Obj[] {
  return parts.map((p): Obj => (p.type === "image" ? { type: "image", data: p.data, mimeType: p.mime } : { type: "text", text: p.type === "omitted" ? IMAGE_OMITTED_TEXT : p.type === "tool_call" ? p.arguments : p.text }));
}

function ompMessage(m: HistoryMessage): Obj {
  const timestamp = Date.parse(m.at);
  if (m.role === "user") return { role: "user", content: ompContent(m.parts), timestamp };
  if (m.role === "tool_result") return { role: "toolResult", toolCallId: m.tool_call_id, toolName: m.tool_name, content: ompContent(m.parts), isError: m.is_error, timestamp };
  const slash = m.model.indexOf("/");
  const content = m.parts.map((p): Obj => (p.type === "thinking" ? { type: "thinking", thinking: p.text }
    : p.type === "tool_call" ? { type: "toolCall", id: p.id, name: p.name, arguments: JSON.parse(p.arguments) }
    : { type: "text", text: p.type === "text" ? p.text : IMAGE_OMITTED_TEXT }));
  return {
    role: "assistant", content, api: IMPORTED_API,
    provider: slash > 0 ? m.model.slice(0, slash) : "", model: slash > 0 ? m.model.slice(slash + 1) : m.model,
    usage: ZERO_USAGE, stopReason: m.parts.some((p) => p.type === "tool_call") ? "toolUse" : "stop", timestamp,
  };
}

/** PURE: one history session as an omp transcript (session header, the untrusted provenance entry, the model, then
 *  each message), chained by deterministic entry ids. */
export function historyToJsonl(s: HistorySession, cwd: string, provenance: Obj): string {
  const rows: Obj[] = [{ type: "session", version: 3, id: s.id, title: s.title, timestamp: s.created_at, cwd }];
  let parent: string | null = null;
  const entry = (type: string, timestamp: string, body: Obj): void => {
    const id = createHash("sha256").update(`${s.id}:${rows.length}`).digest("hex").slice(0, 8);
    rows.push({ type, id, parentId: parent, timestamp, ...body });
    parent = id;
  };
  entry("custom", s.created_at, { customType: IMPORTED_SESSION_TYPE, data: provenance });
  if (s.model.includes("/")) entry("model_change", s.created_at, { model: s.model });
  for (const m of s.messages) entry("message", m.at, { message: ompMessage(m) });
  return `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
}

/** The history hash of a transcript already on disk: the one its import marker recorded, else the hash an export
 *  of it on this machine would carry. Equal to the incoming one = the same session. */
function existingSha(content: string, id: string, includeImages: boolean, sanitize: (s: string) => string): string | null {
  for (const ln of content.split("\n")) {
    if (!ln.includes(IMPORTED_SESSION_TYPE)) continue;
    let o: unknown;
    try { o = JSON.parse(ln); } catch { continue; }
    if (isObj(o) && o.type === "custom" && o.customType === IMPORTED_SESSION_TYPE && isObj(o.data) && typeof o.data.session_sha256 === "string") return o.data.session_sha256;
  }
  const p = sessionToHistory(content, id, { includeImages, sanitize });
  return p ? sha256(asciiJson(p.session)) : null;
}

export interface ImportOptions {
  /** The current project folder: imported sessions belong to it. */
  cwd: string;
  /** omp's sessions root (sessions.sessionsRoot()). */
  root: string;
  decide: Decide;
  record?: BlockRecorder;
  now?: () => string;
  home?: string;
  platform?: string;
}
export interface ImportResult {
  ok: boolean;
  error?: string;
  stage: "size" | "ascii" | "parse" | "format" | "integrity" | "scanner" | "ok";
  imported: string[];
  skipped: string[];
  conflicts: string[];
  blocked: { id: string; reason: string }[];
  failed: { id: string; reason: string }[];
  project?: string;
  marking?: string;
  createdAt?: string;
}

/** Validate a history file and write its clean sessions into the current project. See the header for the gates. */
export async function importHistory(text: string, opts: ImportOptions): Promise<ImportResult> {
  const out: ImportResult = { ok: false, stage: "size", imported: [], skipped: [], conflicts: [], blocked: [], failed: [] };
  const refuse = (stage: ImportResult["stage"], error: string): ImportResult => ({ ...out, ok: false, stage, error });
  const record = opts.record ?? recordBlock;
  if (Buffer.byteLength(text, "utf8") > MAX_HISTORY_BYTES) return refuse("size", `The file is larger than ${MAX_HISTORY_BYTES / 1024 / 1024} MB, the most a history file holds.`);
  if (!ASCII_FILE.test(text)) {
    const cr = text.includes("\r");
    record({ tool: "session_import", severity: "medium", findings: cr ? "carriage-return" : "non-ascii", reason: "History import refused: the file holds bytes other than printable ASCII and LF" });
    return refuse("ascii", cr ? "The file's line endings were changed (CR found). A history file holds only printable ASCII and LF; use the file exactly as exported." : "The file holds characters other than printable ASCII and LF, so it was not written by a LUCID export or was changed after.");
  }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return refuse("parse", "The file is not valid JSON."); }
  const file = parseHistoryFile(raw);
  if (typeof file === "string") return refuse("format", `Not imported: ${file}.`);
  const man = file.manifest;
  Object.assign(out, { project: man.project, marking: man.marking, createdAt: man.created_at });
  for (let i = 0; i < file.sessions.length; i++) {
    const s = file.sessions[i]!, e = man.sessions[i]!;
    if (e.id !== s.id || e.messages !== s.messages.length || sha256(asciiJson(s)) !== e.sha256) {
      record({ tool: "session_import", severity: "high", findings: "integrity", reason: `History import refused: session ${s.id} does not match its manifest hash`, sessionId: s.id });
      return refuse("integrity", `Session ${s.id} does not match the hash in the manifest: the file was changed after it was exported.`);
    }
  }
  if (sha256(asciiJson(file.sessions)) !== man.payload_sha256) {
    record({ tool: "session_import", severity: "high", findings: "integrity", reason: "History import refused: the payload hash does not match" });
    return refuse("integrity", "The sessions do not match the payload hash in the manifest: the file was changed after it was exported.");
  }
  // Every session is scanned before any is written: an unreachable scanner imports nothing.
  const clean: { s: HistorySession; sha: string }[] = [];
  for (let i = 0; i < file.sessions.length; i++) {
    const s = file.sessions[i]!;
    const scan = await scanTexts(historyTexts(s), opts.decide);
    if (!scan.ok && scan.unavailable) {
      record({ tool: "session_import", severity: "high", findings: "scanner-unavailable", reason: "History import stopped: scanner unavailable" });
      return refuse("scanner", `Nothing was imported: ${scan.reason}`);
    }
    if (!scan.ok) {
      record({ tool: "session_import", severity: "high", findings: String(scan.findings), reason: `History import quarantined session ${s.id}: ${scan.reason}`, sessionId: s.id });
      out.blocked.push({ id: s.id, reason: `hidden or deceptive characters (${scan.reason})` });
      continue;
    }
    clean.push({ s, sha: man.sessions[i]!.sha256 });
  }
  const sanitize = exportSanitizer(opts.home, opts.platform);
  const importedAt = iso((opts.now ?? (() => new Date().toISOString()))(), EPOCH);
  const dir = join(opts.root, ompSessionDirName(opts.cwd, opts.home));
  for (const { s, sha } of clean) {
    const existing = sessionFilePath(s.id, opts.root);
    if (existing) {
      let have: string | null = null;
      try { have = existingSha(readFileSync(existing, "utf8"), s.id, man.include_images, sanitize); } catch { /* unreadable: a conflict */ }
      (have === sha ? out.skipped : out.conflicts).push(s.id);
      continue;
    }
    const provenance: Obj = {
      trust: UNTRUSTED, format: HISTORY_FORMAT, project: man.project, marking: man.marking,
      exported_at: man.created_at, exported_by: man.app_version, payload_sha256: man.payload_sha256, session_sha256: sha, imported_at: importedAt,
    };
    const last = s.messages.length ? Date.parse(s.messages[s.messages.length - 1]!.at) : Date.parse(s.created_at);
    const name = `${s.created_at.replace(/[:.]/g, "-")}_${s.id}.jsonl`;
    try {
      writeNewSessionFile(join(dir, name), historyToJsonl(s, opts.cwd, provenance), opts.root, last);
      out.imported.push(s.id);
    } catch (e) {
      if (isObj(e) && e.code === "EEXIST") out.conflicts.push(s.id);
      else out.failed.push({ id: s.id, reason: errText(e) });
    }
  }
  return { ...out, ok: true, stage: "ok" };
}
