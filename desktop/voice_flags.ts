// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/voice_flags.ts - P-VOICE.8 (ADR-0400): the read-aloud flags have ONE rule set, used by the engine
// (settings_store.setVoiceSettings) and by every renderer control (the composer's voice popover, the
// Settings Voice card, Ctrl+G, the LUCID Agent stage), so the two checkbox surfaces can never disagree
// and a click means exactly what it says. Pure: no Node or DOM imports.
//
//   auto-speak   read replies aloud as they stream.
//   conversation the hands-free loop on top of it (the mic opens when the reply finishes). It cannot run
//                without auto-speak, so turning auto-speak OFF turns conversation off for good (stored too,
//                never a masked preference that comes back when auto-speak returns), and turning
//                conversation ON turns auto-speak on.
//   digest       HOW replies are spoken (a short digest for slow engines). A preference, not an action:
//                it survives auto-speak off and only takes effect while auto-speak is on.

export interface ReadAloudFlags {
  ttsAutoSpeak: boolean;
  ttsConversation: boolean;
  ttsDigest: boolean;
}

/** The effective flags from stored values: conversation and digest only count while auto-speak is on. */
export function effectiveReadAloud(stored: Partial<ReadAloudFlags>): ReadAloudFlags {
  const auto = stored.ttsAutoSpeak === true;
  return { ttsAutoSpeak: auto, ttsConversation: auto && stored.ttsConversation === true, ttsDigest: stored.ttsDigest === true };
}

/** Apply one change to the EFFECTIVE flags. Turning auto-speak off wins over anything else in the same
 *  patch (never keep talking or listening when told to stop); turning conversation on brings auto-speak
 *  with it. Idempotent: applying the same patch twice gives the same flags. */
export function applyReadAloudPatch(cur: ReadAloudFlags, patch: Partial<ReadAloudFlags>): ReadAloudFlags {
  let { ttsAutoSpeak, ttsConversation, ttsDigest } = cur;
  if (patch.ttsAutoSpeak !== undefined) ttsAutoSpeak = patch.ttsAutoSpeak === true;
  if (patch.ttsConversation !== undefined) ttsConversation = patch.ttsConversation === true;
  if (patch.ttsDigest !== undefined) ttsDigest = patch.ttsDigest === true;
  if (patch.ttsAutoSpeak === false) ttsConversation = false;
  else if (patch.ttsConversation === true) ttsAutoSpeak = true;
  if (!ttsAutoSpeak) ttsConversation = false;
  return { ttsAutoSpeak, ttsConversation, ttsDigest };
}

/** True when the patch changes any read-aloud flag (the renderer applies those optimistically). */
export function touchesReadAloud(patch: object): boolean {
  return "ttsAutoSpeak" in patch || "ttsConversation" in patch || "ttsDigest" in patch;
}
