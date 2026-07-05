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
// P-TOOLFAIL.2 (ADR-0163) adds the EXPANDED view's raw material: `toolFailureCommand`
// (the command/code the call attempted, from rawInput or omp's `$ …` title) and
// `toolFailureDetail` (the full multi-line error text, newlines preserved) — so the
// collapsed toolbox badge can expand into a "Tool Call Actions" list that shows exactly
// what was attempted and exactly what came back.
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

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Every human-readable fragment omp attached to a tool_call_update, in order — across the
 *  shapes it uses: a `content[]` array (text directly, or nested `content.text`), a `rawOutput`
 *  string or `{ error }`, or a top-level `message`/`error`/`reason`. */
function messageParts(u: unknown): string[] {
  if (!isRecord(u)) return [];
  const parts: string[] = [];
  if (Array.isArray(u.content)) {
    for (const c of u.content) {
      if (!isRecord(c)) continue;
      const nested = isRecord(c.content) ? str(c.content.text) : "";
      const t = str(c.text) || nested;
      if (t) parts.push(t);
    }
  }
  const ro = u.rawOutput;
  if (typeof ro === "string") parts.push(ro);
  else if (isRecord(ro) && typeof ro.error === "string") parts.push(ro.error);
  for (const k of ["message", "error", "reason"] as const) {
    const v = str(u[k]);
    if (v) parts.push(v);
  }
  return parts;
}

/** Pull any human-readable message omp attached to a tool_call_update. Normalized whitespace,
 *  length-capped for the one-line chip. Returns "" when omp gave us nothing to show. */
export function toolFailureMessage(u: unknown): string {
  return messageParts(u).join(" ").replace(/\s+/g, " ").trim().slice(0, 160);
}

/** P-TOOLFAIL.2: the FULL error text for the expanded "Tool Call Actions" row — same sources as
 *  toolFailureMessage, but line structure preserved (CRLF normalized, trailing space trimmed) and
 *  a much higher cap, so a multi-line tool error reads like the terminal output it came from. */
export function toolFailureDetail(u: unknown): string {
  return messageParts(u)
    .join("\n")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/\s+$/g, ""))
    .join("\n")
    .trim()
    .slice(0, 2000);
}

/** P-TOOLFAIL.2: the command/code the failed call ATTEMPTED. Prefers the tool's own rawInput
 *  (same key set the exec-approval path reads); falls back to omp's call title, which for exec
 *  tools is the `$ <command>` summary (the `$ ` marker is stripped — the renderer adds its own).
 *  Returns "" when nothing command-like exists (e.g. a browser tool). */
export function toolFailureCommand(u: unknown): string {
  if (!isRecord(u)) return "";
  const ri = isRecord(u.rawInput) ? u.rawInput : isRecord(u.input) ? u.input : {};
  for (const k of ["command", "cmd", "script", "code", "source", "input"] as const) {
    const v = str(ri[k]).trim();
    if (v) return v.slice(0, 400);
  }
  const title = str(u.title).trim();
  if (title.startsWith("$ ")) return title.slice(2).trim().slice(0, 400);
  return "";
}

/** Build the neutral chip text for a failed/rejected tool call. `failed` ⇒ ran and errored;
 *  anything else (`rejected`) ⇒ did not run. Surfaces omp's message when present; otherwise a
 *  clear fallback that does NOT imply a security denial (the old "tool call rejected" did). */
export function toolFailureReason(u: unknown): ToolFailure {
  const didRun = isRecord(u) && u.status === "failed";
  const msg = toolFailureMessage(u);
  const label = didRun ? "tool failed" : "tool did not run";
  return { didRun, reason: msg ? `${label}: ${msg}` : label };
}
