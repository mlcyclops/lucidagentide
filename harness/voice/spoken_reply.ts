// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/voice/spoken_reply.ts
//
// P-VOICE.5 (ADR-0247): in conversation mode the reply is HEARD, not read - so the agent has to be told to
// write for the ear, automatically.
//
// Without this, hands-free voice is unusable in practice. The model answers the way it always does: headings,
// numbered lists, tables, code fences, file paths. speakable() strips the markdown, but what is left is still
// a written answer read at dictation speed - forty seconds of prose where a sentence would do, and a list of
// four options the listener has already forgotten by item three. Users work this out and start every voice
// session by typing "keep it short so I can understand you", which is exactly the instruction the app should
// be issuing on their behalf.
//
// Delivered as a TRUSTED, delimited block on the USER-TURN preamble - the same channel as the active skill,
// the DESIGN.md invariants and the share-awareness block (never the frozen prefix, invariant #6), so it is
// rebuilt every turn and simply VANISHES the moment conversation mode is switched off.
//
// Deliberately NOT applied to plain auto-speak: there the user is watching the screen while listening along,
// and a rich written answer is still the right answer. Only hands-free turn-taking changes the medium.
//
// Pure: a mode in, a string or null out.

/** How the user is consuming this reply. */
export type ReplyMedium =
  /** Reading on screen; audio is off or click-to-play. Nothing is imposed. */
  | "screen"
  /** Auto-speak: the reply is read aloud WHILE the user watches it stream. Still a written answer. */
  | "narrated"
  /** Conversation mode: hands-free, eyes-off, mic opens when the reply ends. Write for the ear. */
  | "conversation";

/** The guidance block for a spoken turn, or null when the medium imposes nothing.
 *
 *  The rules are deliberately about SHAPE, not personality - they must not fight the user's own persona,
 *  their CLAUDE.md, or an active skill. Nothing here changes WHAT the agent says; it changes how much of it
 *  arrives at once and in what form. */
export function spokenReplyGuidance(medium: ReplyMedium): string | null {
  if (medium !== "conversation") return null;
  return [
    `<spoken-reply mode="conversation">`,
    "This reply will be read aloud and the user is hands-free - listening, not looking at the screen. Write for the ear:",
    "- Lead with the answer. Two or three short sentences is the target; one is often better.",
    "- Plain spoken prose only. No headings, bullet or numbered lists, tables, bold/italic marks, or emoji - they are read as noise or dropped, and a list is unfollowable by ear.",
    "- No code blocks, file paths, URLs, hashes or long identifiers unless the user explicitly asks for one. Say \"I put it in the settings file\", not the path.",
    "- Ask at most one short follow-up question, and only when you genuinely cannot proceed without it.",
    "- When the honest answer really is long, say the two-sentence version aloud and add that the detail is on screen. Never read the long version out.",
    "- Keep doing the work exactly as thoroughly as usual. This constrains the ANSWER's shape, not the effort behind it.",
    "</spoken-reply>",
  ].join("\n");
}

/** Pick the medium from the two voice toggles. Conversation mode implies auto-speak (the store enforces it),
 *  but this stays defensive: a stale renderer flag must never put the agent in eyes-off mode while the reply
 *  is only being displayed. */
export function replyMedium(autoSpeak: boolean, conversation: boolean): ReplyMedium {
  if (autoSpeak && conversation) return "conversation";
  return autoSpeak ? "narrated" : "screen";
}
