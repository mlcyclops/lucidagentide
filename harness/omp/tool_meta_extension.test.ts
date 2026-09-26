// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-EVAL.4 (ADR-0318): the tool-name self-report channel. `readToolMeta` is the whole parsing surface, so
// it carries the tests: it reads payloads that crossed a process boundary and must degrade to null rather
// than post garbage labels the engineering report would then display as fact.

import { describe, expect, test } from "bun:test";
import toolMetaExtension, { readToolMeta } from "./tool_meta_extension.ts";

describe("readToolMeta", () => {
  test("reads a tool_call start event (name + id, no verdict yet)", () => {
    expect(readToolMeta({ type: "tool_call", toolName: "bash", toolCallId: "call_1", input: {} }))
      .toEqual({ id: "call_1", name: "bash" });
  });

  test("reads a tool_result event and translates isError into ok", () => {
    expect(readToolMeta({ type: "tool_result", toolName: "edit", toolCallId: "c2", isError: false }))
      .toEqual({ id: "c2", name: "edit", ok: true });
    expect(readToolMeta({ type: "tool_result", toolName: "edit", toolCallId: "c2", isError: true }))
      .toEqual({ id: "c2", name: "edit", ok: false });
  });

  test("a NON-boolean isError leaves ok absent - unknown must stay unknown, never a confident pass", () => {
    // The report renders "measured" vs "not measured" from exactly this distinction, so coercing a missing
    // or junk isError into `ok: true` would manufacture a green result out of no signal.
    for (const isError of [undefined, null, "false", 0, {}]) {
      expect(readToolMeta({ toolName: "read", toolCallId: "c3", isError })).toEqual({ id: "c3", name: "read" });
    }
  });

  test("custom + MCP tool names survive verbatim (the whole point: these arrive as ACP kind 'other')", () => {
    for (const name of ["preview_open", "knowledge_search", "memory_retain", "mcp__github__search_issues"]) {
      expect(readToolMeta({ toolName: name, toolCallId: "c" })).toEqual({ id: "c", name });
    }
  });

  test("trims surrounding whitespace on both fields", () => {
    expect(readToolMeta({ toolName: "  write \n", toolCallId: " call_9 " })).toEqual({ id: "call_9", name: "write" });
  });

  test("returns null when either field is missing, empty, whitespace-only, or the wrong type", () => {
    expect(readToolMeta({ toolCallId: "c" })).toBeNull();               // no name
    expect(readToolMeta({ toolName: "bash" })).toBeNull();              // no id
    expect(readToolMeta({ toolName: "", toolCallId: "c" })).toBeNull();
    expect(readToolMeta({ toolName: "   ", toolCallId: "c" })).toBeNull();
    expect(readToolMeta({ toolName: "bash", toolCallId: "" })).toBeNull();
    expect(readToolMeta({ toolName: 42, toolCallId: "c" })).toBeNull();  // a renamed/retyped upstream field
    expect(readToolMeta({ toolName: "bash", toolCallId: { id: 1 } })).toBeNull();
  });

  test("returns null for non-object payloads instead of throwing", () => {
    for (const bad of [null, undefined, "tool_call", 7, [], true]) expect(readToolMeta(bad)).toBeNull();
  });
});

describe("toolMetaExtension registration", () => {
  const withUrl = <T>(url: string | undefined, run: () => T): T => {
    const prior = process.env.LUCID_TOOL_META_URL;
    if (url === undefined) delete process.env.LUCID_TOOL_META_URL;
    else process.env.LUCID_TOOL_META_URL = url;
    try { return run(); } finally {
      if (prior === undefined) delete process.env.LUCID_TOOL_META_URL;
      else process.env.LUCID_TOOL_META_URL = prior;
    }
  };

  test("registers both hooks when the desktop handed it a URL", () => {
    withUrl("http://127.0.0.1:1/api/tool/meta?t=x", () => {
      const events: string[] = [];
      toolMetaExtension({ on: (event: string) => { events.push(event); } });
      expect(events).toEqual(["tool_call", "tool_result"]);
    });
  });

  test("registers NOTHING without a URL (bare omp / a test run has no desktop to report to)", () => {
    withUrl(undefined, () => {
      const events: string[] = [];
      toolMetaExtension({ on: (event: string) => { events.push(event); } });
      expect(events).toEqual([]);
    });
  });

  test("an empty or whitespace-only URL is treated as absent", () => {
    for (const url of ["", "   "]) {
      withUrl(url, () => {
        const events: string[] = [];
        toolMetaExtension({ on: (event: string) => { events.push(event); } });
        expect(events).toEqual([]);
      });
    }
  });

  test("fail-soft: a missing hook API, a junk pi, or a throwing on() never breaks omp launch", () => {
    withUrl("http://127.0.0.1:1/api/tool/meta?t=x", () => {
      expect(() => toolMetaExtension({})).not.toThrow();          // older omp, no hook API
      expect(() => toolMetaExtension(null)).not.toThrow();
      expect(() => toolMetaExtension(undefined)).not.toThrow();
      expect(() => toolMetaExtension({ on: "not-a-function" })).not.toThrow();
      expect(() => toolMetaExtension({ on: () => { throw new Error("registration exploded"); } })).not.toThrow();
    });
  });

  test("a hook fired with a junk payload is swallowed, not thrown into omp's tool loop", () => {
    withUrl("http://127.0.0.1:1/api/tool/meta?t=x", () => {
      const handlers: ((event: unknown) => void)[] = [];
      toolMetaExtension({ on: (_event: string, handler: (event: unknown) => void) => { handlers.push(handler); } });
      expect(handlers.length).toBe(2);
      // No id/name: readToolMeta returns null and the handler simply does not post.
      for (const h of handlers) expect(() => h({ nothing: "useful" })).not.toThrow();
    });
  });
});
