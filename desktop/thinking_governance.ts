// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Thinking-item governance (R-04, ADR-0054).
//
// omp made reasoning/thinking items first-class (a `--thinking` flag, reasoning items in replay). They
// are a sensitive surface: if persisted, learned-from, recalled, or exported, raw model reasoning
// could bypass the scan/trust-label gate, leak into semantic memory, or escape CUI exclusion.
//
// The policy (ratifying ADR-0027's display-only posture as a security invariant): only assistant
// **token** text is "learnable" — eligible to be persisted (recordTurns) and learned-from (the
// personalization distiller / memory promotion). Thinking, tool, block, subagent, usage, etc. are
// DISPLAY-ONLY: never persisted, never promoted, never re-fed to a prompt — and therefore never reach
// an export (exports read persisted data). A future change that wants to persist thinking MUST first
// scan + trust-label + promotion-gate + CUI-exclude it; this predicate is the single chokepoint that
// decides what a turn contributes to durable state.

import type { ChatEvent } from "./acp_backend.ts";

/** True only for assistant token text — the one event kind eligible for persistence + learning. */
export function isLearnableAssistantText(e: ChatEvent): e is Extract<ChatEvent, { type: "token" }> {
	return e.type === "token";
}

/** Accumulate ONLY the learnable assistant text from a turn's events (thinking et al. excluded). */
export function accumulateAssistantText(events: Iterable<ChatEvent>): string {
	let out = "";
	for (const e of events) if (isLearnableAssistantText(e)) out += e.text;
	return out;
}
