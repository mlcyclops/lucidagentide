// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/omp/mcp_result_gate.ts
//
// P-MCP-GATE.1 (ADR-0148): the in-process gate for MCP tool RESULTS — closing the ADR-0020 guardrail that
// was declared but never implemented (security_extension.ts only gates tool_call ARGS + <task-result>
// promotion, so every MCP server's OUTPUT re-entered the prompt UNSCANNED).
//
// Loaded as its own omp `-e` extension (the security_extension.ts keystone stays untouched). omp's
// `tool_result` hook may REPLACE the result (ToolResultEventResult), and the runner captures the last
// handler's return — security_extension returns nothing for tool_result, so this gate's result wins.
//
// SOURCE-SCOPED: only results from MCP servers are gated (toolName `mcp__…` or details.serverName present).
// Local built-in tools (read/bash/write/edit/grep/glob) are LEFT UNTOUCHED — scanning a user's own file
// read would be wrong (it isn't untrusted-external) and a false-positive/perf hazard.
//
// FAIL-CLOSED (invariant #3): scanAndDecide maps any scan failure to block, so an unscannable MCP result is
// withheld, never passed. Clean/suspicious MCP output is wrapped in UNTRUSTED_CONTENT + trust-labeled
// (never `trusted`) so the model reads it as data (invariant #5); embedded delimiters are neutralized.

import type { createAgentSession } from "@oh-my-pi/pi-coding-agent";
import type { TrustLabel } from "../contracts.ts";
import { DEFAULT_POLICY, scanAndDecide, type GateDecision } from "../security/gate.ts";
import { ScannerClient } from "../security/scanner_client.ts";
import { UNTRUSTED_START, UNTRUSTED_END } from "../prompt/assembler.ts";

type SessionOpts = NonNullable<Parameters<typeof createAgentSession>[0]>;
type ExtensionFactory = NonNullable<SessionOpts["extensions"]>[number];

// ── pure core (no I/O, unit-tested) ─────────────────────────────────────────────────────────────────

/** The minimal shape of a tool_result the scoping/labeling needs. */
export interface ToolResultMeta {
  toolName?: string;
  details?: unknown;
}

/** Content blocks in a tool result (text is scanned; images pass through untouched). */
export interface McpTextContent { type: "text"; text: string }
export interface McpImageContent { type: "image"; data: string; mimeType: string }
export type McpContent = McpTextContent | McpImageContent;

/** The tool_result slice the gate consumes (structurally compatible with omp's ToolResultEvent). */
export interface ToolResultInput extends ToolResultMeta { content: McpContent[] }

/** The replacement result the gate returns (structurally compatible with omp's ToolResultEventResult). */
export interface GatedResult { content: McpContent[]; isError?: boolean }

/** Is this tool_result from an MCP server (external / untrusted) rather than a local built-in tool?
 *  omp names MCP tools `mcp__<server>_<tool>` and attaches `details.serverName` (mcp/tool-bridge.ts). */
export function isMcpToolResult(ev: ToolResultMeta): boolean {
  if (typeof ev.toolName === "string" && ev.toolName.startsWith("mcp__")) return true;
  const d = ev.details;
  if (typeof d === "object" && d !== null && "serverName" in d) {
    const rec = d as Record<string, unknown>; // narrowed object; read the one field
    return typeof rec.serverName === "string" && rec.serverName.length > 0;
  }
  return false;
}

/** The MCP server name for labeling (from details, else parsed from the `mcp__server_tool` name). */
export function mcpServerName(ev: ToolResultMeta): string {
  const d = ev.details;
  if (typeof d === "object" && d !== null && "serverName" in d) {
    const rec = d as Record<string, unknown>;
    if (typeof rec.serverName === "string" && rec.serverName.length > 0) return rec.serverName;
  }
  const name = typeof ev.toolName === "string" ? ev.toolName : "";
  if (name.startsWith("mcp__")) {
    const rest = name.slice("mcp__".length);
    const i = rest.indexOf("_");
    return i > 0 ? rest.slice(0, i) : rest;
  }
  return "mcp";
}

/** Neutralize the UNTRUSTED_CONTENT delimiter literals so a hostile MCP result cannot break out of the
 *  envelope (the Unicode scanner does not catch this ASCII token). Mirrors the agent-firewall's guard. */
export function neutralizeDelimiters(s: string): string {
  return s.split(UNTRUSTED_END).join("[lucid-neutralized-delimiter]").split(UNTRUSTED_START).join("[lucid-neutralized-delimiter]");
}

/** The replacement text when an MCP result is quarantined — the poison is withheld, only a reason shown. */
export function blockNotice(server: string, reason: string): string {
  return `[BLOCKED by Lucid: quarantined result from MCP server "${server}" — ${reason}. The remote output is withheld.]`;
}

/** Wrap a clean/suspicious MCP result as delimited, trust-labeled untrusted data (never `trusted`). */
export function wrapUntrusted(server: string, decision: GateDecision, rawText: string): string {
  const trust: TrustLabel = decision.trustLabel === "suspicious" ? "suspicious" : "untrusted";
  return `${UNTRUSTED_START}\n[mcp-server name="${server}" trust="${trust}"]\n${neutralizeDelimiters(rawText)}\n${UNTRUSTED_END}`;
}

// ── the extension shell (I/O; wires the pure core to omp's tool_result hook) ──────────────────────────

/** Gate ONE tool_result: `undefined` = leave unchanged (a local built-in tool); otherwise the replacement
 *  result. Fail-closed via scanAndDecide. Exported for direct testing — the omp handler is a thin wrapper. */
export async function gateToolResult(scanner: ScannerClient, ev: ToolResultInput): Promise<GatedResult | undefined> {
  if (!isMcpToolResult(ev)) return undefined; // only MCP/external results; local tools untouched
  const rawText = ev.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n");
  const images = ev.content.flatMap((c) => (c.type === "image" ? [c] : []));
  const decision = await scanAndDecide(scanner, rawText, DEFAULT_POLICY);
  const server = mcpServerName(ev);
  if (decision.block) return { content: [{ type: "text", text: blockNotice(server, decision.reason) }], isError: true };
  return { content: [{ type: "text", text: wrapUntrusted(server, decision, rawText) }, ...images] };
}

/** Build the extension against an injected scanner (DI / test seam). */
export function createMcpResultGate(scanner: ScannerClient): ExtensionFactory {
  return (pi) => {
    pi.on("tool_result", async (event) => {
      const gated = await gateToolResult(scanner, event);
      if (gated?.isError) process.stderr.write(`\n🛡️  [LucidAgentIDE] withheld a quarantined MCP result from "${mcpServerName(event)}"\n`);
      return gated;
    });
  };
}

// Default export: the live extension omp loads via `-e`. Creates + starts the scanner lazily so importing
// the pure core / factory for tests is side-effect-free.
const mcpResultGate: ExtensionFactory = (pi) => {
  const scanner = new ScannerClient();
  scanner.start();
  createMcpResultGate(scanner)(pi);
};

export default mcpResultGate;
