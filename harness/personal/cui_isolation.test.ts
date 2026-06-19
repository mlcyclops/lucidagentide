// harness/personal/cui_isolation.test.ts — P9.5a: hard CUI isolation (ADR-0014).
// The load-bearing invariant: a single key never decrypts both CUI and non-CUI, and a fact
// can NEVER land in the wrong store. Over-tested on purpose — this is the gov/CUI boundary.

import { afterAll, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Telemetry, type TelemetryEvent } from "../telemetry/events.ts";
import { CUI_STORE_VERSION, PersonalStore, STORE_VERSION } from "./store.ts";

let n = 0;
const paths: string[] = [];
const tmp = (): string => { const p = join(tmpdir(), `lucid-cui-iso-${process.pid}-${++n}.enc`); paths.push(p); return p; };
afterAll(() => { for (const p of paths) try { if (existsSync(p)) rmSync(p); } catch { /* ignore */ } });

// ── the wrong-store guards (data-layer, fail loud) ──────────────────────────────
test("the MAIN store refuses a cui-scoped fact", () => {
  const s = PersonalStore.createWithPassphrase(tmp(), "pw");
  const e = s.upsertEntity("x", "user:interest", "trusted");
  expect(() => s.addFact({ entityId: e, statement: "controlled", trustLabel: "trusted", scope: "cui" })).toThrow();
  expect(s.isCui).toBe(false);
});

test("the CUI store accepts cui facts and refuses work/personal facts", () => {
  const s = PersonalStore.createWithPassphrase(tmp(), "pw", { version: CUI_STORE_VERSION });
  expect(s.isCui).toBe(true);
  const e = s.upsertEntity("prog", "user:behavior", "trusted");
  s.addFact({ entityId: e, statement: "controlled work", trustLabel: "trusted", scope: "cui" }); // ok
  expect(() => s.addFact({ entityId: e, statement: "personal", trustLabel: "trusted", scope: "personal" })).toThrow();
  expect(() => s.addFact({ entityId: e, statement: "work", trustLabel: "trusted", scope: "work" })).toThrow();
  expect(s.scopeCounts()).toEqual({ work: 0, personal: 0, cui: 1 });
});

// ── format separation: a CUI file can't be opened as main, or vice versa ────────
test("a CUI store file cannot be opened as a main store (format mismatch)", () => {
  const path = tmp();
  PersonalStore.createWithPassphrase(path, "pw", { version: CUI_STORE_VERSION }).save();
  expect(() => PersonalStore.openWithPassphrase(path, "pw")).toThrow(); // default version = main
  // but opens fine as the CUI variant
  expect(PersonalStore.openWithPassphrase(path, "pw", { version: CUI_STORE_VERSION }).isCui).toBe(true);
});

test("a MAIN store file cannot be opened as a CUI store (format mismatch)", () => {
  const path = tmp();
  PersonalStore.createWithPassphrase(path, "pw").save();
  expect(() => PersonalStore.openWithPassphrase(path, "pw", { version: CUI_STORE_VERSION })).toThrow();
});

// ── independent encryption: separate DEK + passphrase ───────────────────────────
test("CUI store round-trips under its own passphrase; wrong passphrase throws", () => {
  const path = tmp();
  const s = PersonalStore.createWithPassphrase(path, "cui-secret", { version: CUI_STORE_VERSION });
  s.addFact({ entityId: s.upsertEntity("p", "user:goal", "trusted"), statement: "archive it", trustLabel: "trusted", scope: "cui" });
  s.save();
  expect(PersonalStore.openWithPassphrase(path, "cui-secret", { version: CUI_STORE_VERSION }).graph({ scope: "cui" }).facts.length).toBe(1);
  expect(() => PersonalStore.openWithPassphrase(path, "wrong", { version: CUI_STORE_VERSION })).toThrow();
});

