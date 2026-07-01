// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_keys_2.ts — P-KEYS.2 (ADR-0107): credential ROTATION - visibility (age / due /
// expiry, all non-secret) + manual rotate-in-place. Hermetic: drives the REAL cred_vault code with a fake
// safeStorage + in-memory IO; touches no user files.
//
// Proves:
//   (1) rotationStatus/rotationLabel derive the non-secret posture (age, "rotation due", "expired") from the
//       timestamps alone - worst state wins;
//   (2) rotateCredential replaces the secret IN PLACE: same ref (so a whitelist entry never breaks), bumped
//       rotatedAt, refreshed last-4, decrypts to the NEW secret, old ciphertext overwritten;
//   (3) FAIL-CLOSED: rotating with OS encryption unavailable throws and leaves the OLD secret intact.

import { rotateCredential, rotationLabel, rotationStatus, storeCredential, readCredential, type SafeStorageLike, type VaultIo } from "../cred_vault.ts";

const fail = (msg: string): never => { console.error(`FAIL: ${msg}`); process.exit(1); };
const ok = (msg: string): void => console.log(`   ${msg} ✓`);
const DAY = 86_400_000;

// fake OS keystore (base64 - opaque, reversible) + in-memory IO.
const safe = (available = true): SafeStorageLike => ({
  isEncryptionAvailable: () => available,
  encryptString: (s) => Buffer.from("v1:" + Buffer.from(s, "utf8").toString("base64"), "utf8"),
  decryptString: (b) => Buffer.from(b.toString("utf8").replace(/^v1:/, ""), "base64").toString("utf8"),
});
const files = new Map<string, Buffer>();
const io: VaultIo = {
  ensureDir: () => {}, writeFile: (p, d) => { files.set(p, Buffer.from(d)); },
  readFile: (p) => { const b = files.get(p); if (!b) throw new Error("ENOENT"); return b; },
  exists: (p) => files.has(p), remove: (p) => { files.delete(p); },
  list: (dir) => [...files.keys()].filter((k) => k.startsWith(dir + "/")).map((k) => k.slice(dir.length + 1)),
};
const DIR = "/vault";

console.log("== P-KEYS.2 — credential rotation visibility + manual rotate-in-place ==");

console.log("\n1) rotation VISIBILITY is derived from non-secret timestamps (worst state wins)");
const now = 100 * DAY;
if (!rotationStatus({ rotatedAt: 60 * DAY, rotationIntervalDays: 30 }, now).overdue) fail("40d-old key on a 30d policy should be overdue");
if (rotationLabel(rotationStatus({ rotatedAt: 60 * DAY, rotationIntervalDays: 30 }, now)).text !== "rotation due") fail("overdue → 'rotation due'");
if (rotationLabel(rotationStatus({ rotatedAt: 99 * DAY, expiresAt: 90 * DAY }, now)).text !== "expired") fail("past expiry → 'expired' (beats age)");
if (rotationLabel(rotationStatus({ rotatedAt: 95 * DAY, rotationIntervalDays: 30 }, now)).text !== "rotated 5d ago") fail("fresh key → 'rotated Nd ago'");
ok("overdue → 'rotation due'; expired → 'expired'; fresh → 'rotated 5d ago' (all non-secret)");

console.log("\n2) rotateCredential replaces the secret IN PLACE (same ref, bumped rotatedAt, refreshed last-4)");
storeCredential(safe(true), io, DIR, { ref: "gw", kind: "jwt", secret: "OLD.tokenAAAA", label: "prod-gateway", createdAt: 1000, rotationIntervalDays: 30 });
const m = rotateCredential(safe(true), io, DIR, { ref: "gw", secret: "NEW.tokenBBBB", rotatedAt: 5000 });
if (!m) fail("rotate should return updated metadata");
if (m!.ref !== "gw") fail("ref must be preserved so the whitelist entry keeps working");
if (m!.createdAt !== 1000 || m!.label !== "prod-gateway" || m!.rotationIntervalDays !== 30) fail("createdAt/label/interval must be preserved");
if (m!.rotatedAt !== 5000) fail("rotatedAt must bump");
if (m!.last4 !== "BBBB") fail("last-4 must refresh to the new secret's tail");
if (readCredential(safe(true), io, DIR, "gw") !== "NEW.tokenBBBB") fail("must decrypt to the NEW secret");
if (files.get("/vault/gw.bin")!.toString("utf8").includes("OLD.token")) fail("the old ciphertext must be overwritten");
ok("same ref, createdAt/label/interval kept, rotatedAt bumped, last-4 → BBBB, decrypts to the new secret");

console.log("\n3) FAIL-CLOSED: rotating with OS encryption unavailable throws + leaves the OLD secret intact");
let threw = false;
try { rotateCredential(safe(false), io, DIR, { ref: "gw", secret: "WOULD.overwrite", rotatedAt: 9000 }); } catch { threw = true; }
if (!threw) fail("rotate must throw when OS encryption is unavailable");
if (readCredential(safe(true), io, DIR, "gw") !== "NEW.tokenBBBB") fail("the previous secret must be left intact (no plaintext, no clobber)");
ok("encryption unavailable → throws, previous secret untouched (no plaintext fallback)");

console.log("\nPASS — rotation posture is visible from non-secret metadata, and manual rotation is in-place + fail-closed.");
