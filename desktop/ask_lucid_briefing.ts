// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/ask_lucid_briefing.ts - P-ASKLUCID.4 (ADR-0585): what the lanes and the other sessions were last doing.
//
// Until now Lucid saw a lane's name and state, never what it was asked or what it answered, and he saw no
// other session at all. A briefing needs both. This module turns two things the engine already holds
// into text:
//   - each lane's conversation tail: the last request it was given and the last thing it said back;
//   - the sessions in this workspace: which is open, which a lane ran, and the last exchange of the most
//     recent ones.
//
// Both are written by agents and by whatever those agents read, so the service scans each as its own view
// and fences it as untrusted. Nothing here decides anything: it only shortens and lays out.
//
// Two sizes. An ordinary question gets a short view, so a side question stays cheap. "Brief me" gets the
// long one.
//
// Pure, and without imports.

export type BriefMode = "normal" | "brief";

export const BRIEF_LIMITS: Record<BriefMode, {
  /** Characters for the whole lane-activity view, and for the whole sessions view. */
  activity: number; sessions: number;
  /** How many lanes get their conversation tail shown. */
  lanes: number;
  /** Characters of a lane's last request, and of its last answer. */
  request: number; answer: number;
  /** How many sessions are listed, and how many of those get their last exchange shown. */
  sessionRows: number; sessionTails: number;
  /** Characters of each side of a session's last exchange. */
  tailText: number;
}> = {
  normal: { activity: 3000, sessions: 2500, lanes: 8, request: 240, answer: 500, sessionRows: 8, sessionTails: 2, tailText: 300 },
  brief: { activity: 9000, sessions: 6000, lanes: 16, request: 400, answer: 1200, sessionRows: 14, sessionTails: 5, tailText: 500 },
};

/** What the Brief me button asks. */
export const BRIEF_QUESTION = "Brief me on what is going on: what needs me, what is running, what finished, and what you would do next.";

/** Added to the brief: how a briefing is laid out. */
export const ASK_BRIEFING_RULES = [
  "You can also see what each fleet lane was last asked and last answered, and the recent sessions in this workspace with the last exchange of the most recent ones.",
  "When the user asks for a briefing, a status or a catch-up, answer in this order and skip a part that is empty:",
  "1. Needs you: approvals waiting, failed or blocked work, questions an agent asked.",
  "2. Running now: who is working on what.",
  "3. Finished: what was completed since, in one line each.",
  "4. Next: one concrete step you would take, as a proposal when it is something you can propose.",
  "Keep each item to one or two lines and name lanes, tasks and sessions by the names you were shown.",
].join("\n");

function rec(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
}
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
const CONTROLS = new RegExp("[\\u0000-\\u0008\\u000b-\\u001f\\u007f\\u2028\\u2029]+", "g");

