// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/kb_sources.test.ts — P-KGPACK.3 (ADR-0205): the folder → KB-documents reader. Confirms a chat
// export (reusing the vendor parser) and an Obsidian markdown vault both normalise to KbSourceDoc[], the
// chat shape wins when both could match, the markdown walk skips hidden/system dirs + non-md files, and a
// folder with neither returns a friendly error.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readKbSources } from "./kb_sources.ts";

describe("readKbSources", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "kb-src-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("a Claude/ChatGPT chat export becomes one document per conversation", () => {
    writeFileSync(join(dir, "conversations.json"), JSON.stringify([
      { name: "Deploy chat", chat_messages: [{ sender: "human", text: "How do I deploy?" }, { sender: "assistant", text: "Use the CI pipeline." }] },
      { name: "Empty", chat_messages: [] },
    ]));
    const r = readKbSources(dir);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.scan.kind).toBe("chat");
    expect(r.scan.vendor).toBe("anthropic");
    expect(r.scan.docs).toHaveLength(1); // the empty conversation is dropped
    expect(r.scan.docs[0]!.title).toBe("Deploy chat");
    expect(r.scan.docs[0]!.text).toContain("User: How do I deploy?");
    expect(r.scan.docs[0]!.text).toContain("Assistant: Use the CI pipeline."); // a KB keeps both sides
    expect(r.scan.docs[0]!.sourcePath).toBe("chat:anthropic#0");
  });

  test("an Obsidian markdown vault becomes one document per note, hidden/system dirs + non-md skipped", () => {
    writeFileSync(join(dir, "Alpha.md"), "# Alpha\nfirst note");
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "Beta.markdown"), "# Beta\nnested note");
    writeFileSync(join(dir, "notes.txt"), "not markdown");        // ignored (wrong extension)
    mkdirSync(join(dir, ".obsidian"));
    writeFileSync(join(dir, ".obsidian", "app.json"), "{}");       // ignored (system dir)
    const r = readKbSources(dir);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.scan.kind).toBe("obsidian");
    expect(r.scan.vendor).toBeUndefined();
    expect(r.scan.docs.map((d) => d.title).sort()).toEqual(["Alpha", "Beta"]);
    expect(r.scan.docs.find((d) => d.title === "Beta")!.sourcePath).toBe("obsidian:sub/Beta.markdown");
  });

  test("the chat shape wins when a folder holds a conversations.json", () => {
    writeFileSync(join(dir, "conversations.json"), JSON.stringify([{ name: "C", chat_messages: [{ sender: "human", text: "hi" }] }]));
    writeFileSync(join(dir, "note.md"), "# a stray note"); // present, but the export takes precedence
    const r = readKbSources(dir);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.scan.kind).toBe("chat");
  });

  test("a folder with neither an export nor markdown returns a friendly error", () => {
    writeFileSync(join(dir, "random.txt"), "nothing to import");
    const r = readKbSources(dir);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/No chat export .* or markdown/);
  });

  test("an empty path is rejected", () => {
    const r = readKbSources("   ");
    expect(r.ok).toBe(false);
  });
});