test("the CUI store is a DISTINCT file from the main store (own DEK, own custody)", () => {
  const mainPath = tmp(), cuiPath = tmp();
  PersonalStore.createWithPassphrase(mainPath, "same-pass").save();
  PersonalStore.createWithPassphrase(cuiPath, "same-pass", { version: CUI_STORE_VERSION }).save();
  // even with the same passphrase, the files are independent and format-typed
  expect(mainPath).not.toBe(cuiPath);
  expect(() => PersonalStore.openWithPassphrase(cuiPath, "same-pass")).toThrow(); // can't open cui as main
  expect(STORE_VERSION).not.toBe(CUI_STORE_VERSION);
});

// ── telemetry: cui unlock is its own event ──────────────────────────────────────
test("opening the CUI store emits personal_cui_store_unlocked (not personal_store_unlocked)", () => {
  const path = tmp();
  PersonalStore.createWithPassphrase(path, "pw", { version: CUI_STORE_VERSION }).save();
  const events: TelemetryEvent[] = [];
  const tel = new Telemetry({ runId: "r", sessionId: "s", sink: (e) => events.push(e) });
  PersonalStore.openWithPassphrase(path, "pw", { version: CUI_STORE_VERSION, telemetry: tel });
  expect(events.some((e) => e.event === "personal_cui_store_unlocked")).toBe(true);
  expect(events.some((e) => e.event === "personal_store_unlocked")).toBe(false);
});

// ── migration primitives (P9.5b): the move mechanism ────────────────────────────
test("migration: move a cui subgraph (import to dest, remove from source) preserves ids", () => {
  const srcPath = tmp(), dstPath = tmp();
  const src = PersonalStore.createWithPassphrase(srcPath, "p1", { version: CUI_STORE_VERSION });
  const e = src.upsertEntity("Program", "user:behavior", "trusted");
  const f1 = src.addFact({ entityId: e, statement: "a", trustLabel: "trusted", scope: "cui" });
  const f2 = src.addFact({ entityId: e, statement: "b", trustLabel: "trusted", scope: "cui" });
  const dst = PersonalStore.createWithPassphrase(dstPath, "p2", { version: CUI_STORE_VERSION });
  const g = src.graph({ scope: "cui" });
  for (const en of g.entities) dst.importEntity(en);
  for (const ft of g.facts) dst.importFact(ft);
  for (const ft of g.facts) src.removeFact(ft.id);
  dst.save(); src.save();
  expect(dst.scopeCounts().cui).toBe(2);
  expect(src.scopeCounts().cui).toBe(0); // moved OUT of the source
  expect(dst.graph({ scope: "cui" }).facts.map((f) => f.id).sort()).toEqual([f1, f2].sort()); // ids preserved
  for (const ft of g.facts) dst.importFact(ft); // idempotent re-import
  expect(dst.scopeCounts().cui).toBe(2);
  expect(PersonalStore.openWithPassphrase(dstPath, "p2", { version: CUI_STORE_VERSION }).scopeCounts().cui).toBe(2); // durable
});

test("importFact enforces isolation: a cui fact can't be imported into a main store", () => {
  const main = PersonalStore.createWithPassphrase(tmp(), "pw");
  const cui = PersonalStore.createWithPassphrase(tmp(), "pw", { version: CUI_STORE_VERSION });
  cui.addFact({ entityId: cui.upsertEntity("x", "user:goal", "trusted"), statement: "s", trustLabel: "trusted", scope: "cui" });
  const f = cui.graph({ scope: "cui" }).facts[0]!;
  expect(() => main.importFact(f)).toThrow();
});

test("removeFact removes by id and returns false for an unknown id", () => {
  const s = PersonalStore.createWithPassphrase(tmp(), "pw");
  const id = s.addFact({ entityId: s.upsertEntity("t", "user:interest", "trusted"), statement: "x", trustLabel: "trusted" });
  expect(s.removeFact(id)).toBe(true);
  expect(s.graph().facts.length).toBe(0);
  expect(s.removeFact("nope")).toBe(false);
});
