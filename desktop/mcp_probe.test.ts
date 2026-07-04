// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/mcp_probe.test.ts — P-AGENT.12 (ADR-0138): MCP tool discovery. The probe is exercised against a
// REAL in-process HTTP server speaking the MCP JSON-RPC handshake (no mocks), plus the pure naming/parsing
// helpers omp-name fidelity depends on.

import { test, expect, describe, afterAll } from "bun:test";
import { mcpToolName, parseRpcReply, toolsFromReply, probeMcpTools } from "./mcp_probe.ts";
import type { McpServerEntry } from "./settings_store.ts";

describe("mcpToolName (P-AGENT.12) — omp runtime-name fidelity", () => {
  test("plain tool → mcp__<server>_<tool>", () => {
    expect(mcpToolName("crm", "search")).toBe("mcp__crm_search");
  });
  test("tool already prefixed with <server>_ is not doubled (verified omp rule)", () => {
    expect(mcpToolName("crm", "crm_search")).toBe("mcp__crm_search");
  });
});

describe("parseRpcReply / toolsFromReply (P-AGENT.12)", () => {
  test("plain JSON and SSE-framed bodies both parse; wrong ids are rejected", () => {
    const json = JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [] } });
    expect(parseRpcReply(json, 2)).toBeTruthy();
    expect(parseRpcReply(json, 1)).toBeNull();
    const sse = `event: message\ndata: ${json}\n\n`;
    expect(parseRpcReply(sse, 2)).toBeTruthy();
    expect(parseRpcReply("not json", 2)).toBeNull();
  });
  test("malformed tool entries are skipped, never fatal", () => {
    const reply = { id: 2, result: { tools: [{ name: "good", description: "d" }, { nope: 1 }, "junk", { name: "" }] } } as Record<string, unknown>;
    expect(toolsFromReply(reply)).toEqual([{ name: "good", description: "d" }]);
  });
});

// ── a REAL minimal MCP server over streamable HTTP ───────────────────────────────────────────────────────

const seenAuth: string[] = [];
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    seenAuth.push(req.headers.get("authorization") ?? "");
    const body = (await req.json()) as { id?: number; method?: string };
    if (body.method === "initialize")
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "fixture" } } }), {
        headers: { "content-type": "application/json", "mcp-session-id": "sess-1" },
      });
    if (body.method === "tools/list") {
      // answer SSE-framed to prove the tolerant parser end-to-end
      const payload = JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "search", description: "Search the CRM" }, { name: "crm_update", description: "Update a record" }] } });
      return new Response(`event: message\ndata: ${payload}\n\n`, { headers: { "content-type": "text/event-stream" } });
    }
    return new Response(null, { status: 202 }); // notifications/initialized
  },
});
afterAll(() => server.stop(true));

function entry(over: Partial<McpServerEntry> = {}): McpServerEntry {
  return { id: "mcp-test", name: "crm", transport: "http", url: `http://127.0.0.1:${server.port}`, token: "tok-123", enabled: true, ...over };
}

describe("probeMcpTools (P-AGENT.12) — against a live server", () => {
  test("handshake → tools/list; names use the omp convention; bearer token sent", async () => {
    const r = await probeMcpTools(entry());
    expect(r.ok).toBe(true);
    expect(r.tools.map((t) => t.name)).toEqual(["mcp__crm_search", "mcp__crm_update"]); // prefix de-dup applied
    expect(r.tools[0]!.desc).toBe("Search the CRM");
    expect(seenAuth.some((a) => a === "Bearer tok-123")).toBe(true);
  });

  test("an unreachable server fails soft with an error, never throws", async () => {
    const r = await probeMcpTools(entry({ url: "http://127.0.0.1:9", id: "mcp-dead" }), 500);
    expect(r.ok).toBe(false);
    expect(r.tools).toEqual([]);
    expect((r.error ?? "").length).toBeGreaterThan(0);
  });
});
