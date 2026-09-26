// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_creator2.ts - CREATOR-2 (ADR-0286): the runnable proof of the follow-along editor.
//
// Nine sections, no network, no GPU, no fixture files: the take is synthesised in-process so every claim
// below is arithmetic anyone can re-derive, not a golden blob nobody can check.
//
//   1. a synthetic take with REAL structure (tone bursts separated by silence, so the energy measurement
//      has something to find rather than a flat buffer that would make any alignment look good)
//   2. the alignment is DERIVED, and the document says so: every item labeled, every confidence capped,
//      and the provenance note printed verbatim - this is the honesty claim
//   3. delete a word: the timeline closes up by exactly that word's span, and the render's byte length
//      follows the new duration exactly
//   4. drag a span: re-ordering audio never creates or destroys any of it
//   5. re-render ONE span: every byte outside it is untouched. This is the ADR-0286 keystone and it is
//      checked at the byte level with the offsets printed, not asserted by eye
//   6. undo re-renders to the ORIGINAL bytes, so "restores exactly" means exactly
//   7. render is deterministic, which is what makes 5 and 6 meaningful claims instead of coincidences
//   8. a missing source REFUSES the render and NAMES what was missing; it never substitutes silence
//   9. the desktop seam end to end, over an in-memory library: opening a track derives its alignment and
//      carries the note verbatim, and saving APPENDS a remix instead of overwriting the take it came from
//
// The theme: an audio editor's only real promise is that the parts you did not touch are the parts you
// recorded. Here that promise is a byte comparison.

