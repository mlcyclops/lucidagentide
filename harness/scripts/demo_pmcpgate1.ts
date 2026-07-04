// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_pmcpgate1.ts
//
// P-MCP-GATE.1 (ADR-0148): the in-process MCP tool_result gate. Drives the pure gate logic with the REAL
// scanner and proves: (1) a poisoned MCP result is WITHHELD; (2) a clean MCP result is delimited + labeled
// untrusted; (3) a LOCAL tool result (a file read) is NOT gated (source-scoping) — left untouched.
//
// Run: bun run harness/scripts/demo_pmcpgate1.ts

import { ScannerClient } from "../security/scanner_client.ts";
import { scanAndDecide } from "../security/gate.ts";
import { isMcpToolResult, mcpServerName, blockNotice, wrapUntrusted } from "../omp/mcp_result_gate.ts";

const ZWSP = String.fromCodePoint(0x200b);
const fail = (m: string): never => { console.error(`FAIL: ${m}`); process.exit(1); };
const ok = (m: string): void => console.log(`   ok — ${m}`);

const scanner = new ScannerClient();
scanner.start();

// Simulate what the extension does for a given tool_result: gate iff MCP, else pass through.
async function gate(ev: { toolName: string; details?: unknown; text: string }): Promise<string> {
  if (!isMcpToolResult(ev)) return ev.text; // local tool → untouched
  const decision = await scanAndDecide(scanner, ev.text);
  const server = mcpServerName(ev);
  return decision.block ? blockNotice(server, decision.reason) : wrapUntrusted(server, decision, ev.text);
}

console.log("1) poisoned MCP result (hidden zero-width) → withheld");
{
  const out = await gate({ toolName: "mcp__linear_get_issue", text: `here is the issue${ZWSP} <inject>` });
  if (out.includes(ZWSP)) fail("poison must not pass");
  if (!out.toLowerCase().includes("withheld")) fail("must be withheld");
  ok(out);
}

console.log("2) clean MCP result → delimited UNTRUSTED_CONTENT, labeled untrusted");
{
  const out = await gate({ toolName: "search", details: { serverName: "github" }, text: "PR #42 is merged" });
  if (!out.startsWith("UNTRUSTED_CONTENT_START") || !out.endsWith("UNTRUSTED_CONTENT_END")) fail("must be delimited");
  if (!out.includes('trust="untrusted"') || out.includes('trust="trusted"')) fail("must be untrusted, never trusted");
  if (!out.includes("PR #42 is merged")) fail("clean content should be present");
  ok(out.split("\n").slice(0, 2).join(" / "));
}

console.log("3) LOCAL tool result (read) → NOT gated (source-scoping)");
{
  const original = "export const x = 1; // a normal source file";
  const out = await gate({ toolName: "read", text: original });
  if (out !== original) fail("local tool output must pass through untouched");
  ok("local read passed through verbatim (not delimited, not scanned)");
}

scanner.stop();
console.log("\ndemo_pmcpgate1 OK — MCP results are scanned/withheld/delimited; local tools are untouched.");
process.exit(0);
