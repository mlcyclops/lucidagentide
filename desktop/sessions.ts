// desktop/sessions.ts — list REAL omp sessions for the current project from disk.
//
// omp persists every session (interactive or ACP) as a .jsonl under
// ~/.omp/agent/sessions/<encoded-cwd>/. We read those, filter to this repo's cwd,
// and derive a title (first user message), model, turn count, and last-modified.
// New GUI chats write new files here, so they appear on the next poll.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..");
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

export function listSessions(cwd: string = REPO): SessionInfo[] {
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
          out.push({ id: id || f, title: title || "Untitled session", model: model.replace(/^anthropic\//, "") || "—", updatedAt: statSync(p).mtimeMs, turns });
        } catch { /* skip unreadable file */ }
      }
    } catch { /* skip dir */ }
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out.slice(0, 40);
}
