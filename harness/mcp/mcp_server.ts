// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/mcp/mcp_server.ts
//
// P-AGENTFW.1 (ADR-0147): a minimal Model Context Protocol server over stdio — the SAME line-delimited
// JSON-RPC 2.0 we hand-roll for ACP (desktop/acp.ts), so no MCP SDK dependency (air-gap clean). It handles
// exactly the three methods omp drives against a stdio MCP server: `initialize`, `tools/list`, `tools/call`
// (+ the `notifications/initialized` no-op). The wire shapes mirror omp's bundled MCP types.
//
// I/O is injected (`write`) and input is `feed()`-driven, so the whole server is unit-testable without a
// real process. In production `runOverStdio` wires it to process.stdin/stdout. It is LONG-LIVED by design:
// omp treats a stdio MCP server that exits after the handshake as a fork loop (omp mcp/manager.ts), so the
// server never self-exits.

/** MCP text content block (the only content kind the firewall returns). */
export interface McpTextContent {
  type: "text";
  text: string;
}

/** MCP `tools/call` result. */
export interface McpToolResult {
  content: McpTextContent[];
  isError?: boolean;
}

/** MCP tool definition advertised by `tools/list`. */
export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties?: Record<string, unknown>; required?: string[] };
}

/** A tool the server exposes: its definition + the handler `tools/call` dispatches to. */
export interface McpTool {
  def: McpToolDef;
  handler: (args: Record<string, unknown>) => Promise<McpToolResult>;
}

export interface McpServerInfo {
  name: string;
  version: string;
}

export interface McpServerConfig {
  serverInfo: McpServerInfo;
  tools: McpTool[];
  instructions?: string;
  /** Sink for one JSON-RPC line (no trailing newline). */
  write: (line: string) => void;
}

// The protocol version we speak when a client sends none; otherwise we echo the client's.
const DEFAULT_PROTOCOL_VERSION = "2024-11-05";

/** JSON-RPC error codes we use. */
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

export class McpStdioServer {
  #buf = "";
  constructor(private readonly cfg: McpServerConfig) {}

  /** Feed a raw stdout chunk; dispatches every complete newline-delimited message. */
  feed(chunk: string): void {
    this.#buf += chunk;
    let nl: number;
    while ((nl = this.#buf.indexOf("\n")) >= 0) {
      const line = this.#buf.slice(0, nl).trim();
      this.#buf = this.#buf.slice(nl + 1);
      if (line) void this.#handle(line);
    }
  }

  async #handle(line: string): Promise<void> {
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { return; } // unparseable → ignore (client retries/times out)
    if (typeof parsed !== "object" || parsed === null) return;
    const msg = parsed as Record<string, unknown>; // a parsed JSON object; every field is narrowed below
    const method = typeof msg.method === "string" ? msg.method : undefined;
    const id = typeof msg.id === "string" || typeof msg.id === "number" ? msg.id : undefined;
    if (!method) return; // a response, not a request — the firewall server issues no outbound requests

    // Notifications (no id) are acknowledged by silence.
    if (id === undefined) return;

    if (method === "initialize") {
      const params = typeof msg.params === "object" && msg.params !== null ? (msg.params as Record<string, unknown>) : {};
      const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : DEFAULT_PROTOCOL_VERSION;
      this.#respond(id, {
        protocolVersion: requested,
        capabilities: { tools: {} },
        serverInfo: this.cfg.serverInfo,
        ...(this.cfg.instructions ? { instructions: this.cfg.instructions } : {}),
      });
      return;
    }

    if (method === "tools/list") {
      this.#respond(id, { tools: this.cfg.tools.map((t) => t.def) });
      return;
    }

    if (method === "tools/call") {
      const params = typeof msg.params === "object" && msg.params !== null ? (msg.params as Record<string, unknown>) : {};
      const name = typeof params.name === "string" ? params.name : "";
      const args = typeof params.arguments === "object" && params.arguments !== null ? (params.arguments as Record<string, unknown>) : {};
      const tool = this.cfg.tools.find((t) => t.def.name === name);
      if (!tool) {
        this.#error(id, INVALID_PARAMS, `unknown tool: ${name}`);
        return;
      }
      try {
        this.#respond(id, await tool.handler(args));
      } catch (e) {
        // A handler throw becomes an isError tool result (never a silent success, never a crash).
        this.#respond(id, { content: [{ type: "text", text: `tool error: ${e instanceof Error ? e.message : String(e)}` }], isError: true });
      }
      return;
    }

    this.#error(id, METHOD_NOT_FOUND, `unsupported method: ${method}`);
  }

  #respond(id: string | number, result: unknown): void {
    this.cfg.write(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }

  #error(id: string | number, code: number, message: string): void {
    this.cfg.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
  }
}

/** Wire an McpStdioServer to real process stdio and block forever (long-lived; fork-loop-safe). */
export function runOverStdio(cfg: Omit<McpServerConfig, "write">): McpStdioServer {
  const server = new McpStdioServer({ ...cfg, write: (line) => process.stdout.write(line + "\n") });
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => server.feed(chunk));
  return server;
}
