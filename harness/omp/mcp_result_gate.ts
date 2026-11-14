// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/omp/mcp_result_gate.ts
//
// P-MCP-GATE.1 (ADR-0152): the in-process gate for MCP tool RESULTS — closing the ADR-0020 guardrail that
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
//
// SPILLED RESULTS (P-CTX.2a, ADR-0578). omp saves a result over its spill threshold (default 50 KB) whole
// as a session artifact and hands this hook only a head and tail view; the model reads the rest back with
// `read artifact://<n>`, a local tool. Scanning the view alone left the elided middle unscanned and
// readable. So for a spilled MCP result this gate (1) scans the WHOLE artifact, in chunks, and blocks when
// it cannot be read; (2) on a block replaces the artifact's content, so the link returns a notice; (3)
// records the artifact in the provenance ledger with its trust label BEFORE releasing the view, and
// withholds the view when that record cannot be written; and (4) fences any later local read of that
// artifact (artifact_reentry.ts), which the same `tool_result` handler below routes.
//
// NEVER THROWS. omp skips a handler that throws and passes the result on unchanged, so every failure in
// the handler becomes a withheld result instead.

import type { createAgentSession } from "@oh-my-pi/pi-coding-agent";
import type { TrustLabel } from "../contracts.ts";
import { DEFAULT_POLICY, scanAndDecide, type GateDecision } from "../security/gate.ts";
import { scanAndDecideLarge } from "../security/large_scan.ts";
import { ScannerClient } from "../security/scanner_client.ts";
import {
  PURGED_NOTICE,
  artifactRefs,
  sha256Hex,
  spillAccessFromContext,
  spillArtifactIds,
  worseLabel,
  type SpillAccess,
  type SpillRecord,
} from "../security/spill_provenance.ts";
import { UNTRUSTED_START, UNTRUSTED_END } from "../prompt/assembler.ts";
import { neutralizeDelimiters } from "../prompt/untrusted.ts";
import { gateArtifactReentry, reentryBlockNotice } from "./artifact_reentry.ts";
import { writeStderrNotice } from "./stderr_notice.ts";

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
export interface ToolResultInput extends ToolResultMeta { content: McpContent[]; input?: unknown }

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

/** The replacement text when an MCP result is quarantined — the poison is withheld, only a reason shown. */
export function blockNotice(server: string, reason: string): string {
  return `[BLOCKED by Lucid: quarantined result from MCP server "${server}" — ${reason}. The remote output is withheld.]`;
}

/** Wrap a clean/suspicious MCP result as delimited, trust-labeled untrusted data (never `trusted`). */
export function wrapUntrusted(server: string, decision: GateDecision, rawText: string): string {
  const trust: TrustLabel = decision.trustLabel === "suspicious" ? "suspicious" : "untrusted";
  return `${UNTRUSTED_START}\n[mcp-server name="${neutralizeDelimiters(server)}" trust="${trust}"]\n${neutralizeDelimiters(rawText)}\n${UNTRUSTED_END}`;
}

// ── the extension shell (I/O; wires the pure core to omp's tool_result hook) ──────────────────────────

/** Gate ONE tool_result: `undefined` = leave unchanged (a local built-in tool); otherwise the replacement
 *  result. Fail-closed via scanAndDecide. Exported for direct testing — the omp handler is a thin wrapper. */
export async function gateToolResult(
  scanner: ScannerClient,
  ev: ToolResultInput,
  access: SpillAccess | null = null,
): Promise<GatedResult | undefined> {
  if (!isMcpToolResult(ev)) return undefined; // only MCP/external results; local tools untouched
  const rawText = ev.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n");
  const images = ev.content.flatMap((c) => (c.type === "image" ? [c] : []));
  const server = mcpServerName(ev);
  const spilled = spillArtifactIds(ev.details);
  const decision =
    spilled.length === 0
      ? await scanAndDecide(scanner, rawText, DEFAULT_POLICY)
      : await decideSpilled(scanner, ev, server, rawText, spilled, access);
  if (decision.block) return { content: [{ type: "text", text: blockNotice(server, decision.reason) }], isError: true };
  return { content: [{ type: "text", text: wrapUntrusted(server, decision, rawText) }, ...images] };
}

function failClosedDecision(reason: string): GateDecision {
  return { block: true, reason: `fail-closed: ${reason}`, trustLabel: "quarantined", findings: [], failClosed: true };
}

/** Decide a SPILLED MCP result: the inline view AND the whole of every artifact omp saved for it. Side
 *  effects, in this order: a blocked result has its artifacts purged and recorded `quarantined`; a passing
 *  result is recorded with its label, and a record that cannot be written turns the pass into a block. */
