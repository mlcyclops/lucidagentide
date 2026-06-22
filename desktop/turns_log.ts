// desktop/turns_log.ts — ADR-0009 Phase B (issue #12): GUI-owned per-turn transcript capture.
//
// WHY THIS EXISTS: the omp tool-call hook only sees tool calls — never the user's prompt or the
// free-text reply. The one place that observes a whole turn is the GUI's acp_backend.prompt()
// stream. But the GUI process can't co-write agent_obs.duckdb (the omp child holds that single
// writer), so — exactly like security_log.ts / skills_log.ts — turns are recorded HERE to an
// append-only JSONL (~/.omp/lucid-turns.jsonl) plus an in-memory view, and a metadata-only
// `turn_captured` telemetry event is emitted through the canonical Telemetry class (validated
// against the EventName enum).
//
// SANITIZED + sha ONLY: the stored text is escapeMarkdown'd (the harness `turns` table is the
// raw-preserving, replayable core — turns.ts). GUI-side we keep the sanitized transcript + the
// raw's sha256; the raw text itself is never persisted here. Best-effort: a write failure never
// breaks the chat.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { escapeMarkdown } from "../harness/export/safe_export.ts";
import { Telemetry, type EventSink } from "../harness/telemetry/events.ts";
import { EVENTS_LOG_PATH } from "./skills_log.ts";

export interface TurnRecord {
  id: string;
  sessionId: string;
  seq: number;
  role: "user" | "assistant";
  sanitized: string; // escapeMarkdown'd — the only text stored / rendered GUI-side
  rawSha256: string; // raw referenced by hash; the raw text is NOT persisted GUI-side
  trust: "untrusted" | "trusted";
  at: string; // ISO timestamp
}

const LOG_PATH = join(homedir(), ".omp", "lucid-turns.jsonl");
let mem: TurnRecord[] | null = null;
let seq = 0; // monotonic order across captures; continued above the persisted max on load

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** Load the append-only log into memory, advancing `seq` past the highest persisted value. */
function load(): TurnRecord[] {
  if (mem) return mem;
  const out: TurnRecord[] = [];
  try {
    if (existsSync(LOG_PATH)) {
      for (const line of readFileSync(LOG_PATH, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try { out.push(JSON.parse(line) as TurnRecord); } catch { /* skip corrupt line */ }
      }
    }
  } catch { /* unreadable — best-effort, keep what we have */ }
  for (const r of out) if (typeof r.seq === "number" && r.seq >= seq) seq = r.seq + 1;
  mem = out;
  return mem;
}

function append(rec: TurnRecord, path: string): void {
  try { mkdirSync(dirname(path), { recursive: true }); appendFileSync(path, JSON.stringify(rec) + "\n"); }
  catch { /* audit is best-effort; the in-memory view still works for the session */ }
}

function recordOne(
  sessionId: string,
  role: TurnRecord["role"],
  text: string,
  trust: TurnRecord["trust"],
  blocked: number,
  sink: string | EventSink,
  logPath: string,
): void {
  const rec: TurnRecord = {
    id: Snowflake.next(), sessionId, seq: seq++, role,
    sanitized: escapeMarkdown(text), rawSha256: sha256(text), trust,
    at: new Date().toISOString(),
  };
  if (logPath === LOG_PATH) load().push(rec); // live in-memory view tracks only the real log
  append(rec, logPath);
  // METADATA ONLY — never the prompt/reply text (invariant #8). Name is validated by Telemetry.
  try {
    new Telemetry({ runId: Snowflake.next(), sessionId: sessionId || "gui", sink }).emit("turn_captured", {
      turn_id: rec.id, role, seq: rec.seq, raw_sha256: rec.rawSha256, trust_label: trust, blocked, text_len: text.length,
    });
  } catch { /* telemetry best-effort */ }
}

/** Capture one chat turn-pair (the user prompt + the assistant reply). Sanitized + sha only;
 *  fully guarded so it can never break the chat turn. `sink`/`logPath` are injectable for tests. */
export function recordTurns(
  t: { sessionId: string; userText: string; assistantText: string; blocked?: number },
  opts: { sink?: string | EventSink; logPath?: string } = {},
): void {
  const sink = opts.sink ?? EVENTS_LOG_PATH;
  const logPath = opts.logPath ?? LOG_PATH;
  try {
    if (!t.sessionId || !t.userText) return;
    recordOne(t.sessionId, "user", t.userText, "untrusted", Math.max(0, Math.trunc(t.blocked ?? 0)), sink, logPath);
    if (t.assistantText) recordOne(t.sessionId, "assistant", t.assistantText, "trusted", 0, sink, logPath);
  } catch { /* never break chat on a capture failure */ }
}

/** Recent turns for the developer Logs view, oldest→newest within the slice (transcript order). */
export function recentTurns(limit = 60): TurnRecord[] {
  return load().slice(-Math.max(1, limit));
}