/** One line, bounded. */
function line(v: unknown, max: number): string {
  const s = str(v).replace(CONTROLS, " ").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
/** A passage folded to one paragraph, bounded, keeping its END when it is too long: the last thing an agent
 *  said is what a briefing needs, and it is at the bottom of a long answer. */
function tail(v: unknown, max: number): string {
  const s = str(v).replace(CONTROLS, " ").replace(/\s+/g, " ").trim();
  return s.length > max ? `[...] ${s.slice(s.length - max)}` : s;
}
function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}\n[cut: ${s.length - max} more characters]` : s;
}
function ago(at: number, now: number): string {
  if (!(at > 0) || at > now) return "no activity yet";
  const s = Math.floor((now - at) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** A lane's assistant turn keeps `[ran: ...]` lines for the tools it used. Split them off: the count is
 *  worth a few words, the titles are not worth the space. */
export function splitToolLines(text: string): { said: string; tools: number } {
  let tools = 0;
  const said: string[] = [];
  for (const l of text.split(/\r?\n/)) {
    if (/^\s*\[ran: /.test(l)) tools += 1; else said.push(l);
  }
  return { said: said.join("\n"), tools };
}

/** PURE: how urgent a lane is for a briefing: waiting on the user first, then failed, working, the rest. */
export function laneUrgency(lane: Record<string, unknown>): number {
  const status = str(lane.status).toLowerCase();
  if (rec(lane.pendingApproval) || status.includes("approval") || status.includes("waiting")) return 0;
  if (status.includes("error") || status.includes("fail") || status.includes("dead") || status.includes("stuck")) return 1;
  if (status.includes("work") || status.includes("busy") || status.includes("run")) return 2;
  return 3;
}

/** PURE: each lane's last request and last answer, most urgent lane first. `transcriptOf` returns the lane's
 *  turns (`{ role, text, error? }[]`, the shape `fleet.laneTranscript` hands out) and is read structurally. */
export function laneActivityContext(status: unknown, transcriptOf: (laneId: string) => unknown, mode: BriefMode = "normal"): { text: string; lanes: number } {
  const lim = BRIEF_LIMITS[mode];
  const all = (Array.isArray(rec(status)?.lanes) ? (rec(status)!.lanes as unknown[]) : []).map(rec).filter((l): l is Record<string, unknown> => l !== null && str(l.id) !== "");
  if (all.length === 0) return { text: "", lanes: 0 };
  const ordered = all
    .map((lane, order) => ({ lane, order, urgency: laneUrgency(lane) }))
    .sort((a, b) => a.urgency - b.urgency || num(b.lane.lastActivityAt) - num(a.lane.lastActivityAt) || a.order - b.order)
    .map((o) => o.lane);
  const rows: string[] = [];
  let shown = 0;
  for (const lane of ordered.slice(0, lim.lanes)) {
    let turns: unknown[] = [];
    try { const t = transcriptOf(str(lane.id)); turns = Array.isArray(t) ? t : []; } catch { turns = []; }
    const name = `lane "${line(lane.name, 80) || "unnamed"}"`;
    const users = turns.map(rec).filter((t) => t?.role === "user");
    const answers = turns.map(rec).filter((t) => t?.role === "assistant");
    const lastUser = users[users.length - 1];
    const lastAnswer = answers[answers.length - 1];
    if (!lastUser && !lastAnswer) { rows.push(`${name}: no conversation yet.`); continue; }
    shown += 1;
    const out = [`${name} (${users.length} ${users.length === 1 ? "request" : "requests"} so far):`];
    if (lastUser) out.push(`  last asked: ${tail(lastUser.text, lim.request) || "(empty)"}`);
    if (lastAnswer) {
      const { said, tools } = splitToolLines(str(lastAnswer.text));
      const ranAfter = lastUser ? turns.indexOf(lastAnswer) > turns.indexOf(lastUser) : true;
      const text = tail(said, lim.answer);
      const used = tools > 0 ? ` (used ${tools} ${tools === 1 ? "tool" : "tools"})` : "";
      if (ranAfter) out.push(`  last answered${used}: ${text || "(no text, tools only)"}`);
      else out.push("  it has not answered that request yet.");
      const err = line(lastAnswer.error, 200);
      if (err && ranAfter) out.push(`  that turn ended with an error: ${err}`);
    } else out.push("  it has not answered yet.");
    rows.push(out.join("\n"));
  }
  if (all.length > lim.lanes) rows.push(`(${all.length - lim.lanes} more lanes not shown)`);
  return { text: clip(rows.join("\n"), lim.activity), lanes: shown };
}

export interface SessionsOptions {
  /** The session open in the main chat, if any. */
  currentId: string | null;
  now: number;
  mode?: BriefMode;
}

/** PURE: the sessions in this workspace, most recent first, with the last exchange of the first few.
 *  `rows` is the session list (`{ id, title, model, updatedAt, turns, spoke? }[]`); `tailOf` returns
 *  `{ messages: { role, text }[] }` for one session. Both are read structurally. */
export function sessionsContext(rows: unknown, tailOf: (id: string) => unknown, opts: SessionsOptions): { text: string; sessions: number } {
  const lim = BRIEF_LIMITS[opts.mode ?? "normal"];
  const list = (Array.isArray(rows) ? rows : []).map(rec).filter((r): r is Record<string, unknown> => r !== null && str(r.id) !== "" && r.kind !== "kg-ingest");
  if (list.length === 0) return { text: "", sessions: 0 };
  const sorted = [...list].sort((a, b) => (str(b.id) === opts.currentId ? 1 : 0) - (str(a.id) === opts.currentId ? 1 : 0) || num(b.updatedAt) - num(a.updatedAt));
  const out: string[] = [];
  let tails = 0;
  for (const s of sorted.slice(0, lim.sessionRows)) {
    const id = str(s.id);
    const where = id === opts.currentId ? "; open in the main chat now" : str(s.spoke) ? `; run by lane "${line(s.spoke, 60)}"` : "";
    const head = `- "${line(s.title, 120) || "untitled"}": ${Math.max(0, Math.round(num(s.turns)))} turns; last activity ${ago(num(s.updatedAt), opts.now)}${where}`;
    if (tails >= lim.sessionTails) { out.push(head); continue; }
    let messages: unknown[] = [];
    try { const m = rec(tailOf(id))?.messages; messages = Array.isArray(m) ? m : []; } catch { messages = []; }
    const msgs = messages.map(rec).filter((m): m is Record<string, unknown> => m !== null);
    const lastUser = [...msgs].reverse().find((m) => m.role === "user");
    const lastAnswer = [...msgs].reverse().find((m) => m.role === "assistant");
    if (!lastUser && !lastAnswer) { out.push(head); continue; }
    tails += 1;
    const extra: string[] = [];
    if (lastUser) extra.push(`    last asked: ${tail(lastUser.text, lim.tailText) || "(empty)"}`);
    if (lastAnswer) extra.push(`    last answered: ${tail(splitToolLines(str(lastAnswer.text)).said, lim.tailText) || "(no text)"}`);
    out.push([head, ...extra].join("\n"));
  }
  if (list.length > lim.sessionRows) out.push(`(${list.length - lim.sessionRows} older sessions not listed)`);
  return { text: clip(out.join("\n"), lim.sessions), sessions: Math.min(list.length, lim.sessionRows) };
}
