// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-VAULT-KEYS.1 (ADR-0472): the engine vault's sealing, master-key lifecycle and fail-closed rules.
// Logic tests inject an in-memory OsKeyStore through _setVaultBackendForTest; the race test uses two
// real processes with a file-backed fake; the DPAPI test runs the real bun:ffi backend on Windows only.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  _setVaultBackendForTest, dpapi, openSealed, readVault, sealSecrets, SECRETS_FILE, updateVault, vaultStatus, withFileLock,
  type MasterMiss, type OsKeyStore,
} from "./engine_vault.ts";

const dirs: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "lucid-vault-"));
  dirs.push(d);
  return join(d, "lucid-engine-vault");
}
afterEach(() => _setVaultBackendForTest(null));
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const quiet = <T>(fn: () => T): T => {
  const orig = console.error; console.error = () => {};
  try { return fn(); } finally { console.error = orig; }
};

interface FakeStore extends OsKeyStore { creates: number }
/** An in-memory OS key store: `key` = an existing master record, `fail` = a record that cannot be read. */
function fakeStore(key: Buffer | null = null, fail?: MasterMiss): FakeStore {
  let held = key ? Buffer.from(key) : null;
  const store: FakeStore = {
    kind: "dpapi",
    creates: 0,
    read: () => fail ?? (held ? Buffer.from(held) : { missing: "absent" }),
    create: (k) => { held = Buffer.from(k); store.creates++; return true; },
  };
  return store;
}
const useStore = (store: OsKeyStore | null): void => _setVaultBackendForTest(() => store);
/** Set refs (and delete refs) through the real locked delta write. */
const put = (dir: string, set: Record<string, string>, del: string[] = []) => updateVault(dir, { set, del });
const MAP = { "key:OPENAI_API_KEY": "sk-test-ROUNDTRIP-1234", "mcp:docs": "tok-ROUNDTRIP-5678" };

describe("sealing", () => {
  test("seal/open round trip; the record carries the key id and no plaintext", () => {
    const key = randomBytes(32);
    const sealed = sealSecrets(key, MAP);
    expect(sealed).toMatchObject({ v: 1, alg: "A256GCM" });
    expect(sealed.kid).toBe(createHash("sha256").update(key).digest("hex").slice(0, 16));
    expect(JSON.stringify(sealed)).not.toContain("ROUNDTRIP");
    expect(openSealed(key, sealed)).toEqual(MAP);
  });

  test("a wrong key is named by its key id before any decrypt", () => {
    expect(() => openSealed(randomBytes(32), sealSecrets(randomBytes(32), MAP))).toThrow(/different master key/);
  });
});

