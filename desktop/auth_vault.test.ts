// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/auth_vault.test.ts - clearDisabledCredential only ever nulls a stale `disabled_cause`,
// never touches the token blob, and is a safe no-op on the active / missing / absent cases.
//
// The second half of the file covers credentialSnapshot / landedFreshCredential (ADR-0316): deciding
// whether an `auth-broker login` actually wrote a token, WITHOUT trusting the broker's exit code, so a
// login that succeeded always respawns omp and a login that failed never resurrects a logged-out row.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import {
  clearAllOauthCredentials,
  clearDisabledCredential,
  credentialSnapshot,
  disconnectCredential,
  landedFreshCredential,
} from "./auth_vault.ts";

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

// ---------------------------------------------------------------------------------------------------
// ADR-0316: a login is confirmed by the VAULT, not by the broker's exit code.
// ---------------------------------------------------------------------------------------------------

const SNAP_PROVIDER = "openai-codex";
const snapDirs: string[] = [];
afterEach(() => { for (const d of snapDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A throwaway vault carrying omp's REAL `auth_credentials` shape, including the `updated_at` /
 *  `created_at` defaults the fingerprint depends on (copied from a live agent.db). */
function snapVault(): string {
  const dir = mkdtempSync(join(tmpdir(), "lucid-snap-"));
  snapDirs.push(dir);
  const p = join(dir, "agent.db");
  const db = new Database(p);
  db.exec(`CREATE TABLE auth_credentials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL,
    credential_type TEXT NOT NULL,
    data TEXT NOT NULL,
    disabled_cause TEXT DEFAULT NULL,
    identity_key TEXT DEFAULT NULL,
    created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
    updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
  )`);
  db.close();
  return p;
}
function snapRun(p: string, sql: string, ...args: (string | number | null)[]): void {
  const db = new Database(p);
  try { db.query(sql).run(...args as never[]); } finally { db.close(); }
}
/** What omp's `auth-broker login` effectively does: land an oauth row for a provider. */
function snapLogin(p: string, token: string, updatedAt = 1_700_000_000, disabled: string | null = null): void {
  snapRun(p, "insert into auth_credentials (provider, credential_type, data, disabled_cause, updated_at) values (?,?,?,?,?)",
    SNAP_PROVIDER, "oauth", token, disabled, updatedAt);
}

describe("credentialSnapshot", () => {
  test("absent vault file reports nothing present, and never throws", () => {
    expect(credentialSnapshot(SNAP_PROVIDER, join(tmpdir(), "lucid-no-such-dir", "agent.db")))
      .toEqual({ present: false });
  });

  test("a vault with no row for the provider reports nothing present", () => {
    expect(credentialSnapshot(SNAP_PROVIDER, snapVault()).present).toBe(false);
  });

  test("an unreadable vault reports nothing present instead of throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "lucid-snap-"));
    snapDirs.push(dir);
    const p = join(dir, "agent.db");
    writeFileSync(p, "this is not a database");
    expect(credentialSnapshot(SNAP_PROVIDER, p).present).toBe(false);
  });

  test("an API-key row is NOT reported as an OAuth login", () => {
    const p = snapVault();
    snapRun(p, "insert into auth_credentials (provider, credential_type, data) values (?,?,?)", SNAP_PROVIDER, "api_key", "sk-live");
    expect(credentialSnapshot(SNAP_PROVIDER, p).present).toBe(false);
  });

  test("reads the oauth row and surfaces its disabled state", () => {
    const p = snapVault();
    snapLogin(p, "tok-1", 1_700_000_000, "logged out by user");
    const s = credentialSnapshot(SNAP_PROVIDER, p);
    expect(s.present).toBe(true);
    expect(s.disabled).toBe(true);
    expect(s.updatedAt).toBe(1_700_000_000);
  });

  test("never carries the token blob itself, only a hash of it", () => {
    const p = snapVault();
    snapLogin(p, "super-secret-refresh-token");
    expect(JSON.stringify(credentialSnapshot(SNAP_PROVIDER, p))).not.toContain("super-secret-refresh-token");
  });
});

describe("landedFreshCredential", () => {
  test("a first-ever login is detected", () => {
    const p = snapVault();
    const before = credentialSnapshot(SNAP_PROVIDER, p);
    snapLogin(p, "tok-1");
    expect(landedFreshCredential(before, credentialSnapshot(SNAP_PROVIDER, p))).toBe(true);
  });

  // THE regression this mechanism exists for: the broker wrote a good token but told us nothing useful
  // (non-zero exit, or it never exited). `updated_at` has one-second resolution, so the blob hash is
  // what carries the verdict when a re-login lands inside the same tick.
  test("a re-login that rewrites the blob within the same updated_at tick is still detected", () => {
    const p = snapVault();
    snapLogin(p, "tok-1", 1_700_000_000);
    const before = credentialSnapshot(SNAP_PROVIDER, p);
    snapRun(p, "update auth_credentials set data = ? where provider = ?", "tok-2-fresh", SNAP_PROVIDER);
    const after = credentialSnapshot(SNAP_PROVIDER, p);
    expect(after.updatedAt).toBe(before.updatedAt); // the clock did not move
    expect(landedFreshCredential(before, after)).toBe(true); // the blob hash caught it
  });

  test("a replaced row (logout then login) is detected by id, even with an identical token and clock", () => {
    const p = snapVault();
    snapLogin(p, "tok-1", 1_700_000_000);
    const before = credentialSnapshot(SNAP_PROVIDER, p);
    snapRun(p, "delete from auth_credentials where provider = ?", SNAP_PROVIDER);
    snapLogin(p, "tok-1", 1_700_000_000);
    const after = credentialSnapshot(SNAP_PROVIDER, p);
    expect(after.id).not.toBe(before.id);
    expect(landedFreshCredential(before, after)).toBe(true);
  });

  test("a bumped updated_at alone is detected", () => {
    const p = snapVault();
    snapLogin(p, "tok-1", 1_700_000_000);
    const before = credentialSnapshot(SNAP_PROVIDER, p);
    snapRun(p, "update auth_credentials set updated_at = ? where provider = ?", 1_700_000_099, SNAP_PROVIDER);
    expect(landedFreshCredential(before, credentialSnapshot(SNAP_PROVIDER, p))).toBe(true);
  });

  // The anti-resurrection guarantee. The caller reacts to `true` by clearing `disabled_cause`, so a
  // failed login reading as success would re-arm a credential the user deliberately logged out of.
  test("a failed login that changed nothing is NOT treated as fresh", () => {
    const p = snapVault();
    snapLogin(p, "tok-1", 1_700_000_000);
    const before = credentialSnapshot(SNAP_PROVIDER, p);
    expect(landedFreshCredential(before, credentialSnapshot(SNAP_PROVIDER, p))).toBe(false);
  });

  test("a failed login against a logged-out (disabled) credential is NOT treated as fresh", () => {
    const p = snapVault();
    snapLogin(p, "tok-1", 1_700_000_000, "logged out by user");
    const before = credentialSnapshot(SNAP_PROVIDER, p);
    const after = credentialSnapshot(SNAP_PROVIDER, p);
    expect(after.disabled).toBe(true);
    expect(landedFreshCredential(before, after)).toBe(false);
  });

  test("a login that left no row at all is NOT treated as fresh", () => {
    const p = snapVault();
    const before = credentialSnapshot(SNAP_PROVIDER, p);
    expect(landedFreshCredential(before, credentialSnapshot(SNAP_PROVIDER, p))).toBe(false);
  });

  test("a vault that became unreadable after the login is NOT treated as fresh", () => {
    const p = snapVault();
    snapLogin(p, "tok-1");
    const before = credentialSnapshot(SNAP_PROVIDER, p);
    expect(landedFreshCredential(before, { present: false })).toBe(false);
  });

  test("an OLDER updated_at with an identical blob is NOT treated as fresh (clock skew)", () => {
    const p = snapVault();
    snapLogin(p, "tok-1", 1_700_000_000);
    const before = credentialSnapshot(SNAP_PROVIDER, p);
    snapRun(p, "update auth_credentials set updated_at = ? where provider = ?", 1_699_999_000, SNAP_PROVIDER);
    expect(landedFreshCredential(before, credentialSnapshot(SNAP_PROVIDER, p))).toBe(false);
  });
});
