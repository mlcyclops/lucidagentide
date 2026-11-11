// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/sessions.ts - list REAL omp sessions for the current project from disk.
//
// omp persists every session (interactive or ACP) as a .jsonl under
// ~/.omp/agent/sessions/<encoded-cwd>/. We read those, filter to this repo's cwd,
// and derive a title (first user message), model, turn count, and last-modified.
// New GUI chats write new files here, so they appear on the next poll.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { UNTRUSTED_END, UNTRUSTED_START } from "../harness/prompt/assembler.ts";
import { EXTRACT_SYSTEM } from "../harness/personal/distiller.ts";
import { CARRIED_MARKER } from "./interject_store.ts";
import { currentWorkspace } from "./workspace.ts";

const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

// The per-session USER-TURN PREAMBLE that acp_backend prepends to the first typed
// message (never the frozen prefix): the AskSage persona (UNTRUSTED_CONTENT_* wrapped),
// the active bundled skill (<active-skill>), the personalization recall (<user-profile>),
// and the cross-session memory recall (<recalled-memory>). The model needs these, but
// they must NOT appear in the chat transcript or session titles. omp persists them inside
// the user turn on disk, so strip any leading block(s) before we DISPLAY a user message.
// Display-only: the model already received the full body live. See issue #52.
// Opening tags may carry attributes (e.g. `<user-profile note="…">`, `<active-skill name="…">`),
// so match `<tag` + any attrs + `>`, not a bare `<tag>`.
const PREAMBLE_BLOCKS: RegExp[] = [
  new RegExp(`^\\s*${UNTRUSTED_START}[\\s\\S]*?${UNTRUSTED_END}`),
  /^\s*<active-skill\b[^>]*>[\s\S]*?<\/active-skill>/,
  /^\s*<user-profile\b[^>]*>[\s\S]*?<\/user-profile>/,
  /^\s*<recalled-memory\b[^>]*>[\s\S]*?<\/recalled-memory>/,
  /^\s*<encrypted-vault\b[^>]*>[\s\S]*?<\/encrypted-vault>/, // P-VAULT-HINT.1: the locked-vault hint
  // Every block that rides the user-turn tail has to be listed here or it shows up in the transcript as if
  // the user had typed it. These three were injected without a matching stripper:
  /^\s*<design-invariants\b[^>]*>[\s\S]*?<\/design-invariants>/, // P-DESIGN.1 (ADR-0154)
  /^\s*<session-share\b[^>]*>[\s\S]*?<\/session-share>/,         // P-PREVIEW-PWA.3 (ADR-0240)
  /^\s*<spoken-reply\b[^>]*>[\s\S]*?<\/spoken-reply>/,           // P-VOICE.5 (ADR-0248)
  // P-OWN.1: the checkout briefing acp_backend prepends after the preamble. Peer-controlled text inside it
  // is collapsed onto single lines by checkout_owners.neutral, so the real closing tag is the only one
  // that starts a line: anchor on that, or a peer named "</checkout-peers>" would end the strip early and
  // leak the rest of the block into the transcript and the session title.
  /^\s*<checkout-peers\b[^>]*>[\s\S]*?\n<\/checkout-peers>(?=\s|$)/,
];

/** Remove the leading injected-context block(s) from a user message so only what the
 *  user actually typed is shown. Strips repeatedly (blocks stack) and is a no-op for a
 *  clean message. Never applied to assistant text. Exported for tests. */
export function stripInjectedPreamble(text: string): string {
  let s = text;
  for (let changed = true; changed; ) {
    changed = false;
    for (const re of PREAMBLE_BLOCKS) {
      const m = re.exec(s);
      if (m) { s = s.slice(m[0].length); changed = true; }
    }
  }
  return s.replace(/^\s+/, "");
}

// P-SESS-SEARCH.1 (ADR-0552): an operator note carried into a prompt (ADR-0414) opens it as CARRIED_MARKER,
// a newline, the note, then a blank line before what the user typed. The block has no closing tag, so the
// note ends at its first blank line (the harness's own notes are one paragraph). It stays in the transcript,
// the record of what the agent was told, but it never names the session: before this, every session a lane
// was attached to was titled "[LUCID OPERATOR NOTE - sent while no tool s...".
const CARRIED_NOTE = new RegExp(`^\\s*${CARRIED_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n[\\s\\S]*?(?:\\n\\n|$)`);

/** A user message with the injected preamble AND any leading carried operator notes removed: what the
 *  user typed. The session title and the search text read this; the transcript keeps the notes. */
export function typedText(text: string): string {
  let s = stripInjectedPreamble(text);
  for (let m = CARRIED_NOTE.exec(s); m; m = CARRIED_NOTE.exec(s)) s = stripInjectedPreamble(s.slice(m[0].length));
  return s;
}

