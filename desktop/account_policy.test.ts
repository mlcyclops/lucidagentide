// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-ACCT.1 (ADR-0375): account derivation and the vault appliers. The load-bearing contracts:
// omp resolves ONLY rows whose disabled_cause IS NULL, and stored OAuth outranks an env key, so
// "active" here must mirror what omp will actually route with after a switch.

import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { deriveAccounts, identityLabel, LEGACY_KEY_ACCOUNT_ID, LUCID_INACTIVE_CAUSE, oauthAccountId, validAccountName, type StoredAccount } from "./account_policy.ts";
import { activateOauthIdentity, disconnectOauthIdentity, listOauthRows, parkAllOauth } from "./auth_vault.ts";

const KEY_WORK: StoredAccount = { id: "key:w", name: "Work key", kind: "key", key: "sk-work-1234", createdAt: 1 };
const KEY_PERS: StoredAccount = { id: "key:p", name: "Personal", kind: "key", key: "sk-pers-9999", createdAt: 2 };

describe("deriveAccounts", () => {
  test("one account per OAuth identity; an active row beats a parked sibling of the same identity", () => {
    const v = deriveAccounts({
      oauthRows: [
        { identityKey: "email:a@work.com", disabledCause: LUCID_INACTIVE_CAUSE },
        { identityKey: "email:a@work.com", disabledCause: null }, // re-login while parked
        { identityKey: "email:b@home.com", disabledCause: LUCID_INACTIVE_CAUSE },
      ],
      stored: [],
    });
    expect(v).toHaveLength(2);
    const a = v.find((x) => x.id === oauthAccountId("email:a@work.com"))!;
    expect(a.parked).toBe(false);
    expect(a.active).toBe(true); // first unparked identity wins when nothing is persisted
    expect(v.find((x) => x.id === oauthAccountId("email:b@home.com"))!.parked).toBe(true);
  });

  test("stored oauth record contributes ONLY a rename; identities default to a humanized label", () => {
    const v = deriveAccounts({
      oauthRows: [{ identityKey: "email:a@work.com", disabledCause: null }],
      stored: [{ id: oauthAccountId("email:a@work.com"), name: "Company sub", kind: "oauth", identityKey: "email:a@work.com", createdAt: 1 }],
    });
    expect(v[0]!.name).toBe("Company sub");
    expect(identityLabel("email:a@work.com")).toBe("a@work.com");
    expect(identityLabel(null)).toBe("signed-in account");
  });

  test("legacy env key appears as its own account ONLY until a stored account holds the same value", () => {
    const withLegacy = deriveAccounts({ oauthRows: [], stored: [KEY_WORK], legacyKey: "sk-other-5555" });
    expect(withLegacy.map((v) => v.id)).toContain(LEGACY_KEY_ACCOUNT_ID);
    const migrated = deriveAccounts({ oauthRows: [], stored: [KEY_WORK], legacyKey: KEY_WORK.key });
    expect(migrated.map((v) => v.id)).not.toContain(LEGACY_KEY_ACCOUNT_ID);
    expect(migrated.find((v) => v.id === "key:w")!.active).toBe(true); // env slot holds its key
  });

  test("persisted activeId wins; a stale activeId falls back to omp precedence (unparked oauth first)", () => {
    const rows = [{ identityKey: "email:a@work.com", disabledCause: null }];
    const picked = deriveAccounts({ oauthRows: rows, stored: [KEY_WORK, KEY_PERS], legacyKey: KEY_PERS.key, activeId: "key:p" });
    expect(picked.find((v) => v.active)!.id).toBe("key:p");
    const stale = deriveAccounts({ oauthRows: rows, stored: [KEY_WORK], legacyKey: undefined, activeId: "key:gone" });
    expect(stale.find((v) => v.active)!.kind).toBe("oauth");
  });

  test("keys are last4-masked, never the value", () => {
    const v = deriveAccounts({ oauthRows: [], stored: [KEY_WORK] });
    expect(v[0]!.keyLast4).toBe("1234");
    expect(JSON.stringify(v)).not.toContain("sk-work-1234");
  });

  test("validAccountName trims, collapses whitespace, and refuses markup or novels", () => {
    expect(validAccountName("  Work   sub ")).toBe("Work sub");
    expect(validAccountName("a<b>")).toBeNull();
    expect(validAccountName("")).toBeNull();
    expect(validAccountName("x".repeat(49))).toBeNull();
  });
});

