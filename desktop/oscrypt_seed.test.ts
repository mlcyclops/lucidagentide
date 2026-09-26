// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// oscrypt_seed.test.ts - the safeStorage key-convergence rules (oscrypt_seed.ts).
//
// The load-bearing property: a port-suffixed instance ends up ENCRYPTING AND DECRYPTING WITH THE
// CANONICAL install's os_crypt key, so a vault credential stored by any instance is readable by every
// other. The regression this pins: "Restart to apply" relaunched onto a fresh port, the new instance
// minted its own key, readCredential failed closed, and the Local Provider silently vanished from the
// model picker while the UI still said "key in vault".

import { describe, expect, test } from "bun:test";
import { backfillCanonicalFromInstance, extractOsCryptKey, seedInstanceFromCanonical } from "./oscrypt_seed.ts";

const KEY_A = "RFBBUEkA_canonical_key";
const KEY_B = "RFBBUEkA_divergent_key";
const state = (key?: string, extra?: Record<string, unknown>): string =>
  JSON.stringify({ ...(extra ?? {}), ...(key ? { os_crypt: { encrypted_key: key, audit_enabled: true } } : {}) });

describe("extractOsCryptKey", () => {
  test("reads the key; null for empty, unparseable, keyless, or non-string keys", () => {
    expect(extractOsCryptKey(state(KEY_A))).toBe(KEY_A);
    expect(extractOsCryptKey("")).toBeNull();
    expect(extractOsCryptKey("not json {")).toBeNull();
    expect(extractOsCryptKey(state(undefined))).toBeNull();
    expect(extractOsCryptKey(JSON.stringify({ os_crypt: { encrypted_key: 42 } }))).toBeNull();
    expect(extractOsCryptKey(JSON.stringify([1, 2]))).toBeNull();
  });
});

describe("seedInstanceFromCanonical", () => {
  test("fresh instance (no Local State) adopts the canonical key as a minimal valid file", () => {
    const r = seedInstanceFromCanonical(state(KEY_A), "");
    expect(r.changed).toBe(true);
    expect(extractOsCryptKey(r.content!)).toBe(KEY_A);
  });
  test("a divergent pre-fix instance key is REPLACED (convergence is the point)", () => {
    const r = seedInstanceFromCanonical(state(KEY_A), state(KEY_B));
    expect(r.changed).toBe(true);
    expect(extractOsCryptKey(r.content!)).toBe(KEY_A);
  });
  test("preserves unrelated Local State fields and os_crypt siblings on merge", () => {
    const r = seedInstanceFromCanonical(state(KEY_A), state(KEY_B, { browser: { theme: "dark" } }));
    const parsed = JSON.parse(r.content!);
    expect(parsed.browser).toEqual({ theme: "dark" });
    expect(parsed.os_crypt.audit_enabled).toBe(true);
  });
  test("no-op when the instance already matches", () => {
    expect(seedInstanceFromCanonical(state(KEY_A), state(KEY_A)).changed).toBe(false);
  });
  test("no-op when the canonical side has no key yet (backfill handles that direction)", () => {
    expect(seedInstanceFromCanonical("", state(KEY_B)).changed).toBe(false);
    expect(seedInstanceFromCanonical(state(undefined), "").changed).toBe(false);
  });
  test("REFUSES to overwrite a non-empty unparseable instance file (never destroys user data)", () => {
    const r = seedInstanceFromCanonical(state(KEY_A), "corrupt{{{");
    expect(r.changed).toBe(false);
    expect(r.reason).toContain("refusing to overwrite");
  });
});

describe("backfillCanonicalFromInstance", () => {
  test("an absent canonical file adopts the instance's freshly-minted key", () => {
    const r = backfillCanonicalFromInstance("", state(KEY_B));
    expect(r.changed).toBe(true);
    expect(extractOsCryptKey(r.content!)).toBe(KEY_B);
  });
  test("NEVER touches a canonical file that already holds a key", () => {
    expect(backfillCanonicalFromInstance(state(KEY_A), state(KEY_B)).changed).toBe(false);
  });
  test("no-op when the instance has nothing to offer", () => {
    expect(backfillCanonicalFromInstance("", "").changed).toBe(false);
  });
});

describe("round trip (the incident, replayed)", () => {
  test("store on port A, relaunch onto port B: B seeds from canonical and shares A's key", () => {
    // Machine with a canonical install. Port-A instance seeds from canonical, stores a credential.
    const portA = seedInstanceFromCanonical(state(KEY_A), "");
    // Relaunch rolls port B; B seeds from the same canonical file.
    const portB = seedInstanceFromCanonical(state(KEY_A), "");
    expect(extractOsCryptKey(portA.content!)).toBe(extractOsCryptKey(portB.content!));
  });
});
