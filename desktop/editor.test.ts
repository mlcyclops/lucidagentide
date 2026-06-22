// Tests for the in-app editor's gated read/write (ADR-0036). The load-bearing properties:
//   - paths are confined to the workspace (no arbitrary read/write),
//   - a save with a >=high finding is BLOCKED and never reaches disk (the gate, fail-closed),
//   - conflict detection refuses to clobber a file that drifted on disk (or a Save-As onto an
//     existing file) unless the caller explicitly overwrites.
// The scanner is injected (deps.scanner) so these run offline without the Python sidecar.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ScannerClient } from "../harness/security/scanner_client.ts";
import { readEditorFile, saveEditorFile } from "./editor.ts";

// A temp dir UNDER home, so pathWithin(homedir, …) passes (the GUI file boundary, ADR-0023).
const root = mkdtempSync(join(homedir(), ".lucid-edit-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

// Fake scanners: clean (no findings) vs poison (a high-severity finding when the text contains POISON).
const fake = (findings: (t: string) => unknown[]): ScannerClient =>
  ({ scan: async (t: string) => ({ findings: findings(t), scanner_version: "test" }) }) as unknown as ScannerClient;
const cleanScanner = fake(() => []);
const poisonScanner = fake((t) => (/POISON/.test(t) ? [{ type: "zero-width", codepoint: "U+200B", index: 0, severity: "high" }] : []));

describe("readEditorFile", () => {
  test("reads a workspace file with mtime + content hash", () => {
    const p = join(root, "a.ts"); writeFileSync(p, "export const x = 1;\n");
    const r = readEditorFile(p);
    expect(r.ok).toBe(true);
    expect(r.content).toBe("export const x = 1;\n");
    expect(r.sha256).toBe(sha256("export const x = 1;\n"));
    expect(typeof r.mtime).toBe("number");
  });
  test("rejects a path outside home", () => {
    const r = readEditorFile("/etc/passwd");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/outside your home folder/i);
  });
  test("a missing file reports doesn't-exist", () => {
    const r = readEditorFile(join(root, "ghost.ts"));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/doesn't exist/i);
  });
});

describe("saveEditorFile (gated)", () => {
  test("clean content writes and returns the new hash", async () => {
    const p = join(root, "clean.ts");
    const r = await saveEditorFile({ path: p, content: "const y = 2;\n" }, { scanner: cleanScanner });
    expect(r.ok).toBe(true);
    expect(existsSync(p)).toBe(true);
    expect(readFileSync(p, "utf8")).toBe("const y = 2;\n");
    expect(r.sha256).toBe(sha256("const y = 2;\n"));
  });

  test("a >=high finding BLOCKS the save — nothing reaches disk (fail-closed gate)", async () => {
    const p = join(root, "poison.ts");
    const r = await saveEditorFile({ path: p, content: "const a = 1; // POISON\n" }, { scanner: poisonScanner });
    expect(r.ok).toBe(false);
    expect(r.blocked).toBe(true);
    expect(existsSync(p)).toBe(false); // the buffer never landed
  });

  test("rejects a save outside home", async () => {
    const r = await saveEditorFile({ path: "/etc/lucid-escape.ts", content: "x" }, { scanner: cleanScanner });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/inside your home folder/i);
  });

  test("conflict: on-disk hash drifted since open → refuse without overwrite, then overwrite forces", async () => {
    const p = join(root, "conflict.ts"); writeFileSync(p, "v1\n");
    const r1 = await saveEditorFile({ path: p, content: "v2\n", baseSha: sha256("WRONG") }, { scanner: cleanScanner });
    expect(r1.ok).toBe(false);
    expect(r1.conflict).toBe(true);
    expect(readFileSync(p, "utf8")).toBe("v1\n"); // untouched
    const r2 = await saveEditorFile({ path: p, content: "v2\n", baseSha: sha256("WRONG"), overwrite: true }, { scanner: cleanScanner });
    expect(r2.ok).toBe(true);
    expect(readFileSync(p, "utf8")).toBe("v2\n");
  });

  test("Save-As onto an existing file with no baseSha is a conflict (no silent clobber)", async () => {
    const p = join(root, "exists.ts"); writeFileSync(p, "original\n");
    const r = await saveEditorFile({ path: p, content: "new\n" }, { scanner: cleanScanner });
    expect(r.ok).toBe(false);
    expect(r.conflict).toBe(true);
    expect(readFileSync(p, "utf8")).toBe("original\n");
  });

  test("saving with the correct baseSha succeeds (no false conflict)", async () => {
    const p = join(root, "match.ts"); writeFileSync(p, "base\n");
    const r = await saveEditorFile({ path: p, content: "next\n", baseSha: sha256("base\n") }, { scanner: cleanScanner });
    expect(r.ok).toBe(true);
    expect(readFileSync(p, "utf8")).toBe("next\n");
  });
});

// P-IDE.6: the full editor lifecycle through BOTH functions — the round-trip the renderer drives
// (open → edit → save → re-save) and the conflict cycle (open → external change → conflict → overwrite).
describe("editor lifecycle (read ↔ save)", () => {
  test("save → read round-trip: the read's hash matches what save reported", async () => {
    const p = join(root, "rt.ts");
    const saved = await saveEditorFile({ path: p, content: "const v = 1;\n" }, { scanner: cleanScanner });
    expect(saved.ok).toBe(true);
    const read = readEditorFile(p);
    expect(read.ok).toBe(true);
    expect(read.content).toBe("const v = 1;\n");
    expect(read.sha256).toBe(saved.sha256); // the hash the editor would carry forward as baseSha
  });

  test("open → external change → conflict → overwrite → reopen reflects the overwrite", async () => {
    const p = join(root, "life.ts"); writeFileSync(p, "v1\n");
    const opened = readEditorFile(p);                       // editor opens the file (carries baseSha)
    expect(opened.ok).toBe(true);
    writeFileSync(p, "external edit\n");                    // someone changes it on disk
    const blocked = await saveEditorFile({ path: p, content: "my edit\n", baseSha: opened.sha256 }, { scanner: cleanScanner });
    expect(blocked.conflict).toBe(true);                    // editor refuses to clobber
    expect(blocked.currentSha).toBe(sha256("external edit\n"));
    const forced = await saveEditorFile({ path: p, content: "my edit\n", baseSha: opened.sha256, overwrite: true }, { scanner: cleanScanner });
    expect(forced.ok).toBe(true);
    const reopened = readEditorFile(p);
    expect(reopened.content).toBe("my edit\n");
    expect(reopened.sha256).toBe(forced.sha256);
  });

  test("consecutive in-editor saves chain cleanly (each save's hash becomes the next baseSha)", async () => {
    const p = join(root, "chain.ts");
    const s1 = await saveEditorFile({ path: p, content: "a\n" }, { scanner: cleanScanner });        // Save As (no baseSha, new file)
    expect(s1.ok).toBe(true);
    const s2 = await saveEditorFile({ path: p, content: "b\n", baseSha: s1.sha256 }, { scanner: cleanScanner }); // edit again with the prior hash
    expect(s2.ok).toBe(true);
    expect(readFileSync(p, "utf8")).toBe("b\n");
  });
});
