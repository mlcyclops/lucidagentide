// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-TUI.0 (ADR-0415): the engine discovery seam. What must stay true forever:
// a written file round-trips 0600; anything off-shape reads as null (never a guess);
// listing surfaces only parseable files, newest launch first; and verification is
// fail-closed - only a live engine echoing THIS file's nonce counts as ours.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoveryDir, discoveryPath, listDiscoveries, parseDiscovery,
  readDiscovery, removeDiscovery, verifyDiscovery, writeDiscovery,
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

  test("the dir is userData when Electron launched us, else ~/.omp", () => {
    expect(discoveryDir({ LUCID_DATA_ROOT: "/tmp/ud" })).toBe("/tmp/ud");
    expect(discoveryDir({})).toContain(".omp");
  });
});
