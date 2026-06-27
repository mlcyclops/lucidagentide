// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Tests for GUI file-path containment (M2, ADR-0023): import sources and export
// destinations must resolve inside the user's home subtree. The containment check
// runs before the stateful (store-unlocked) guards, so these exercise it without
// creating a real encrypted store: an outside-home path is rejected with the
// "home folder" message; an inside-home path passes containment and falls through
// to the next guard (a different message), proving the boundary is scoped, not blanket.
import { afterEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { exportCuiArchive, exportVault, importChatExport } from "./personal.ts";
import { personalBaseDir, personalCuiStorePath, personalStorePath } from "./settings_store.ts";

const OUTSIDE = "/etc/lucid-escape"; // not under homedir()
const INSIDE = join(homedir(), ".omp", "lucid-probe");
const homeMsg = /home folder/i;

// ADR-0034: LUCID_PERSONAL_DIR relocates the whole personalization artifact set (store, CUI store,
// audit, exports) as one unit — for tests + isolated demos that must not touch the real store.
describe("personalBaseDir override (LUCID_PERSONAL_DIR)", () => {
  const saved = process.env.LUCID_PERSONAL_DIR;
  afterEach(() => { if (saved === undefined) delete process.env.LUCID_PERSONAL_DIR; else process.env.LUCID_PERSONAL_DIR = saved; });

  test("defaults to ~/.omp when unset", () => {
    delete process.env.LUCID_PERSONAL_DIR;
    expect(personalBaseDir()).toBe(join(homedir(), ".omp"));
    expect(personalStorePath()).toBe(join(homedir(), ".omp", "lucid-personal.kg.enc"));
  });

  test("relocates store + CUI store under the override dir", () => {
    process.env.LUCID_PERSONAL_DIR = join(homedir(), ".omp-test-isolated");
    expect(personalBaseDir()).toBe(join(homedir(), ".omp-test-isolated"));
    expect(personalStorePath()).toBe(join(homedir(), ".omp-test-isolated", "lucid-personal.kg.enc"));
    expect(personalCuiStorePath()).toBe(join(homedir(), ".omp-test-isolated", "lucid-cui.kg.enc"));
  });
});

describe("exportVault dest containment", () => {
  test("rejects a destination outside home", () => {
    const r = exportVault({ dest: OUTSIDE });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(homeMsg);
  });
  test("an inside-home destination passes containment (different guard fires)", () => {
    const r = exportVault({ dest: INSIDE });
    expect(r.ok).toBe(false);
    expect(r.error ?? "").not.toMatch(homeMsg); // got past containment
  });
  test("traversal that escapes home is rejected", () => {
    const r = exportVault({ dest: join(homedir(), "..", "..", "etc") });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(homeMsg);
  });
});

describe("exportCuiArchive dest containment", () => {
  test("rejects a destination outside home", () => {
    const r = exportCuiArchive({ dest: OUTSIDE });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(homeMsg);
  });
  test("an inside-home destination passes containment", () => {
    const r = exportCuiArchive({ dest: INSIDE });
    expect(r.ok).toBe(false);
    expect(r.error ?? "").not.toMatch(homeMsg);
  });
});

describe("importChatExport source containment", () => {
  test("rejects a source path outside home (e.g. /etc/passwd)", async () => {
    const r = await importChatExport("/etc/passwd");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(homeMsg);
  });
  test("an inside-home source passes containment (different guard fires)", async () => {
    const r = await importChatExport(INSIDE);
    expect(r.ok).toBe(false);
    expect(r.error ?? "").not.toMatch(homeMsg);
  });
});
