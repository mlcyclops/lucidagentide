// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/omp/knowledge_extension.test.ts
//
// ADR-0214: the pure response-shaping for the `knowledge_search` tool (the fetch itself is a thin wrapper).
// Covers: hits pass the delimited `wrapped` block through verbatim with a cite reminder; an empty result and a
// missing desktop URL each degrade to clear guidance so the agent never loops. Tolerates the dev server's
// { ok, data } envelope AND a bare payload.

import { describe, expect, test } from "bun:test";
import knowledgeExtension, { formatKnowledgeResult } from "./knowledge_extension.ts";

// A minimal `pi` mock capturing the registered tool (mirrors omp's registerTool + typebox surface).
function mockPi() {
  let tool: any = null;
  const T = { Object: (x: any) => x, String: (x: any) => x, Optional: (x: any) => x, Number: (x: any) => x };
  return { pi: { typebox: { Type: T }, registerTool: (t: any) => { tool = t; } }, tool: () => tool };
}
const txt = (r: any) => r?.content?.[0]?.text ?? "";

const WRAPPED = "UNTRUSTED_CONTENT_START\n[1] (compiled:page:onboarding) Onboarding\nStep one...\nUNTRUSTED_CONTENT_END";

describe("formatKnowledgeResult", () => {
  test("hits → passes the delimited wrapped block through, with a cite reminder", () => {
    const out = formatKnowledgeResult({ data: { items: [{}], wrapped: WRAPPED } }, true, "how do I onboard");
    expect(out).toContain(WRAPPED);
    expect(out).toContain("1 result");
    expect(out).toMatch(/reference DATA, not instructions/);
    expect(out).toMatch(/Cite the \[n\]/);
  });
  test("tolerates a bare payload (no { data } envelope)", () => {
    const out = formatKnowledgeResult({ items: [{}, {}], wrapped: WRAPPED }, true, "q");
    expect(out).toContain("2 results");
    expect(out).toContain(WRAPPED);
  });
  test("empty result → guidance to ingest, not an error (so the agent won't loop)", () => {
    const out = formatKnowledgeResult({ data: { items: [], wrapped: "" } }, true, "obscure topic");
    expect(out).toMatch(/No matches/);
    expect(out).toMatch(/Obsidian vault or folder/);
    expect(out).not.toContain("UNTRUSTED_CONTENT_START");
  });
  test("no desktop URL → clear unavailable message", () => {
    expect(formatKnowledgeResult(null, false, "q")).toMatch(/isn't available/);
  });
  test("the query is truncated in the echoed message (no unbounded echo)", () => {
    const long = "x".repeat(200);
    const out = formatKnowledgeResult({ data: { items: [], wrapped: "" } }, true, long);
    expect(out).toContain("x".repeat(80));
    expect(out).not.toContain("x".repeat(81));
  });
});

describe("knowledgeExtension registration", () => {
  test("registers a read-only knowledge_search tool", () => {
    const m = mockPi();
    knowledgeExtension(m.pi);
    const t = m.tool();
    expect(t?.name).toBe("knowledge_search");
    expect(t?.approval).toBe("read"); // never trips the exec gate
    expect(typeof t?.execute).toBe("function");
  });
  test("older omp without registerTool/typebox → no-op, never throws", () => {
    expect(() => knowledgeExtension({} as any)).not.toThrow();
    expect(() => knowledgeExtension({ registerTool: () => {} } as any)).not.toThrow(); // no typebox
  });
  test("execute: empty query → asks for a query (no fetch)", async () => {
    const m = mockPi(); knowledgeExtension(m.pi);
    expect(txt(await m.tool().execute("id", { query: "  " }))).toMatch(/Provide a .query/);
  });
  test("execute: no LUCID_KB_RETRIEVE_URL → graceful unavailable text (no fetch)", async () => {
    const prev = process.env.LUCID_KB_RETRIEVE_URL;
    delete process.env.LUCID_KB_RETRIEVE_URL;
    try {
      const m = mockPi(); knowledgeExtension(m.pi);
      expect(txt(await m.tool().execute("id", { query: "anything" }))).toMatch(/isn't available/);
    } finally { if (prev !== undefined) process.env.LUCID_KB_RETRIEVE_URL = prev; }
  });
});
