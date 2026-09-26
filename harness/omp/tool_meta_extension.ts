// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/omp/tool_meta_extension.ts - P-EVAL.4 (ADR-0318): tell the desktop the REAL name of every tool
// call, because ACP structurally cannot.
//
// THE DEFECT THIS FIXES. omp's ACP tool_call update is built by `buildToolCallStartUpdate`
// (node_modules/@oh-my-pi/pi-coding-agent/src/modes/acp/acp-event-mapper.ts:410-417) and carries exactly
// five fields: toolCallId, title, kind, status, rawInput. The tool's NAME is never transmitted. Two
// consequences the desktop lived with:
//   1. `kind` is a coarse enum (mapToolKind: read | edit | execute | search | fetch | think | other), so
//      EVERY custom tool - every LUCID extension tool, every MCP tool - arrives as "other".
//   2. `title` used to read `"<toolName>: <subject>"`, which is what the desktop scraped instead. With
//      intent tracing on (omp injects an `i` field into every tool schema) `buildToolTitle` returns the
//      MODEL'S PROSE instead, so the name vanished from there too. That is the same shadowing that broke
//      preview_open and the preview activity pills (ADR-0308).
// Net effect on the product: the engineering report's per-tool breakdown degraded to "other x23" and the
// chat's tool chips lost their labels. This is the "reports are missing a lot of detail they used to
// have" the user reported.
//
// WHY A SELF-REPORT CHANNEL. The hook API DOES have the name: `pi.on("tool_call")` fires in-process
// inside omp with `{ toolName, toolCallId, input }`, and `pi.on("tool_result")` adds `isError`. omp's
// process has no channel to the Electron renderer, so we reuse the exact pattern ADR-0308 established for
// preview_open: the omp child inherits a ready token'd URL (LUCID_TOOL_META_URL) and POSTs to it. The
// desktop joins on toolCallId, which BOTH sides have.
//
// WHY THIS IS NOT THE SECURITY GATE. security_extension.ts already registers a `tool_call` hook and can
// BLOCK. This module is observability only: it never inspects content, never returns a verdict, and never
// awaits. Keeping it a separate extension keeps the gate's decision path free of reporting work, and means
// a failure here can only cost a label, never a security decision.
//
// FAIL-SOFT BY DESIGN (deliberately the opposite of the gate). Telemetry is not a security control: if the
// URL is unset, the POST fails, or the hook API is missing, the correct outcome is a coarser report, not a
// blocked tool call. Every path is wrapped and fire-and-forget.

/** One report. `ok` is absent on the start event and set on the result event, so the desktop can upgrade
 *  a pending call to a settled one without a second lookup. */
export interface ToolMetaReport {
  id: string;
  name: string;
  ok?: boolean;
}

/** The sliver of omp's ExtensionAPI this module touches. Declared structurally (rather than importing
 *  omp's types, which are not exported to `-e` extensions) so nothing here is `any`: the hook payloads
 *  arrive off a process boundary and are narrowed by the guards below before use. */
interface OmpHookApi {
  on?: (event: "tool_call" | "tool_result", handler: (event: unknown) => void) => void;
}

/** Narrow a hook payload to the two fields we need. Returns null when either is missing or empty, so a
 *  future omp that renames a field degrades to "no label" instead of posting `undefined` strings. */
export function readToolMeta(event: unknown): ToolMetaReport | null {
  if (!event || typeof event !== "object") return null;
  const name = "toolName" in event && typeof event.toolName === "string" ? event.toolName.trim() : "";
  const id = "toolCallId" in event && typeof event.toolCallId === "string" ? event.toolCallId.trim() : "";
  if (!name || !id) return null;
  // isError is optional on the start event and on tools that do not report it; only translate it to `ok`
  // when it is genuinely a boolean, so "unknown" stays unknown rather than becoming a confident "passed".
  const isError = "isError" in event ? event.isError : undefined;
  return typeof isError === "boolean" ? { id, name, ok: !isError } : { id, name };
}

export default function toolMetaExtension(pi: unknown): void {
  try {
    const api = (pi ?? {}) as OmpHookApi;
    if (typeof api.on !== "function") return; // older omp / no hook API: no-op, the desktop falls back to `kind`
    const url = (process.env.LUCID_TOOL_META_URL ?? "").trim();
    if (!url) return; // not launched by the desktop (bare `omp` / a test): nothing to report to

    const post = (report: ToolMetaReport): void => {
      // Fire-and-forget. No await, no retry, no backpressure: a slow desktop must never stall a tool call,
      // and a dropped label costs a coarser report and nothing else.
      void fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(report),
      }).catch(() => { /* observability only; never surfaces to the model or the gate */ });
    };

    // Start: the name is available here, and this fires BEFORE the tool runs, so the desktop usually has
    // the label by the time it renders the chip. The join is on toolCallId, so late arrival is still correct.
    api.on("tool_call", (event) => {
      const m = readToolMeta(event);
      if (m) post(m);
    });
    // Settle: same id, now carrying pass/fail. This is what lets the report say "bash x3 (1 failed)"
    // instead of only counting calls.
    api.on("tool_result", (event) => {
      const m = readToolMeta(event);
      if (m) post(m);
    });
  } catch {
    /* A reporting extension must never break omp launch. Worst case: labels fall back to the ACP `kind`. */
  }
}
