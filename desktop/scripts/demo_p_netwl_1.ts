// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_netwl_1.ts — P-NETWL.1 (ADR-0106): a curated network WHITELIST that auto-allows
// egress on top of the per-website gate, plus an OS-encrypted credential vault for the endpoints that need
// auth. Hermetic: it drives the REAL policy code (egressWhitelistAllows in egress_policy.ts) with an injected
// store + injected managed ceiling, and the REAL vault with a fake safeStorage, so it touches no user files.
//
// Proves:
//   (1) an `always`-scoped domain wildcard and an IP CIDR auto-allow a URL the plain gate would prompt for;
//   (2) the enterprise-managed ceiling WINS over a user whitelist - a managed-denied host, and a host outside
//       a restrictive managed allow-list, are never granted (tighten-only, fail-closed);
//   (3) `project` / `loop` scopes are recorded but NOT yet granted (deferred to P-NETWL.2/.3);
//   (4) the credential vault encrypts at rest (blob != plaintext), decrypt roundtrips, and FAIL-CLOSES with
//       NO plaintext written when OS encryption is unavailable.

import { egressWhitelistAllows } from "../egress_policy.ts";
import { emptyStore, upsertEntry, type WhitelistEntry, type WhitelistStore } from "../network_whitelist.ts";
import { storeCredential, readCredential, listCredentials, type SafeStorageLike, type VaultIo } from "../cred_vault.ts";
import type { ManagedEgressPolicy } from "../managed_config.ts";

const fail = (msg: string): never => { console.error(`FAIL: ${msg}`); process.exit(1); };
const ok = (msg: string): void => console.log(`   ${msg} ✓`);
const entry = (o: Partial<WhitelistEntry> & Pick<WhitelistEntry, "id" | "pattern">): WhitelistEntry =>
  ({ kind: "domain", zone: "external", scope: "always", ...o });

console.log("== P-NETWL.1 — curated network whitelist + OS-encrypted credential vault ==");

// A user whitelist: an external SaaS by wildcard, an internal subnet by CIDR, plus deferred-scope entries.
let store: WhitelistStore = emptyStore();
store = upsertEntry(store, entry({ id: "saas", pattern: "*.githubusercontent.com", zone: "external", scope: "always" }));
store = upsertEntry(store, entry({ id: "intranet", kind: "ip", pattern: "10.0.0.0/8", zone: "internal", scope: "always" }));
store = upsertEntry(store, entry({ id: "proj", pattern: "*.staging.local", zone: "internal", scope: "project", project: "/work/app" }));
store = upsertEntry(store, entry({ id: "loop", pattern: "*.bing.com", zone: "external", scope: "loop" }));

console.log("\n1) an always-scoped domain wildcard + IP CIDR auto-allow (no managed ceiling)");
if (!egressWhitelistAllows(store, "https://raw.githubusercontent.com/o/r/main/x")) fail("*.githubusercontent.com should auto-allow");
if (!egressWhitelistAllows(store, "http://10.14.2.9:8080/api")) fail("10.0.0.0/8 should auto-allow an internal IP");
if (egressWhitelistAllows(store, "https://evil.com/x")) fail("an unlisted host must NOT be whitelisted");
ok("*.githubusercontent.com and 10.0.0.0/8 auto-allow; evil.com falls through to the gate");

console.log("\n2) the managed ceiling WINS over the user whitelist (tighten-only, fail-closed)");
const denyManaged: ManagedEgressPolicy = { deniedHosts: ["raw.githubusercontent.com"] };
if (egressWhitelistAllows(store, "https://raw.githubusercontent.com/x", denyManaged)) fail("a managed-DENIED host must never be granted by a user whitelist");
ok("managed deny beats user allow");
const restrictiveManaged: ManagedEgressPolicy = { allowedHosts: ["objects.githubusercontent.com"] };
if (egressWhitelistAllows(store, "https://raw.githubusercontent.com/x", restrictiveManaged)) fail("a host outside a restrictive managed allow-list must not be granted");
if (!egressWhitelistAllows(store, "https://objects.githubusercontent.com/x", restrictiveManaged)) fail("a host inside BOTH the whitelist and the managed allow-list should be granted");
ok("restrictive managed allow-list clamps the whitelist to its intersection");

console.log("\n3) project / loop scopes are recorded but NOT yet granted (deferred to P-NETWL.2/.3)");
if (egressWhitelistAllows(store, "https://web.staging.local/x")) fail("a `project`-scoped entry must not auto-allow in P-NETWL.1");
if (egressWhitelistAllows(store, "https://www.bing.com/search")) fail("a `loop`-scoped entry must not auto-allow in P-NETWL.1");
if (store.entries.length !== 4) fail("all four entries (incl. deferred scopes) must persist in the store");
ok("project + loop entries persist for the later increments but grant nothing today");

console.log("\n4) credential vault: encrypts at rest, roundtrips, and fail-closes with no plaintext");
const files = new Map<string, Buffer>();
const io: VaultIo = {
  ensureDir: () => {},
  writeFile: (p, d) => { files.set(p, Buffer.from(d)); },
  readFile: (p) => { const b = files.get(p); if (!b) throw new Error("ENOENT"); return b; },
  exists: (p) => files.has(p),
  remove: (p) => { files.delete(p); },
  list: (dir) => [...files.keys()].filter((k) => k.startsWith(dir + "/")).map((k) => k.slice(dir.length + 1)),
};
const safeUp: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  // stand-in for DPAPI/Keychain/libsecret: opaque ciphertext (base64), never the plaintext.
  encryptString: (s) => Buffer.from("v1:" + Buffer.from(s, "utf8").toString("base64"), "utf8"),
  decryptString: (b) => Buffer.from(b.toString("utf8").replace(/^v1:/, ""), "base64").toString("utf8"),
};
const meta = storeCredential(safeUp, io, "/vault", { ref: "cred_jwt_prod", kind: "jwt", secret: "eyJhbGciOi.TOPSECRET", label: "prod JWT" });
if (files.get("/vault/cred_jwt_prod.bin")!.toString("utf8").includes("TOPSECRET")) fail("the secret must NOT be stored in plaintext");
if (readCredential(safeUp, io, "/vault", "cred_jwt_prod") !== "eyJhbGciOi.TOPSECRET") fail("main-side decrypt must roundtrip");
if (listCredentials(io, "/vault")[0]?.ref !== "cred_jwt_prod" || JSON.stringify(listCredentials(io, "/vault")).includes("TOPSECRET")) fail("listing exposes metadata only, never the secret");
ok(`stored '${meta.label}' encrypted (blob has no plaintext); decrypt roundtrips; listing is metadata-only`);

const filesFC = new Map<string, Buffer>();
const ioFC: VaultIo = { ...io, writeFile: (p, d) => { filesFC.set(p, Buffer.from(d)); }, exists: (p) => filesFC.has(p), list: () => [...filesFC.keys()] };
const safeDown: SafeStorageLike = { isEncryptionAvailable: () => false, encryptString: () => { throw new Error("nope"); }, decryptString: () => { throw new Error("nope"); } };
let threw = false;
try { storeCredential(safeDown, ioFC, "/vault", { ref: "x", kind: "pem", secret: "PRIVATEKEY" }); } catch { threw = true; }
if (!threw) fail("storing with OS encryption unavailable MUST throw");
if (filesFC.size !== 0) fail("fail-closed: nothing may be written when encryption is unavailable");
ok("OS encryption unavailable → store throws and writes NOTHING (no plaintext fallback)");

console.log("\nPASS — the whitelist auto-allows under the managed ceiling, deferred scopes grant nothing, and secrets are OS-encrypted or refused.");
