// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/launcher/session_metrics.test.ts
//
// P-NVIM.3 (ADR-0155) — the DuckDB-free session metrics behind `lucid stats` (spend + KV-cache % +
// context-fill). Drives sessionStats/formatStats over a fixture omp session .jsonl so the numbers the
// Neovim statusline / :LucidStats float show match how the GUI Memory inspector reads the same file.

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatStats, liveBudgets, sessionStats } from "../../tools/session_metrics.ts";

const tmps: string[] = [];
afterAll(() => {
  for (const d of tmps) try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
});

function fixture(lines: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "lucid-sess-"));
  tmps.push(dir);
  const p = join(dir, "session.jsonl");
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return p;
}

const twoTurn = () =>
  fixture([
    { type: "session", cwd: "/x", timestamp: "2026-01-01T00:00:00Z" },
    { type: "model_change", model: "claude-haiku-4-5" },
    { type: "message", message: { model: "claude-haiku-4-5", usage: { input: 1000, cacheRead: 9000, cacheWrite: 500, output: 200, cost: { total: 0.05 } } } },
    { type: "message", message: { usage: { input: 500, cacheRead: 9500, cacheWrite: 0, output: 100, cost: { total: 0.03 } } } },
  ]);

test("sessionStats computes spend, KV-cache hit, and context-fill from the session .jsonl", () => {
  const s = sessionStats(twoTurn());
  expect(s).not.toBeNull();
  const st = s!;
  expect(st.model).toBe("claude-haiku-4-5");
  expect(st.turns).toBe(2);
  expect(st.cost).toBeCloseTo(0.08, 10); // 0.05 + 0.03
  // cache: read 9000+9500, write 500, fresh(input) 1000+500
  expect(st.cache).toEqual({ read: 18500, write: 500, fresh: 1500, hit: 18500 / 20500 });
  // context occupancy = last turn prompt (input+cacheRead+cacheWrite) = 500+9500+0
  expect(st.current).toBe(10000);
  expect(st.peak).toBe(10500); // first turn was bigger
  expect(st.prompts).toEqual([10500, 10000]); // per-turn context occupancy (feeds the editor sparkline)
  expect(st.window).toBe(200000); // claude-haiku-4-5 context window
  expect(st.contextFill).toBeCloseTo(10000 / 200000, 10);
});

test("sessionStats returns null for a missing/unknown session", () => {
  expect(sessionStats("/no/such/session.jsonl")).toBeNull();
});

test("formatStats renders spend + cache% + context% (and a no-session hint)", () => {
  const out = formatStats(sessionStats(twoTurn()));
  expect(out).toContain("$0.0800");
  expect(out).toMatch(/cache\s+90% hit/); // 18500/20500 = 90.2% -> 90%
  expect(out).toMatch(/context\s+5%/); // 10000/200000
  expect(formatStats(null)).toContain("no omp session");
});

test("formatStats includes rate-limit budgets when provided", () => {
  const out = formatStats(sessionStats(twoTurn()), [{ label: "Claude 5 Hour", used: 0.17, status: "ok", resetsAt: null }]);
  expect(out).toContain("budgets");
  expect(out).toContain("Claude 5 Hour 17%");
});

// ── liveBudgets (fix 2026-08-25): the "always at 100%" stale-quota bug ────────────────────────────
// usage_history's newest row per label can be arbitrarily old; a row whose window already reset is
// history, not status - and omp stores resets_at in SECONDS while the renderer compares ms.
const NOW = 1_787_600_000_000; // ms epoch

test("liveBudgets drops a row whose window already reset (the false always-100% toast)", () => {
  const stale = { label: "7 days", used: 1, status: "exhausted", resetsAt: 1_785_961_000 }; // seconds, weeks past
  expect(liveBudgets([stale], NOW)).toEqual([]);
});

test("liveBudgets keeps a live window and normalizes seconds-epoch resetsAt to ms", () => {
  const live = { label: "5 hours", used: 0.93, status: "ok", resetsAt: (NOW + 3_600_000) / 1000 };
  const out = liveBudgets([live], NOW);
  expect(out).toHaveLength(1);
  expect(out[0]!.resetsAt).toBe(NOW + 3_600_000); // ms now - ageStr math stops saying "resets now"
});

test("liveBudgets keeps a null-reset row for display (the toast layer skips it as unverifiable)", () => {
  const out = liveBudgets([{ label: "7 days", used: 0.95, status: "ok", resetsAt: null }], NOW);
  expect(out).toHaveLength(1);
  expect(out[0]!.resetsAt).toBeNull();
});

test("liveBudgets dedupes label ties, keeping the hottest (rows arrive used-desc)", () => {
  const a = { label: "7 days", used: 0.9, status: "ok", resetsAt: (NOW + 1000) / 1000 };
  const b = { label: "7 days", used: 0.4, status: "ok", resetsAt: (NOW + 1000) / 1000 };
  const out = liveBudgets([a, b], NOW);
  expect(out).toHaveLength(1);
  expect(out[0]!.used).toBe(0.9);
});

test("liveBudgets passes an already-ms resetsAt through untouched", () => {
  const out = liveBudgets([{ label: "x", used: 0.5, status: "ok", resetsAt: NOW + 5000 }], NOW);
  expect(out[0]!.resetsAt).toBe(NOW + 5000);
});
