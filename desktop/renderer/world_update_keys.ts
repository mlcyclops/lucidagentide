// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/world_update_keys.ts - P-WORLDS.UPDATE1 (ADR-0685): which world updates were announced.
//
// One announcement is "<id>@<version>". The engine keeps the list (settings_store worldUpdatesAnnounced) and the
// renderer's world_updates.ts decides what to announce next. P-TYPECHECK.1 (ADR-0695): this file imports nothing, so
// the engine can load it without pulling world_updates.ts and, through it, ui.ts and bridge.ts (DOM types the root
// typecheck does not have). Keep it import-free.

/** At most this many announced keys are kept (the newest). */
export const ANNOUNCED_MAX = 200;
const ANNOUNCED_RE = /^[a-z0-9][a-z0-9-]{0,63}@v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** "<id>@<version>": one announcement. */
export const updateKey = (u: { id: string; to: string }): string => `${u.id}@${u.to}`;

/** Only well-formed keys, each once (its last position), the newest ANNOUNCED_MAX. Anything else reads as none. */
export function sanitizeAnnounced(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = raw.length - 1; i >= 0 && out.length < ANNOUNCED_MAX; i--) {
    const k: unknown = raw[i];
    if (typeof k !== "string" || !ANNOUNCED_RE.test(k) || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out.reverse();
}

/** The updates not announced before. Pure. */
export function unannounced<T extends { id: string; to: string }>(pending: readonly T[], announced: readonly string[]): T[] {
  const s = new Set(announced);
  return pending.filter((u) => !s.has(updateKey(u)));
}

/** The announced keys after announcing `fresh`. Pure. */
export function rememberAnnounced(announced: readonly string[], fresh: readonly { id: string; to: string }[]): string[] {
  return sanitizeAnnounced([...announced, ...fresh.map(updateKey)]);
}
