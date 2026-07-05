// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/sec_review.ts — P-SECACK.1 (ADR-0170): pure split/count logic for the Security
// panel's reviewed-state. Renderer-safe (no node imports) so securityHtml, the rail badge, and the
// click handlers all agree on ONE definition of "active" vs "reviewed".

export interface AckInfo { at: string; reviewer?: string }

/** Split DB-backed rows into active (never acked) vs reviewed (acked), preserving order.
 *  Rows without a usable key stay ACTIVE — a malformed row must never silently vanish. */
export function splitReviewed<T extends Record<string, unknown>>(
  rows: T[] | null | undefined,
  acks: Record<string, AckInfo> | null | undefined,
  key = "artifact_id",
): { active: T[]; reviewed: T[] } {
  const active: T[] = [], reviewed: T[] = [];
  for (const r of rows ?? []) {
    const id = String(r?.[key] ?? "");
    (id && acks?.[id] ? reviewed : active).push(r);
  }
  return { active, reviewed };
}

/** Findings NEW since the last "mark seen" watermark. No watermark → everything is new (the historic
 *  total). A watermark above the current total (never expected — findings are append-only) clamps to
 *  0, never negative. */
export function freshFindings(total: number, seen: number | null | undefined): number {
  const t = Math.max(0, Number(total) || 0);
  if (seen == null || !Number.isFinite(Number(seen))) return t;
  return Math.max(0, t - Math.max(0, Number(seen)));
}
