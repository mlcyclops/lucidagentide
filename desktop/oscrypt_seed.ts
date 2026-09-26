// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/oscrypt_seed.ts - converge Electron safeStorage's os_crypt key across port-keyed instances.
//
// THE BUG THIS KILLS (Windows): Electron `safeStorage` is Chromium os_crypt - the AES-256-GCM key that
// encrypts every vault credential lives in `<userData>/Local State` (DPAPI-wrapped, per PROFILE DIR,
// not per user). main.ts suffixes userData per port (`...-<PORT>`) so a dev build can run beside the
// installed app, which silently gives EVERY port-instance its OWN encryption key, while the credential
// vault (~/.omp/lucid-cred-vault) is global. A key stored by the instance on port A is undecryptable by
// the instance on port B: readCredential fails closed, the Local Provider is skipped at engine spawn,
// and the model never reaches the picker - with the UI still showing "key in vault" (listing reads only
// metadata, never decrypts).
//
// THE FIX: before Chromium initializes (module load, pre-ready), a port-suffixed instance SEEDS its
// `Local State` os_crypt key from the canonical (unsuffixed) userData dir, so every instance encrypts
// and decrypts with the SAME key. If the canonical dir has no key yet (a machine that only ever ran
// port-suffixed dev builds), the instance BACKFILLS its freshly-minted key into the canonical file
// post-ready, so all later instances converge on it.
//
// macOS (Keychain, service = app name) and Linux (libsecret, app-name-keyed) already share the key
// across instances; the gating in main.ts applies this on win32 only.
//
// PURE: JSON-text in, JSON-text out; all IO stays in main.ts. Mirrors mergeModelsYaml's posture: a
// non-empty file that does not parse is NEVER overwritten (changed:false + reason), so a corrupt or
// foreign Local State is left for Chromium to deal with rather than destroyed.

export interface SeedResult {
  changed: boolean;
  content?: string; // the full Local State JSON to write, when changed
  reason?: string;  // why nothing was written, when not
}

/** Parse a Local State text into a plain JSON object. Null when empty, unparseable, or not an object. */
function parseLocalState(text: string): Record<string, unknown> | null {
  const t = (text ?? "").trim();
  if (!t) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(t); } catch { return null; }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  return { ...parsed };
}

/** The os_crypt section of a parsed Local State, or {} when absent/malformed. Sibling fields beside
 *  encrypted_key (e.g. audit_enabled) ride along untouched. */
function osCryptSection(state: Record<string, unknown>): Record<string, unknown> {
  const s = state.os_crypt;
  return typeof s === "object" && s !== null && !Array.isArray(s) ? { ...s } : {};
}

/** Extract the os_crypt encrypted_key from a Local State JSON text. Null when absent/unparseable. */
export function extractOsCryptKey(text: string): string | null {
  const state = parseLocalState(text);
  if (!state) return null;
  const k = osCryptSection(state).encrypted_key;
  return typeof k === "string" && k.length > 0 ? k : null;
}

/** Set `os_crypt.encrypted_key` in a Local State text, preserving everything else. An empty/absent file
 *  becomes a minimal valid Local State; a non-empty unparseable file is refused (never destroyed). */
function withOsCryptKey(text: string, encryptedKey: string): SeedResult {
  const t = (text ?? "").trim();
  const base = t ? parseLocalState(t) : {};
  if (!base) return { changed: false, reason: "existing Local State is not a parseable JSON object; refusing to overwrite" };
  const osCrypt = osCryptSection(base);
  if (osCrypt.encrypted_key === encryptedKey) return { changed: false, reason: "key already matches" };
  osCrypt.encrypted_key = encryptedKey;
  return { changed: true, content: JSON.stringify({ ...base, os_crypt: osCrypt }) };
}

/** Pre-ready (module load, before Chromium reads Local State): make a port-suffixed instance use the
 *  CANONICAL install's encryption key. No-op when the canonical dir has no key yet, or the instance
 *  already matches. An instance's divergent pre-fix key is deliberately REPLACED - convergence is the
 *  point; anything it encrypted was already unreadable everywhere else. */
export function seedInstanceFromCanonical(canonicalText: string, instanceText: string): SeedResult {
  const key = extractOsCryptKey(canonicalText);
  if (!key) return { changed: false, reason: "canonical Local State has no os_crypt key yet" };
  return withOsCryptKey(instanceText, key);
}

/** Post-ready (after Chromium minted this instance's key): if the canonical dir has NO key, adopt this
 *  instance's key as the canonical one, so every later instance (and the packaged app's first run)
 *  converges on it. Never touches a canonical file that already holds a key. */
export function backfillCanonicalFromInstance(canonicalText: string, instanceText: string): SeedResult {
  if (extractOsCryptKey(canonicalText)) return { changed: false, reason: "canonical already has a key" };
  const key = extractOsCryptKey(instanceText);
  if (!key) return { changed: false, reason: "instance has no os_crypt key to backfill" };
  return withOsCryptKey(canonicalText, key);
}
