// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/preamble.ts
//
// Builds the per-turn USER-TURN PREAMBLE that acp_backend prepends to the typed message
// (never the frozen prefix; invariant #5/#6 — these live AFTER the cache breakpoint, so
// re-sending them every turn does not bust the prefix KV cache).
//
// Issue #54: STANDING guidance (the active persona, the active bundled skill, and the live
// <user-profile> personalization profile) is re-delivered EVERY turn so it does not fade across
// a long conversation. The cross-session <recalled-memory> block is a one-time SESSION-START
// recall of prior-session facts (not standing guidance), so it is delivered ONCE per session.

export interface PreambleState {
  /** Active AskSage persona, already scanned + delimiter-wrapped, or null. */
  persona: string | null;
  /** Active bundled skill, already `<active-skill …>`-wrapped, or null. */
  skill: string | null;
  /** Live <user-profile> personalization block (recallPreamble()), re-read each turn; "" when off. */
  profile: string;
  /** P-DESIGN.1 (ADR-0154): the project's DESIGN.md invariants (already `<design-invariants>`-wrapped), or ""
   *  when there's no DESIGN.md. STANDING guidance — re-delivered every turn so design work keeps honoring it. */
  designInvariants?: string;
  /** P-VOICE.5 (ADR-0248): the `<spoken-reply>` block when the user is hands-free in conversation mode, else
   *  null/"". STANDING for as long as the mode is on, and it vanishes the turn after it is switched off \u2014 it
   *  is rebuilt from the live voice settings every turn, exactly like the share-awareness block. */
  spokenReply?: string | null;
  /** CREATOR-0 (ADR-0284): the `<critical>` Creator-mode block, present only while a CREATOR build is in
   *  CREATOR mode. STANDING while the mode is on and gone the turn after it is switched off, exactly like
   *  spokenReply - it is rebuilt from the live mode every turn and never enters the frozen prefix. */
  creatorMode?: string | null;
  /** Cross-session <recalled-memory> block, or null. Delivered once per session. */
  memoryRecall: string | null;
  /** Whether the cross-session recall has already been delivered this session. */
  memoryRecallDelivered: boolean;
}

export interface PreambleResult {
  /** The assembled preamble to prepend to the user's typed text (may be ""). */
  preamble: string;
  /** Updated once-per-session flag for the cross-session recall. */
  memoryRecallDelivered: boolean;
}

/** Assemble the user-turn preamble. Persona, skill, and profile are STANDING (every turn);
 *  the cross-session memory recall is one-time per session. Pure + deterministic. */
export function buildUserTurnPreamble(s: PreambleState): PreambleResult {
  let preamble = "";
  if (s.persona) preamble += `${s.persona}\n\n`;
  if (s.skill) preamble += `${s.skill}\n\n`;
  if (s.profile) preamble += `${s.profile}\n\n`;
  if (s.designInvariants) preamble += `${s.designInvariants}\n\n`; // P-DESIGN.1: honor DESIGN.md every turn
  // CREATOR-0: the Creator workspace rules sit with the other standing guidance, above the spoken-reply
  // block so "answer for the ear" stays nearest the user's words.
  if (s.creatorMode) preamble += `${s.creatorMode}\n\n`;
  // P-VOICE.5: LAST of the standing blocks, so "answer for the ear" is the nearest instruction to the user's
  // own words - it shapes the reply without displacing the persona/skill guidance above it.
  if (s.spokenReply) preamble += `${s.spokenReply}\n\n`;
  let memoryRecallDelivered = s.memoryRecallDelivered;
  if (s.memoryRecall && !memoryRecallDelivered) {
    preamble += `${s.memoryRecall}\n\n`;
    memoryRecallDelivered = true;
  }
  return { preamble, memoryRecallDelivered };
}
