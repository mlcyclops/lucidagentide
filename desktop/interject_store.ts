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
//   - ADR-0414: a tool result is not the only way out. A note still waiting when the target's NEXT
//     prompt starts (the turn it was meant for ended in prose, or the target was idle when the note was
//     queued: the attach / release notes, a health probe) is carried into that prompt by
//     carryPendingNotes. Before this, such notes sat here across turns until eight of them filled the cap
//     and every later push was refused.
//   - ADR-0414: a LIVE push (the user's Push now / Check in) names whether the target's turn is running.
//     Not running is a typed `idle` refusal the renderer acts on (it sends the text as the next prompt),
//     never a note parked where nothing will read it until some later turn.

import { HEALTH_PROBE_NOTE } from "./health_watch.ts";

const MAX_NOTES_PER_TARGET = 8;
const MAX_NOTE_CHARS = 4000;

const queues = new Map<string, string[]>();

/** Why a note was not queued. The renderer maps each to what happened to the user's text. */
export type InterjectRefusal = "no-target" | "empty" | "too-long" | "cap" | "unknown-target" | "idle";

/** Queue one operator note for `target` ("master" or a laneId). Trims; refuses empty, over-long,
 *  and cap-exceeding notes with a typed code and a human-readable reason.
 *  `state` (ADR-0414) is the caller's view of the target: `running: null` means no such session (always
 *  refused), `false` means no turn is running, which refuses only a `live` push (the user's own). A note
 *  that is not live (the harness's attach / release / probe notes) is queued for the next tool result
 *  or the next prompt, whichever comes first. */
export function addInterject(target: string, text: string, state?: { running: boolean | null; live: boolean }): { ok: boolean; code?: InterjectRefusal; reason?: string } {
  const t = (target ?? "").trim();
  if (!t) return { ok: false, code: "no-target", reason: "target required" };
  const note = (text ?? "").trim();
  if (!note) return { ok: false, code: "empty", reason: "empty note refused" };
  if (note.length > MAX_NOTE_CHARS) return { ok: false, code: "too-long", reason: `note too long (${note.length} chars; max ${MAX_NOTE_CHARS})` };
  if (state && state.running === null) return { ok: false, code: "unknown-target", reason: "that session is no longer running" };
  if (state?.live && !state.running) return { ok: false, code: "idle", reason: "the turn had already ended" };
  const q = queues.get(t) ?? [];
  if (q.length >= MAX_NOTES_PER_TARGET) return { ok: false, code: "cap", reason: `${MAX_NOTES_PER_TARGET} earlier notes are still waiting for the agent's next tool step` };
  q.push(note);
  queues.set(t, q);
  return { ok: true };
}

/** The marker a carried note opens with. Operator origin like the tool-result MARKER in
 *  harness/omp/interject_extension.ts, and it says WHEN the note was written so the model does not
 *  mistake an older note for part of the request that follows. */
const CARRIED_MARKER = "[LUCID OPERATOR NOTE - sent while no tool step was running, so it is delivered with this prompt; weigh it, then handle the request below]";

/** ADR-0414: drain every note still waiting for `target` into the block that opens its next prompt
 *  ("" when none). Called by the prompt paths (acp_backend for "master", fleet_lanes for a lane) at the
 *  moment the prompt is sent, so the note reaches the agent exactly once: either here or at a tool
 *  result, whichever comes first. */
export function carryPendingNotes(target: string): string {
  // A health probe asks about the turn that went quiet. That turn is over by now, so carrying the probe
  // would open a fresh request with a stale "Status?"; it is dropped here, and only here.
  return drainInterjects(target).filter((n) => n !== HEALTH_PROBE_NOTE).map((n) => `${CARRIED_MARKER}\n${n}`).join("\n\n");
}

/** Return AND clear every pending note for `target` (FIFO order). The consumers are the target's omp
 *  child polling from interject_extension.ts and carryPendingNotes at prompt start; draining is the
 *  exactly-once delivery point for both. */
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