export interface SessionInfo {
  id: string;
  title: string;
  model: string;
  updatedAt: number;
  turns: number;
  kind?: "chat" | "kg-ingest"; // P-KG-INGEST.1b: throwaway model-extraction sessions (import + AI-learn)
  /** P-SESS-SEARCH.1: the fleet lane that ran this session (lane-session ledger), set only when listed. */
  spoke?: string;
  /** P-SESS-ARCHIVE.1: the file lives in the archive folder (set only when true). */
  archived?: true;
}
// P-KG-INGEST.1b (ADR-0076): the chat list, with throwaway extraction sessions split into their own group.
// P-SESS-SEARCH.1: `hiddenSpokes` counts the spoke sessions a SpokeFilter held back (set only when filtered).
// P-SESS-ARCHIVE.1: `archived` counts this workspace's archived chats (the sidebar's Archived group).
export interface SessionList { sessions: SessionInfo[]; ingest: SessionInfo[]; hiddenSpokes?: number; archived?: number }

/** Where omp keeps every session (one folder per encoded cwd). */
export const sessionsRoot = (): string => join(homedir(), ".omp", "agent", "sessions");
/** P-SESS-ARCHIVE.1 (ADR-0554): archived sessions keep their `<encoded-cwd>/<file>` path under this sibling
 *  folder. Same volume as the sessions folder, so archiving and restoring are one atomic rename, and omp,
 *  which only looks under `sessions/`, never sees or scans them. */
export const archiveRootFor = (root: string): string => `${root}-archive`;
/** Is `p` inside folder `root`? A bare prefix test would also match `sessions-archive` for `sessions`. */
const under = (p: string, root: string): boolean => p.startsWith(root + sep);

/** P-SESS-SEARCH.1 (ADR-0552): which sessions fleet lanes ran (session id -> lane name, from the durable
 *  lane-session ledger), whether to show them, and the ids that stay visible regardless (the session Main
 *  holds and the lane the main composer is driving). Spoke sessions are hidden unless `show`. */
export interface SpokeFilter { spokes: ReadonlyMap<string, string>; show: boolean; keep?: ReadonlySet<string> }

function spokeView<S extends SessionInfo>(rows: S[], filter?: SpokeFilter): { rows: S[]; hidden: number } {
  if (!filter) return { rows, hidden: 0 };
  const out: S[] = [];
  let hidden = 0;
  for (const s of rows) {
    const name = filter.spokes.get(s.id);
    if (name === undefined) { out.push(s); continue; }
    if (!filter.show && !filter.keep?.has(s.id)) { hidden++; continue; }
    out.push({ ...s, spoke: name });
  }
  return { rows: out, hidden };
}

// The import / AI-learn extractor runs in THROWAWAY omp sessions whose only "user message" is the
// extractor system prompt + the text being learned from. omp persists each one, so a big import leaves
// hundreds of "Extract DURABLE facts about…" rows polluting the chat history. Detect them by the stable
// opening of EXTRACT_SYSTEM and group them out of the way (they stay inspectable, just collapsed).
const EXTRACT_SENTINEL = EXTRACT_SYSTEM.slice(0, 52);
/** True if a session's first user message is an extractor prompt (an ingest throwaway, not a real chat). */
export function isIngestPrompt(rawFirstUser: string): boolean {
  return rawFirstUser.trimStart().startsWith(EXTRACT_SENTINEL);
}
/** A meaningful ingest title: the actual text being learned from (the extractor system prompt stripped). */
export function ingestPreview(rawFirstUser: string): string {
  const s = rawFirstUser.trimStart();
  const after = s.startsWith(EXTRACT_SYSTEM) ? s.slice(EXTRACT_SYSTEM.length) : s.slice(EXTRACT_SENTINEL.length);
  return after.replace(/^\s+/, "").slice(0, 64) || "ingested message";
}

function firstUserText(message: any): string {
  const c = message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) for (const part of c) if (part?.type === "text" && part.text) return part.text;
  return "";
}

// P-PERF.4 (ADR-0131): incremental session index. listSessions used to re-read + re-parse EVERY .jsonl
// on EVERY call - and the sidebar polls it - so a long history meant megabytes of synchronous I/O per
// poll (the single biggest UI stall found in the battery investigation). Each file's parsed metadata is
// cached keyed by mtime+size (append-only .jsonl always changes both); a poll now re-parses only what
// changed and stat()s the rest. Entries for deleted files are pruned each scan.
// P-SESS-SEARCH.1 (ADR-0552): `text` is what search reads - every user message as typed (typedText) and every
// assistant reply's text, never tool output, thinking, or injected blocks. Built in the same parse the
// listing already pays for, so a search reads no file; the corpus measured 8.6 MB of it for 951 MB of
// transcripts. Empty for ingest throwaways and probe sessions, which search never returns.
interface IndexEntry { mtimeMs: number; size: number; scwd: string; meta: Omit<SessionInfo, "updatedAt"> | null; text: string }
const sessionIndex = new Map<string, IndexEntry>();
let indexParses = 0; // test seam: how many files were actually (re)parsed

/** Parse one session .jsonl's TEXT into list metadata. `meta: null` = an empty/probe session (cached
 *  too, so it isn't re-parsed every poll just to be skipped again). Takes text rather than a path so
 *  the timeline's async scan can read the file off the event loop. */
