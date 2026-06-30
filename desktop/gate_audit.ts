// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/gate_audit.ts — P-ENT.4 (ADR-0069): attribute a per-action gate DENIAL so the audit (and a future
// chip) can answer "did I deny it, or did it auto-deny?". Pure — the deny paths in acp_backend (exec + egress
// approval) call this so every denial is recorded with an honest cause, including the fail-closed paths that
// used to settle silently (a denial with no SecurityEvent — the gap this closes).

/** Human reason for a gate deny outcome:
 *  - timed out (no response within the prompt window) → fail-closed, NOT the user;
 *  - resolved with no optionId (the turn ended / disconnected while pending) → fail-closed, NOT the user;
 *  - resolved with a deny optionId (the user clicked Block) → an explicit user decision. */
export function gateDenyReason(optionId: string | null | undefined, timedOut = false): string {
  if (timedOut) return "fail-closed (no response in 5m)";
  if (!optionId) return "fail-closed (turn ended)";
  return "denied by you";
}
