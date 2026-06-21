// Tests for loadExportText (ADR-0025): the TOCTOU-safe import-source reader. It must
// classify file vs directory vs missing by performing the read directly and handling the
// error (no stat-then-read race; js/file-system-race), and read the listing once for folders.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadExportText } from "./personal.ts";

const root = mkdtempSync(join(tmpdir(), "lucid-export-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const mk = (rel: string, body: string): string => { const p = join(root, rel); writeFileSync(p, body); return p; };

describe("loadExportText", () => {
  test("reads a .json file directly", () => {
    const p = mk("conv.json", '{"a":1}');
    expect(loadExportText(p)).toEqual({ ok: true, text: '{"a":1}' });
  });

  test("reads conversations.json from a directory (EISDIR fall-through, no stat)", () => {
    const dir = join(root, "chatgpt"); mkdirSync(dir);
    writeFileSync(join(dir, "conversations.json"), '{"v":"gpt"}');
    expect(loadExportText(dir)).toEqual({ ok: true, text: '{"v":"gpt"}' });
  });

  test("reads the lone .json in a directory", () => {
    const dir = join(root, "single"); mkdirSync(dir);
    writeFileSync(join(dir, "whatever.json"), '{"v":"x"}');
    expect(loadExportText(dir)).toEqual({ ok: true, text: '{"v":"x"}' });
  });

  test("a missing path reports doesn't-exist (ENOENT, not a crash)", () => {
    const r = loadExportText(join(root, "nope.json"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/doesn't exist/i);
  });

  test("a directory with nothing usable reports the folder guidance", () => {
    const dir = join(root, "empty"); mkdirSync(dir);
    writeFileSync(join(dir, "readme.txt"), "hi");
    const r = loadExportText(dir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/conversations\.json/i);
  });

  test("an ambiguous directory (multiple .json, none named) is rejected, not guessed", () => {
    const dir = join(root, "ambig"); mkdirSync(dir);
    writeFileSync(join(dir, "a.json"), "{}"); writeFileSync(join(dir, "b.json"), "{}");
    const r = loadExportText(dir);
    expect(r.ok).toBe(false);
  });
});