async function decideSpilled(
  scanner: ScannerClient,
  ev: ToolResultInput,
  server: string,
  inlineText: string,
  spilled: readonly string[],
  access: SpillAccess | null,
): Promise<GateDecision> {
  if (access === null) return failClosedDecision("the result was spilled to an artifact that cannot be read for scanning");

  let decision = await scanAndDecide(scanner, inlineText, DEFAULT_POLICY);
  const scanned = new Map<string, { chars: number; sha256: string }>();
  for (const id of spilled) {
    if (decision.block) break;
    let full: string;
    try {
      full = await access.readFull(id);
    } catch {
      decision = failClosedDecision(`spilled artifact ${id} could not be read for scanning`);
      break;
    }
    scanned.set(id, { chars: full.length, sha256: sha256Hex(full) });
    const whole = await scanAndDecideLarge(scanner, full, DEFAULT_POLICY);
    if (whole.block) decision = whole;
    else if (whole.trustLabel === "suspicious") {
      decision = {
        ...decision,
        reason: decision.trustLabel === "suspicious" ? decision.reason : whole.reason,
        trustLabel: "suspicious",
        findings: [...decision.findings, ...whole.findings],
      };
    }
  }

  const record = (id: string, label: SpillRecord["trust_label"], purged: boolean): SpillRecord => ({
    artifact_id: `${access.sessionId}/${id}`,
    session_id: access.sessionId,
    omp_artifact_id: id,
    tool_name: typeof ev.toolName === "string" ? ev.toolName : "mcp",
    source: `mcp:${server}`,
    trust_label: label,
    total_chars: scanned.get(id)?.chars ?? null,
    content_sha256: scanned.get(id)?.sha256 ?? null,
    purged,
    created_at: new Date().toISOString(),
  });
  const quarantine = async (): Promise<void> => {
    for (const id of spilled) {
      const purged = await access.purge(id, PURGED_NOTICE);
      // The in-memory record is kept even when the durable write throws, so this process still withholds
      // a read of the artifact; a failed purge AND a failed write is the one case a restart can lose.
      try { access.ledger.record(record(id, "quarantined", purged)); } catch { /* held in memory */ }
    }
  };

  if (decision.block) {
    await quarantine();
    return decision;
  }
  const label = worseLabel("untrusted", decision.trustLabel === "suspicious" ? "suspicious" : "untrusted");
  try {
    for (const id of spilled) access.ledger.record(record(id, label, false));
  } catch {
    await quarantine(); // no provenance record, no content
    return failClosedDecision("the provenance record for the spilled result could not be written");
  }
  return decision;
}

/** Build the extension against an injected scanner (DI / test seam). */
export function createMcpResultGate(scanner: ScannerClient): ExtensionFactory {
  return (pi) => {
    pi.on("tool_result", async (event, ctx) => handleToolResult(scanner, event, ctx));
  };
}

/** The whole `tool_result` handler: an MCP result goes through the gate, any other result through the
 *  artifact re-entry gate. Never throws (see NEVER THROWS in the header). Exported for direct testing. */
export async function handleToolResult(scanner: ScannerClient, event: ToolResultInput, ctx: unknown): Promise<GatedResult | undefined> {
  const mcp = isMcpToolResult(event);
  try {
    const access = spillAccessFromContext(ctx);
    const gated = mcp ? await gateToolResult(scanner, event, access) : await gateArtifactReentry(scanner, event, access);
    if (gated?.isError) {
      writeStderrNotice(
        mcp
          ? `\n🛡️  [LucidAgentIDE] withheld a quarantined MCP result from "${mcpServerName(event)}"\n`
          : `\n🛡️  [LucidAgentIDE] withheld a read of an artifact that came from an external source\n`,
      );
    }
    return gated;
  } catch {
    // A failure inside the gate must not let the result through. An MCP result is withheld outright. A
    // local result is withheld only when its input names an artifact; any other local result is not this
    // gate's to rule on and passes as it always has.
    if (mcp) return { content: [{ type: "text", text: blockNotice(mcpServerName(event), "fail-closed: the result gate failed") }], isError: true };
    let dir: string | null = null;
    try { dir = spillAccessFromContext(ctx)?.artifactsDir ?? null; } catch { /* no directory to match paths against; artifact:// links still match */ }
    let namesArtifact = true; // an input that cannot be read counts as naming one
    try {
      const refs = artifactRefs(event.input, dir);
      namesArtifact = refs.ids.length > 0 || refs.wholeDir;
    } catch { /* keep true */ }
    if (!namesArtifact) return undefined;
    return { content: [{ type: "text", text: reentryBlockNotice([], "fail-closed: the result gate failed") }], isError: true };
  }
}

// Default export: the live extension omp loads via `-e`. Creates + starts the scanner lazily so importing
// the pure core / factory for tests is side-effect-free.
const mcpResultGate: ExtensionFactory = (pi) => {
  const scanner = new ScannerClient();
  scanner.start();
  createMcpResultGate(scanner)(pi);
};

export default mcpResultGate;
