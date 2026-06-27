// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/format.ts - tiny presentation helpers (no DOM).

export const clamp01 = (f: number) => Math.max(0, Math.min(1, Number.isFinite(f) ? f : 0));

export function fmtNum(n: number): string {
  n = Number(n);
  if (!Number.isFinite(n)) return "-";
  const a = Math.abs(n);
  if (a >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (a >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(Math.round(n));
}

export function fmtUSD(n: number): string {
  n = Number(n) || 0;
  return "$" + n.toFixed(2); // nearest cent — e.g. $0.00, $0.43
}

export const pct = (f: number) => Math.round(clamp01(f) * 100);

/** "Load" ramp - high is BAD (context fill, rate-limit): green→amber→red. */
export function loadColor(f: number): string {
  return f >= 0.9 ? "var(--red)" : f >= 0.7 ? "var(--amber)" : "var(--green)";
}

/** "Good" ramp - high is GOOD (cache-hit rate): red→amber→green. */
export function goodColor(f: number): string {
  return f >= 0.66 ? "var(--green)" : f >= 0.33 ? "var(--amber)" : "var(--red)";
}

export function ageStr(epochMs: number | null | undefined): string {
  if (!epochMs) return "-";
  const s = Math.round((epochMs - Date.now()) / 1000);
  if (s <= 0) return "now";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
