// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-TUI.0 (ADR-0419): the engine discovery seam. What must stay true forever:
// a written file round-trips 0600; anything off-shape reads as null (never a guess);
// listing surfaces only parseable files, newest launch first; and verification is
// fail-closed - only a live engine echoing THIS file's nonce counts as ours.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoveryDir, discoveryPath, listDiscoveries, listNonceRecords, nonceDir, noncePath, parseDiscovery,
  parseNonceRecord, pidAlive, pruneStaleDiscovery, readDiscovery, readNonceRecord, removeDiscovery,
  resolveNonceGroup, verifyDiscovery, writeDiscovery, writeNonceRecord,
} from "./engine_discovery.ts";
import type { EngineDiscovery } from "./engine_discovery.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lucid-disc-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function d(over: Partial<EngineDiscovery> = {}): EngineDiscovery {
  return {
    v: 1, pid: 4242, port: 5319, nonce: "nonce-a", token: "tok-a",
    version: "2.3.0", flavor: "agent", startedAt: "2026-09-28T10:00:00.000Z", ...over,
  };
}

describe("engine discovery (P-TUI.0)", () => {
  test("write round-trips, and the file is owner-only (0600)", () => {
    const p = discoveryPath(dir, 5319);
    writeDiscovery(p, d());
    expect(readDiscovery(p)).toEqual(d());
    if (process.platform !== "win32") expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  test("overwrite by a new launch leaves exactly the new content", () => {
    const p = discoveryPath(dir, 5319);
    writeDiscovery(p, d({ nonce: "old" }));
    writeDiscovery(p, d({ nonce: "new", pid: 4343 }));
    expect(readDiscovery(p)?.nonce).toBe("new");
  });

  test("off-shape content is null, never a guess", () => {
    expect(parseDiscovery("not json")).toBeNull();
    expect(parseDiscovery("[]")).toBeNull();
    expect(parseDiscovery("null")).toBeNull();
    expect(parseDiscovery(JSON.stringify({ ...d(), v: 2 }))).toBeNull();
    expect(parseDiscovery(JSON.stringify({ ...d(), port: "5319" }))).toBeNull();
    expect(parseDiscovery(JSON.stringify({ ...d(), port: 0 }))).toBeNull();
    expect(parseDiscovery(JSON.stringify({ ...d(), pid: 1.5 }))).toBeNull();
    expect(parseDiscovery(JSON.stringify({ ...d(), token: "" }))).toBeNull();
    expect(parseDiscovery(JSON.stringify({ ...d(), nonce: "  " }))).toBeNull();
    const { token: _token, ...missingToken } = d();
    expect(parseDiscovery(JSON.stringify(missingToken))).toBeNull();
    expect(readDiscovery(join(dir, "engine-discovery-9.json"))).toBeNull(); // absent file
  });

  test("listing surfaces parseable files newest first and ignores junk", () => {
    writeDiscovery(discoveryPath(dir, 5319), d({ port: 5319, startedAt: "2026-09-28T10:00:00.000Z" }));
    writeDiscovery(discoveryPath(dir, 5320), d({ port: 5320, flavor: "creator", startedAt: "2026-09-28T11:00:00.000Z" }));
    writeFileSync(join(dir, "engine-discovery-9999.json"), "torn{", { mode: 0o600 }); // torn file drops out
    writeFileSync(join(dir, "settings.json"), "{}", { mode: 0o600 }); // unrelated file never listed
    const got = listDiscoveries(dir);
    expect(got.map((e) => e.discovery.port)).toEqual([5320, 5319]);
    expect(listDiscoveries(join(dir, "no-such-dir"))).toEqual([]);
  });

  test("verification demands OUR nonce back: squatters, strangers and dead ports all fail", async () => {
    const ok = (body: unknown): typeof fetch =>
      (() => Promise.resolve(Response.json(body))) as unknown as typeof fetch;
    expect(await verifyDiscovery(d(), ok({ ok: true, nonce: "nonce-a" }))).toBe(true);
    expect(await verifyDiscovery(d(), ok({ ok: true, nonce: "impostor" }))).toBe(false);
    expect(await verifyDiscovery(d(), ok({ ok: true }))).toBe(false); // pre-ADR-0305 shape: foreign
    expect(await verifyDiscovery(d(), ok({ ok: true, nonce: null }))).toBe(false);
    const dead = (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch;
    expect(await verifyDiscovery(d(), dead)).toBe(false); // fail-closed: an error is "no engine"
    const teapot = (() => Promise.resolve(new Response("{}", { status: 503 }))) as unknown as typeof fetch;
    expect(await verifyDiscovery(d(), teapot)).toBe(false);
  });

  test("removal is idempotent and the engine's exit leaves nothing behind", () => {
    const p = discoveryPath(dir, 5319);
    writeDiscovery(p, d());
    removeDiscovery(p);
    expect(readDiscovery(p)).toBeNull();
    removeDiscovery(p); // second remove: no throw
  });

  test("a stale file goes only when its process is gone; a live pid (booting engine, reused pid) keeps it", () => {
    const p = discoveryPath(dir, 5319);
    writeDiscovery(p, d());
    expect(pruneStaleDiscovery(p, d(), () => true)).toBe(false);
    expect(readDiscovery(p)).not.toBeNull();
    expect(pruneStaleDiscovery(p, d(), () => false)).toBe(true);
    expect(readDiscovery(p)).toBeNull();
  });

  test("pidAlive: this process is alive; a pid no process holds is not", () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(2 ** 22 + 7)).toBe(false);
  });

  test("the dir is userData when Electron launched us, else ~/.omp", () => {
    expect(discoveryDir({ LUCID_DATA_ROOT: "/tmp/ud" })).toBe("/tmp/ud");
    expect(discoveryDir({})).toContain(".omp");
  });
});

// ADR-0498: the nonce-only record a controller client reads. It never carries the UI token, it is
// owner-only unless the operator names a group, and it proves the engine through the same handshake.
describe("nonce-only discovery record (ADR-0498)", () => {
  const { token: _token, ...launch } = d();
  const posix = process.platform !== "win32";

  test("the record carries no token even when handed the token-bearing shape, and is 0600 by default", () => {
    const p = noncePath(dir, 5319);
    writeNonceRecord(p, d(), null); // an EngineDiscovery passed in: only the nonce keys are serialized
    const raw = readFileSync(p, "utf8");
    expect(raw).not.toContain("tok-a");
    expect(Object.keys(JSON.parse(raw)).toSorted()).toEqual(["flavor", "nonce", "pid", "port", "startedAt", "v", "version"]);
    expect(readNonceRecord(p)).toEqual(launch);
    if (posix) expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  test.skipIf(!posix)("with a group the record is chowned to it and made 0640; the token file stays 0600", () => {
    const gid = process.getgid!();
    const nonceFile = noncePath(join(dir, "shared"), 5319);
    const tokenFile = discoveryPath(dir, 5319);
    writeDiscovery(tokenFile, d());
    writeNonceRecord(nonceFile, launch, gid);
    expect(statSync(nonceFile).mode & 0o777).toBe(0o640);
    expect(statSync(nonceFile).gid).toBe(gid);
    expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
    expect(readDiscovery(tokenFile)).toEqual(d()); // the UI token file is unchanged in shape and content
  });

  test.skipIf(!posix || process.getuid?.() === 0)("a group the OS refuses publishes nothing, not a wrongly shared record", () => {
    const p = noncePath(dir, 5319);
    expect(() => writeNonceRecord(p, launch, 0)).toThrow(); // root's group: an unprivileged owner cannot chgrp to it
    expect(existsSync(p)).toBe(false);
    expect(readdirSync(dir)).toEqual([]); // no tmp left behind either
  });

  test("the group resolves from a gid or a name; unset is owner-only; an unknown name refuses", () => {
    const groups = join(dir, "group");
    writeFileSync(groups, "root:x:0:\nlucid-discovery:x:998:lucid-spoke,lucid-spoke-agent\n");
    expect(resolveNonceGroup(undefined, groups)).toBeNull();
    expect(resolveNonceGroup("  ", groups)).toBeNull();
    expect(resolveNonceGroup("1234", groups)).toBe(1234);
    expect(resolveNonceGroup("lucid-discovery", groups)).toBe(998);
    expect(() => resolveNonceGroup("lucid-discover", groups)).toThrow(/not in/);
    expect(() => resolveNonceGroup("lucid-discovery", join(dir, "no-such-file"))).toThrow(/cannot read/);
  });

  test("a record with a token, an extra key or a missing key is off-shape; the two files never cross", () => {
    expect(parseNonceRecord(JSON.stringify(launch))).toEqual(launch);
    expect(parseNonceRecord(JSON.stringify(d()))).toBeNull(); // token-bearing: refused on this path
    expect(parseNonceRecord(JSON.stringify({ ...launch, extra: 1 }))).toBeNull();
    const { nonce: _nonce, ...noNonce } = launch;
    expect(parseNonceRecord(JSON.stringify(noNonce))).toBeNull();
    expect(parseNonceRecord(JSON.stringify({ ...launch, v: 2 }))).toBeNull();
    writeDiscovery(discoveryPath(dir, 5319), d());
    writeNonceRecord(noncePath(dir, 5320), { ...launch, port: 5320 }, null);
    writeFileSync(noncePath(dir, 5321), JSON.stringify(d({ port: 5321 })), { mode: 0o600 }); // a token under the nonce name
    expect(listNonceRecords(dir).map((e) => e.record.port)).toEqual([5320]);
    expect(listDiscoveries(dir).map((e) => e.discovery.port)).toEqual([5319]);
  });

  test("the record's dir is LUCID_DISCOVERY_NONCE_DIR when named, else beside the token file", () => {
    expect(nonceDir({ LUCID_DATA_ROOT: "/tmp/ud", LUCID_DISCOVERY_NONCE_DIR: "/run/lucid-discovery" })).toBe("/run/lucid-discovery");
    expect(nonceDir({ LUCID_DATA_ROOT: "/tmp/ud" })).toBe("/tmp/ud");
  });

  test("a controller client proves the engine from the record alone; a squatter on the port fails", async () => {
    const nonce = "launch-nonce-1";
    const engine = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ ok: true, nonce }) });
    try {
      writeNonceRecord(noncePath(dir, engine.port!), { ...launch, port: engine.port!, nonce }, null);
      const [found] = listNonceRecords(dir);
      expect(await verifyDiscovery(found!.record)).toBe(true);
    } finally {
      engine.stop(true);
    }
    const squatter = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ ok: true, nonce: "someone-else" }) });
    try {
      expect(await verifyDiscovery({ port: squatter.port!, nonce })).toBe(false);
    } finally {
      squatter.stop(true);
    }
  });
});
