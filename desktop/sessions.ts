// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/sessions.ts - list REAL omp sessions for the current project from disk.
//
// omp persists every session (interactive or ACP) as a .jsonl under
// ~/.omp/agent/sessions/<encoded-cwd>/. We read those, filter to this repo's cwd,
// and derive a title (first user message), model, turn count, and last-modified.
// New GUI chats write new files here, so they appear on the next poll.

import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { UNTRUSTED_END, UNTRUSTED_START } from "../harness/prompt/assembler.ts";
import { EXTRACT_SYSTEM } from "../harness/personal/distiller.ts";
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

export interface SessionInfo {
  id: string;
  title: string;
  model: string;
  updatedAt: number;
  turns: number;
  kind?: "chat" | "kg-ingest"; // P-KG-INGEST.1b: throwaway model-extraction sessions (import + AI-learn)
}
// P-KG-INGEST.1b (ADR-0076): the chat list, with throwaway extraction sessions split into their own group.
export interface SessionList { sessions: SessionInfo[]; ingest: SessionInfo[] }

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
interface IndexEntry { mtimeMs: number; size: number; scwd: string; meta: Omit<SessionInfo, "updatedAt"> | null }
const sessionIndex = new Map<string, IndexEntry>();
let indexParses = 0; // test seam: how many files were actually (re)parsed

/** Parse one session .jsonl into list metadata. `meta: null` = an empty/probe session (cached too, so
 *  it isn't re-parsed every poll just to be skipped again). */
function parseSessionFile(p: string, f: string): { scwd: string; meta: Omit<SessionInfo, "updatedAt"> | null } {
  indexParses++;
  let id = "", scwd = "", model = "", title = "", turns = 0;
  let kind: "chat" | "kg-ingest" = "chat";
  for (const ln of readFileSync(p, "utf8").split("\n")) {
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
        else { const t = stripInjectedPreamble(raw); if (t.trim()) title = t.trim().slice(0, 64); }
      }
      if (o.message.role === "assistant" && o.message.usage) { turns++; if (o.message.model) model = o.message.model; }
    }
  }
  if (!title && turns === 0) return { scwd, meta: null }; // empty/probe session - remembered, skipped
  return { scwd, meta: { id: id || f, title: title || "Untitled session", model: model.replace(/^anthropic\//, "") || "-", turns, kind } };
}

export function __sessionIndexStats(): { parses: number; entries: number } { return { parses: indexParses, entries: sessionIndex.size }; }
export function __resetSessionIndex(): void { sessionIndex.clear(); indexParses = 0; }

export function listSessions(cwd: string = currentWorkspace(), root: string = join(homedir(), ".omp", "agent", "sessions")): SessionList {
  if (!existsSync(root)) return { sessions: [], ingest: [] };
  const want = norm(cwd);
  const all: SessionInfo[] = [];
  const seen = new Set<string>();
  for (const d of readdirSync(root)) {
    const dir = join(root, d);
    try {
      if (!statSync(dir).isDirectory()) continue;
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".jsonl")) continue;
        const p = join(dir, f);
        try {
          const st = statSync(p);
          seen.add(p);
          let e = sessionIndex.get(p);
          if (!e || e.mtimeMs !== st.mtimeMs || e.size !== st.size) {
            e = { mtimeMs: st.mtimeMs, size: st.size, ...parseSessionFile(p, f) };
            sessionIndex.set(p, e);
          }
          if (!e.meta || norm(e.scwd) !== want) continue;
          all.push({ ...e.meta, updatedAt: st.mtimeMs });
        } catch { /* skip unreadable file */ }
      }
    } catch { /* skip dir */ }
  }
  // Prune index entries for files deleted under THIS root (other roots - e.g. tests - are untouched).
  for (const k of sessionIndex.keys()) if (k.startsWith(root) && !seen.has(k)) sessionIndex.delete(k);
  all.sort((a, b) => b.updatedAt - a.updatedAt);
  // Split: real chats (capped) vs the collapsed ingest group — so a big import can't crowd out chats.
  return {
    sessions: all.filter((s) => s.kind !== "kg-ingest").slice(0, 40),
    ingest: all.filter((s) => s.kind === "kg-ingest").slice(0, 60),
  };
}

