// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/stall_notice.ts — P-STALL.1 (ADR-0186): provider-silence wording (pure).
//
// During provider overload a model can sit for minutes before its first token. The backend now waits
// up to 10 minutes (was 5, with an error that falsely said "2 minutes") and emits a { type:"slow" }
// event at each silent 2-minute mark. These helpers turn that into honest UI copy: the HUD phase line
// and a once-per-turn toast. Pure so the wording (and the minute math) is unit-testable.

/** The HUD phase line while the provider is silent. Repeats/updates each notice. */
export function slowPhaseLabel(waitedMs: number): string {
  const m = Math.max(1, Math.floor(waitedMs / 60_000));
  return `Still waiting on the provider · silent for ${m} min`;
}

/** The once-per-turn toast explaining WHY the wait is happening and what LUCID is doing about it. */
export function slowToastCopy(waitedMs: number, capMs: number): { title: string; desc: string } {
  const m = Math.max(1, Math.floor(waitedMs / 60_000));
  const cap = Math.round(capMs / 60_000);
  return {
    title: "The provider is slow to respond",
    desc: `Nothing received for ${m} min - models can be overloaded at peak times. LUCID keeps this turn alive for up to ${cap} minutes so you don't lose your place in the queue; Stop cancels it.`,
  };
}

/** The backend's patience, mirrored for the toast copy (acp_backend.IDLE_MS). */
export const TURN_PATIENCE_MS = 600_000;