// ── P-OWN.1: peer notes, agent to agent ──────────────────────────────────────────────────────────────
// A session sharing a checkout with another can check in with it before touching a file the other is
// editing. The note rides the same drain the operator notes use, but it is a SEPARATE queue and a
// separate kind on the wire: the child's interject_extension marks it as a PEER note inside the untrusted
// delimiters, never as operator-origin. Same caps as operator notes, per target. A session that asked and
// wants to WAIT for the answer registers a waiter: the first matching note from that peer resolves it and
// is consumed there, so it is never delivered twice.

export interface PeerNote { from: string; name: string; text: string }

const peerQueues = new Map<string, PeerNote[]>();
type PeerWaiter = { from: string; resolve: (n: PeerNote) => void };
const peerWaiters = new Map<string, PeerWaiter[]>();

/** Queue one peer note for `to` from `from`. Same trim/size/cap discipline as operator notes. */
export function addPeerNote(to: string, from: string, name: string, text: string): { ok: boolean; reason?: string } {
  const t = (to ?? "").trim();
  const f = (from ?? "").trim();
  if (!t || !f) return { ok: false, reason: "from and to required" };
  if (t === f) return { ok: false, reason: "a session cannot check in with itself" };
  const note = (text ?? "").trim();
  if (!note) return { ok: false, reason: "empty note refused" };
  if (note.length > MAX_NOTE_CHARS) return { ok: false, reason: `note too long (${note.length} chars; max ${MAX_NOTE_CHARS})` };
  const entry: PeerNote = { from: f, name: (name ?? "").trim() || f, text: note };
  // A session waiting on exactly this peer takes the note directly.
  const waiters = peerWaiters.get(t);
  const i = waiters?.findIndex((w) => w.from === f) ?? -1;
  if (waiters && i >= 0) {
    const [w] = waiters.splice(i, 1);
    if (waiters.length === 0) peerWaiters.delete(t);
    w!.resolve(entry);
    return { ok: true };
  }
  const q = peerQueues.get(t) ?? [];
  if (q.length >= MAX_NOTES_PER_TARGET) return { ok: false, reason: `too many pending peer notes for "${t}" (cap ${MAX_NOTES_PER_TARGET}) - wait for the agent's next tool result to drain them` };
  q.push(entry);
  peerQueues.set(t, q);
  return { ok: true };
}

/** Return AND clear every pending peer note for `target` (FIFO). Drained with the operator notes. */
export function drainPeerNotes(target: string): PeerNote[] {
  const t = (target ?? "").trim();
  const q = peerQueues.get(t);
  if (!q || q.length === 0) return [];
  peerQueues.delete(t);
  return q;
}

/** Wait up to `timeoutMs` for a note addressed to `target` from `from`. A note already queued answers at
 *  once (and leaves the queue); otherwise the next matching addPeerNote resolves this. Null on timeout. */
export function awaitPeerReply(target: string, from: string, timeoutMs: number): Promise<PeerNote | null> {
  const t = (target ?? "").trim();
  const f = (from ?? "").trim();
  if (!t || !f) return Promise.resolve(null);
  const q = peerQueues.get(t);
  const i = q?.findIndex((n) => n.from === f) ?? -1;
  if (q && i >= 0) {
    const [n] = q.splice(i, 1);
    if (q.length === 0) peerQueues.delete(t);
    return Promise.resolve(n!);
  }
  const { promise, resolve } = Promise.withResolvers<PeerNote | null>();
  const w: PeerWaiter = { from: f, resolve: (n) => { clearTimeout(timer); resolve(n); } };
  const timer = setTimeout(() => {
    const ws = peerWaiters.get(t);
    const k = ws?.indexOf(w) ?? -1;
    if (ws && k >= 0) { ws.splice(k, 1); if (ws.length === 0) peerWaiters.delete(t); }
    resolve(null);
  }, Math.max(0, timeoutMs));
  timer.unref?.();
  const ws = peerWaiters.get(t) ?? [];
  ws.push(w);
  peerWaiters.set(t, ws);
  return promise;
}

// Test-only: reset the module-scope state between cases (same pattern as import_job.ts).
export function __resetInterjects(): void { queues.clear(); peerQueues.clear(); peerWaiters.clear(); }