function parseSessionText(text: string, f: string): { scwd: string; meta: Omit<SessionInfo, "updatedAt"> | null; text: string } {
  indexParses++;
  let id = "", scwd = "", model = "", title = "", turns = 0;
  let kind: "chat" | "kg-ingest" = "chat";
  const said: string[] = [];
  for (const ln of text.split("\n")) {
    if (!ln) continue;
    let o: any;
    try { o = JSON.parse(ln); } catch { continue; }
    if (o.type === "session") { id = o.id ?? f; scwd = o.cwd ?? ""; }
    else if (o.type === "model_change" && o.model) model = o.model;
    else if (o.type === "message" && o.message) {
      if (o.message.role === "user" && !title) {
        const raw = firstUserText(o.message);
        // An extractor throwaway -> group it; its title is the snippet it learned from, not the prompt.
        if (isIngestPrompt(raw)) { kind = "kg-ingest"; const t = ingestPreview(raw); if (t.trim()) title = t.trim().slice(0, 64); }
        else { const t = typedText(raw); if (t.trim()) title = t.trim().slice(0, 64); }
      }
      if (kind === "chat" && (o.message.role === "user" || o.message.role === "assistant")) {
        const t = o.message.role === "user" ? typedText(msgText(o.message)) : msgText(o.message);
        if (t.trim()) said.push(t);
      }
      if (o.message.role === "assistant" && o.message.usage) {
        turns++;
        if (o.message.model) {
          const next = canonicalModelId(o.message.model, o.message.provider);
          // A bare id that merely restates the prefixed one (older rows carry no provider) keeps the prefix.
          if (next.includes("/") || !model.endsWith(`/${next}`)) model = next;
        }
      }
    }
  }
  if (!title && turns === 0) return { scwd, meta: null, text: "" }; // empty/probe session - remembered, skipped
  return { scwd, meta: { id: id || f, title: title || "Untitled session", model: model || "-", turns, kind }, text: said.join("\n") };
}

/** The model as omp's `session/set_config_option` accepts it: `provider/model`. A `model_change` row
 *  already carries that form; an assistant message carries the bare id with `provider` beside it. The
 *  index used to keep the bare id (and stripped `anthropic/` on top), which the orbit's Recover then
 *  handed straight back to omp, and omp refused every one as "Unknown ACP model". Display code shortens
 *  the id itself (modelLabel / prettyModel); the record stays the id that works. */
export function canonicalModelId(model: string, provider?: unknown): string {
  if (model.includes("/") || typeof provider !== "string" || !provider) return model;
  return `${provider}/${model}`;
}

export function __sessionIndexStats(): { parses: number; entries: number } { return { parses: indexParses, entries: sessionIndex.size }; }
/** The index entry for `p` given its handle's stat: the cached one when size and mtime still match,
 *  else a fresh parse of `text`. */
function indexedEntry(p: string, f: string, st: { mtimeMs: number; size: number }, text: string): IndexEntry {
  const hit = sessionIndex.get(p);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit;
  const e: IndexEntry = { mtimeMs: st.mtimeMs, size: st.size, ...parseSessionText(text, f) };
  sessionIndex.set(p, e);
  markDirty(p);
  return e;
}

// ── P-SESS-ARCHIVE.1 (ADR-0554): the index survives restarts ──────────────────────────────────────────────
// Building the index reads every transcript once: 1.1 GB on the measured machine, about 3 s at every engine
// start. The entries (list metadata + search text, about 1% of the bytes) are written to one file beside the
// sessions folder and read back at the first scan, so a start re-parses only files whose mtime or size
// changed. The session files stay the only truth: an entry is used only while its mtime+size still match,
// and a missing, unreadable, foreign-version or malformed index file is simply rebuilt.
/** Bump whenever parseSessionText's output changes, or old titles and search text would outlive the fix. */
const INDEX_FILE_VERSION = 1;
/** At most one write per this long: the session in use changes every turn. */
const INDEX_SAVE_DELAY_MS = 30_000;
/** Which root the index file covers (its archive sibling too). undefined = the default, not yet resolved;
 *  null = persistence off. Only keys under these roots are ever read from or written to the file. */
let indexStore: { file: string; root: string } | null | undefined;
let indexStoreLoaded = false;
let indexSaveTimer: Timer | null = null;

function store(): { file: string; root: string } | null {
  if (indexStore === undefined) indexStore = { file: join(homedir(), ".omp", "agent", "lucid-session-index.json"), root: sessionsRoot() };
  return indexStore;
}
function persisted(k: string): boolean {
  const s = store();
  return !!s && (under(k, s.root) || under(k, archiveRootFor(s.root)));
}

function isIndexEntry(v: unknown): v is IndexEntry {
  if (!v || typeof v !== "object") return false;
  if (!("mtimeMs" in v) || typeof v.mtimeMs !== "number" || !("size" in v) || typeof v.size !== "number") return false;
  if (!("scwd" in v) || typeof v.scwd !== "string" || !("text" in v) || typeof v.text !== "string" || !("meta" in v)) return false;
  const m = v.meta;
  if (m === null) return true;
  return !!m && typeof m === "object" && "id" in m && typeof m.id === "string" && "title" in m && typeof m.title === "string"
    && "model" in m && typeof m.model === "string" && "turns" in m && typeof m.turns === "number"
    && (!("kind" in m) || m.kind === undefined || m.kind === "chat" || m.kind === "kg-ingest");
}

