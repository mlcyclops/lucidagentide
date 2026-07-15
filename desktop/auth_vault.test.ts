// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/auth_vault.test.ts - clearDisabledCredential only ever nulls a stale `disabled_cause`,
// never touches the token blob, and is a safe no-op on the active / missing / absent cases.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { clearAllOauthCredentials, clearDisabledCredential, disconnectCredential } from "./auth_vault.ts";

let dbPath = "";
function seed(disabledCause: string | null): void {
  const db = new Database(dbPath);
  db.exec("create table auth_credentials (id integer primary key, provider text, credential_type text, data text, disabled_cause text, identity_key text)");
  db.query("insert into auth_credentials (provider, credential_type, data, disabled_cause, identity_key) values (?,?,?,?,?)")
    .run("openai-codex", "oauth", '{"access":"TOKEN-DO-NOT-TOUCH","refresh":"RT"}', disabledCause, "email:nick@example.com");
  db.close();
}
function read(provider: string): { data: string; disabled_cause: string | null } | null {
  const db = new Database(dbPath, { readonly: true });
  try { return db.query("select data, disabled_cause from auth_credentials where provider = ?").get(provider) as never; }
  finally { db.close(); }
}

beforeEach(() => { dbPath = join(tmpdir(), `lucid-vault-${process.pid}-${Math.floor(performance.now() * 1000)}.db`); });
afterEach(() => { try { rmSync(dbPath, { force: true }); } catch { /* ignore */ } });

describe("clearDisabledCredential", () => {
  test("clears a stale disabled_cause and re-enables, leaving the token blob untouched", () => {
    seed("logged out by user");
    const r = clearDisabledCredential("openai-codex", dbPath);
    expect(r.cleared).toBe(1);
    expect(r.identity).toBe("email:nick@example.com");
    const row = read("openai-codex")!;
    expect(row.disabled_cause).toBeNull();           // re-enabled
    expect(row.data).toContain("TOKEN-DO-NOT-TOUCH"); // token blob preserved verbatim
  });

  test("no-op when the credential is already active (disabled_cause null)", () => {
    seed(null);
    const r = clearDisabledCredential("openai-codex", dbPath);
    expect(r.cleared).toBe(0);
    expect(r.reason).toBe("already active");
  });

  test("no-op for a provider with no row", () => {
    seed("logged out by user");
    const r = clearDisabledCredential("anthropic", dbPath);
    expect(r.cleared).toBe(0);
    expect(read("openai-codex")!.disabled_cause).toBe("logged out by user"); // unrelated row untouched
  });

  test("missing vault and empty provider fail closed (0 cleared, never throws)", () => {
    expect(clearDisabledCredential("openai-codex", join(tmpdir(), "definitely-not-here.db")).cleared).toBe(0);
    expect(clearDisabledCredential("", dbPath).cleared).toBe(0);
  });
});

/** Seed a mixed vault: two normal oauth logins, an ORPHAN oauth (broker id with no Settings descriptor),
 *  and an API-key credential that must never be deleted by an OAuth sign-out. */
function seedMixed(): void {
  const db = new Database(dbPath);
  db.exec("create table auth_credentials (id integer primary key, provider text, credential_type text, data text, disabled_cause text, identity_key text)");
  const ins = db.query("insert into auth_credentials (provider, credential_type, data, disabled_cause, identity_key) values (?,?,?,?,?)");
  ins.run("anthropic", "oauth", '{"access":"A"}', null, "email:a@x.com");
  ins.run("openai-codex", "oauth", '{"access":"O"}', null, "email:o@x.com");
  ins.run("google-antigravity", "oauth", '{"access":"G"}', null, "sub:orphan"); // orphan — no UI card
  ins.run("openrouter", "api", '{"key":"KEEP-ME"}', null, "key");                // API key — must survive
  db.close();
}
function count(where = ""): number {
  const db = new Database(dbPath, { readonly: true });
  try { return (db.query(`select count(*) as n from auth_credentials ${where}`).get() as { n: number }).n; }
  finally { db.close(); }
}

describe("disconnectCredential", () => {
  test("DELETES the oauth row for a provider (real clear, not a soft-disable)", () => {
    seedMixed();
    const r = disconnectCredential("anthropic", dbPath);
    expect(r.removed).toBe(1);
    expect(read("anthropic")).toBeNull();          // row (and its token blob) gone
    expect(read("openai-codex")).not.toBeNull();   // other logins untouched
    expect(count("where credential_type = 'api'")).toBe(1); // API key survives
  });

  test("never deletes an API-key row (scoped to credential_type='oauth')", () => {
    seedMixed();
    const r = disconnectCredential("openrouter", dbPath); // openrouter's row is an api key, not oauth
    expect(r.removed).toBe(0);
    expect(read("openrouter")!.data).toContain("KEEP-ME");
  });

  test("missing provider / vault fail closed (0 removed, never throws)", () => {
    expect(disconnectCredential("", dbPath).removed).toBe(0);
    expect(disconnectCredential("anthropic", join(tmpdir(), "nope.db")).removed).toBe(0);
  });
});

describe("clearAllOauthCredentials", () => {
  test("removes EVERY oauth login (including orphans) but keeps API keys", () => {
    seedMixed();
    const r = clearAllOauthCredentials(dbPath);
    expect(r.removed).toBe(3); // anthropic + openai-codex + google-antigravity (orphan)
    expect(count("where credential_type = 'oauth'")).toBe(0);
    expect(count("where credential_type = 'api'")).toBe(1); // API key untouched
    expect(read("openrouter")!.data).toContain("KEEP-ME");
  });

  test("missing vault fails closed (0 removed)", () => {
    expect(clearAllOauthCredentials(join(tmpdir(), "nope.db")).removed).toBe(0);
  });
});
