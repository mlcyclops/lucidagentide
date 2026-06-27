// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Tests for loadExportText (ADR-0025): the TOCTOU-safe import-source reader. It must
// classify file vs directory vs missing by performing the read directly and handling the
// error (no stat-then-read race; js/file-system-race), and read the listing once for folders.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { estimateChatExport, loadExportData, loadExportText } from "./personal.ts";

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

// loadExportData (ADR-0034): shard-aware resolution for the modern ChatGPT export, which ships
// conversations-000.json … -NNN.json with no single combined file.
describe("loadExportData (sharded ChatGPT export)", () => {
  const conv = (title: string) => ({ title, mapping: { a: { message: { author: { role: "user" }, create_time: 1, content: { content_type: "text", parts: [title] } } } } });

  test("merges loose conversations-NNN.json shards from a directory, in order", () => {
    const dir = join(root, "sharded"); mkdirSync(dir);
    writeFileSync(join(dir, "conversations-001.json"), JSON.stringify([conv("B")]));
    writeFileSync(join(dir, "conversations-000.json"), JSON.stringify([conv("A")]));
    writeFileSync(join(dir, "user.json"), '{"id":"u"}'); // sibling metadata must be ignored
    const r = loadExportData(dir);
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.data as { title: string }[]).map((c) => c.title)).toEqual(["A", "B"]);
  });

  test("a lone conversations.json directory still works (legacy single-file)", () => {
    const dir = join(root, "legacy"); mkdirSync(dir);
    writeFileSync(join(dir, "conversations.json"), JSON.stringify([conv("only")]));
    const r = loadExportData(dir);
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.data as { title: string }[]).length).toBe(1);
  });

  test("reads a single .json file directly (parsed, not just text)", () => {
    const p = mk("single-conv.json", JSON.stringify([conv("x")]));
    const r = loadExportData(p);
    expect(r.ok).toBe(true);
    if (r.ok) expect(Array.isArray(r.data)).toBe(true);
  });

  test("a missing path reports doesn't-exist", () => {
    const r = loadExportData(join(root, "ghost.json"));
    expect(r.ok).toBe(false);
  });
});

// estimateChatExport (ADR-0035): read-only pre-import counts for the AI-mode token/time warning.
// The source must resolve inside home (M2 containment), so the fixture lives under homedir().
describe("estimateChatExport", () => {
  const homeRoot = mkdtempSync(join(homedir(), ".lucid-est-"));
  afterAll(() => rmSync(homeRoot, { recursive: true, force: true }));
  const conv = (title: string, userTexts: string[]) => ({ title, mapping: Object.fromEntries(
    userTexts.map((t, i) => [`u${i}`, { message: { author: { role: "user" }, create_time: i, content: { content_type: "text", parts: [t] } } }]),
  ) });

  test("counts user messages + chars across merged shards", async () => {
    const dir = join(homeRoot, "export"); mkdirSync(dir);
    writeFileSync(join(dir, "conversations-000.json"), JSON.stringify([conv("A", ["hello there", "second msg"])]));
    writeFileSync(join(dir, "conversations-001.json"), JSON.stringify([conv("B", ["third"])]));
    const r = await estimateChatExport(dir);
    expect(r.ok).toBe(true);
    expect(r.vendor).toBe("openai");
    expect(r.conversations).toBe(2);
    expect(r.userMessages).toBe(3);
    expect(r.userChars).toBe("hello there".length + "second msg".length + "third".length);
  });

  test("rejects a source outside home (containment)", async () => {
    const r = await estimateChatExport("/etc/passwd");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/home folder/i);
  });
});
