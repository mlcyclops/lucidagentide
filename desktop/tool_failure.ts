// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/tool_failure.ts — P-TOOLFAIL.1 (ADR-0093): turn omp's GENERIC failed/rejected
// tool_call_update into an HONEST, specific chip reason.
//
// omp fires one signal for two very different things: a tool that RAN and errored
// (status "failed"), and a tool that DID NOT run — refused, unavailable, or cancelled
// (status "rejected"). The old chip flattened both to a flat "tool call rejected", which
// read as a security/permission DENIAL even when the real cause was "no such tool" or a
// plain runtime error. (See ADR-0093: a turn whose browser-open + js-execute calls showed
// "rejected" with NO approval prompt and NO audit record — because the gate never ran; the
// tools simply weren't available, and the chip mislabeled a failure as a denial.)
//
// This module is PURE (no I/O) so it is over-testable. The gate's own security blocks do NOT
// flow through here — those are surfaced from the gate's stderr signal (acp_backend onStderr).
// A reason produced here is therefore NEVER a security quarantine; it means "the tool failed
// or didn't run", and the chip that renders it stays neutral.

/** A failed/rejected tool_call_update reduced to what the neutral chip needs. */
export interface ToolFailure {
  /** true = the tool ran and errored ("failed"); false = it never ran ("rejected": refused / unavailable / cancelled). */
  didRun: boolean;
  /** The chip text — omp's own message when present, else a clear, non-accusatory fallback. */
  reason: string;
}

/** Pull any human-readable message omp attached to a tool_call_update — across the shapes it
 *  uses: a `content[]` array (text directly, or nested `content.text`), a `rawOutput` string or
 *  `{ error }`, or a top-level `message`/`error`/`reason`. Normalized whitespace, length-capped.
 *  Returns "" when omp gave us nothing to show. */
export function toolFailureMessage(u: any): string {
  const parts: string[] = [];
  const content = u?.content;
  if (Array.isArray(content)) {
    for (const c of content) {
      const t = typeof c?.text === "string" ? c.text
        : typeof c?.content?.text === "string" ? c.content.text
        : "";
      if (t) parts.push(t);
    }
  }
  const ro = u?.rawOutput;
  if (typeof ro === "string") parts.push(ro);
  else if (ro && typeof ro.error === "string") parts.push(ro.error);
  for (const k of ["message", "error", "reason"]) {
    if (typeof u?.[k] === "string") parts.push(u[k]);
  }
  return parts.join(" ").replace(/\s+/g, " ").trim().slice(0, 160);
}

/** Build the neutral chip text for a failed/rejected tool call. `failed` ⇒ ran and errored;
 *  anything else (`rejected`) ⇒ did not run. Surfaces omp's message when present; otherwise a
 *  clear fallback that does NOT imply a security denial (the old "tool call rejected" did). */
export function toolFailureReason(u: any): ToolFailure {
  const didRun = u?.status === "failed";
  const msg = toolFailureMessage(u);
  const label = didRun ? "tool failed" : "tool did not run";
  return { didRun, reason: msg ? `${label}: ${msg}` : label };
}
