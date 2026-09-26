// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/interject_store.ts - P-INTERJECT.1: mid-turn operator interjections.
//
// The user can type a note WHILE the master agent (or a fleet lane) is mid-turn; the note is held
// here until the target's omp child polls for it at its next tool result (interject_extension.ts
// does one loopback GET per tool result via /api/interject/pending, which drains atomically).
//
// Pure module-scope state, no I/O: dev.ts owns the HTTP surface; this owns the queue discipline.
//   - target is "master" or a laneId; each target keeps its own FIFO queue (per-target isolation).
//   - Per-target cap of 8 pending notes (mirrors the fleet prompt-queue cap): past it, refuse
//     loudly rather than silently dropping - the operator deserves to know the note did not land.
//   - Notes are trimmed; empty/whitespace-only notes and notes over 4000 chars are refused.
//   - drainInterjects returns AND clears: the single consumer is the target's omp child, so a
//     drained note is delivered exactly once.

const MAX_NOTES_PER_TARGET = 8;
const MAX_NOTE_CHARS = 4000;

const queues = new Map<string, string[]>();

/** Queue one operator note for `target` ("master" or a laneId). Trims; refuses empty, over-long,
 *  and cap-exceeding notes with a human-readable reason. */
export function addInterject(target: string, text: string): { ok: boolean; reason?: string } {
  const t = (target ?? "").trim();
  if (!t) return { ok: false, reason: "target required" };
  const note = (text ?? "").trim();
  if (!note) return { ok: false, reason: "empty note refused" };
  if (note.length > MAX_NOTE_CHARS) return { ok: false, reason: `note too long (${note.length} chars; max ${MAX_NOTE_CHARS})` };
  const q = queues.get(t) ?? [];
  if (q.length >= MAX_NOTES_PER_TARGET) return { ok: false, reason: `too many pending notes for "${t}" (cap ${MAX_NOTES_PER_TARGET}) - wait for the agent's next tool result to drain them` };
  q.push(note);
  queues.set(t, q);
  return { ok: true };
}

/** Return AND clear every pending note for `target` (FIFO order). The one consumer is the target's
 *  omp child polling from interject_extension.ts, so this is the exactly-once delivery point. */
export function drainInterjects(target: string): string[] {
  const t = (target ?? "").trim();
  const q = queues.get(t);
  if (!q || q.length === 0) return [];
  queues.delete(t);
  return q;
}

/** How many notes are waiting for `target` (UI badge; does not consume). */
export function pendingInterjectCount(target: string): number {
  return queues.get((target ?? "").trim())?.length ?? 0;
}

// Test-only: reset the module-scope state between cases (same pattern as import_job.ts).
export function __resetInterjects(): void { queues.clear(); }
