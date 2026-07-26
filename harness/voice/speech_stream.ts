// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/voice/speech_stream.ts
//
// P-VOICE.2 (ADR-0246): the pure "what can we speak YET?" brain behind live read-aloud.
//
// Read-aloud used to wait for the whole reply, then synthesize it as one clip - so a 600-word answer meant
// ~20 seconds of silence before the first word. Live voice needs the opposite: speak sentence one while the
// model is still writing sentence five. That needs a cursor over a GROWING buffer that only ever hands back
// text which is (a) syntactically complete and (b) safe to read out loud.
//
// Two hazards make this non-trivial, and both are handled here:
//   1. An UNTERMINATED code fence. Mid-stream, "```ts\nconst x" has an open fence; speakable() only strips
//      CLOSED ```…``` pairs, so reading it would narrate raw source. Everything from an odd-numbered fence
//      onward is withheld until its closer arrives.
//   2. A period is not a sentence end. "3.14", "e.g. ", "v2.1" all end in `.`; splitting there produces
//      chopped, unnatural audio. A boundary requires a terminator followed by whitespace, and abbreviations
//      are excluded.
//
// Pure: no DOM, no fetch, no clock. The renderer owns the synthesis queue; this owns the text math.

/** What one pump produced: zero or more ready-to-speak spans, and the cursor to pass back next time. */
export interface SpeechChunks {
  chunks: string[];
  cursor: number;
}

export interface TakeChunksOptions {
  /** Don't emit a span shorter than this (whitespace-trimmed). Batches short sentences into one request so a
   *  long answer isn't hundreds of tiny synth calls. Callers use a SMALL value for the first span of a turn
   *  (fast first audio) and a larger one afterwards (smooth, cheap). Ignored when `flush` is set. */
  minChars?: number;
  /** The stream ended: emit whatever remains, complete sentence or not, including inside an open fence
   *  (speakable() strips what it can). Advances the cursor to the end of the buffer. */
  flush?: boolean;
}

/** Words that end in `.` mid-sentence. A boundary right after one of these is suppressed so "e.g. the API"
 *  stays one span instead of splitting into "e.g." + "the API". Lower-case; matched case-insensitively. */
const ABBREVIATIONS: Record<string, true> = {
  "e.g": true, "i.e": true, etc: true, vs: true, cf: true, al: true, approx: true, est: true,
  mr: true, mrs: true, ms: true, dr: true, prof: true, sr: true, jr: true, st: true,
  fig: true, no: true, vol: true, ch: true, sec: true, inc: true, ltd: true, co: true,
};

/** How much of `buf` is settled prose — i.e. NOT inside a code fence that has yet to be closed. An odd number
 *  of ``` markers means the last one opened a block still being written, so text from that marker on is held
 *  back. An even count (or none) means the whole buffer is safe. */
export function settledEnd(buf: string): number {
  let open = false;
  let lastOpen = buf.length;
  for (let i = buf.indexOf("```"); i !== -1; i = buf.indexOf("```", i + 3)) {
    open = !open;
    if (open) lastOpen = i;
  }
  return open ? lastOpen : buf.length;
}

/** Indices in `s` just past each COMPLETE sentence. A hard newline always ends one (headings, list items and
 *  table rows carry no terminator but are separate utterances); `.`/`!`/`?` end one only when followed by
 *  whitespace, which excludes decimals ("3.14") and versions ("v2.1"), and never right after an abbreviation.
 *  A terminator at the very end of `s` is NOT a boundary — the next token may continue it. */
export function sentenceBounds(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "\n") { out.push(i + 1); continue; }
    if (c !== "." && c !== "!" && c !== "?") continue;
    let end = i;
    while (end + 1 < s.length && ".!?".includes(s[end + 1]!)) end++; // "?!" / "..." run as one terminator
    const next = s[end + 1];
    i = end;
    if (next === undefined || !/\s/.test(next)) continue; // end-of-buffer, or a decimal / version / "U.S."
    const word = /([A-Za-z.]+)\.$/.exec(s.slice(Math.max(0, end - 12), end + 1))?.[1];
    if (word && ABBREVIATIONS[word.toLowerCase().replace(/\.$/, "")] === true) continue;
    out.push(end + 1);
  }
  return out;
}

/** Pull every span of `buf` after `cursor` that is safe to speak now, batched to at least `minChars`.
 *  Returns the new cursor; text after it is deliberately withheld (incomplete sentence, or an open code
 *  fence) and will be picked up by a later pump once more tokens arrive, or by a final `flush: true` call. */
export function takeSpeechChunks(buf: string, cursor: number, opts: TakeChunksOptions = {}): SpeechChunks {
  const limit = opts.flush ? buf.length : settledEnd(buf);
  if (limit <= cursor) return { chunks: [], cursor };
  const region = buf.slice(cursor, limit);
  const minChars = Math.max(1, opts.minChars ?? 24);
  const chunks: string[] = [];
  let start = 0;
  for (const b of sentenceBounds(region)) {
    if (b - start < minChars) continue;
    const span = region.slice(start, b).trim();
    if (span) chunks.push(span);
    start = b;
  }
  if (opts.flush) {
    const tail = region.slice(start).trim();
    if (tail) chunks.push(tail);
    return { chunks, cursor: limit };
  }
  return { chunks, cursor: cursor + start };
}
