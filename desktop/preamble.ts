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
  let memoryRecallDelivered = s.memoryRecallDelivered;
  if (s.memoryRecall && !memoryRecallDelivered) {
    preamble += `${s.memoryRecall}\n\n`;
    memoryRecallDelivered = true;
  }
  return { preamble, memoryRecallDelivered };
}
