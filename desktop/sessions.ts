// desktop/sessions.ts - list REAL omp sessions for the current project from disk.
//
// omp persists every session (interactive or ACP) as a .jsonl under
// ~/.omp/agent/sessions/<encoded-cwd>/. We read those, filter to this repo's cwd,
// and derive a title (first user message), model, turn count, and last-modified.
// New GUI chats write new files here, so they appear on the next poll.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { UNTRUSTED_END, UNTRUSTED_START } from "../harness/prompt/assembler.ts";
import { currentWorkspace } from "./workspace.ts";

const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

// The per-session USER-TURN PREAMBLE that acp_backend prepends to the first typed
// message (never the frozen prefix): the AskSage persona (UNTRUSTED_CONTENT_* wrapped),
// the active bundled skill (<active-skill>), the personalization recall (<user-profile>),
// and the cross-session memory recall (<recalled-memory>). The model needs these, but
// they must NOT appear in the chat transcript or session titles. omp persists them inside
// the user turn on disk, so strip any leading block(s) before we DISPLAY a user message.
// Display-only: the model already received the full body live. See issue #52.
const PREAMBLE_BLOCKS: RegExp[] = [
  new RegExp(`^\\s*${UNTRUSTED_START}[\\s\\S]*?${UNTRUSTED_END}`),
  /^\s*<active-skill\b[\s\S]*?<\/active-skill>/,
  /^\s*<user-profile>[\s\S]*?<\/user-profile>/,
  /^\s*<recalled-memory>[\s\S]*?<\/recalled-memory>/,
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
              if (o.message.role === "user" && !title) { const t = stripInjectedPreamble(firstUserText(o.message)); if (t.trim()) title = t.trim().slice(0, 64); }
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
            // Strip the injected preamble from USER turns only (assistant text never carries it).
            const raw = msgText(o.message);
            const t = o.message.role === "user" ? stripInjectedPreamble(raw) : raw;
            if (t.trim()) out.push({ role: o.message.role, text: t });
          }
        }
        return out;
      }
    } catch { /* skip */ }
  }
  return [];
}
