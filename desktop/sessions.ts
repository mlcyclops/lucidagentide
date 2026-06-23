// desktop/sessions.ts - list REAL omp sessions for the current project from disk.
//
// omp persists every session (interactive or ACP) as a .jsonl under
// ~/.omp/agent/sessions/<encoded-cwd>/. We read those, filter to this repo's cwd,
// and derive a title (first user message), model, turn count, and last-modified.
// New GUI chats write new files here, so they appear on the next poll.

import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { currentWorkspace } from "./workspace.ts";

const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

export interface SessionInfo {
  id: string;
  title: string;
  model: string;
  updatedAt: number;
  turns: number;
}

function firstUserText(message: any): string {
  const c = message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) for (const part of c) if (part?.type === "text" && part.text) return part.text;
  return "";
}

export function listSessions(cwd: string = currentWorkspace()): SessionInfo[] {
  const root = join(homedir(), ".omp", "agent", "sessions");
  if (!existsSync(root)) return [];
  const want = norm(cwd);
  const out: SessionInfo[] = [];
  for (const d of readdirSync(root)) {
    const dir = join(root, d);
    try {
      if (!statSync(dir).isDirectory()) continue;
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".jsonl")) continue;
        const p = join(dir, f);
        try {
          let id = "", scwd = "", model = "", title = "", turns = 0;
          for (const ln of readFileSync(p, "utf8").split("\n")) {
            if (!ln) continue;
            let o: any;
            try { o = JSON.parse(ln); } catch { continue; }
            if (o.type === "session") { id = o.id ?? f; scwd = o.cwd ?? ""; }
            else if (o.type === "model_change" && o.model) model = o.model;
            else if (o.type === "message" && o.message) {
              if (o.message.role === "user" && !title) { const t = firstUserText(o.message); if (t.trim()) title = t.trim().slice(0, 64); }
              if (o.message.role === "assistant" && o.message.usage) { turns++; if (o.message.model) model = o.message.model; }
            }
          }
          if (norm(scwd) !== want) continue;
          if (!title && turns === 0) continue; // skip empty/probe sessions with no prompt
          out.push({ id: id || f, title: title || "Untitled session", model: model.replace(/^anthropic\//, "") || "-", updatedAt: statSync(p).mtimeMs, turns });
        } catch { /* skip unreadable file */ }
      }
    } catch { /* skip dir */ }
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out.slice(0, 40);
}

function msgText(message: any): string {
  const c = message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.filter((x: any) => x?.type === "text").map((x: any) => x.text).join("");
  return "";
}

/** Read a session's user/assistant transcript (for resuming into the chat). */
export function sessionMessages(id: string): { role: string; text: string }[] {
  const root = join(homedir(), ".omp", "agent", "sessions");
  if (!existsSync(root)) return [];
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
            const t = msgText(o.message);
            if (t.trim()) out.push({ role: o.message.role, text: t });
          }
        }
        return out;
      }
    } catch { /* skip */ }
  }
  return [];
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
