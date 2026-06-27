// Tests for P-VAULT-HINT.1 (ADR-0077): the locked-vault existence hint. Security-critical — the hint
// must signal that a vault EXISTS without ever carrying decrypted content, and only fire when locked.

import { expect, test } from "bun:test";
import { lockedVaultHint, type VaultLockState } from "./vault_hint.ts";

const st = (o: Partial<VaultLockState>): VaultLockState =>
  ({ scope: "personal", personalConfigured: false, personalUnlocked: false, cuiConfigured: false, cuiUnlocked: false, ...o });

test("configured + locked personal vault → an existence hint that asks to unlock", () => {
  const h = lockedVaultHint(st({ scope: "personal", personalConfigured: true, personalUnlocked: false }));
  expect(h).toContain('locked="true"');
  expect(h).toContain('scope="personal"');
  expect(h.toLowerCase()).toContain("unlock");
  expect(h.toLowerCase()).toContain("ask");
});

test("STRUCTURALLY content-free: the hint carries no recall block and no untrusted delimiters", () => {
  // The function's inputs are booleans + a scope label — there is NO graph/fact input, so it cannot leak
  // content by construction. Assert it isn't the <user-profile> recall block and isn't untrusted data.
  const h = lockedVaultHint(st({ scope: "personal", personalConfigured: true }));
  expect(h).not.toContain("<user-profile");
  expect(h).not.toContain("UNTRUSTED_CONTENT");
  expect(h.startsWith("<encrypted-vault")).toBe(true); // first-party instruction, not delimited data
});

test("unlocked vault → no hint (normal recall handles it)", () => {
  expect(lockedVaultHint(st({ scope: "personal", personalConfigured: true, personalUnlocked: true }))).toBe("");
});

test("never set up → no hint", () => {
  expect(lockedVaultHint(st({ scope: "personal", personalConfigured: false }))).toBe("");
});

test("combined scope keys on the MAIN store", () => {
  expect(lockedVaultHint(st({ scope: "combined", personalConfigured: true, personalUnlocked: false }))).toContain('scope="personal"');
});

test("CUI scope: hint only when the isolated CUI store is configured + locked", () => {
  expect(lockedVaultHint(st({ scope: "cui", cuiConfigured: true, cuiUnlocked: false }))).toContain('scope="CUI"');
  expect(lockedVaultHint(st({ scope: "cui", cuiConfigured: true, cuiUnlocked: true }))).toBe(""); // unlocked
  expect(lockedVaultHint(st({ scope: "cui", cuiConfigured: false }))).toBe(""); // never set up
});

test("compartment isolation: a view never surfaces the OTHER compartment's lock", () => {
  // cui view never leaks that the MAIN store exists/locked...
  expect(lockedVaultHint(st({ scope: "cui", personalConfigured: true, personalUnlocked: false, cuiConfigured: false }))).toBe("");
  // ...and a personal view never surfaces a locked CUI store (CUI hard isolation, ADR-0014).
  expect(lockedVaultHint(st({ scope: "personal", personalConfigured: true, personalUnlocked: true, cuiConfigured: true, cuiUnlocked: false }))).toBe("");
});