/** P-KG-INGEST.2 (ADR-0079): delete ALL kg-ingest throwaway sessions for one workspace. Defense in depth:
 *  only removes files that BOTH (a) belong to the current workspace AND (b) are extractor throwaways
 *  (`isIngestPrompt` on the first user message) — a real chat is never touched. Returns the count removed. */
export function clearIngestSessions(cwd: string = currentWorkspace(), root: string = join(homedir(), ".omp", "agent", "sessions")): { ok: boolean; cleared: number } {
  if (!existsSync(root)) return { ok: true, cleared: 0 };
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
export interface TranscriptPage { messages: { role: string; text: string }[]; total: number }

/** Read a session's user/assistant transcript (for resuming into the chat), tail-first when limited. */
export function sessionMessages(id: string, limit = 0, root: string = join(homedir(), ".omp", "agent", "sessions")): TranscriptPage {
  if (!existsSync(root)) return { messages: [], total: 0 };
  for (const d of readdirSync(root)) {
    const dir = join(root, d);
    try {
      if (!statSync(dir).isDirectory()) continue;
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".jsonl")) continue;
        const content = readFileSync(join(dir, f), "utf8");
        let sid = f;
        try { sid = JSON.parse(content.split("\n", 1)[0] ?? "")?.id ?? f; } catch { /* keep f */ }
        if (sid !== id && f !== id) continue;
        const out: { role: string; text: string }[] = [];
        for (const ln of content.split("\n")) {
          if (!ln) continue;
          let o: any; try { o = JSON.parse(ln); } catch { continue; }
          if (o.type === "message" && (o.message?.role === "user" || o.message?.role === "assistant")) {
            // Strip the injected preamble from USER turns only (assistant text never carries it).
            const raw = msgText(o.message);
            const t = o.message.role === "user" ? stripInjectedPreamble(raw) : raw;
            if (t.trim()) out.push({ role: o.message.role, text: t });
          }
        }
        return { messages: limit > 0 && out.length > limit ? out.slice(-limit) : out, total: out.length };
      }
    } catch { /* skip */ }
  }
  return { messages: [], total: 0 };
}

/** Delete a session's omp `.jsonl` transcript from disk. Restricted to the CURRENT
 *  workspace's sessions (defense in depth) and matched by session id (or filename).
 *  Returns `{ ok }`; `ok:false` when the session is not found, belongs to another
 *  workspace, or the file can't be removed (e.g. still open by omp on Windows — close
 *  the live session first). The append-only DuckDB audit/provenance is a separate store
 *  and is intentionally untouched (issue #53). */
export function deleteSession(id: string, cwd: string = currentWorkspace(), root: string = join(homedir(), ".omp", "agent", "sessions")): { ok: boolean; error?: string } {
  if (!existsSync(root)) return { ok: false, error: "no sessions directory" };
  const want = norm(cwd);
  for (const d of readdirSync(root)) {
    const dir = join(root, d);
    try {
      if (!statSync(dir).isDirectory()) continue;
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".jsonl")) continue;
        const p = join(dir, f);
        // Resolve id + cwd from the session record (first matching line), like listSessions.
        let sid = f, scwd = "";
        try {
          for (const ln of readFileSync(p, "utf8").split("\n")) {
            if (!ln) continue;
            let o: any; try { o = JSON.parse(ln); } catch { continue; }
            if (o.type === "session") { sid = o.id ?? f; scwd = o.cwd ?? ""; break; }
          }
        } catch { /* keep filename fallback */ }
        if (sid !== id && f !== id) continue;
        if (scwd && norm(scwd) !== want) return { ok: false, error: "session belongs to another workspace" };
        try { rmSync(p, { force: true }); return { ok: true }; }
        catch (e) { return { ok: false, error: String((e as any)?.message ?? e) }; }
      }
    } catch { /* skip dir */ }
  }
  return { ok: false, error: "session not found" };
}
