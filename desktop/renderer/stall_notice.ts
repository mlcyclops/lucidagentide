// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/stall_notice.ts - provider-silence wording (pure).
//
// P-STALL.1 (ADR-0186) made a silent provider VISIBLE: a { type:"slow" } event at each quiet 2-minute
// mark. P-STALL.2 (ADR-0263) removed the 10-minute turn cutoff that was killing legitimately long
// work (subagent fan-outs routinely run longer than any fixed clock), so the copy no longer names a
// cap: the turn waits as long as the work takes, Stop is the way out, and each notice now NAMES the
// open tool calls / spawned subagent tasks the turn is waiting on. Pure so the wording (and the
// minute math) is unit-testable.

/** One pending call as carried on the { type:"slow" } event (chat_events.ts). */
export interface SlowPending {
  label: string;
  elapsedMs: number;
}

/** The HUD phase line while the provider is silent. Repeats/updates each notice; when the turn is
 *  waiting on live tool calls / subagents, the count makes the quiet legible. */
export function slowPhaseLabel(waitedMs: number, pending?: SlowPending[]): string {
  const m = Math.max(1, Math.floor(waitedMs / 60_000));
  if (pending?.length) return `Working · waiting on ${pending.length} task${pending.length === 1 ? "" : "s"} · quiet for ${m} min`;
  return `Still waiting on the provider · silent for ${m} min`;
}

/** "Waiting on: subagent explore: map callers (12m) · bash: cargo build (3m) · +2 more" - the visible
 *  answer to "what is it actually doing?". Null when nothing is tracked (pre-first-token silence). */
export function pendingSummaryLine(pending: SlowPending[] | undefined, show = 3): string | null {
  if (!pending?.length) return null;
  const mins = (ms: number) => { const m = Math.floor(ms / 60_000); return m >= 1 ? `${m}m` : "<1m"; };
  const head = pending.slice(0, show).map((p) => `${p.label} (${mins(p.elapsedMs)})`).join(" · ");
  const rest = pending.length - show;
  return `Waiting on: ${head}${rest > 0 ? ` · +${rest} more` : ""}`;
}

/** The once-per-turn toast explaining WHY the wait is happening and the one real way out (Stop). */
export function slowToastCopy(waitedMs: number, pending?: SlowPending[]): { title: string; desc: string } {
  const m = Math.max(1, Math.floor(waitedMs / 60_000));
  const tail = pendingSummaryLine(pending);
  return {
    title: pending?.length ? "Long-running work in progress" : "The provider is slow to respond",
    desc: `Nothing received for ${m} min. ${pending?.length
      ? "The turn is waiting on running tasks and will take as long as the work needs - it is not stuck."
      : "Models can be overloaded at peak times; the turn waits as long as it takes so you never lose your place in the queue."} Stop cancels it.${tail ? `\n${tail}` : ""}`,
  };
}
