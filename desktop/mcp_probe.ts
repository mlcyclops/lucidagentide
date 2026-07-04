// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/mcp_probe.ts — P-AGENT.12 (ADR-0140): discover the TOOL NAMES a configured MCP server exposes, so
// the Agent Builder's catalog can offer them under the EXACT names omp registers at runtime.
//
// Naming (verified against the pinned omp bundle): an MCP tool becomes `mcp__<server>_<tool>`, and when the
// tool's own name already starts with `<server>_` the prefix is NOT doubled. The allow-list extension and
// the security gate string-match these names at tool_call time, so getting them exactly right is what makes
// an MCP tool ALLOWABLE in a built agent. A mismatch fails CLOSED (the call is denied and the run trace
// shows the actual name) — never open.
//
// The probe speaks MCP's JSON-RPC over streamable HTTP: `initialize` → `notifications/initialized` →
// `tools/list`, honoring `mcp-session-id` and tolerating servers that answer with an SSE-framed body.
// Fail-soft by contract: an unreachable/misbehaving server yields { ok:false, error } and the catalog simply
// falls back to the built-ins — a probe can never break the Builder. Results are cached briefly so opening
// the picker doesn't hammer servers.

import type { McpServerEntry } from "./settings_store.ts";

export interface McpToolInfo {
  name: string; // the omp runtime name: mcp__<server>_<tool>
  desc: string;
  server: string; // the configured server name (provenance chip in the picker)
}

export interface McpProbeResult {
  ok: boolean;
  server: string;
  tools: McpToolInfo[];
  error?: string;
}

/** omp's runtime name for an MCP tool (verified: `mcp__${server}_${tool}`, prefix not doubled). */
export function mcpToolName(serverName: string, toolName: string): string {
  const prefix = `${serverName}_`;
  const bare = toolName.startsWith(prefix) ? toolName.slice(prefix.length) : toolName;
  return `mcp__${serverName}_${bare}`;
}

/** Parse a JSON-RPC reply that may arrive as plain JSON or as an SSE-framed body (`data: {…}` lines).
 *  Returns the parsed object for the given id, or null (fail-soft — the caller reports the server). */
export function parseRpcReply(body: string, id: number): Record<string, unknown> | null {
  const tryParse = (text: string): Record<string, unknown> | null => {
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null) return null;
      const obj = parsed as Record<string, unknown>;
      return obj.id === id ? obj : null;
    } catch {
      return null;
    }
  };
  const direct = tryParse(body.trim());
  if (direct) return direct;
  for (const line of body.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const hit = tryParse(line.slice(5).trim());
    if (hit) return hit;
  }
  return null;
}

/** Extract `result.tools[]` name/description pairs from a tools/list reply, defensively. */
export function toolsFromReply(reply: Record<string, unknown>): Array<{ name: string; description: string }> {
  if (typeof reply.result !== "object" || reply.result === null) return [];
  const result = reply.result as Record<string, unknown>;
  if (!Array.isArray(result.tools)) return [];
  const out: Array<{ name: string; description: string }> = [];
  for (const t of result.tools) {
    if (typeof t !== "object" || t === null) continue;
    const tool = t as Record<string, unknown>;
    if (typeof tool.name !== "string" || !tool.name) continue;
    out.push({ name: tool.name, description: typeof tool.description === "string" ? tool.description : "" });
  }
  return out;
}

async function rpc(url: string, headers: Record<string, string>, payload: unknown, timeoutMs: number): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/** Probe one server for its tool list. Never throws — every failure mode is { ok:false, error }. */
export async function probeMcpTools(entry: McpServerEntry, timeoutMs = 4000): Promise<McpProbeResult> {
  const fail = (error: string): McpProbeResult => ({ ok: false, server: entry.name, tools: [], error });
  try {
    const auth: Record<string, string> = entry.token ? { authorization: `Bearer ${entry.token}` } : {};
    const initResp = await rpc(entry.url, auth, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "lucid-agent-ide", version: "1.0" } },
    }, timeoutMs);
    if (!initResp.ok) return fail(`initialize: HTTP ${initResp.status}`);
    const session = initResp.headers.get("mcp-session-id");
    const sessionHeader: Record<string, string> = session ? { "mcp-session-id": session } : {};
    if (!parseRpcReply(await initResp.text(), 1)) return fail("initialize: unparseable reply");

    // Courtesy per spec; some servers require it before tools/list. Failure here is not fatal.
    await rpc(entry.url, { ...auth, ...sessionHeader }, { jsonrpc: "2.0", method: "notifications/initialized" }, timeoutMs).catch(() => null);

    const listResp = await rpc(entry.url, { ...auth, ...sessionHeader }, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, timeoutMs);
    if (!listResp.ok) return fail(`tools/list: HTTP ${listResp.status}`);
    const reply = parseRpcReply(await listResp.text(), 2);
    if (!reply) return fail("tools/list: unparseable reply");
    const tools = toolsFromReply(reply).map((t) => ({
      name: mcpToolName(entry.name, t.name),
      desc: t.description || `MCP tool ${t.name}`,
      server: entry.name,
    }));
    return { ok: true, server: entry.name, tools };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

// ── 5-minute probe cache (per server id) — opening the picker never hammers servers ─────────────────────

const CACHE_TTL_MS = 5 * 60_000;
const cache = new Map<string, { at: number; result: McpProbeResult }>(); // dynamic, keyed by server id

/** Probe all ENABLED servers (cached). SSE-transport entries are skipped with an honest note — the legacy
 *  SSE handshake needs a persistent stream; omp still runs their tools, we just can't enumerate them yet. */
export async function probeEnabledServers(servers: McpServerEntry[], now = Date.now()): Promise<McpProbeResult[]> {
  const out: McpProbeResult[] = [];
  for (const s of servers.filter((x) => x.enabled)) {
    if (s.transport === "sse") {
      out.push({ ok: false, server: s.name, tools: [], error: "legacy SSE transport — tool discovery not supported yet; the server's tools still run under omp" });
      continue;
    }
    const hit = cache.get(s.id);
    if (hit && now - hit.at < CACHE_TTL_MS) {
      out.push(hit.result);
      continue;
    }
    const result = await probeMcpTools(s);
    cache.set(s.id, { at: now, result });
    out.push(result);
  }
  return out;
}
