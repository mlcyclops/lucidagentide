// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-VOICE.2 (ADR-0246): the live read-aloud chunker. These prove the two things that make streaming TTS
// sound wrong when they're missed - reading an unterminated code fence out loud, and splitting a decimal /
// abbreviation into two utterances - plus the cursor contract that guarantees no text is spoken twice or lost.

import { expect, test } from "bun:test";
import { sentenceBounds, settledEnd, takeSpeechChunks } from "./speech_stream.ts";

test("settledEnd withholds an unterminated code fence, releases it once closed", () => {
  const open = "Here is the fix.\n```ts\nconst x = 1;";
  expect(settledEnd(open)).toBe(open.indexOf("```"));
  const closed = `${open}\n\`\`\`\nThat's it.`;
  expect(settledEnd(closed)).toBe(closed.length);
  expect(settledEnd("no fences at all")).toBe(16);
});

test("a growing buffer never speaks inside an open fence", () => {
  const buf = "Ship it.\n```js\nconsole.log(1)";
  const r = takeSpeechChunks(buf, 0, { minChars: 1 });
  expect(r.chunks).toEqual(["Ship it."]);
  expect(buf.slice(r.cursor)).toBe("```js\nconsole.log(1)"); // the open block stays withheld
});

test("sentence boundaries skip decimals, versions and abbreviations", () => {
  expect(sentenceBounds("pi is 3.14 exactly")).toEqual([]);        // decimal is not a boundary
  expect(sentenceBounds("we shipped v2.1 today")).toEqual([]);     // version is not a boundary
  expect(sentenceBounds("use e.g. this one")).toEqual([]);         // abbreviation is not a boundary
  expect(sentenceBounds("Done. Next.")).toEqual([5]);              // trailing terminator is NOT settled yet
  expect(sentenceBounds("Wait!? Now")).toEqual([6]);               // a "?!" run is one boundary
  expect(sentenceBounds("## Results\nrows")).toEqual([11]);        // a hard newline always ends an utterance
});

test("minChars batches short sentences and holds an incomplete tail", () => {
  const buf = "One. Two. Three. And here is a much longer closing sentence that clears the bar. Trail";
  const r = takeSpeechChunks(buf, 0, { minChars: 40 });
  expect(r.chunks).toEqual(["One. Two. Three. And here is a much longer closing sentence that clears the bar."]);
  expect(buf.slice(r.cursor).trim()).toBe("Trail"); // no terminator yet → withheld (spans are trimmed on emit)
});

test("pumping a stream token-by-token speaks everything exactly once, in order", () => {
  const full = "First sentence lands early. Second one follows right after. Then a final short one.";
  let cursor = 0;
  const spoken: string[] = [];
  for (let i = 1; i <= full.length; i++) {
    const r = takeSpeechChunks(full.slice(0, i), cursor, { minChars: spoken.length ? 30 : 1 });
    spoken.push(...r.chunks);
    cursor = r.cursor;
  }
  const flushed = takeSpeechChunks(full, cursor, { flush: true });
  spoken.push(...flushed.chunks);
  expect(flushed.cursor).toBe(full.length);
  expect(spoken.join(" ")).toBe(full);
});

test("flush emits the remainder even mid-sentence and inside an open fence", () => {
  const buf = "Interrupted mid thou";
  expect(takeSpeechChunks(buf, 0, {}).chunks).toEqual([]);
  expect(takeSpeechChunks(buf, 0, { flush: true })).toEqual({ chunks: ["Interrupted mid thou"], cursor: buf.length });
  const fenced = "Look.\n```\nraw";
  expect(takeSpeechChunks(fenced, 0, { flush: true }).cursor).toBe(fenced.length);
});

test("an empty or already-consumed buffer is a no-op", () => {
  expect(takeSpeechChunks("", 0, {})).toEqual({ chunks: [], cursor: 0 });
  expect(takeSpeechChunks("All done.\n", 10, {})).toEqual({ chunks: [], cursor: 10 });
  expect(takeSpeechChunks("   \n", 0, { flush: true }).chunks).toEqual([]); // whitespace only → nothing to say
});
