// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/collab/pwa_history.ts - P-REMOTE.16 (ADR-0431): the phone's ON-DEVICE transcript history, PURE.
//
// The PWA keeps the master session's SETTLED items in localStorage so a reload, a killed tab, or a reconnect
// after a long screen lock shows the conversation immediately (under the reconnect banner) and the guest's
// first `hello` can carry `since` = the highest settled turn it already holds - the host then replays only
// what the phone missed. This module is the serialize/parse pair; the PWA owns the storage calls.
//
// FAIL-CLOSED GATE: a CUI session NEVER leaves history on the phone. `serializeHistory` returns null unless
// the host's posture says `cui === false` explicitly (an unknown or strict posture is CUI), and the PWA
// removes the key on null. Only SETTLED items persist (`seq` defined and `seq <= since`): a live, partial
// turn is re-sent by the host anyway, and a local fold without a seq was never journaled.
//
// Bounded: the envelope is held under HISTORY_MAX_BYTES by first shedding tool code bodies (oldest first;
// path + the precomputed +/- stay, so a chip still reads right) and then dropping the oldest items.
// Thinking is KEPT - it is the record of what the agent reasoned, and it is already small per turn.
//
// No DOM, no storage access, no I/O: the whole policy is unit-tested headless.

import type { ViewItem } from "./pwa_view.ts";

export const HISTORY_VERSION = 1;
export const HISTORY_MAX_BYTES = 1024 * 1024;

/** The versioned localStorage envelope. `savedAt` is informational (UNIX ms). */
interface HistoryEnvelope { v: number; roomId: string; since: number; savedAt: number; items: ViewItem[] }

/** Items worth persisting: settled (seq <= since) transcript entries. Status snapshots (fleet/process) are
 *  live state the next poll re-sends; a preview image is a data URL that would dominate the budget. */
function persistable(it: ViewItem, since: number): boolean {
  if (it.kind === "preview" || it.kind === "fleet-lanes" || it.kind === "processes") return false;
  return typeof it.seq === "number" && Number.isFinite(it.seq) && it.seq <= since;
}

/** A tool item with its code bodies shed (path + diffstat stay). Other items pass through unchanged. */
function shedCode(it: ViewItem): ViewItem {
  if (it.kind !== "tool" || !it.code) return it;
  const { code, ...rest } = it;
  return { ...rest, code: { path: code.path } };
}

/** UTF-8 byte length of a string (localStorage quotas are measured in UTF-16 units, but the byte figure is
 *  the conservative one, so the budget never silently doubles on non-ASCII text). */
function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * Serialize the master item list for localStorage, or null when nothing may be stored (CUI posture, no
 * room, nothing settled). `since` is the guest's settled-seq cursor; items newer than it are not persisted.
 * Returns a JSON string under HISTORY_MAX_BYTES.
 */
export function serializeHistory(roomId: string, items: ViewItem[], since: number, posture: { cui: boolean; lockdown: boolean } | null | undefined): string | null {
  // FAIL-CLOSED: only an explicit `cui: false` permits history on the phone. A missing posture, a malformed
  // one, or an older host that never said - all mean "treat as CUI" and store nothing.
  if (!posture || typeof posture !== "object" || posture.cui !== false) return null;
  if (typeof roomId !== "string" || !roomId) return null;
  if (!Number.isFinite(since) || since <= 0) return null;
  let kept = items.filter((it) => persistable(it, since));
  if (kept.length === 0) return null;
  const envelope = (list: ViewItem[]): string => JSON.stringify({ v: HISTORY_VERSION, roomId, since, savedAt: Date.now(), items: list } satisfies HistoryEnvelope);
  let out = envelope(kept);
  if (byteLength(out) <= HISTORY_MAX_BYTES) return out;
  // Over budget: shed code bodies oldest-first, re-measuring as we go, so a recent edit keeps its diff for
  // as long as the budget allows.
  for (let i = 0; i < kept.length && byteLength(out) > HISTORY_MAX_BYTES; i++) {
    const it = kept[i]!;
    if (it.kind !== "tool" || !it.code || Object.keys(it.code).length <= 1) continue;
    kept = kept.slice();
    kept[i] = shedCode(it);
    out = envelope(kept);
  }
  // Still over: drop the oldest items until it fits (a whole-turn drop would need turn boundaries the item
  // list does not carry; dropping items is strictly older-first, so what remains is always the newest).
  while (kept.length > 0 && byteLength(out) > HISTORY_MAX_BYTES) {
    kept = kept.slice(Math.max(1, Math.ceil(kept.length / 8)));
    out = envelope(kept);
  }
  return kept.length ? out : null;
}

const ITEM_KINDS: Record<string, true> = { user: true, answer: true, thinking: true, tool: true, subagent: true, block: true, "lane-error": true, note: true };

/** Parse a stored envelope for `roomId`. Returns null for anything malformed (wrong version, another room,
 *  non-array items, bad cursor) - the PWA then starts empty and asks the host for the whole window, which
 *  is the safe direction. Items are shape-checked per kind; an unknown kind is dropped, not kept. */
export function parseHistory(raw: string | null | undefined, roomId: string): { items: ViewItem[]; since: number } | null {
  if (typeof raw !== "string" || !raw || typeof roomId !== "string" || !roomId) return null;
  let env: unknown;
  try { env = JSON.parse(raw); } catch { return null; }
  if (!env || typeof env !== "object") return null;
  const e = env as Partial<HistoryEnvelope>;
  if (e.v !== HISTORY_VERSION || e.roomId !== roomId || !Array.isArray(e.items)) return null;
  if (typeof e.since !== "number" || !Number.isFinite(e.since) || e.since <= 0) return null;
  const items: ViewItem[] = [];
  for (const it of e.items as unknown[]) {
    if (!it || typeof it !== "object") continue;
    const v = it as { kind?: unknown; seq?: unknown };
    if (typeof v.kind !== "string" || !ITEM_KINDS[v.kind]) continue;
    if (typeof v.seq !== "number" || !Number.isFinite(v.seq) || v.seq > e.since) continue;
    if (!validItem(v as ViewItem)) continue;
    items.push(v as ViewItem);
  }
  return { items, since: e.since };
}

/** Per-kind shape check: every string field the renderer reads must be a string, so a corrupted entry
 *  cannot throw inside render() and blank the whole transcript. */
function validItem(it: ViewItem): boolean {
  switch (it.kind) {
    case "user": case "answer": case "thinking": case "note": return typeof it.text === "string";
    case "tool": return typeof it.name === "string" && typeof it.detail === "string" && (it.code === undefined || (!!it.code && typeof it.code === "object" && typeof it.code.path === "string"));
    case "subagent": return typeof it.agent === "string" && typeof it.title === "string" && typeof it.count === "number";
    case "block": return typeof it.reason === "string" && typeof it.severity === "string";
    case "lane-error": return typeof it.message === "string";
    default: return false;
  }
}
