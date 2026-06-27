// desktop/vault_hint.ts — P-VAULT-HINT.1 (ADR-0077): the content-free "a locked vault exists" hint.
//
// When the user's encrypted memory vault is CONFIGURED but LOCKED, recallPreamble() used to inject
// nothing, so the agent had no idea anything existed and silently answered from empty. This builds a
// first-party hint (NOT untrusted-delimited) that tells the model a locked vault EXISTS — so it can offer
// to unlock — while NEVER exposing any decrypted content.
//
// Why no count: the fact count lives inside the AES-GCM blob; reading it would require decrypting, which
// a locked vault must not do (keystone #3, fail-closed). ADR-0077 says: degrade to the boolean form
// rather than unlock to count. A future slice could surface a count from a non-secret manifest.

export type VaultScope = "work" | "personal" | "cui" | "combined";

export interface VaultLockState {
  scope: VaultScope;
  personalConfigured: boolean; // the main store file exists on disk (no decrypt needed to know this)
  personalUnlocked: boolean;
  cuiConfigured: boolean;
  cuiUnlocked: boolean;
  // P-VAULT-HINT.2 (ADR-0080): a fact count KNOWN from this session's lock (captured in memory when the
  // user locked the vault — never read from disk, never a decrypt). Omit/0 → the boolean form.
  count?: number;
}

/** The hint for a CONFIGURED-but-LOCKED vault in the current scope, or "" when nothing is locked
 *  (unlocked, or never set up). The string carries NO decrypted content — only that a vault exists. */
export function lockedVaultHint(s: VaultLockState): string {
  // CUI is its own isolated store; for any non-cui scope the relevant lock is the main store.
  const cuiLocked = s.scope === "cui" && s.cuiConfigured && !s.cuiUnlocked;
  const mainLocked = s.scope !== "cui" && s.personalConfigured && !s.personalUnlocked;
  if (!cuiLocked && !mainLocked) return "";
  const which = cuiLocked ? "CUI" : "personal";
  // The count is OPTIONAL metadata (known only from this session's lock). It's still not content — just
  // "how many", which makes the offer-to-unlock more concrete. Omitted → the boolean form.
  const hasCount = typeof s.count === "number" && s.count > 0;
  const countAttr = hasCount ? ` facts="${s.count}"` : "";
  const countPhrase = hasCount ? ` (about ${s.count} stored fact${s.count === 1 ? "" : "s"})` : "";
  return (
    `<encrypted-vault locked="true" scope="${which}"${countAttr}>\n` +
    `The user has a LOCKED, encrypted ${which} memory vault${countPhrase}. Its contents are unreadable this ` +
    `turn by design. If the answer would clearly benefit from the user's saved preferences, decisions, or ` +
    `context, briefly ASK them to unlock it (open the Knowledge panel and enter the passphrase) — never ` +
    `guess or fabricate what it might contain.\n` +
    `</encrypted-vault>`
  );
}
