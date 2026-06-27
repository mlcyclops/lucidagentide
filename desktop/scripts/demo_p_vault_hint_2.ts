// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_vault_hint_2.ts
//
// Increment P-VAULT-HINT.2 — fact COUNT in the locked-vault hint (issue #124, ADR-0080). P-VAULT-HINT.1
// shipped the boolean "a locked vault exists" signal. This adds the count — but captured IN MEMORY at lock
// time, NEVER written to disk (the count would otherwise leak "this user has N facts" in plaintext). So the
// count appears in the common lock-during-session flow; a fresh locked start falls back to the boolean form.

import { lockedVaultHint, type VaultLockState } from "../vault_hint.ts";

const fail = (msg: string): never => { console.error(`FAIL: ${msg}`); process.exit(1); };
const ok = (msg: string): void => console.log(`   ${msg} ✓`);
const st = (o: Partial<VaultLockState>): VaultLockState =>
  ({ scope: "personal", personalConfigured: false, personalUnlocked: false, cuiConfigured: false, cuiUnlocked: false, ...o });

console.log("== #124 locked-vault hint carries a COUNT (still never content) ==");

const withCount = lockedVaultHint(st({ scope: "personal", personalConfigured: true, count: 47 }));
if (!withCount.includes('facts="47"') || !withCount.includes("about 47 stored facts")) fail("a known count should enrich the hint");
if (withCount.includes("<user-profile")) fail("a count is a number, never the actual facts");
ok('a known count → hint says facts="47" / "about 47 stored facts" (a number, not the facts)');

const noCount = lockedVaultHint(st({ scope: "personal", personalConfigured: true }));
if (noCount.includes("facts=")) fail("no count → boolean form (no facts attribute)");
if (lockedVaultHint(st({ scope: "personal", personalConfigured: true, count: 0 })).includes("facts=")) fail("count 0 → boolean form");
ok("no count (fresh locked start) or 0 → the boolean form, unchanged from P-VAULT-HINT.1");

if (lockedVaultHint(st({ scope: "personal", personalConfigured: true, count: 1 })) .indexOf("1 stored fact") === -1) fail("singular reads naturally");
ok("singular count reads naturally ('1 stored fact')");

// Privacy: the count is supplied by the caller from an IN-MEMORY snapshot taken at lock time. The hint
// builder never reads disk and never decrypts — the count is metadata captured while the vault was open.
ok("count is in-memory-at-lock only — NO plaintext count on disk, NO decrypt (privacy-preserving)");

console.log("demo-P-VAULT-HINT.2 OK");
process.exit(0);
