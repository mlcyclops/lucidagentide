// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/personal/personal.test.ts — P9.1: encryption + the encrypted store.
// Over-tested on purpose: this is the project's first encryption-at-rest surface and
// holds the user's private personalization graph. Wrong key / tampering MUST fail.

import { afterAll, expect, test } from "bun:test";
import { existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Telemetry, type TelemetryEvent } from "../telemetry/events.ts";
import { decrypt, deriveKey, encrypt, randomKey, randomSalt } from "./crypto.ts";
import { PersonalStore } from "./store.ts";

let n = 0;
const paths: string[] = [];
const tmp = (): string => { const p = join(tmpdir(), `lucid-personal-${process.pid}-${++n}.enc`); paths.push(p); return p; };
afterAll(() => { for (const p of paths) try { if (existsSync(p)) rmSync(p); } catch { /* ignore */ } });

// ── crypto primitives ──────────────────────────────────────────────────────────
test("AES-256-GCM round-trips", () => {
  const key = randomKey();
  const sealed = encrypt("the user prefers terse answers", key);
  expect(decrypt(sealed, key).toString("utf8")).toBe("the user prefers terse answers");
});

test("decrypt with the wrong key throws (never returns garbage)", () => {
  const sealed = encrypt("secret", randomKey());
  expect(() => decrypt(sealed, randomKey())).toThrow();
});

test("tampering with the ciphertext is detected (GCM auth tag)", () => {
  const key = randomKey();
  const sealed = encrypt("secret", key);
  const bytes = Buffer.from(sealed.ct, "base64");
  bytes[0] = (bytes[0]! ^ 0xff) & 0xff; // flip a byte
  expect(() => decrypt({ ...sealed, ct: bytes.toString("base64") }, key)).toThrow();
});

test("PBKDF2 is deterministic per (passphrase, salt) and salt-sensitive", () => {
  const salt = randomSalt();
  expect(deriveKey("hunter2", salt).equals(deriveKey("hunter2", salt))).toBe(true);
  expect(deriveKey("hunter2", salt).equals(deriveKey("hunter2", randomSalt()))).toBe(false);
});

// ── passphrase-custody store ─────────────────────────────────────────────────────
test("store: create → mutate → reopen with passphrase round-trips the graph", () => {
  const path = tmp();
  const s = PersonalStore.createWithPassphrase(path, "correct horse battery staple");
  const e = s.upsertEntity("editor", "user:preference", "trusted");
  s.addFact({ entityId: e, statement: "Prefers Vim keybindings", trustLabel: "trusted", sourceSessionId: "sess-1" });
  const e2 = s.upsertEntity("Rust", "user:interest", "untrusted");
  s.addLink(e, e2, "uses-with");
  s.save();

  const reopened = PersonalStore.openWithPassphrase(path, "correct horse battery staple");
  const g = reopened.graph();
  expect(g.entities.length).toBe(2);
  expect(g.facts.length).toBe(1);
  expect(g.facts[0]!.statement).toBe("Prefers Vim keybindings");
  expect(g.links.length).toBe(1);
  expect(g.links[0]!.relation).toBe("uses-with");
});

test("store: save() writes the encrypted file owner-only (0600, no world-readable window)", () => {
  const path = tmp();
  PersonalStore.createWithPassphrase(path, "pw").save();
  // POSIX perms only; Windows ACLs don't map to a mode bitmask (CI is ubuntu).
  if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
});

test("store: wrong passphrase fails closed (throws, no graph leaks)", () => {
  const path = tmp();
  PersonalStore.createWithPassphrase(path, "right-pass").save();
  expect(() => PersonalStore.openWithPassphrase(path, "wrong-pass")).toThrow();
});

test("store: upsertEntity reuses an entity by (name, kind)", () => {
  const path = tmp();
  const s = PersonalStore.createWithPassphrase(path, "pw");
  const a = s.upsertEntity("coffee", "user:preference", "trusted");
  const b = s.upsertEntity("coffee", "user:preference", "trusted");
  expect(a).toBe(b);
  expect(s.graph().entities.length).toBe(1);
});

test("store: forgetFact soft-deletes (hidden by default, visible with includeForgotten)", () => {
  const path = tmp();
  const s = PersonalStore.createWithPassphrase(path, "pw");
  const e = s.upsertEntity("x", "user:behavior", "trusted");
  const f = s.addFact({ entityId: e, statement: "stale fact", trustLabel: "trusted" });
  expect(s.forgetFact(f)).toBe(true);
  expect(s.graph().facts.length).toBe(0);
  expect(s.graph({ includeForgotten: true }).facts.length).toBe(1);
});

// ── compartments / scope (ADR-0012; CUI isolation ADR-0014) ──────────────────────
test("store: work/personal facts are scoped; graph filters; combined is the union", () => {
  const path = tmp();
  const s = PersonalStore.createWithPassphrase(path, "pw");
  const e = s.upsertEntity("topic", "user:interest", "trusted");
  s.addFact({ entityId: e, statement: "personal default", trustLabel: "trusted" });
  s.addFact({ entityId: e, statement: "at work", trustLabel: "trusted", scope: "work" });
  expect(s.graph({ scope: "personal" }).facts.length).toBe(1);
  expect(s.graph({ scope: "work" }).facts.length).toBe(1);
  expect(s.graph({ scope: "combined" }).facts.length).toBe(2);
  expect(s.graph().facts.length).toBe(2); // default = combined (work + personal)
  expect(s.scopeCounts()).toEqual({ work: 1, personal: 1, cui: 0 });
});

// ── keystore-custody store (OS keystore hands us the unsealed DEK) ────────────────
test("store: keystore custody round-trips and rejects a wrong key", () => {
  const path = tmp();
  const dek = randomKey();
  const s = PersonalStore.createWithKey(path, dek);
  s.addFact({ entityId: s.upsertEntity("k", "user:goal", "trusted"), statement: "ship P9", trustLabel: "trusted" });
  s.save();
  expect(PersonalStore.openWithKey(path, dek).graph().facts.length).toBe(1);
  expect(() => PersonalStore.openWithKey(path, randomKey())).toThrow();
});

// ── telemetry ────────────────────────────────────────────────────────────────────
test("opening a store emits personal_store_unlocked (metadata only, no content)", () => {
  const path = tmp();
  PersonalStore.createWithPassphrase(path, "pw").save();
  const events: TelemetryEvent[] = [];
  const tel = new Telemetry({ runId: "r1", sessionId: "s1", sink: (e) => events.push(e) });
  PersonalStore.openWithPassphrase(path, "pw", { telemetry: tel });
  const ev = events.find((e) => e.event === "personal_store_unlocked");
  expect(ev).toBeDefined();
  expect(ev!.custody).toBe("passphrase");
  // no fact statements / entity names in the event payload
  expect(JSON.stringify(ev)).not.toContain("statement");
});
