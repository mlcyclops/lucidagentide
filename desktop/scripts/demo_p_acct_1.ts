// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Increment P-ACCT.1 (ADR-0375) - named multi-account providers. Proves, against the REAL store, the
// REAL vault appliers on a real sqlite file with omp's schema, and the REAL policy layer, the exact
// sequence the /api/accounts routes run:
//   (1) two ChatGPT subscriptions (OAuth identities) plus two named API keys coexist on one provider;
//   (2) switching an OAuth account parks the other identity (omp's soft-disable, LUCID's cause only)
//       and switching back restores it, without touching rows omp disabled for its own reasons;
//   (3) switching to a KEY account parks all OAuth rows (stored OAuth outranks env keys in omp) and
//       lands that account's key in the single env slot;
//   (4) rename and remove behave (oauth rename-only records; removing the active account clears the
//       env slot and the active pointer);
//   (5) the rebuilt renderer bundle actually carries the new accordion + accounts UI markers.

import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

// Isolate the settings store BEFORE importing it (the store resolves its file per call, but keep the
// env set first anyway so no accidental early read touches the real file).
const settingsFile = join(tmpdir(), `lucid-acct-demo-${process.pid}.json`);
process.env.LUCID_GUI_SETTINGS_FILE = settingsFile;

import { deriveAccounts, LUCID_INACTIVE_CAUSE, oauthAccountId } from "../account_policy.ts";
import { activateOauthIdentity, listOauthRows, parkAllOauth } from "../auth_vault.ts";
import { activeAccountId, addKeyAccount, load, providerAccounts, removeAccount, renameAccount, setActiveAccount, setKey } from "../settings_store.ts";

let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? "  ok " : "FAIL "} ${label}`);
  if (!ok) failures++;
}

const dbPath = join(tmpdir(), `lucid-acct-demo-${process.pid}.db`);
const db = new Database(dbPath);
db.exec(`CREATE TABLE auth_credentials (
  id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, credential_type TEXT NOT NULL,
  identity_key TEXT, data TEXT NOT NULL, disabled_cause TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')), updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')))`);
const ins = db.prepare("insert into auth_credentials (provider, credential_type, identity_key, data, disabled_cause) values (?,?,?,?,?)");
ins.run("openai-codex", "oauth", "email:work@company.com", "{tokenWork}", null);
ins.run("openai-codex", "oauth", "email:home@gmail.com", "{tokenHome}", null);
ins.run("openai-codex", "oauth", "email:stale@old.com", "{tokenStale}", "logged out by user");
db.close();

const PROV = "openai"; // LUCID provider id; its omp broker id is openai-codex
const BROKER = "openai-codex";
const ENV = "OPENAI_API_KEY";
const snapshot = () => deriveAccounts({
  oauthRows: listOauthRows(BROKER, dbPath),
  stored: providerAccounts(PROV),
  legacyKey: load().keys?.[ENV] || undefined,
  activeId: activeAccountId(PROV),
});

try {
  console.log("== P-ACCT.1 - named multi-account providers ==");

  // (1) coexistence
  const work = addKeyAccount(PROV, "Work API key", "sk-work-1111");
  addKeyAccount(PROV, "Personal API key", "sk-pers-2222");
  let v = snapshot();
  check("two OAuth identities + two named keys coexist on one provider", v.length === 4);
  check("omp-disabled identity (stale@old.com) is not an account", !v.some((a) => a.identity === "stale@old.com"));
  check("no secret ever appears in a view (last4 only)", !JSON.stringify(v).includes("sk-work-1111") && v.some((a) => a.keyLast4 === "1111"));

  // (2) OAuth <-> OAuth switch
  activateOauthIdentity(BROKER, "email:home@gmail.com", dbPath);
  setActiveAccount(PROV, oauthAccountId("email:home@gmail.com"));
  v = snapshot();
  check("switch to home@gmail.com: work identity parked under LUCID's cause", v.find((a) => a.identity === "work@company.com")?.parked === true);
  check("home@gmail.com is active", v.find((a) => a.active)?.identity === "home@gmail.com");
  activateOauthIdentity(BROKER, "email:work@company.com", dbPath);
  setActiveAccount(PROV, oauthAccountId("email:work@company.com"));
  v = snapshot();
  check("switch back is lossless (work active again, home parked)", v.find((a) => a.active)?.identity === "work@company.com" && v.find((a) => a.identity === "home@gmail.com")?.parked === true);

  // (3) OAuth -> key switch
  parkAllOauth(BROKER, dbPath);
  setKey(ENV, "sk-work-1111");
  setActiveAccount(PROV, work!.id);
  v = snapshot();
  check("key account active: EVERY oauth row parked (stored OAuth would outrank the env key)", listOauthRows(BROKER, dbPath).every((r) => r.disabledCause === LUCID_INACTIVE_CAUSE));
  check("the active account is the named key and the env slot holds its key", v.find((a) => a.active)?.id === work!.id && load().keys?.[ENV] === "sk-work-1111");

  // (4) rename + remove
  renameAccount(PROV, oauthAccountId("email:work@company.com"), "Company ChatGPT");
  v = snapshot();
  check("an OAuth identity can be renamed without a credential record of its own", v.find((a) => a.identity === "work@company.com")?.name === "Company ChatGPT");
  if (load().keys?.[ENV] === "sk-work-1111") setKey(ENV, ""); // the route clears the env slot with the active key account
  removeAccount(PROV, work!.id);
  v = snapshot();
  check("removing the active key account clears the env slot and the active pointer", !v.some((a) => a.id === work!.id) && !load().keys?.[ENV] && activeAccountId(PROV) === undefined);

  // (5) served-bytes markers in the rebuilt bundle
  const bundle = readFileSync(join(import.meta.dir, "..", "renderer", "app.bundle.js"), "utf8");
  for (const marker of ["data-acct-switch", "data-prov-acc", "accountsBlock", "provAccordion"]) {
    check(`renderer bundle carries ${marker}`, bundle.includes(marker));
  }
  const css = readFileSync(join(import.meta.dir, "..", "renderer", "styles.css"), "utf8");
  check("stylesheet carries the accordion styles (.prov-acc)", css.includes(".prov-acc"));
} finally {
  try { rmSync(dbPath, { force: true }); } catch { /* windows handle lag */ }
  try { rmSync(settingsFile, { force: true }); } catch { /* ditto */ }
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