// The vault appliers against a REAL sqlite file with omp's schema. Cleanup is best-effort with the
// failure swallowed (auth_vault.test.ts pattern): Windows can hold a just-closed sqlite handle briefly,
// and a leaked tmp file must never fail the suite.
function seedDb(): string {
  const p = join(tmpdir(), `lucid-acct-${process.pid}-${Math.floor(performance.now() * 1000)}.db`);
  const db = new Database(p);
  db.exec(`CREATE TABLE auth_credentials (
    id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, credential_type TEXT NOT NULL,
    identity_key TEXT, data TEXT NOT NULL, disabled_cause TEXT,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')), updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')))`);
  const ins = db.prepare("insert into auth_credentials (provider, credential_type, identity_key, data, disabled_cause) values (?,?,?,?,?)");
  ins.run("openai-codex", "oauth", "email:a@work.com", "{tokenA}", null);
  ins.run("openai-codex", "oauth", "email:b@home.com", "{tokenB}", null);
  ins.run("openai-codex", "oauth", "email:c@old.com", "{tokenC}", "logged out by user"); // omp's own cause
  ins.run("anthropic", "oauth", "email:z@x.com", "{tokenZ}", null);
  db.close();
  return p;
}

describe("vault appliers (P-ACCT.1)", () => {
  test("activate parks the others, unparks the target, and NEVER touches omp-disabled rows or other providers", () => {
    const dbp = seedDb();
    try {
      activateOauthIdentity("openai-codex", "email:b@home.com", dbp);
      const rows = listOauthRows("openai-codex", dbp);
      expect(rows).toEqual([
        { identityKey: "email:a@work.com", disabledCause: LUCID_INACTIVE_CAUSE },
        { identityKey: "email:b@home.com", disabledCause: null },
      ]); // c@old.com (omp-disabled) is not even listed
      // switch back: fully reversible
      activateOauthIdentity("openai-codex", "email:a@work.com", dbp);
      expect(listOauthRows("openai-codex", dbp).find((r) => r.identityKey === "email:a@work.com")!.disabledCause).toBeNull();
      // other provider untouched throughout
      expect(listOauthRows("anthropic", dbp)[0]!.disabledCause).toBeNull();
      const db = new Database(dbp, { readonly: true });
      // bun:sqlite returns unknown row shapes; the SELECT names exactly this column.
      const ompRow = db.query("select disabled_cause as c from auth_credentials where identity_key = 'email:c@old.com'").get() as { c: string };
      expect(ompRow.c).toBe("logged out by user");
      db.close();
    } finally { try { rmSync(dbp, { force: true }); } catch { /* windows handle lag */ } }
  });

  test("parkAllOauth silences every active row so an env key wins omp's precedence; disconnect removes ONE identity", () => {
    const dbp = seedDb();
    try {
      const r = parkAllOauth("openai-codex", dbp);
      expect(r.parked).toBe(2);
      expect(listOauthRows("openai-codex", dbp).every((x) => x.disabledCause === LUCID_INACTIVE_CAUSE)).toBe(true);
      disconnectOauthIdentity("openai-codex", "email:b@home.com", dbp);
      expect(listOauthRows("openai-codex", dbp).map((x) => x.identityKey)).toEqual(["email:a@work.com"]);
    } finally { try { rmSync(dbp, { force: true }); } catch { /* windows handle lag */ } }
  });

  test("missing vault fails closed: empty lists, zero-change results, never a throw", () => {
    const nope = join(tmpdir(), "lucid-acct-none", "agent.db");
    expect(listOauthRows("openai-codex", nope)).toEqual([]);
    expect(activateOauthIdentity("openai-codex", "email:a@work.com", nope).unparked).toBe(0);
    expect(parkAllOauth("openai-codex", nope).parked).toBe(0);
  });
});
