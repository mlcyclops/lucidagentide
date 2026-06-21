// Tests for GUI file-path containment (M2, ADR-0023): import sources and export
// destinations must resolve inside the user's home subtree. The containment check
// runs before the stateful (store-unlocked) guards, so these exercise it without
// creating a real encrypted store: an outside-home path is rejected with the
// "home folder" message; an inside-home path passes containment and falls through
// to the next guard (a different message), proving the boundary is scoped, not blanket.
import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { exportCuiArchive, exportVault, importChatExport } from "./personal.ts";

const OUTSIDE = "/etc/lucid-escape"; // not under homedir()
const INSIDE = join(homedir(), ".omp", "lucid-probe");
const homeMsg = /home folder/i;

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
