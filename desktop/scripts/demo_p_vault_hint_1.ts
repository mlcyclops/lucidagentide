// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_vault_hint_1.ts
//
// Increment P-VAULT-HINT.1 — locked-vault existence signal (issue #111, ADR-0077). When the user's
// encrypted memory vault is LOCKED, the agent used to get nothing and answered "what do I like?" from
// empty. Now recallPreamble() injects a content-free hint so the agent KNOWS a vault exists and offers to
// unlock — while never decrypting anything. Proof of the pure, fail-closed core (vault_hint.ts).

import { lockedVaultHint, type VaultLockState } from "../vault_hint.ts";

const fail = (msg: string): never => { console.error(`FAIL: ${msg}`); process.exit(1); };
const ok = (msg: string): void => console.log(`   ${msg} ✓`);
const st = (o: Partial<VaultLockState>): VaultLockState =>
  ({ scope: "personal", personalConfigured: false, personalUnlocked: false, cuiConfigured: false, cuiUnlocked: false, ...o });

console.log("== #111 locked vault → existence hint (no content, ever) ==");

const locked = lockedVaultHint(st({ scope: "personal", personalConfigured: true, personalUnlocked: false }));
if (!locked || !locked.includes('locked="true"') || !locked.toLowerCase().includes("unlock")) fail("locked personal vault should produce an unlock hint");
ok("locked + configured personal vault → hint that asks the user to unlock");

if (locked.includes("<user-profile") || locked.includes("UNTRUSTED_CONTENT") || !locked.startsWith("<encrypted-vault")) fail("hint must be a first-party signal, not the recall block / untrusted data");
ok("hint is first-party (NOT the <user-profile> recall block, NOT untrusted-delimited)");

if (lockedVaultHint(st({ scope: "personal", personalConfigured: true, personalUnlocked: true })) !== "") fail("an UNLOCKED vault must yield no hint");
if (lockedVaultHint(st({ scope: "personal", personalConfigured: false })) !== "") fail("a vault that was never set up must yield no hint");
ok("unlocked → no hint (normal recall runs); never-configured → no hint (fail-closed)");

if (!lockedVaultHint(st({ scope: "cui", cuiConfigured: true, cuiUnlocked: false })).includes('scope="CUI"')) fail("locked CUI store should hint about CUI");
if (lockedVaultHint(st({ scope: "personal", personalConfigured: true, personalUnlocked: true, cuiConfigured: true, cuiUnlocked: false })) !== "") fail("a personal view must NOT surface a locked CUI store (ADR-0014 isolation)");
ok("CUI compartment isolation preserved: each view only ever signals its own locked store");

// Structural guarantee: lockedVaultHint takes only booleans + a scope label — NO graph/fact input — so it
// is incapable of leaking decrypted content. That is the fail-closed property (keystone #3).
ok("structurally content-free: the hint builder has no fact/graph input → cannot leak vault content");

console.log("demo-P-VAULT-HINT.1 OK");
process.exit(0);