describe("vault files", () => {
  test("the first write creates one master key and a v2 file; later writes are deltas", () => {
    const dir = scratch();
    const store = fakeStore();
    useStore(store);
    expect(vaultStatus(dir)).toEqual({ custody: "dpapi", state: "ok" });
    expect(readVault(dir)).toEqual({ exists: false, secrets: {}, entries: {} });
    put(dir, MAP);
    expect(store.creates).toBe(1);
    const raw = JSON.parse(readFileSync(join(dir, SECRETS_FILE), "utf8"));
    expect(Object.keys(raw).sort()).toEqual(["alg", "ct", "iv", "kid", "tag", "v"]);
    expect(raw.v).toBe(2); // P-VAULT-V2.1 (ADR-0474): the engine writes only v2
    expect(readVault(dir)).toMatchObject({ exists: true, secrets: MAP, version: 2 });
    put(dir, { "key:A": "1" }); // refs the delta does not name are kept
    expect(store.creates).toBe(1);
    expect(readVault(dir).secrets).toEqual({ ...MAP, "key:A": "1" });
    put(dir, {}, Object.keys(MAP));
    expect(readVault(dir).secrets).toEqual({ "key:A": "1" });
    expect(existsSync(join(dir, "secrets.lock"))).toBe(false);
  });

  test("wrong master key (kid mismatch): unreadable, and the file is untouched", () => {
    const dir = scratch();
    useStore(fakeStore(randomBytes(32)));
    put(dir, MAP);
    const before = readFileSync(join(dir, SECRETS_FILE));
    useStore(fakeStore(randomBytes(32)));
    const r = readVault(dir);
    expect(r.exists).toBe(true);
    expect(r.secrets).toEqual({});
    expect(r.problem).toContain("different master key");
    expect(vaultStatus(dir).state).toBe("unreadable");
    expect(readFileSync(join(dir, SECRETS_FILE)).equals(before)).toBe(true);
  });

  test("tampered ciphertext: unreadable, and the file is untouched", () => {
    const dir = scratch();
    const store = fakeStore(randomBytes(32));
    useStore(store);
    put(dir, MAP);
    const file = join(dir, SECRETS_FILE);
    const raw = JSON.parse(readFileSync(file, "utf8"));
    const ct = Buffer.from(raw.ct, "base64");
    ct[0] = ct[0]! ^ 0xff;
    raw.ct = ct.toString("base64");
    writeFileSync(file, JSON.stringify(raw, null, 2));
    const tampered = readFileSync(file);
    useStore(store); // drop the read memo
    expect(readVault(dir).problem).toContain("authentication failed");
    expect(vaultStatus(dir).state).toBe("unreadable");
    expect(readFileSync(file).equals(tampered)).toBe(true);
  });

  test("a master record that exists but cannot be read is never replaced", () => {
    const dir = scratch();
    useStore(fakeStore(randomBytes(32)));
    put(dir, MAP);
    const before = readFileSync(join(dir, SECRETS_FILE));
    const locked = fakeStore(null, { missing: "unreadable", detail: "keychain locked" });
    useStore(locked);
    expect(vaultStatus(dir)).toMatchObject({ custody: "dpapi", state: "unreadable" });
    expect(() => put(dir, { "key:B": "2" })).toThrow(/unreadable/);
    expect(locked.creates).toBe(0);
    expect(readFileSync(join(dir, SECRETS_FILE)).equals(before)).toBe(true);
    // Without a secrets file nothing is lost: the same backend reports plain unavailability.
    expect(vaultStatus(scratch())).toMatchObject({ custody: "plaintext-file", state: "unavailable" });
  });

  test("an unreadable file is set aside, never overwritten, when a new map is written", () => {
    const dir = scratch();
    useStore(fakeStore(randomBytes(32)));
    put(dir, MAP);
    const before = readFileSync(join(dir, SECRETS_FILE));
    useStore(fakeStore(randomBytes(32)));
    quiet(() => put(dir, { "key:NEW": "n" }));
    const aside = readdirSync(dir).filter((f) => f.startsWith(`${SECRETS_FILE}.unreadable-`));
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(dir, aside[0]!)).equals(before)).toBe(true);
    expect(readVault(dir).secrets).toEqual({ "key:NEW": "n" });
  });

  test("no OS backend: unavailable, plaintext-file custody, and nothing is created", () => {
    const dir = scratch();
    useStore(null);
    expect(vaultStatus(dir)).toMatchObject({ custody: "plaintext-file", state: "unavailable" });
    expect(() => put(dir, MAP)).toThrow(/no OS vault backend/);
    expect(existsSync(dir)).toBe(false);
  });
});

describe("owner-token lock", () => {
  const lockIn = (): string => { const d = scratch(); mkdirSync(d, { recursive: true }); return join(d, "secrets.lock"); };
  const OLD = Date.now() - 120_000; // well past the 60 s stale age

  test("a lock held by a LIVE process is never stolen, however old; the waiter gives up with an error", () => {
    const lock = lockIn();
    const held = JSON.stringify({ pid: process.pid, token: "someone-else", ts: OLD });
    writeFileSync(lock, held);
    let ran = false;
    expect(() => withFileLock(lock, () => { ran = true; }, { timeoutMs: 150 })).toThrow(/is held by pid/);
    expect(ran).toBe(false);
    expect(readFileSync(lock, "utf8")).toBe(held);
  });

  test("a stale lock whose owner is dead is taken over, and released afterwards", async () => {
    const lock = lockIn();
    const child = Bun.spawn([process.execPath, "-e", "0"], { stdout: "ignore", stderr: "ignore" });
    await child.exited;
    writeFileSync(lock, JSON.stringify({ pid: child.pid, token: "dead-owner", ts: OLD }));
    let sawOurs = "";
    expect(withFileLock(lock, () => { sawOurs = readFileSync(lock, "utf8"); return 7; }, { timeoutMs: 2_000 })).toBe(7);
    expect(JSON.parse(sawOurs).pid).toBe(process.pid);
    expect(existsSync(lock)).toBe(false);
  });

  test("a FRESH lock of a dead owner is still waited for (stale needs age AND a dead pid)", async () => {
    const lock = lockIn();
    const child = Bun.spawn([process.execPath, "-e", "0"], { stdout: "ignore", stderr: "ignore" });
    await child.exited;
    writeFileSync(lock, JSON.stringify({ pid: child.pid, token: "just-died", ts: Date.now() }));
    expect(() => withFileLock(lock, () => 1, { timeoutMs: 150 })).toThrow(/is held by/);
    expect(existsSync(lock)).toBe(true);
  });

  test("release never deletes a lock that no longer carries our token", () => {
    const lock = lockIn();
    const theirs = JSON.stringify({ pid: process.pid, token: "taken-over-by-another", ts: Date.now() });
    withFileLock(lock, () => { writeFileSync(lock, theirs); });
    expect(readFileSync(lock, "utf8")).toBe(theirs);
  });
});

