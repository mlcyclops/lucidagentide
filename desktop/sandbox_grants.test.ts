// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/sandbox_grants.test.ts — P-SANDBOX.8: the user-approved directory-grant store.
//
// Covers the PURE updaters (the correctness of the approval handshake lives here: consumePending's
// one-shot + fail-closed matching is what stops a forged/replayed POST from applying an ACE) and the
// on-disk round-trip under the LUCID_SANDBOX_GRANTS_FILE env seam. The helper edge (applyGrantAce /
// revokeGrantAce) is Windows-FFI and verified live (see the P-SANDBOX.8 acceptance run).

import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addGrant, consumePending, loadGrants, normalizeGrantPath, PENDING_MAX_AGE_MS, removeGrant,
  sandboxGrantsView, saveGrants, setPending, type SandboxGrantsStore,
} from "./sandbox_grants.ts";

const grant = (path: string, mode: "rx" | "rw" = "rx") => ({ path, mode, grantedAt: "2026-01-01T00:00:00.000Z", reason: "test" });
const empty: SandboxGrantsStore = { grants: [] };

// ── pure updaters ─────────────────────────────────────────────────────────────
test("addGrant unshifts (newest first) and never mutates the input store", () => {
  const s1 = addGrant(empty, grant("C:\\data"));
  const s2 = addGrant(s1, grant("C:\\other", "rw"));
  expect(empty.grants).toHaveLength(0);
  expect(s2.grants.map((g) => g.path)).toEqual(["C:\\other", "C:\\data"]);
});

test("re-granting the same dir (case/separator/trailing-slash variants) replaces the old row", () => {
  const s1 = addGrant(empty, grant("C:\\Data", "rx"));
  const s2 = addGrant(s1, grant("c:/data/", "rw"));
  expect(s2.grants).toHaveLength(1);
  expect(s2.grants[0]!.mode).toBe("rw");
});

test("removeGrant drops by normalized path and leaves others alone", () => {
  const s = addGrant(addGrant(empty, grant("C:\\a")), grant("C:\\b"));
  const out = removeGrant(s, "c:/A/");
  expect(out.grants.map((g) => g.path)).toEqual(["C:\\b"]);
});

test("normalizeGrantPath folds separators, trailing slashes, and case", () => {
  expect(normalizeGrantPath("C:/Data\\Sub/")).toBe("c:\\data\\sub");
});

// ── the one-shot approval handshake ───────────────────────────────────────────
const now = Date.parse("2026-01-01T12:00:00.000Z");
const pendingAt = new Date(now - 1_000).toISOString();

test("consumePending: a fresh exact {path,mode} match claims the slot exactly once", () => {
  const s = setPending(addGrant(empty, grant("C:\\keep")), { path: "C:\\data", mode: "rx", reason: "r", at: pendingAt });
  const first = consumePending(s, "c:/data", "rx", now);
  expect(first.ok).toBe(true);
  expect(first.store.pending).toBeUndefined();
  expect(first.store.grants).toHaveLength(1); // grants untouched by the claim
  const second = consumePending(first.store, "c:/data", "rx", now);
  expect(second.ok).toBe(false); // one-shot: already consumed
});

test("consumePending: a mismatched path or mode fails AND still burns the slot (fail-closed)", () => {
  for (const [path, mode] of [["C:\\elsewhere", "rx"], ["C:\\data", "rw"]] as const) {
    const s = setPending(empty, { path: "C:\\data", mode: "rx", reason: "r", at: pendingAt });
    const r = consumePending(s, path, mode, now);
    expect(r.ok).toBe(false);
    expect(r.store.pending).toBeUndefined(); // a probe must not leave a claimable approval behind
  }
});

test("consumePending: an expired (or future-dated) approval no longer matches", () => {
  const stale = setPending(empty, { path: "C:\\data", mode: "rx", reason: "r", at: new Date(now - PENDING_MAX_AGE_MS - 1).toISOString() });
  expect(consumePending(stale, "C:\\data", "rx", now).ok).toBe(false);
  const future = setPending(empty, { path: "C:\\data", mode: "rx", reason: "r", at: new Date(now + 60_000).toISOString() });
  expect(consumePending(future, "C:\\data", "rx", now).ok).toBe(false);
});

// ── persistence round-trip (the env seam the endpoint + dialog share) ─────────
let tmp: string | null = null;
afterEach(() => {
  delete process.env.LUCID_SANDBOX_GRANTS_FILE;
  if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

test("save/load round-trip under LUCID_SANDBOX_GRANTS_FILE; a missing file is an empty store", () => {
  tmp = mkdtempSync(join(tmpdir(), "lucid-grants-"));
  process.env.LUCID_SANDBOX_GRANTS_FILE = join(tmp, "nested", "grants.json"); // save creates the dir
  expect(loadGrants()).toEqual({ grants: [] });
  const s = setPending(addGrant({ grants: [] }, grant("C:\\data", "rw")), { path: "C:\\next", mode: "rx", reason: "r", at: pendingAt });
  saveGrants(s);
  const back = loadGrants();
  expect(back.grants).toEqual(s.grants);
  expect(back.pending).toEqual(s.pending);
  expect(sandboxGrantsView()).toEqual(s.grants);
});

test("loadGrants tolerates a corrupt file (empty store, never a throw)", async () => {
  tmp = mkdtempSync(join(tmpdir(), "lucid-grants-"));
  const file = join(tmp, "grants.json");
  process.env.LUCID_SANDBOX_GRANTS_FILE = file;
  await Bun.write(file, "not json {");
  expect(loadGrants()).toEqual({ grants: [] });
});
