// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/import_progress.ts - pure, DOM-free formatting of the background-import status
// (P-KG-INGEST.1, ADR-0076). Lives renderer-side (no Snowflake/server deps) so it's safe to bundle and
// unit-testable; the status pill in app.ts renders from it, and `make demo-P-KG-INGEST.1` asserts it.

export interface ImportLineInput {
  state: "running" | "done" | "failed" | "cancelled";
  messages: number; totalMessages: number; learned: number; blocked: number;
}

/** A percentage + one-line status for the import progress pill. */
export function formatImportLine(v: ImportLineInput): { pct: number; line: string; done: boolean } {
  const pct = v.totalMessages > 0 ? Math.min(100, Math.round((v.messages / v.totalMessages) * 100)) : 0;
  const facts = `${v.learned} fact${v.learned === 1 ? "" : "s"}`;
  switch (v.state) {
    case "done": return { pct: 100, line: `Done - learned ${facts} from ${v.messages} messages`, done: true };
    case "cancelled": return { pct, line: `Stopped - kept ${facts} from ${v.messages} messages`, done: true };
    case "failed": return { pct, line: "Import failed", done: true };
    default: return { pct, line: `${v.messages}/${v.totalMessages} messages · ${facts}${v.blocked ? ` · ${v.blocked} blocked` : ""}`, done: false };
  }
}
