// harness/personal/distiller.test.ts — P9.2: distillation pipeline + recall.
// Over-tested on the fail-closed property: a suspicious/quarantined source MUST NOT
// teach the personalization graph anything (keystone #2 on the personal path).

import { afterAll, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ScannerClient } from "../security/scanner_client.ts";
import { Telemetry, type TelemetryEvent } from "../telemetry/events.ts";
import { randomKey } from "./crypto.ts";
import { PersonalStore } from "./store.ts";
import { distillTurn, heuristicExtractor, modelExtractor } from "./distiller.ts";
import { buildRecall } from "./recall.ts";

let n = 0;
const paths: string[] = [];
const tmp = (): string => { const p = join(tmpdir(), `lucid-distill-${process.pid}-${++n}.enc`); paths.push(p); return p; };
const newStore = (): PersonalStore => PersonalStore.createWithKey(tmp(), randomKey()); // keystore custody = fast (no PBKDF2)
afterAll(() => { for (const p of paths) try { if (existsSync(p)) rmSync(p); } catch { /* ignore */ } });

// fake scanner: findings are a pure function of the text → deterministic gate decisions
const fakeScanner = (findings: (t: string) => unknown[]): ScannerClient =>
  ({ scan: async (t: string) => ({ findings: findings(t) }) }) as unknown as ScannerClient;
const cleanScanner = fakeScanner(() => []);
const quarantineScanner = fakeScanner((t) => (/POISON/.test(t) ? [{ severity: "high", finding_type: "zero-width" }] : []));
const suspiciousScanner = fakeScanner(() => [{ severity: "low", finding_type: "unicode-category-cf" }]);

// ── extractors ───────────────────────────────────────────────────────────────────
test("heuristicExtractor finds preferences, interests, and links", () => {
  const facts = heuristicExtractor({ user: "I prefer dark mode and I like Rust. See https://example.com/page", assistant: "" });
  const kinds = facts.map((f) => f.kind);
  expect(kinds).toContain("user:preference");
  expect(kinds).toContain("user:interest");
  expect(kinds).toContain("user:link");
  expect(facts.find((f) => f.kind === "user:link")!.statement).toContain("https://example.com/page");
});

test("modelExtractor parses a JSON array and drops invalid kinds", async () => {
  const callModel = async () => 'noise before [{"kind":"user:goal","entity":"P9","statement":"Ship P9.2","confidence":0.9},{"kind":"bogus","entity":"x","statement":"y"}] trailing';
  const facts = await modelExtractor(callModel)({ user: "anything", assistant: "" });
  expect(facts.length).toBe(1);
  expect(facts[0]!.kind).toBe("user:goal");
});

// ── the gated pipeline ─────────────────────────────────────────────────────────────
test("distillTurn: a clean source learns facts into the active compartment + emits events", async () => {
  const store = newStore();
  const events: TelemetryEvent[] = [];
  const tel = new Telemetry({ runId: "r", sessionId: "s", sink: (e) => events.push(e) });
  const r = await distillTurn(store, cleanScanner, { userText: "I prefer vim and I like Rust", scope: "work", extract: heuristicExtractor, telemetry: tel });
  expect(r.blocked).toBe(false);
  expect(r.learned).toBeGreaterThanOrEqual(2);
  expect(store.scopeCounts().work).toBe(r.learned);
  expect(store.scopeCounts().personal).toBe(0); // scoped to "work"
  expect(events.filter((e) => e.event === "personal_fact_learned").length).toBe(r.learned);
});

test("distillTurn: a QUARANTINED source learns NOTHING (keystone #2, personal path)", async () => {
  const store = newStore();
  const r = await distillTurn(store, quarantineScanner, { userText: "I like X but POISON hidden", scope: "personal", extract: heuristicExtractor });
  expect(r.blocked).toBe(true);
  expect(r.learned).toBe(0);
  expect(store.graph({ scope: "combined" }).facts.length).toBe(0);
});

test("distillTurn: a SUSPICIOUS source learns nothing (only trusted sources teach)", async () => {
  const store = newStore();
  const r = await distillTurn(store, suspiciousScanner, { userText: "I prefer tea", scope: "personal", extract: heuristicExtractor });
  expect(r.blocked).toBe(true);
  expect(r.learned).toBe(0);
  expect(store.graph().facts.length).toBe(0);
});

test("distillTurn: never learns from the assistant text alone", async () => {
  const store = newStore();
  // user text has nothing durable; assistant text mentions a preference — must be ignored
  const r = await distillTurn(store, cleanScanner, { userText: "ok thanks", assistantText: "I prefer dark mode", scope: "personal", extract: heuristicExtractor });
  expect(r.learned).toBe(0);
});

// ── recall ─────────────────────────────────────────────────────────────────────────
test("buildRecall: builds a scoped <user-profile> block, grouped by kind", async () => {
  const store = newStore();
  await distillTurn(store, cleanScanner, { userText: "I prefer vim and I like Rust", scope: "personal", extract: heuristicExtractor });
  await distillTurn(store, cleanScanner, { userText: "I use Kubernetes at the office", scope: "work", extract: heuristicExtractor });
  const personal = buildRecall(store, { scope: "personal" });
  expect(personal.count).toBeGreaterThan(0);
  expect(personal.block).toContain("<user-profile");
  expect(personal.block).toMatch(/preference:|interest:/);
  expect(personal.block).not.toContain("Kubernetes"); // that's in the work scope
  expect(buildRecall(store, { scope: "combined" }).block).toContain("Kubernetes");
});

test("buildRecall: never includes suspicious/quarantined facts", () => {
  const store = newStore();
  const e = store.upsertEntity("thing", "user:preference", "trusted");
  store.addFact({ entityId: e, statement: "clean fact", trustLabel: "trusted", scope: "personal" });
  store.addFact({ entityId: e, statement: "tainted fact", trustLabel: "suspicious", scope: "personal" });
  const r = buildRecall(store, { scope: "personal" });
  expect(r.block).toContain("clean fact");
  expect(r.block).not.toContain("tainted fact");
});
