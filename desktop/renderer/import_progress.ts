// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/import_progress.ts - pure, DOM-free formatting of the background-import status
// (P-KG-INGEST.1, ADR-0076). Lives renderer-side (no Snowflake/server deps) so it's safe to bundle and
// unit-testable; the status pill in app.ts renders from it, and `make demo-P-KG-INGEST.1` asserts it.

export interface ImportLineInput {
  state: "running" | "done" | "failed" | "cancelled";
  messages: number; totalMessages: number; learned: number; blocked: number;
  /** Server clock: last time a tick moved the counters. Used to detect a wedged run. */
  updatedAt?: number;
  /** Server clock: when Stop was pressed (job is unwinding). */
  cancelRequestedAt?: number;
  /** "now" on the same clock as updatedAt. Defaults to Date.now(). */
  now?: number;
}

/** No tick for this long while running means the run is wedged, not slow. One model extraction is
 *  bounded well under this (P-KG-INGEST.5, ADR-0252), so silence past it is a real stall, and the pill
 *  must SAY so instead of showing a healthy-looking "0/500" forever. */
export const STALL_MS = 90_000;

export interface ImportLine { pct: number; line: string; done: boolean; stalled: boolean }

/** A percentage + one-line status for the import progress pill. */
export function formatImportLine(v: ImportLineInput): ImportLine {
  const pct = v.totalMessages > 0 ? Math.min(100, Math.round((v.messages / v.totalMessages) * 100)) : 0;
  const facts = `${v.learned} fact${v.learned === 1 ? "" : "s"}`;
  switch (v.state) {
    case "done": return { pct: 100, line: `Done - learned ${facts} from ${v.messages} messages`, done: true, stalled: false };
    case "cancelled": return { pct, line: `Stopped - kept ${facts} from ${v.messages} messages`, done: true, stalled: false };
    case "failed": return { pct, line: "Import failed", done: true, stalled: false };
    default: {
      const now = v.now ?? Date.now();
      const quietMs = v.updatedAt ? now - v.updatedAt : 0;
      const stalled = quietMs >= STALL_MS;
      const counts = `${v.messages}/${v.totalMessages} messages \u00b7 ${facts}${v.blocked ? ` \u00b7 ${v.blocked} blocked` : ""}`;
      if (v.cancelRequestedAt) return { pct, line: `Stopping - ${counts}`, done: false, stalled };
      if (stalled) return { pct, line: `No response from the model for ${Math.round(quietMs / 1000)}s \u00b7 ${counts}`, done: false, stalled: true };
      return { pct, line: counts, done: false, stalled: false };
    }
  }
}