import { buildWav, parseWav, type WavFormat } from "../brief/tts_backend.ts";
import {
  DERIVED_CONFIDENCE_CEILING, canUndo, commit, deleteSpan, deriveAlignment, docDurationMs, docFromSource,
  durationOfWav, moveSpan, newHistory, redo, renderTimeline, replaceSpan, spanOf, undo, validateDoc,
  type OpResult, type SourceAudio, type TimelineDoc,
} from "../creator/timeline.ts";
import { NO_TEXT_NOTE, editorStageDir, openEditor, saveEdit, type EditorIo } from "../../desktop/creator_editor.ts";
import {
  addTrack, foldLibrary, libraryAudioDir, libraryLedger,
  type CreatorTrack, type LibraryResult,
} from "../../desktop/creator_library.ts";

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`   ${ok ? "ok" : "FAIL"} - ${label}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures++;
};

/** 16kHz mono 16-bit: a real speech rate at which 1ms is exactly 32 bytes, so every offset printed below
 *  is an integer the reader can check against the duration. */
const FMT: WavFormat = { channels: 1, sampleRate: 16000, bitsPerSample: 16 };
const MS_BYTES = (FMT.sampleRate / 1000) * (FMT.bitsPerSample >> 3) * FMT.channels;
const HEADER = 44;

interface Segment { readonly loud: boolean; readonly ms: number }

/** Tone bursts separated by silence. A fixed-frequency sine is deterministic, which is what lets a later
 *  phase compare two renders byte for byte and mean it. */
function burstWav(pattern: readonly Segment[], freq: number, amp: number): Uint8Array {
  const totalMs = pattern.reduce((n, p) => n + p.ms, 0);
  const data = new Uint8Array(totalMs * MS_BYTES);
  let s = 0;
  for (const p of pattern) {
    const samples = (p.ms * FMT.sampleRate) / 1000;
    for (let i = 0; i < samples; i++, s++) {
      const v = p.loud ? Math.round(amp * Math.sin((2 * Math.PI * freq * s) / FMT.sampleRate)) : 0;
      const u = v < 0 ? v + 0x10000 : v;
      data[s * 2] = u & 0xff;
      data[s * 2 + 1] = (u >> 8) & 0xff;
    }
  }
  return buildWav(FMT, data);
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

/** The first and last offsets at which two buffers disagree, plus how many bytes did. Null when identical.
 *  A range is the useful shape here: the keystone claim is "the differences are CONFINED to the span". */
function diffRange(a: Uint8Array, b: Uint8Array): { first: number; last: number; count: number } | null {
  let first = -1;
  let last = -1;
  let count = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] === b[i]) continue;
    if (first < 0) first = i;
    last = i;
    count++;
  }
  return first < 0 ? null : { first, last, count };
}

/** Stop the proof. A refusal in a step everything after it stands on is not a soft check: every later
 *  measurement would be reading the wrong document, so the demo exits instead of reporting nonsense. */
function stop(label: string, why: string): never {
  console.log(`   FAIL - ${label} (${why})`);
  console.log("\n1 CHECK(S) FAILED");
  process.exit(1);
}

const must = (label: string, r: OpResult): TimelineDoc => (r.ok ? r.doc : stop(label, r.error));

const mustTrack = (label: string, r: LibraryResult): CreatorTrack =>
  (r.ok && r.track ? r.track : stop(label, r.error ?? "the library returned no track"));

function rendered(label: string, doc: TimelineDoc, srcs: ReadonlyMap<string, SourceAudio>): Uint8Array {
  const r = renderTimeline(doc, srcs);
  return r.ok ? r.wav : stop(label, r.error);
}

/** An in-memory library: the REAL `addTrack`/`foldLibrary`/`openEditor`/`saveEdit` run against two Maps
 *  instead of a disk, so what phase 9 proves is the product's own save path and not a re-implementation
 *  of it. `EditorIo` is `LibraryIo` plus the one byte writer a render needs, because a render only ever
 *  exists in memory and the library imports from a path. */
function fakeEditorIo(): EditorIo & { fileBytes(path: string): Uint8Array | undefined; paths(): string[] } {
  const files = new Map<string, Uint8Array>();
  const text = new Map<string, string>();
  let seq = 0;
  let clock = 1_700_000_000_000;
  return {
    fileBytes: (p) => files.get(p),
    paths: () => [...files.keys()],
    ensureDir: () => {},
    readText: (p) => text.get(p) ?? "",
    appendLine: (p, line) => { text.set(p, (text.get(p) ?? "") + line + "\n"); },
    copyIn: (src, dest) => {
      const b = files.get(src);
      if (!b) throw new Error(`no file at ${src}`);
      files.set(dest, b);
      return b.length;
    },
    readBase64: (p) => {
      const b = files.get(p);
      if (!b) throw new Error(`no file at ${p}`);
      return Buffer.from(b).toString("base64");
    },
    removeFile: (p) => { files.delete(p); text.delete(p); },
    exists: (p) => files.has(p) || text.has(p),
    now: () => (clock += 1000),
    id: () => `trk${++seq}`,
    writeBytes: (p, bytes) => { files.set(p, bytes); },
  };
}

console.log("1) a synthetic take with REAL structure: tone bursts separated by silence");
const takeWav = burstWav([
  { loud: false, ms: 40 },
  { loud: true, ms: 160 }, { loud: false, ms: 120 },
  { loud: true, ms: 160 }, { loud: false, ms: 120 },
  { loud: true, ms: 160 }, { loud: false, ms: 120 },
  { loud: true, ms: 160 }, { loud: false, ms: 120 },
  { loud: true, ms: 160 },
  { loud: false, ms: 40 },
], 180, 12000);
const take = durationOfWav(takeWav);
check("it parses back as the format it claims",
  take.fmt.sampleRate === 16000 && take.fmt.channels === 1 && take.fmt.bitsPerSample === 16,
  `${take.fmt.sampleRate}Hz / ${take.fmt.channels}ch / ${take.fmt.bitsPerSample}-bit PCM`);
check("5 bursts of 160ms, 120ms of silence between them, 40ms of lead and tail",
  take.durationMs === 1360, `${take.durationMs}ms, ${takeWav.length} bytes total`);
check("byte arithmetic is exact at this rate, so every offset below is checkable",
  takeWav.length === HEADER + take.durationMs * MS_BYTES,
  `${HEADER}-byte header + ${take.durationMs} x ${MS_BYTES} = ${takeWav.length}`);

console.log("2) the alignment is DERIVED from that audio, and the document says so");
const TEXT = "Ship the whole thing Friday";
const align = deriveAlignment(TEXT, take.data, take.fmt);
check("the energy measurement found one speech run per burst",
  align.runs.length === 5, align.runs.map((r) => `${r.startMs}-${r.endMs}ms`).join(", "));
check("every word got a home, in reading order",
  align.items.map((it) => it.text).join(" ") === TEXT, align.items.map((it) => `${it.text} ${it.startMs}-${it.endMs}`).join(", "));
check("EVERY item is labeled derived - not one is passed off as a vendor timing",
  align.items.every((it) => it.source === "derived"));
check(`EVERY confidence is capped at DERIVED_CONFIDENCE_CEILING (${DERIVED_CONFIDENCE_CEILING})`,
  align.items.length > 0 && align.items.every((it) => it.confidence <= DERIVED_CONFIDENCE_CEILING),
  `highest is ${Math.max(...align.items.map((it) => it.confidence))}`);
console.log(`   note (verbatim, this is what the UI shows): ${align.note}`);
check("the note admits the boundaries inside a run are proportional, not measured per word",
  align.note.includes("proportional"));

const docA = docFromSource({ sourceId: "take-1", fmt: take.fmt, durationMs: take.durationMs, items: align.items });
const sources = new Map<string, SourceAudio>([["take-1", { fmt: take.fmt, data: take.data }]]);
check("the document it builds is structurally valid", validateDoc(docA).length === 0, validateDoc(docA).join("; "));
const renderA = rendered("render the original take", docA, sources);

console.log("3) delete a word: the timeline closes up by exactly that word's span");
const whole = docA.items[2]!;
const wholeSpan = spanOf(docA, [whole.id])!;
const spanLen = wholeSpan.endMs - wholeSpan.startMs;
const docB = must("delete the span", deleteSpan(docA, [whole.id]));
check(`the timeline shortened by exactly "${whole.text}"`,
  docDurationMs(docB) === docDurationMs(docA) - spanLen,
  `${docDurationMs(docA)}ms - ${spanLen}ms = ${docDurationMs(docB)}ms`);
check("the word is gone and the survivors kept their reading order",
  docB.items.map((it) => it.text).join(" ") === "Ship the thing Friday",
  docB.items.map((it) => it.text).join(" "));
check("the survivors are still CONTIGUOUS: no hole is left where the word was",
  docB.items.every((it, i) => i === 0 || it.startMs === docB.items[i - 1]!.endMs),
  docB.items.map((it) => `${it.startMs}-${it.endMs}`).join(" "));
const renderB = rendered("render after the delete", docB, sources);
check("the rendered byte length matches the NEW duration exactly",
  renderB.length === HEADER + docDurationMs(docB) * MS_BYTES,
  `${renderB.length} = ${HEADER} + ${docDurationMs(docB)} x ${MS_BYTES}`);
check("which is the original render minus exactly the deleted span's bytes",
  renderA.length - renderB.length === spanLen * MS_BYTES,
  `${renderA.length} - ${renderB.length} = ${spanLen} x ${MS_BYTES}`);

console.log("4) drag a span: the order changes, the length does not");
const friday = docB.items[3]!;
const docC = must("drag the span to the head", moveSpan(docB, [friday.id], 0));
check("a drag is LENGTH-PRESERVING: it re-orders audio, it never creates or destroys any",
  docDurationMs(docC) === docDurationMs(docB), `${docDurationMs(docB)}ms before, ${docDurationMs(docC)}ms after`);
check(`"${friday.text}" now reads first, and the rest slid back in order`,
  docC.items.map((it) => it.text).join(" ") === "Friday Ship the thing",
  docC.items.map((it) => it.text).join(" "));
const renderC = rendered("render after the drag", docC, sources);
check("the render is the same byte COUNT but not the same BYTES: the audio really moved",
  renderC.length === renderB.length && !sameBytes(renderC, renderB), `${renderC.length} bytes either way`);
check("and the document is still structurally valid", validateDoc(docC).length === 0, validateDoc(docC).join("; "));

console.log("5) re-render ONE span: every byte outside it is untouched (the ADR-0286 keystone)");
const retakeWav = burstWav([{ loud: true, ms: 400 }], 320, 9000);
const retake = durationOfWav(retakeWav);
sources.set("retake-1", { fmt: retake.fmt, data: retake.data });
const PROMPT = "say 'entire' instead";
const evenSwap = must("replace the span with an equal-length retake",
  replaceSpan(docA, [whole.id], { sourceId: "retake-1", durationMs: spanLen, prompt: PROMPT }));
const renderD = rendered("render the re-rendered span", evenSwap, sources);
const spanFrom = HEADER + wholeSpan.startMs * MS_BYTES;
const spanTo = HEADER + wholeSpan.endMs * MS_BYTES;
check("an equal-length replacement renders to the same byte count, header included",
  renderD.length === renderA.length, `${renderD.length} bytes`);
const d = diffRange(renderA, renderD);
check("the span's audio genuinely changed", d !== null && d.count > 0, d ? `${d.count} bytes differ` : "nothing differed at all");
check(`EVERY differing byte falls INSIDE the span, offsets [${spanFrom}, ${spanTo})`,
  d !== null && d.first >= spanFrom && d.last < spanTo,
  d ? `first diff at ${d.first}, last at ${d.last}` : "");
check(`the ${spanFrom} bytes BEFORE the span are byte-identical`,
  sameBytes(renderA.subarray(0, spanFrom), renderD.subarray(0, spanFrom)), `offsets [0, ${spanFrom})`);
check(`the ${renderA.length - spanTo} bytes AFTER the span are byte-identical`,
  sameBytes(renderA.subarray(spanTo), renderD.subarray(spanTo)), `offsets [${spanTo}, ${renderA.length})`);
check("the new clip carries the clip it replaced and the prompt that produced it",
  evenSwap.clips.some((c) => c.sourceId === "retake-1" && typeof c.parentClipId === "string" && c.prompt === PROMPT));

console.log("   a SHORTER replacement moves the tail, so the WAV header changes and the comparison is on PCM:");
const SHORTER = 200;
const shortSwap = must("replace the span with a shorter retake",
  replaceSpan(docA, [whole.id], { sourceId: "retake-1", durationMs: SHORTER, prompt: PROMPT }));
const renderE = rendered("render the shortened span", shortSwap, sources);
const preData = parseWav(renderA).data;
const postData = parseWav(renderE).data;
const headTo = wholeSpan.startMs * MS_BYTES;
const preTailFrom = wholeSpan.endMs * MS_BYTES;
const postTailFrom = headTo + SHORTER * MS_BYTES;
check("the file shortens by exactly the difference in span length",
  renderE.length === renderA.length - (spanLen - SHORTER) * MS_BYTES,
  `${renderA.length} - (${spanLen} - ${SHORTER}) x ${MS_BYTES} = ${renderE.length}`);
check(`the PCM before the span is still byte-identical, offsets [0, ${headTo})`,
  sameBytes(preData.subarray(0, headTo), postData.subarray(0, headTo)));
check(`the PCM after the span is byte-identical once shifted, [${preTailFrom}, ${preData.length}) maps to [${postTailFrom}, ${postData.length})`,
  sameBytes(preData.subarray(preTailFrom), postData.subarray(postTailFrom)));

console.log("6) undo restores the document exactly: byte-identical on re-render");
const before = newHistory(docA);
const after = commit(before, evenSwap);
const back = undo(after);
check("the history knows it can go back, and knows when it cannot", canUndo(after) && !canUndo(back));
check("the undone document re-renders to the ORIGINAL bytes, not merely a matching length",
  sameBytes(rendered("re-render after undo", back.present, sources), renderA),
  `${renderA.length} bytes, identical`);
check("and redo returns to the re-rendered take, also byte for byte",
  sameBytes(rendered("re-render after redo", redo(back).present, sources), renderD));

console.log("7) render is DETERMINISTIC, which is what makes the byte claims above claims at all");
check("the original take renders identically twice", sameBytes(rendered("re-render the original", docA, sources), renderA));
check("so does the edited document", sameBytes(rendered("re-render the edit", evenSwap, sources), renderD));

console.log("8) a missing source REFUSES the render; it never quietly substitutes silence");
const withoutRetake = new Map<string, SourceAudio>([["take-1", { fmt: take.fmt, data: take.data }]]);
const refused = renderTimeline(evenSwap, withoutRetake);
check("the render is refused rather than filled in", refused.ok === false);
check("and the error NAMES the source it could not find",
  !refused.ok && refused.error.includes("retake-1"), refused.ok ? "" : refused.error);
const mismatched = renderTimeline(evenSwap, new Map<string, SourceAudio>([
  ["take-1", { fmt: take.fmt, data: take.data }],
  ["retake-1", { fmt: { channels: 2, sampleRate: 48000, bitsPerSample: 16 }, data: retake.data }],
]));
check("a format mismatch is refused with BOTH formats named, never silently resampled",
  !mismatched.ok && mismatched.error.includes("48000Hz/2ch") && mismatched.error.includes("16000Hz/1ch"),
  mismatched.ok ? "" : mismatched.error);

console.log("9) the desktop seam: open a library track, save the edit as a NEW remix beside it");
const io = fakeEditorIo();
const BASE = "/creator";
io.writeBytes("/imports/take.wav", takeWav);
io.writeBytes("/imports/retake.wav", retakeWav);
io.writeBytes("/imports/bed.wav", buildWav({ channels: 2, sampleRate: 48000, bitsPerSample: 16 }, new Uint8Array(9600)));
const takeTrack = mustTrack("import the take", addTrack(io, BASE, { sourcePath: "/imports/take.wav", title: "Ship it", origin: "elevenlabs", lyrics: TEXT }));
const alt = mustTrack("import the retake", addTrack(io, BASE, { sourcePath: "/imports/retake.wav", title: "Retake", origin: "elevenlabs" }));
const bed = mustTrack("import a 48kHz stereo bed", addTrack(io, BASE, { sourcePath: "/imports/bed.wav", title: "Stereo bed", origin: "local" }));

const opened = openEditor(io, BASE, { trackId: takeTrack.id, buckets: 64 });
check("openEditor turns the library track into a session", opened.ok && !!opened.session, opened.error ?? "");
const session = opened.session ?? stop("open the editor", opened.error ?? "no session came back");
check("it carries the derived provenance note VERBATIM: the seam never re-words the core's claim",
  session.note === align.note, session.note);
check("its document is the same 5 derived words bound to the same audio",
  session.doc.items.length === 5 && session.doc.items.every((it) => it.source === "derived") && session.durationMs === take.durationMs,
  `${session.doc.items.length} words over ${session.durationMs}ms`);
check("the waveform is 64 buckets of the take's OWN samples, not a decoration",
  session.peaks.length === 64 && session.peaks.some((p) => p > 0), `highest peak ${Math.max(...session.peaks)}`);
check("a same-format track is offered as a replacement source, with its measured duration",
  session.sources.length === 1 && session.sources[0]!.id === alt.id && session.sources[0]!.durationMs === retake.durationMs,
  session.sources.map((s) => `${s.title} ${s.durationMs}ms`).join(", "));
check("the 48kHz stereo bed is left OUT rather than offered and refused at save time",
  !session.sources.some((s) => s.id === bed.id));

const sessionEdit = must("delete a word in the opened session", deleteSpan(session.doc, [session.doc.items[2]!.id]));
const saved = saveEdit(io, BASE, { trackId: takeTrack.id, doc: sessionEdit, title: "Ship it (tighter)", prompt: "drop the third word" });
check("the edit saves", saved.ok, saved.error ?? "");
const shelf = foldLibrary(io.readText(libraryLedger(BASE)));
const child = shelf.find((t) => t.id === saved.trackId);
check("it is a NEW library record, appended beside the original",
  shelf.length === 4 && !!child && child.id !== takeTrack.id, `${shelf.length} tracks on the shelf`);
check("recorded as a REMIX whose parent is the track it was edited from",
  child?.kind === "remix" && child.parentId === takeTrack.id, `kind ${child?.kind}, parent ${child?.parentId}`);
const parentBytes = io.fileBytes(`${libraryAudioDir(BASE)}/${takeTrack.file}`);
check("the ORIGINAL's bytes are untouched: an edit in LUCID is an append, never an overwrite",
  !!parentBytes && sameBytes(parentBytes, takeWav), `${parentBytes?.length ?? 0} bytes, still the take that was imported`);
const childBytes = io.fileBytes(`${libraryAudioDir(BASE)}/${child?.file ?? ""}`) ?? new Uint8Array(0);
const childWav = childBytes.length > 0 ? durationOfWav(childBytes) : null;
check("the saved bytes re-parse as a valid WAV in the take's own format",
  childWav !== null && childWav.fmt.sampleRate === take.fmt.sampleRate
  && childWav.fmt.channels === take.fmt.channels && childWav.fmt.bitsPerSample === 16,
  childWav ? `${childBytes.length} bytes, ${childWav.durationMs}ms` : "nothing was written");
check("and they are EXACTLY what the pure core rendered for the same edit in phase 3",
  sameBytes(childBytes, renderB), "byte-identical to the in-process render");
// saveEdit measures its reported duration back off the bytes it wrote, which is the honest thing to
// report, so this compares against the FILE and never against docDurationMs.
check("the result reports the size and duration it actually wrote",
  childWav !== null && saved.bytes === childBytes.length && saved.durationMs === childWav.durationMs,
  `${saved.bytes} bytes, ${saved.durationMs}ms`);
// The two only coincide because 1ms is a whole 16 frames at 16kHz, so a clip length in whole milliseconds
// is always a whole number of frames. At a rate where that is false they would legitimately differ by a
// millisecond, and this is the check that should say so rather than the one above.
check("at this rate the rendered duration is the document's duration exactly, with no rounding slack",
  childWav !== null && childWav.durationMs === docDurationMs(sessionEdit)
  && childBytes.length === HEADER + docDurationMs(sessionEdit) * MS_BYTES,
  `${childWav?.durationMs ?? 0}ms measured vs ${docDurationMs(sessionEdit)}ms in the document`);
check("the words travel with the edit, so re-opening it follows along without re-pasting the text",
  child?.lyrics === "Ship the thing Friday", child?.lyrics ?? "");

const orphan = must("point a span at a track that is not in the library",
  replaceSpan(session.doc, [session.doc.items[0]!.id], { sourceId: "trk-gone", durationMs: 100, prompt: PROMPT }));
const refusedSave = saveEdit(io, BASE, { trackId: takeTrack.id, doc: orphan, title: "broken" });
check("a save whose source is not in the library is REFUSED by id, never rendered as silence",
  !refusedSave.ok && (refusedSave.error ?? "").includes("trk-gone"), refusedSave.error ?? "");
check("and the refused save appended nothing", foldLibrary(io.readText(libraryLedger(BASE))).length === 4);
check("staging is cleaned up: a save leaves behind nothing that looks like a track",
  io.paths().every((p) => !p.startsWith(editorStageDir(BASE))),
  io.paths().filter((p) => p.startsWith(editorStageDir(BASE))).join(", "));

// LUCID ships no transcoder by design (no ffmpeg, no native module), so the two cases where the editor
// has nothing to work with are refusals that NAME the reason, not empty editors the user has to interpret.
io.writeBytes("/imports/voice.mp3", new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00]));
const mp3 = mustTrack("import an mp3", addTrack(io, BASE, { sourcePath: "/imports/voice.mp3", title: "Voice memo", origin: "local" }));
const refusedOpen = openEditor(io, BASE, { trackId: mp3.id });
check("an mp3 is REFUSED by its real mime, not opened over audio nothing can decode",
  !refusedOpen.ok && (refusedOpen.error ?? "").includes("audio/mpeg") && (refusedOpen.error ?? "").includes("Voice memo"),
  refusedOpen.error ?? "");
const noText = openEditor(io, BASE, { trackId: alt.id });
check("a track with no words says there is nothing to follow, and paints no word strip",
  noText.ok && noText.session?.note === NO_TEXT_NOTE && noText.session?.doc.items.length === 0,
  noText.session?.note ?? noText.error ?? "");

console.log(failures === 0
  ? "\ndemo_creator2 OK - the follow-along editor's alignment is labeled derived and capped below vendor confidence with the reason printed, a delete closes the timeline by exactly the word's span and the render's byte length follows, a drag re-orders audio without creating or destroying a sample, and a re-rendered span changes ONLY the bytes inside it: the audio before and after it comes back byte for byte, undo re-renders to the original file, the same document always renders the same bytes, and a source that is not there refuses the render by name instead of substituting silence. Through the desktop seam the same edit opens from a library track with its provenance note carried word for word, and saves as a NEW remix whose parent keeps every one of its own bytes."
  : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