/** Seed the in-memory index from the file, once, the first time its root (or archive) is scanned. Entries
 *  already in memory win: they were read from disk this run. */
function loadIndexStore(root: string): void {
  const s = store();
  if (indexStoreLoaded || !s || (root !== s.root && root !== archiveRootFor(s.root))) return;
  indexStoreLoaded = true;
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(s.file, "utf8")); } catch { return; }
  if (!raw || typeof raw !== "object" || !("v" in raw) || raw.v !== INDEX_FILE_VERSION || !("entries" in raw) || !Array.isArray(raw.entries)) return;
  for (const row of raw.entries) {
    if (!Array.isArray(row) || typeof row[0] !== "string" || !persisted(row[0]) || sessionIndex.has(row[0])) continue;
    if (isIndexEntry(row[1])) sessionIndex.set(row[0], row[1]);
  }
}

function markDirty(k: string): void {
  if (indexSaveTimer || !indexStoreLoaded || !persisted(k)) return;
  indexSaveTimer = setTimeout(() => { indexSaveTimer = null; flushSessionIndex(); }, INDEX_SAVE_DELAY_MS);
  indexSaveTimer.unref(); // a pending save is never the reason the engine stays up
}

/** Write the index file now (temp file + rename, so a crash mid-write leaves the previous one). Never
 *  writes before the file was read this run: a scan of another root must not overwrite it with nothing. */
