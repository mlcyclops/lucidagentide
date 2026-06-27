// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/usage_ledger.test.ts — P10.2 (ADR-0011): the cross-model cost & savings ledger.
// Aggregation is read-only over omp session .jsonl; the savings figure is DERIVED from the
// data (cache reads billed at ~10% of input → est. savings = cost.cacheRead × 9), so it's
// tested against a fixture with a known cost breakdown.

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ledgerProvider, usageLedger } from "../tools/memory_data.ts";

const roots: string[] = [];
afterAll(() => { for (const r of roots) try { rmSync(r, { recursive: true, force: true }); } catch { /* ignore */ } });

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "lucid-ledger-"));
  roots.push(root);
  const sess = (name: string, lines: object[]) => {
    const dir = join(root, name); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "s.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
  };
  // session 1 — Opus, one turn with a big cache READ (the source of savings)
  sess("a", [
    { type: "session", cwd: "/x", timestamp: "2026-06-19T00:00:00Z" },
    { type: "model_change", model: "anthropic/claude-opus-4-8" },
    { type: "message", message: { model: "claude-opus-4-8", usage: { input: 100, output: 50, cacheRead: 900, cacheWrite: 0, totalTokens: 1050, cost: { input: 0.0005, output: 0.00375, cacheRead: 0.00045, cacheWrite: 0, total: 0.0047 } } } },
  ]);
  // session 2 — a gov GPT model, no cache
  sess("b", [
    { type: "session", cwd: "/y", timestamp: "2026-06-19T01:00:00Z" },
    { type: "message", message: { model: "asksage-openai/gpt-5.2", usage: { input: 200, output: 80, cacheRead: 0, cacheWrite: 0, totalTokens: 280, cost: { input: 0.001, output: 0.004, cacheRead: 0, cacheWrite: 0, total: 0.005 } } } },
  ]);
  return root;
}

test("aggregates per model with derived savings + cache hit-rate", () => {
  const led = usageLedger({ root: fixtureRoot() });
  expect(led.models.length).toBe(2);
  const opus = led.models.find((m) => m.model === "claude-opus-4-8")!;
  expect(opus.turns).toBe(1);
  expect(opus.tokens.cacheRead).toBe(900);
  expect(opus.cost.total).toBeCloseTo(0.0047, 6);
  // savings = cost.cacheRead × 9
  expect(opus.savings).toBeCloseTo(0.00045 * 9, 8);
  // cache hit-rate = cacheRead / (cacheRead + cacheWrite + input) = 900 / 1000
  expect(opus.cacheHitRate).toBeCloseTo(0.9, 6);
  expect(opus.provider).toBe("anthropic");
  expect(opus.source).toBe("subscription");
});

test("classifies provider + strips the gateway prefix from the model id", () => {
  const led = usageLedger({ root: fixtureRoot() });
  const gpt = led.models.find((m) => m.model === "gpt-5.2")!; // asksage-openai/ prefix stripped
  expect(gpt).toBeTruthy();
  expect(gpt.provider).toBe("openai");
});

test("totals sum across models; sorted by spend; all subscription (no local)", () => {
  const led = usageLedger({ root: fixtureRoot() });
  expect(led.totals.sessions).toBe(2);
  expect(led.totals.cost).toBeCloseTo(0.0047 + 0.005, 6);
  expect(led.totals.savings).toBeCloseTo(0.00045 * 9, 8);
  expect(led.models[0]!.cost.total).toBeGreaterThanOrEqual(led.models[1]!.cost.total); // sorted desc
  expect(led.bySource.local.cost).toBe(0);
  expect(led.bySource.subscription.cost).toBeCloseTo(led.totals.cost, 6);
});

test("missing/empty root yields an empty ledger (never throws)", () => {
  const led = usageLedger({ root: join(tmpdir(), "lucid-no-such-" + process.pid) });
  expect(led.models.length).toBe(0);
  expect(led.totals.cost).toBe(0);
});

test("ledgerProvider maps known + local model families", () => {
  expect(ledgerProvider("claude-opus-4-8")).toBe("anthropic");
  expect(ledgerProvider("gpt-5.2")).toBe("openai");
  expect(ledgerProvider("google-gemini-2.5-flash")).toBe("google");
  expect(ledgerProvider("llama-3-70b")).toBe("local");
  expect(ledgerProvider("rag")).toBe("asksage-rag");
});
