// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/session_steps.ts — P-RESUME.1 (ADR-0171): GUI-owned per-session "agent activity" sidecar.
//
// WHY THIS EXISTS: omp's session .jsonl (the file sessionMessages resumes from) persists only
// user/assistant MESSAGES. Thinking streams, tool-call steps, and tool failures were rendered live
// and then existed nowhere — switching sessions and back lost the whole activity history (user
// report). We never write foreign records into omp's transcript (invariant #1: extend, never
// fork), so the GUI records the steps it already observes (every ChatEvent funnels through
// Backend.emit) in its OWN append-only JSONL per session: ~/.omp/lucid-steps/<sid>.jsonl —
// the third use of the security_log.ts sidecar pattern (ADR-0019 C, ADR-0170).
//
// Turn anchoring: each record carries the USER-TURN ordinal it belongs to. The counter increments
// when a prompt begins, and /api/session re-syncs it to the transcript's real user count on every
// resume read — so turns that happened OUTSIDE this GUI (TUI, another machine) can't shift the
// anchors of later ones. Bounded: thinking capped per turn, records capped per turn, fail detail
// capped per record. Best-effort: recording NEVER throws into a turn.

import { appendFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/** One user turn's restored activity, ready for the renderer. */
export interface RestoredTurn {
  turn: number; // 1-based user-message ordinal in the omp transcript
  thinking: string;
  thinkingTruncated: boolean;
  tools: { name: string; detail: string }[];
  fails: { tool: string; reason: string; command?: string; detail?: string }[];
}

/** The subset of ChatEvent fields the recorder reads (structural — avoids importing the union). */
export interface StepEventLike {
  type: string;
  text?: string;      // thinking
  name?: string;      // tool
  detail?: string;    // tool / block
  tool?: string;      // block
  reason?: string;    // block
  command?: unknown;  // block carries the attempted command (string); other ChatEvents reuse the name with other types
  quarantined?: boolean; // block: false = ordinary tool failure (quarantines live in the security ledger)
}

// Caps — the sidecar stays bounded no matter how wild a turn gets.
export const THINK_CAP = 20_000; // restored thinking chars per turn
export const STEP_CAP = 400;     // tool+fail records per turn
const DETAIL_CAP = 4_000;        // chars of one fail's full error text
const FIELD_CAP = 600;           // chars of tool detail / command / reason

const cap = (s: unknown, n: number): string => String(s ?? "").slice(0, n);

/** Fold raw JSONL lines into per-turn groups. PURE + corrupt-tolerant (bad line → skipped, never a
 *  throw). Turns with no recorded activity are dropped; output is sorted by turn ascending. */
export function foldSteps(lines: string[]): RestoredTurn[] {
  const byTurn = new Map<number, RestoredTurn>();
  const turnOf = (o: Record<string, unknown>): RestoredTurn | null => {
    const t = Number(o.turn);
    if (!Number.isInteger(t) || t < 1) return null;
    let g = byTurn.get(t);
    if (!g) { g = { turn: t, thinking: "", thinkingTruncated: false, tools: [], fails: [] }; byTurn.set(t, g); }
    return g;
  };
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object") continue;
      const o = parsed as Record<string, unknown>; // narrowed to object above; fields re-checked below
      const g = turnOf(o);
      if (!g) continue;
      if (o.k === "think" && typeof o.text === "string") {
        const room = THINK_CAP - g.thinking.length;
        if (room <= 0) { g.thinkingTruncated = true; continue; }
        if (o.text.length > room) { g.thinking += o.text.slice(0, room); g.thinkingTruncated = true; }
        else g.thinking += o.text;
        if (o.over === true) g.thinkingTruncated = true;
      } else if (o.k === "tool" && g.tools.length + g.fails.length < STEP_CAP) {
        g.tools.push({ name: cap(o.name, FIELD_CAP) || "tool", detail: cap(o.detail, FIELD_CAP) });
      } else if (o.k === "fail" && g.tools.length + g.fails.length < STEP_CAP) {
        g.fails.push({
          tool: cap(o.tool, FIELD_CAP) || "tool",
          reason: cap(o.reason, FIELD_CAP),
          command: typeof o.command === "string" && o.command ? cap(o.command, FIELD_CAP) : undefined,
          detail: typeof o.detail === "string" && o.detail ? cap(o.detail, DETAIL_CAP) : undefined,
        });
      }
      // k === "prompt" only anchors the turn ordinal — nothing to store.
    } catch { /* skip the corrupt line — keep every parseable step */ }
  }
  return [...byTurn.values()]
    .filter((g) => g.thinking.length > 0 || g.tools.length > 0 || g.fails.length > 0)
    .sort((a, b) => a.turn - b.turn);
}

// ── recorder state (per GUI process) ─────────────────────────────────────────────────────────────

const turnOrdinals = new Map<string, number>();                       // sid → current user-turn ordinal
const pendingThink = new Map<string, { turn: number; text: string; over: boolean }>(); // buffered thinking (one write per turn)
const writtenSteps = new Map<string, number>();                       // `${sid}:${turn}` → tool/fail records appended

function stepsFile(sid: string | null | undefined): string | null {
  if (!sid || !sid.trim()) return null;
  // The sid names a file — strip anything path-like so a hostile id can't traverse out of the dir.
  const safe = sid.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  if (!safe.replace(/[._-]/g, "")) return null; // ids that sanitize to nothing (e.g. "..") are refused
  return join(process.env.LUCID_STEPS_DIR || join(homedir(), ".omp", "lucid-steps"), `${safe}.jsonl`);
}