describe("master key creation race", () => {
  test("two processes creating the master key at once agree on one key, created once", async () => {
    const dir = scratch();
    const mod = pathToFileURL(join(import.meta.dir, "engine_vault.ts")).href;
    // A file-backed fake store whose create() is slow, so both racers are inside ensureMasterKey together.
    const code = `
      import { ensureMasterKey } from ${JSON.stringify(mod)};
      import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
      import { createHash } from "node:crypto";
      import { join } from "node:path";
      const dir = process.env.RACE_DIR;
      const p = join(dir, "fake-master.bin");
      let creates = 0;
      const store = {
        kind: "dpapi",
        read: () => existsSync(p) ? readFileSync(p) : { missing: "absent" },
        create: (k) => { creates++; Bun.sleepSync(300); const t = p + "." + process.pid; writeFileSync(t, k); renameSync(t, p); return true; },
      };
      mkdirSync(dir, { recursive: true });
      while (Date.now() < Number(process.env.RACE_AT)) Bun.sleepSync(1);
      const key = ensureMasterKey(store, dir);
      console.log(JSON.stringify({ kid: Buffer.isBuffer(key) ? createHash("sha256").update(key).digest("hex") : key, creates }));
    `;
    const env = { ...process.env, RACE_DIR: dir, RACE_AT: String(Date.now() + 1500) };
    const procs = [0, 1].map(() => Bun.spawn([process.execPath, "-e", code], { env, stdout: "pipe", stderr: "pipe" }));
    const outs = await Promise.all(procs.map(async (p) => {
      const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
      await p.exited;
      if (!out.trim()) throw new Error(`racer printed nothing: ${err.slice(0, 400)}`);
      return JSON.parse(out.trim()) as { kid: unknown; creates: number };
    }));
    expect(typeof outs[0]!.kid).toBe("string");
    expect(outs[0]!.kid).toBe(outs[1]!.kid);
    expect(outs[0]!.creates + outs[1]!.creates).toBe(1);
    expect(existsSync(join(dir, "master.lock"))).toBe(false);
  }, 30_000);
});

describe("real OS backend", () => {
  test.skipIf(process.platform !== "win32")("DPAPI protects and unprotects through bun:ffi", () => {
    const api = dpapi();
    expect(api).not.toBeNull();
    const secret = randomBytes(32);
    const blob = api!.protect(secret);
    expect(blob).not.toBeNull();
    expect(blob!.length).toBeGreaterThan(secret.length);
    expect(blob!.includes(secret)).toBe(false);
    expect(api!.unprotect(blob!)!.equals(secret)).toBe(true);
    const bad = Buffer.from(blob!);
    bad[bad.length - 1] = bad[bad.length - 1]! ^ 0xff;
    expect(api!.unprotect(bad)).toBeNull();
  });

  test.skipIf(process.platform !== "win32")("the DPAPI-backed vault round-trips and keeps only ciphertext on disk", () => {
    const dir = scratch();
    put(dir, MAP);
    expect(existsSync(join(dir, "master.dpapi"))).toBe(true);
    expect(readVault(dir).secrets).toEqual(MAP);
    expect(vaultStatus(dir)).toEqual({ custody: "dpapi", state: "ok" });
    for (const f of readdirSync(dir)) expect(readFileSync(join(dir, f), "utf8")).not.toContain("ROUNDTRIP");
  });
});
