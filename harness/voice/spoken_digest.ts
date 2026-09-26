// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/voice/spoken_digest.ts - P-VOICE.6: the slow-engine spoken digest.
//
// dots.tts on the DGX synthesizes roughly 5-10 seconds of wall-clock per clip, so narrating a long
// reply verbatim queues minutes of synthesis behind a WireGuard hop. The composer keeps the full
// verbatim text; the AUDIO gets a short model-written digest instead: the renderer speaks the first
// settled sentence immediately (the comprehension anchor - the user hears something within one
// synthesis round-trip), suppresses the verbatim middle, and when the turn settles it speaks this
// digest of the whole reply. The user hears WHAT happened, not every token of it.
//
// Pure prompt-building only: the caller owns the completion seam (backend.complete) and the fallback
// (an empty/failed digest means "speak the tail verbatim", never silence).

/** Below this many characters a digest costs more latency than it saves - speak verbatim instead.
 *  Sized so a two-or-three-sentence reply (which IS its own digest) never takes the extra round-trip. */
export const DIGEST_MIN_CHARS = 360;

/** Hard cap on what we send to the digest completion; replies beyond this are truncated head+tail
 *  (the opening states the conclusion, the tail carries the verification - the middle is tool noise). */
export const DIGEST_INPUT_CAP = 12_000;

/** Build the {system, user} pair for the digest completion. The system prompt writes for the EAR:
 *  the same rules as the hands-free spoken-reply guidance (P-VOICE.5), compressed to a summarizer. */
export function digestSpokenReply(fullText: string): { system: string; user: string } {
  const t = fullText.trim();
  const clipped = t.length <= DIGEST_INPUT_CAP
    ? t
    : `${t.slice(0, DIGEST_INPUT_CAP / 2)}\n[...]\n${t.slice(-DIGEST_INPUT_CAP / 2)}`;
  return {
    system:
      "You compress an assistant's reply into a short SPOKEN digest that will be read aloud by TTS. " +
      "Rules: at most three short sentences; plain spoken prose only - no lists, headings, markdown, code, " +
      "URLs, file paths, or long identifiers (say 'the settings file', not the path); keep the concrete " +
      "outcome, key numbers, and any action the listener must take; keep the reply's first-person voice; " +
      "never say you are summarizing. If the reply is already two sentences or fewer of plain prose, " +
      "return it unchanged.",
    user: clipped,
  };
}
