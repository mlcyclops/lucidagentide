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

test("heuristicExtractor captures natural-language facts (decision, role, goal, avoid, name)", () => {
  const facts = heuristicExtractor({ user: "I'm a security engineer and I decided to go with Postgres. I avoid Java. My goal is to ship v1. Call me Nick.", assistant: "" });
  const kinds = facts.map((f) => f.kind);
  expect(kinds).toContain("user:decision");    // Chose Postgres
  expect(kinds).toContain("user:personality");  // Is a security engineer / Goes by Nick
  expect(kinds).toContain("user:goal");         // ship v1
  expect(facts.some((f) => /avoids java/i.test(f.statement))).toBe(true);
  expect(facts.some((f) => /goes by nick/i.test(f.statement))).toBe(true);
});

test("heuristicExtractor learns nothing from a plain coding question (no personal facts)", () => {
  expect(heuristicExtractor({ user: "Can you fix this restart() bug in my game loop?", assistant: "" }).length).toBe(0);
});

test("cross-turn linking: re-mentioning a prior concept links it to the new turn's fact (#1)", async () => {
  const store = newStore();
  await distillTurn(store, cleanScanner, { userText: "I love premium custard", scope: "personal", extract: heuristicExtractor });
  // a LATER turn that re-mentions "custard" (a word in the prior entity) and learns a NEW fact
  await distillTurn(store, cleanScanner, { userText: "I love caramel on custard", scope: "personal", extract: heuristicExtractor });
  const g = store.graph();
  const id = (name: string) => g.entities.find((e) => e.name.toLowerCase() === name)?.id;
  const custard = id("premium custard"), caramel = id("caramel on custard");
  expect(custard && caramel).toBeTruthy();
  const link = g.links.find((l) =>
    (l.from_entity_id === caramel && l.to_entity_id === custard) ||
    (l.from_entity_id === custard && l.to_entity_id === caramel));
  expect(link?.relation).toBe("mentioned with"); // joined across turns
});

test("cross-turn linking does NOT connect unrelated turns", async () => {
  const store = newStore();
  await distillTurn(store, cleanScanner, { userText: "I love premium custard", scope: "personal", extract: heuristicExtractor });
  await distillTurn(store, cleanScanner, { userText: "I use Rust for systems work", scope: "personal", extract: heuristicExtractor });
  const g = store.graph();
  expect(g.links.length).toBe(0); // no shared words → no cross-link, no false edges
});

test("modelExtractor parses a JSON array and drops invalid kinds", async () => {
  const callModel = async () => 'noise before [{"kind":"user:goal","entity":"P9","statement":"Ship P9.2","confidence":0.9},{"kind":"bogus","entity":"x","statement":"y"}] trailing';
  const facts = await modelExtractor(callModel)({ user: "anything", assistant: "" });
  expect(facts.length).toBe(1);
  expect(facts[0]!.kind).toBe("user:goal");
});

test("modelExtractor parses relations between entities", async () => {
  const callModel = async () =>
    '[{"kind":"user:skill","entity":"rust","statement":"Codes in Rust","relations":[{"to":"kubernetes","relation":"deploys with"}]},{"kind":"user:skill","entity":"kubernetes","statement":"Deploys with K8s"}]';
  const facts = await modelExtractor(callModel)({ user: "anything", assistant: "" });
  expect(facts.find((f) => f.entity === "rust")!.relations).toEqual([{ to: "kubernetes", relation: "deploys with" }]);
});

test("heuristicExtractor chains same-turn facts with a co-occurrence relation (not URLs)", () => {
  const facts = heuristicExtractor({ user: "I prefer vim and I like Rust. See https://x.com/y", assistant: "" });
  const withRel = facts.filter((f) => (f.relations?.length ?? 0) > 0);
  expect(withRel.length).toBeGreaterThan(0); // at least one co-occurrence link
  expect(facts.find((f) => f.kind === "user:link")!.relations ?? []).toEqual([]); // URLs don't chain
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

test("distillTurn: a clean multi-fact turn creates relational links in the store", async () => {
  const store = newStore();
  // model extractor with an explicit relation → a link between the two real entity nodes
  const callModel = async () =>
    '[{"kind":"user:skill","entity":"rust","statement":"Codes in Rust","relations":[{"to":"kubernetes","relation":"deploys with"}]},{"kind":"user:skill","entity":"kubernetes","statement":"Uses K8s"}]';
  await distillTurn(store, cleanScanner, { userText: "I code in Rust and deploy with Kubernetes", scope: "work", extract: modelExtractor(callModel) });
  const g = store.graph({ scope: "combined" });
  expect(g.links.length).toBe(1);
  const rust = g.entities.find((e) => e.name === "rust")!;
  const k8s = g.entities.find((e) => e.name === "kubernetes")!;
  expect(g.links[0]).toMatchObject({ from_entity_id: rust.id, to_entity_id: k8s.id, relation: "deploys with" });
});

test("distillTurn: the offline heuristic also produces links (co-occurrence)", async () => {
  const store = newStore();
  await distillTurn(store, cleanScanner, { userText: "I prefer vim and I like Rust", scope: "personal", extract: heuristicExtractor });
  expect(store.graph().links.length).toBeGreaterThan(0);
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