function append(file: string, obj: Record<string, unknown>): void {
  try { mkdirSync(dirname(file), { recursive: true }); appendFileSync(file, JSON.stringify(obj) + "\n"); }
  catch { /* observability, never the turn */ }
}

/** Current ordinal for a session, lazily seeded from the sidecar's own max turn on first touch
 *  (so a GUI restart continues numbering instead of restarting at 1). */
function currentTurn(sid: string): number {
  const known = turnOrdinals.get(sid);
  if (known !== undefined) return known;
  const file = stepsFile(sid);
  let max = 0;
  if (file) {
    let raw = "";
    try { raw = readFileSync(file, "utf8"); } catch { /* no sidecar yet */ }
    for (const g of foldSteps(raw.split("\n"))) max = Math.max(max, g.turn);
  }
  turnOrdinals.set(sid, max);
  return max;
}

function flushThink(sid: string): void {
  const buf = pendingThink.get(sid);
  if (!buf || !buf.text) { pendingThink.delete(sid); return; }
  pendingThink.delete(sid);
  const file = stepsFile(sid);
  if (file) append(file, { k: "think", turn: buf.turn, text: buf.text, over: buf.over, at: new Date().toISOString() });
}

/** A user prompt is starting: flush the previous turn's thinking and advance the ordinal. */
export function beginStepTurn(sid: string | null | undefined): void {
  const file = stepsFile(sid);
  if (!file || !sid) return;
  flushThink(sid);
  const turn = currentTurn(sid) + 1;
  turnOrdinals.set(sid, turn);
  append(file, { k: "prompt", turn, at: new Date().toISOString() });
}

/** The turn settled: persist the buffered thinking (one record per turn, not one per chunk). */
export function endStepTurn(sid: string | null | undefined): void {
  if (sid) flushThink(sid);
}

/** Re-anchor the ordinal to the transcript's REAL user-message count (called on every resume read).
 *  Only ever raises — turns recorded by this GUI can't be pushed backwards onto earlier messages. */
export function syncStepTurns(sid: string | null | undefined, userCount: number): void {
  if (!sid || !stepsFile(sid)) return;
  const n = Math.max(0, Math.floor(Number(userCount) || 0));
  if (n > currentTurn(sid)) turnOrdinals.set(sid, n);
}

/** Observe one ChatEvent (called from Backend.emit — the funnel every event passes through).
 *  Hot path: anything but thinking/tool/ordinary-failure returns immediately. */
export function noteStepEvent(sid: string | null | undefined, e: StepEventLike): void {
  if (e.type !== "thinking" && e.type !== "tool" && e.type !== "block") return;
  if (!sid) return;
  const file = stepsFile(sid);
  if (!file) return;
  const turn = currentTurn(sid);
  if (turn < 1) return; // steps before any known prompt have no anchor — drop, never misattach
  if (e.type === "thinking") {
    let buf = pendingThink.get(sid);
    if (!buf || buf.turn !== turn) { if (buf) flushThink(sid); buf = { turn, text: "", over: false }; pendingThink.set(sid, buf); }
    const room = THINK_CAP - buf.text.length;
    if (room <= 0) { buf.over = true; return; }
    const t = String(e.text ?? "");
    if (t.length > room) { buf.text += t.slice(0, room); buf.over = true; } else buf.text += t;
    return;
  }
  // tool + ordinary failure records are low-frequency — append immediately, capped per turn.
  const key = `${sid}:${turn}`;
  const n = writtenSteps.get(key) ?? 0;
  if (n >= STEP_CAP) return;
  if (e.type === "tool") {
    writtenSteps.set(key, n + 1);
    append(file, { k: "tool", turn, name: cap(e.name, FIELD_CAP), detail: cap(e.detail, FIELD_CAP), at: new Date().toISOString() });
  } else if (e.quarantined === false) {
    // Ordinary tool failure (P-TOOLFAIL). Real quarantines already live in the security ledger.
    writtenSteps.set(key, n + 1);
    append(file, {
      k: "fail", turn, tool: cap(e.tool, FIELD_CAP), reason: cap(e.reason, FIELD_CAP),
      command: typeof e.command === "string" && e.command ? cap(e.command, FIELD_CAP) : undefined,
      detail: e.detail ? cap(e.detail, DETAIL_CAP) : undefined,
      at: new Date().toISOString(),
    });
  }
}

/** The restored per-turn activity for a session (merged into the /api/session response). */
export function readTurnSteps(sid: string | null | undefined): RestoredTurn[] {
  const file = stepsFile(sid);
  if (!file || !sid) return [];
  flushThink(sid); // a just-settled live turn shows up even before the next beginStepTurn
  let raw = "";
  try { raw = readFileSync(file, "utf8"); } catch { return []; }
  return foldSteps(raw.split("\n"));
}

/** Remove a session's sidecar (called when the session itself is deleted). */
export function deleteSteps(sid: string | null | undefined): void {
  const file = stepsFile(sid);
  if (!file || !sid) return;
  try { rmSync(file, { force: true }); } catch { /* best-effort */ }
  turnOrdinals.delete(sid);
  pendingThink.delete(sid);
}

/** Drop all in-memory state so tests can point LUCID_STEPS_DIR at fresh temp dirs. */
export function _resetStepsForTest(): void {
  turnOrdinals.clear(); pendingThink.clear(); writtenSteps.clear();
}