export function flushSessionIndex(): void {
  if (indexSaveTimer) { clearTimeout(indexSaveTimer); indexSaveTimer = null; }
  const s = store();
  if (!s || !indexStoreLoaded) return;
  const tmp = `${s.file}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(s.file), { recursive: true });
    writeFileSync(tmp, JSON.stringify({ v: INDEX_FILE_VERSION, entries: [...sessionIndex].filter(([k]) => persisted(k)) }));
    renameSync(tmp, s.file);
  } catch { try { rmSync(tmp, { force: true }); } catch { /* nothing to clean */ } }
}

/** Test seam: point persistence at a file and root, turn it off (null), or back to the default (undefined). */
export function __setSessionIndexStore(s: { file: string; root: string } | null | undefined): void {
  if (indexSaveTimer) { clearTimeout(indexSaveTimer); indexSaveTimer = null; }
  indexStore = s;
  indexStoreLoaded = false;
}

export function __resetSessionIndex(): void {
  sessionIndex.clear(); allScans.clear(); archiveScanned.clear(); indexParses = 0;
  if (indexSaveTimer) { clearTimeout(indexSaveTimer); indexSaveTimer = null; }
  indexStoreLoaded = false;
}

/** The file of session `id` under `root`: the index first (no file read), else a scan for its session
 *  record (a file the index has not seen yet). */
function findSessionPath(id: string, root: string): string | null {
  loadIndexStore(root);
  for (const [k, e] of sessionIndex) {
    if (under(k, root) && (e.meta?.id === id || basename(k) === id) && existsSync(k)) return k;
  }
  if (!existsSync(root)) return null;
  for (const d of readdirSync(root)) {
    const dir = join(root, d);
    try {
      if (!statSync(dir).isDirectory()) continue;
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".jsonl")) continue;
        const p = join(dir, f);
        try { if (f === id || sessionRecord(readFileSync(p, "utf8"), f).id === id) return p; } catch { /* unreadable */ }
      }
    } catch { /* skip dir */ }
  }
  return null;
}

/** The sidebar's list: this workspace's sessions, newest first, chats and ingest throwaways split.
 *  P-BOOTPERF.1 (ADR-pending): ASYNC, over the same scan as listAllSessions. The synchronous walk read
 *  and parsed every .jsonl on the engine's one event loop, and the sidebar asks at boot, when the index
 *  is cold: on a large corpus (13k files, an antivirus scanning each open) that froze every other route
 *  for tens of seconds, the workspace bar and the turn-status probe included. It joins an in-flight scan
 *  but never reuses a finished one (reuseMs 0), so a chat that just changed always shows.
 *  `filter` (P-SESS-SEARCH.1) tags and, unless shown, holds back spoke sessions BEFORE the 40-row cap,
 *  so hidden spokes never take a slot a chat could have. */
export async function listSessions(cwd: string = currentWorkspace(), root: string = join(homedir(), ".omp", "agent", "sessions"), filter?: SpokeFilter): Promise<SessionList> {
  const all = (await workspaceSessions(cwd, root)).map((r) => r.row);
  const chats = spokeView(all.filter((s) => s.kind !== "kg-ingest"), filter);
  // Split: real chats (capped) vs the collapsed ingest group, so a big import can't crowd out chats.
  return {
    sessions: chats.rows.slice(0, 40),
    ingest: all.filter((s) => s.kind === "kg-ingest").slice(0, 60),
    ...(filter ? { hiddenSpokes: chats.hidden } : {}),
    archived: (await archivedRows(cwd, root)).filter((r) => r.row.kind !== "kg-ingest").length,
  };
}

/** P-SESS-SEARCH.1: one search hit. `snippet` is set when the match came from the conversation rather
 *  than the title, model, or spoke name: the matched words with some text either side. */
export interface SessionHit extends SessionInfo { snippet?: string }
/** `total` counts every visible match (hits is capped); `hiddenSpokes` counts matches a SpokeFilter held back. */
export interface SessionSearch { hits: SessionHit[]; total: number; hiddenSpokes: number }

const SEARCH_MAX_TERMS = 8;
const SNIPPET_BEFORE = 40;
const SNIPPET_AFTER = 100;

function snippetAt(text: string, at: number, len: number): string {
  const start = Math.max(0, at - SNIPPET_BEFORE);
  const end = Math.min(text.length, at + len + SNIPPET_AFTER);
  return `${start > 0 ? "\u2026" : ""}${text.slice(start, end).replace(/\s+/g, " ").trim()}${end < text.length ? "\u2026" : ""}`;
}

/** P-SESS-SEARCH.1 (ADR-0552): every chat session of `cwd` (not just the sidebar's 40) whose title, model,
 *  spoke name, or conversation (index `text`: typed prompts and replies) contains EVERY whitespace-separated
 *  term, case-insensitive. Sessions matched by name come first, then those matched only by what was said;
 *  each group newest first. Reads the index only, over the sidebar's async scan: a file is parsed only if it
 *  changed since the last listing. */
export async function searchSessions(query: string, opts: { cwd?: string; root?: string; filter?: SpokeFilter; limit?: number } = {}): Promise<SessionSearch> {
  const terms = [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))].slice(0, SEARCH_MAX_TERMS);
  if (!terms.length) return { hits: [], total: 0, hiddenSpokes: 0 };
  const res = terms.map((t) => new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  const cwd = opts.cwd ?? currentWorkspace();
  const root = opts.root ?? sessionsRoot();
  // P-SESS-ARCHIVE.1: archived sessions are found too (marked), straight from the index: no file is read.
  const rows = [...await workspaceSessions(cwd, root), ...await archivedRows(cwd, root)];
  const named: SessionHit[] = [];
  const said: SessionHit[] = [];
  for (const { row: info, text } of rows) {
    if (info.kind === "kg-ingest") continue;
    const label = `${info.title}\n${info.model}\n${opts.filter?.spokes.get(info.id) ?? ""}`;
    const inLabel = res.map((re) => re.test(label));
    if (inLabel.every(Boolean)) { named.push(info); continue; }
    if (!res.every((re, i) => inLabel[i] || re.test(text))) continue;
    const m = res[inLabel.indexOf(false)]!.exec(text);
    said.push(m ? { ...info, snippet: snippetAt(text, m.index, m[0].length) } : info);
  }
  const visible = spokeView([...named, ...said], opts.filter);
  return { hits: visible.rows.slice(0, Math.max(1, opts.limit ?? 50)), total: visible.rows.length, hiddenSpokes: visible.hidden };
}

/** Every parseable session of `cwd` with its search text, newest first, uncapped: the one scan the listing
 *  and search share. Joins an in-flight all-workspace scan but never reuses a finished one (reuseMs 0). */
async function workspaceSessions(cwd: string, root: string): Promise<{ row: SessionInfo; text: string }[]> {
  const want = norm(cwd);
  const out: { row: SessionInfo; text: string }[] = [];
  for (const { row: { cwd: scwd, ...row }, text } of await scanSessions(root, 0)) if (norm(scwd) === want) out.push({ row, text });
  return out;
}

// ── P-SESS-ARCHIVE.1 (ADR-0554): archive and restore ──────────────────────────────────────────────────────
// Archiving moves a transcript to the same relative path under `<root>-archive` and moves its index entry
// with it, so it is never parsed again, never stat()ed by the sidebar poll, and still searchable. Nothing is
// deleted. Restoring is the reverse rename; opening, recovering or deleting an archived session restores or
// finds it first (dev.ts), because omp loads sessions only from the sessions folder.

/** Archive roots whose files the index has seen at least once this run. Archived files do not change on
 *  their own, so after one scan the index answers for them; archive and restore keep it in step. */
const archiveScanned = new Set<string>();

/** This workspace's archived sessions with their search text, newest first, from the index. */
async function archivedRows(cwd: string, root: string, refresh = false): Promise<{ row: SessionInfo; text: string }[]> {
  const ar = archiveRootFor(root);
  if (refresh || !archiveScanned.has(ar)) { await scanSessions(ar, 0); archiveScanned.add(ar); }
  const want = norm(cwd);
  const out: { row: SessionInfo; text: string }[] = [];
  for (const [k, e] of sessionIndex) {
    if (under(k, ar) && e.meta && norm(e.scwd) === want) out.push({ row: { ...e.meta, updatedAt: e.mtimeMs, archived: true }, text: e.text });
  }
  return out.sort((a, b) => b.row.updatedAt - a.row.updatedAt);
}

/** The Archived group: this workspace's archived chats, newest first. Re-scans the archive folder (async). */
export async function archivedSessions(cwd: string = currentWorkspace(), root: string = sessionsRoot()): Promise<SessionInfo[]> {
  return (await archivedRows(cwd, root, true)).map((r) => r.row).filter((s) => s.kind !== "kg-ingest");
}

export interface MoveResult { ok: boolean; error?: string }

function moveSession(from: string, to: string): MoveResult {
  if (existsSync(to)) return { ok: false, error: "a session file with that name is already there; nothing was moved" };
  try {
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
  } catch (e) {
    const code = e && typeof e === "object" && "code" in e ? String(e.code) : "";
    return { ok: false, error: code === "EBUSY" || code === "EPERM" ? "the session file is in use by a running agent; close it and try again" : `could not move the session file (${code || "error"})` };
  }
  const e = sessionIndex.get(from);
  sessionIndex.delete(from);
  markDirty(from);
  if (e) { try { const st = statSync(to); sessionIndex.set(to, { ...e, mtimeMs: st.mtimeMs, size: st.size }); markDirty(to); } catch { /* re-indexed on the next scan */ } }
  allScans.clear();
  return { ok: true };
}

function sessionCwd(p: string): string {
  const known = sessionIndex.get(p)?.scwd;
  if (known) return known;
  try { return sessionRecord(readFileSync(p, "utf8"), basename(p)).cwd; } catch { return ""; }
}

/** Archive one session. `cwd` set = refuse a session of another workspace (the sidebar's rule for delete).
 *  Already archived counts as done. The caller refuses live sessions (dev.ts knows who holds what). */
export function archiveSession(id: string, opts: { cwd?: string; root?: string } = {}): MoveResult {
  const root = opts.root ?? sessionsRoot();
  const from = findSessionPath(id, root);
  if (!from) return findSessionPath(id, archiveRootFor(root)) ? { ok: true } : { ok: false, error: "session not found" };
  const scwd = opts.cwd ? sessionCwd(from) : "";
  if (opts.cwd && scwd && norm(scwd) !== norm(opts.cwd)) return { ok: false, error: "session belongs to another workspace" };
  return moveSession(from, join(archiveRootFor(root), relative(root, from)));
}

/** Bring an archived session back to the sessions folder. `restored` false = it was not archived. */
export function restoreSession(id: string, root: string = sessionsRoot()): MoveResult & { restored: boolean } {
  if (findSessionPath(id, root)) return { ok: true, restored: false };
  const ar = archiveRootFor(root);
  const from = findSessionPath(id, ar);
  if (!from) return { ok: false, restored: false, error: "session not found" };
  const r = moveSession(from, join(root, relative(ar, from)));
  return { ...r, restored: r.ok };
}

export interface ArchivePolicy {
  /** Run the rule on its own (on engine start and every few hours). Off by default. */
  auto: boolean;
  /** Archive a session untouched for this many days. */
  days: number;
  /** Spoke sessions and empty ones (started, never answered) go after this many days. */
  spokeDays: number;
}
export const DEFAULT_ARCHIVE_POLICY: ArchivePolicy = { auto: false, days: 30, spokeDays: 7 };

/** A stored or posted policy, clamped: whole days, 1 to 3650; anything malformed takes the default. */
export function archivePolicy(v: unknown): ArchivePolicy {
  const o = v && typeof v === "object" ? v : {};
  const day = (x: unknown, d: number): number => (typeof x === "number" && Number.isFinite(x) ? Math.min(3650, Math.max(1, Math.round(x))) : d);
  return {
    auto: "auto" in o && o.auto === true,
    days: day("days" in o ? o.days : undefined, DEFAULT_ARCHIVE_POLICY.days),
    spokeDays: day("spokeDays" in o ? o.spokeDays : undefined, DEFAULT_ARCHIVE_POLICY.spokeDays),
  };
}

export interface ArchiveRun { candidates: number; archived: number; skipped: number }

/** Apply the age rule to every session of every workspace. `keep` = live session ids (Main's, every spoke's,
 *  stopped ones included: a respawn resumes its session) which are never moved. `dryRun` counts only. A file
 *  that cannot be moved (open on Windows) is skipped and retried next run. */
export async function autoArchive(policy: ArchivePolicy, keep: ReadonlySet<string>, spokes: ReadonlyMap<string, string>, opts: { root?: string; now?: number; dryRun?: boolean } = {}): Promise<ArchiveRun> {
  const root = opts.root ?? sessionsRoot();
  const now = opts.now ?? Date.now();
  const run: ArchiveRun = { candidates: 0, archived: 0, skipped: 0 };
  if (!existsSync(root)) return run;
  // P-BOOTPERF.1: the shared async scan refreshes the index; the rule then reads the index, not the files.
  await scanSessions(root, 0);
  for (const [p, e] of [...sessionIndex]) {
    if (!under(p, root)) continue;
    try {
      // Only a probe session (no meta) is read here, for its id: small, and rare.
      const id = e.meta?.id ?? sessionRecord(readFileSync(p, "utf8"), basename(p)).id;
      if (keep.has(id)) continue;
      const days = !e.meta || spokes.has(id) ? policy.spokeDays : policy.days;
      if (now - e.mtimeMs < days * 86_400_000) continue;
      run.candidates++;
      if (opts.dryRun) continue;
      if (moveSession(p, join(archiveRootFor(root), relative(root, p))).ok) run.archived++;
      else run.skipped++;
    } catch { /* unreadable: leave it */ }
  }
  return run;
}

/** P-FLEET.L5 (ADR-0274): one session row for the TIMELINE - a SessionInfo plus the cwd it belongs to,
 *  because the timeline spans EVERY workspace (master chats, lane folders, clones) instead of filtering
 *  to the current one like the sidebar. */
export interface SessionRow extends SessionInfo { cwd: string }

/** How long a finished all-workspace scan answers repeat callers. A real corpus is ~13k files, and even
 *  warm a scan is ~1.5 s of stats; the Timeline dock and the orbit's ghost read land together at boot,
 *  and a paged read asks once per page, so they share one scan instead of each paying for their own. */
const ALL_SCAN_REUSE_MS = 2_000;
/** Files stat'ed / read concurrently: parallel enough to beat the sequential scan, bounded so a cold
 *  scan never holds hundreds of multi-MB transcripts in memory at once. */
const ALL_SCAN_BATCH = 64;
/** One scanned session: its row plus its index `text` (P-SESS-SEARCH.1), which only search reads. */
interface ScannedSession { row: SessionRow; text: string }
/** Per root: the in-flight (doneAt null) or recently finished scan. Single-flight + short reuse. */
const allScans = new Map<string, { rows: Promise<ScannedSession[]>; doneAt: number | null }>();

/** Every parseable session on disk, across ALL workspaces, newest first, uncapped. Rides the SAME
 *  mtime+size index as listSessions (P-PERF.4), so a timeline read re-parses only what changed. ASYNC,
 *  unlike the sidebar's per-workspace listing: this walks every workspace the machine has ever had, and
 *  doing that synchronously froze the whole engine for seconds per call (11 s cold, 1.5-2.6 s warm on
 *  a 13k-session corpus), starving the Timeline dock's own request behind the orbit's paged reads.
 *  Concurrent and back-to-back callers share one scan (`reuseMs`, ALL_SCAN_REUSE_MS by default; 0 joins
 *  only a scan still in flight). */
export async function listAllSessions(root: string = join(homedir(), ".omp", "agent", "sessions"), reuseMs: number = ALL_SCAN_REUSE_MS): Promise<SessionRow[]> {
  return (await scanSessions(root, reuseMs)).map((s) => s.row);
}

/** The single-flight scan behind listAllSessions, the sidebar listing, and search. */
function scanSessions(root: string, reuseMs: number): Promise<ScannedSession[]> {
  const hit = allScans.get(root);
  if (hit && (hit.doneAt === null || Date.now() - hit.doneAt < reuseMs)) return hit.rows;
  const scan: { rows: Promise<ScannedSession[]>; doneAt: number | null } = { rows: scanAllSessions(root), doneAt: null };
  allScans.set(root, scan);
  scan.rows.then(
    () => { scan.doneAt = Date.now(); },
    () => { if (allScans.get(root) === scan) allScans.delete(root); },
  );
  return scan.rows;
}

async function scanAllSessions(root: string): Promise<ScannedSession[]> {
  if (!existsSync(root)) return [];
  loadIndexStore(root);
  const all: ScannedSession[] = [];
  const seen = new Set<string>();
  let dirs: string[];
  try { dirs = await readdir(root); } catch { return []; }
  for (const d of dirs) {
    const dir = join(root, d);
    let files: string[];
    try { files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl")); } catch { continue; } // not a dir / unreadable
    for (let i = 0; i < files.length; i += ALL_SCAN_BATCH) {
      await Promise.all(files.slice(i, i + ALL_SCAN_BATCH).map(async (f) => {
        const p = join(dir, f);
        try {
          // One handle for the size/mtime check and the read: nothing can swap the file in between.
          const h = await open(p, "r");
          let e: IndexEntry;
          try {
            const st = await h.stat();
            const hit = sessionIndex.get(p);
            e = hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size ? hit : indexedEntry(p, f, st, await h.readFile("utf8"));
          } finally { await h.close(); }
          seen.add(p);
          if (!e.meta) return; // empty/probe session
          all.push({ row: { ...e.meta, updatedAt: e.mtimeMs, cwd: e.scwd }, text: e.text });
        } catch { /* skip unreadable file */ }
      }));
    }
  }
  for (const k of sessionIndex.keys()) if (under(k, root) && !seen.has(k)) { sessionIndex.delete(k); markDirty(k); }
  all.sort((a, b) => b.row.updatedAt - a.row.updatedAt);
  return all;
}

/** P-KG-INGEST.2 (ADR-0079): delete ALL kg-ingest throwaway sessions for one workspace. Defense in depth:
 *  only removes files that BOTH (a) belong to the current workspace AND (b) are extractor throwaways
 *  (`isIngestPrompt` on the first user message) — a real chat is never touched. Returns the count removed. */
export function clearIngestSessions(cwd: string = currentWorkspace(), root: string = join(homedir(), ".omp", "agent", "sessions")): { ok: boolean; cleared: number } {
  if (!existsSync(root)) return { ok: true, cleared: 0 };
  allScans.delete(root); // P-BOOTPERF.1: a scan in flight may predate the removal; the next list rescans
  const want = norm(cwd);
  let cleared = 0;
  for (const d of readdirSync(root)) {
    const dir = join(root, d);
    try {
      if (!statSync(dir).isDirectory()) continue;
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".jsonl")) continue;
        const p = join(dir, f);
        try {
          let scwd = "", isIngest = false, sawUser = false;
          for (const ln of readFileSync(p, "utf8").split("\n")) {
            if (!ln) continue;
            let o: any; try { o = JSON.parse(ln); } catch { continue; }
            if (o.type === "session") scwd = o.cwd ?? "";
            else if (o.type === "message" && o.message?.role === "user" && !sawUser) { sawUser = true; isIngest = isIngestPrompt(firstUserText(o.message)); }
            if (scwd && sawUser) break; // we know cwd + ingest-ness — stop reading
          }
          if (isIngest && norm(scwd) === want) { rmSync(p, { force: true }); cleared++; }
        } catch { /* skip unreadable/locked file */ }
      }
    } catch { /* skip dir */ }
  }
  return { ok: true, cleared };
}

function msgText(message: any): string {
  const c = message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.filter((x: any) => x?.type === "text").map((x: any) => x.text).join("");
  return "";
}

// P-PERF.4 (ADR-0131): tail-first transcript page. A resume used to ship the WHOLE transcript over
// IPC and into the DOM - unbounded for a long chat. `limit` returns only the LAST N messages plus the
// true total so the UI can say "showing the last N of M". limit 0 = everything (export paths etc.).
// P-RESUME.1 (ADR-0171): user messages carry their 1-based user ordinal (`turn`) so restored agent
// activity (thinking/tool steps from the lucid-steps sidecar) anchors to the right message even in a
// tail-limited page; `userTotal` re-syncs the recorder's turn counter on every resume read.
export interface TranscriptPage { messages: { role: string; text: string; turn?: number }[]; total: number; userTotal: number }

/** The `{ type: "session" }` record of a transcript: its id and cwd. Found by SCANNING for the record,
 *  never by reading line one: omp 18 prepends a fixed-width `{ type: "title" }` slot as the first line of
 *  every session file, so "line one is the session record" stopped being true for every session written
 *  since the 18.x pin, and a reader built on it matched no file at all (the sidebar listed sessions the
 *  chat could not load). The scan stops at the record; on a file with none, the filename stands in. */
export function sessionRecord(content: string, fallbackId: string): { id: string; cwd: string } {
  for (const ln of content.split("\n")) {
    if (!ln) continue;
    let o: unknown;
    try { o = JSON.parse(ln); } catch { continue; }
    if (o && typeof o === "object" && "type" in o && o.type === "session") {
      const id = "id" in o && typeof o.id === "string" && o.id ? o.id : fallbackId;
      const cwd = "cwd" in o && typeof o.cwd === "string" ? o.cwd : "";
      return { id, cwd };
    }
  }
  return { id: fallbackId, cwd: "" };
}

/** Read a session's user/assistant transcript (for resuming into the chat), tail-first when limited. */
export function sessionMessages(id: string, limit = 0, root: string = sessionsRoot()): TranscriptPage {
  // P-SESS-ARCHIVE.1: located through the index (it used to read every file until the id matched), and an
  // archived session's transcript reads in place: reviewing one never has to restore it.
  const p = findSessionPath(id, root) ?? findSessionPath(id, archiveRootFor(root));
  let content = "";
  try { if (p) content = readFileSync(p, "utf8"); } catch { /* unreadable */ }
  if (!content) return { messages: [], total: 0, userTotal: 0 };
  const out: { role: string; text: string; turn?: number }[] = [];
  let users = 0;
  for (const ln of content.split("\n")) {
    if (!ln) continue;
    let o: any; try { o = JSON.parse(ln); } catch { continue; }
    if (o.type === "message" && (o.message?.role === "user" || o.message?.role === "assistant")) {
      // Strip the injected preamble from USER turns only (assistant text never carries it).
      const raw = msgText(o.message);
      const t = o.message.role === "user" ? stripInjectedPreamble(raw) : raw;
      if (t.trim()) {
        if (o.message.role === "user") { users++; out.push({ role: "user", text: t, turn: users }); }
        else out.push({ role: "assistant", text: t });
      }
    }
  }
  return { messages: limit > 0 && out.length > limit ? out.slice(-limit) : out, total: out.length, userTotal: users };
}

/** Delete a session's omp `.jsonl` transcript from disk. Restricted to the CURRENT
 *  workspace's sessions (defense in depth) and matched by session id (or filename).
 *  Returns `{ ok }`; `ok:false` when the session is not found, belongs to another
 *  workspace, or the file can't be removed (e.g. still open by omp on Windows — close
 *  the live session first). The append-only DuckDB audit/provenance is a separate store
 *  and is intentionally untouched (issue #53). */
export function deleteSession(id: string, cwd: string = currentWorkspace(), root: string = sessionsRoot()): { ok: boolean; error?: string } {
  // P-SESS-ARCHIVE.1: an archived session is deletable from the Archived group too; its index entry goes with it.
  const p = findSessionPath(id, root) ?? findSessionPath(id, archiveRootFor(root));
  if (!p) return { ok: false, error: "session not found" };
  const scwd = sessionCwd(p);
  if (scwd && norm(scwd) !== norm(cwd)) return { ok: false, error: "session belongs to another workspace" };
  try { rmSync(p, { force: true }); }
  catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  sessionIndex.delete(p);
  markDirty(p);
  allScans.clear();
  return { ok: true };
}
