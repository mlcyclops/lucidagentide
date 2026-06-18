// harness/tools/result_adapter.ts
//
// ┌─────────────────────────────────────────────────────────────────────────┐
// │  FROZEN CONTRACT (CLAUDE.md). This is the ONLY place omp's                │
// │  `AgentToolResult` and the PRD `ToolResult` are allowed to meet.          │
// │  Import this module everywhere a conversion is needed; never hand-roll    │
// │  the mapping elsewhere. Changing the mapping is its own increment + ADR.  │
// └─────────────────────────────────────────────────────────────────────────┘
//
// We import omp's REAL type (ADR-0003) so that if omp changes AgentToolResult,
// THIS file fails to compile — the boundary breaks loudly, by design.

import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { ToolResult } from "../contracts.ts";

// omp content items are `{ type:"text", text }` | `{ type:"image", data, mimeType }`.
// We flatten text parts for the PRD `summary`; non-text parts are preserved in
// `payload` so nothing is silently dropped.

/** omp `AgentToolResult` → PRD `ToolResult`. */
export function fromOmpResult(
  toolName: string,
  result: AgentToolResult,
  durationMs: number,
): ToolResult {
  const textParts: string[] = [];
  const nonText: AgentToolResult["content"] = [];
  for (const part of result.content) {
    if (part.type === "text") textParts.push(part.text);
    else nonText.push(part);
  }
  // omp convention: `isError === true` means the tool failed. Absence ⇒ success.
  const success = result.isError !== true;
  return {
    tool_name: toolName,
    success,
    summary: textParts.join("\n"),
    payload: {
      details: result.details,
      // keep the full original content for forensic/replay fidelity
      content: result.content,
      nonTextParts: nonText,
      useless: result.useless ?? false,
    },
    duration_ms: durationMs,
  };
}

/** PRD `ToolResult` → omp `AgentToolResult`. */
export function toOmpResult(result: ToolResult): AgentToolResult {
  return {
    content: [{ type: "text", text: result.summary }],
    details: result.payload,
    isError: result.success ? undefined : true,
  };
}
