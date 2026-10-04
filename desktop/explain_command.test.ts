// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/explain_command.test.ts
//
// CUI lockdown: TLDR's direct keyed path posts the command to Anthropic / OpenAI / Gemini, none CUI-authorized.
// Under lockdown it must refuse BEFORE any request leaves, even with a key saved, and mark the refusal so the
// /api/explain route reroutes through the governed omp util session instead of a "missing key" message.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { explainCommand } from "./explain_command.ts";

describe("explainCommand under CUI lockdown", () => {
  const realFetch = globalThis.fetch;
  let dir = "";
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
    delete process.env.LUCID_GUI_SETTINGS_FILE;
  });

  test("locked: refused with lockdown:true and NO request sent, even with an Anthropic key saved", async () => {
    dir = mkdtempSync(join(tmpdir(), "explain-"));
    const file = join(dir, "gui.json");
    writeFileSync(file, JSON.stringify({ keys: { ANTHROPIC_API_KEY: "test-not-a-real-key" } }));
    process.env.LUCID_GUI_SETTINGS_FILE = file;
    const calls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => { calls.push(String(url)); return new Response("{}", { status: 500 }); }) as typeof fetch;

    const locked = await explainCommand("rm -rf ./build", true);
    expect(locked.ok).toBe(false);
    expect(locked.lockdown).toBe(true);
    expect(locked.error).toMatch(/CUI lockdown/);
    expect(calls).toEqual([]);

    // Same settings, lock off: the keyed path IS taken (proves the refusal above is the gate, not a missing key).
    const open = await explainCommand("rm -rf ./build", false);
    expect(open.lockdown).toBeUndefined();
    expect(calls).toEqual(["https://api.anthropic.com/v1/messages"]);
  });
});
