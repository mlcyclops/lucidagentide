// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_pvoice2.ts
//
// P-VOICE.2 (ADR-0247): live read-aloud - the composer voice picker + auto-speak. This exercises the three
// pieces that can actually break, with NO network, NO Electron and NO audio device:
//   [1] the settings store  - a voice is remembered PER ENGINE, and the legacy single-voice field migrates
//   [2] the streaming chunker - a realistic reply with a code fence is spoken as prose, never as source
//   [3] SpeechQueue        - ordering, the prefetch ceiling, cancellation, and handle accounting
//   [4] placePopover       - the picker opens UPWARD off the composer and never clips the window bottom
//
// Run with: bun run harness/scripts/demo_pvoice2.ts

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { takeSpeechChunks } from "../voice/speech_stream.ts";
import { resolveVoice } from "../voice/catalog.ts";
import { SpeechQueue, type SpeechQueueDeps } from "../../desktop/renderer/speech_queue.ts";
import { placePopover } from "../../desktop/renderer/popover_place.ts";

const fail = (m: string): never => { console.error(`FAIL: ${m}`); process.exit(1); };
const ok = (m: string): void => { console.log(`   PASS  ${m}`); };

// The settings store resolves its file per call via LUCID_GUI_SETTINGS_FILE, so point it at a temp file
// BEFORE importing it - the real ~/.omp/lucid-gui.json is never read or written by this demo.
const dir = mkdtempSync(join(tmpdir(), "lucid-pvoice2-"));
process.env.LUCID_GUI_SETTINGS_FILE = join(dir, "lucid-gui.json");
const { load, save, setVoiceSettings, voiceSettings } = await import("../../desktop/settings_store.ts");

try {
  console.log("== [1/4] settings: one remembered voice PER ENGINE, and auto-speak is opt-in ==");
  {
    // A pre-P-VOICE.2 install: a bare `ttsVoice` holding an ElevenLabs id, and no auto-speak key at all.
    save({ ttsProvider: "elevenlabs", ttsVoice: "21m00Tcm4TlvDq8ikWAM" });
    const legacy = voiceSettings();
    if (legacy.ttsVoice !== "21m00Tcm4TlvDq8ikWAM") fail(`legacy ElevenLabs voice lost: ${legacy.ttsVoice}`);
    if (legacy.ttsAutoSpeak !== false) fail("auto-speak must default OFF (cloud egress + per-character cost)");
    ok("legacy install keeps its ElevenLabs voice; auto-speak defaults off");

    // Switch to OpenAI: the ElevenLabs id must NOT follow, or the request 400s against a fixed voice set.
    setVoiceSettings({ ttsProvider: "openai-tts" });
    if (voiceSettings().ttsVoice !== "") fail("an ElevenLabs voice id leaked into the OpenAI engine");
    setVoiceSettings({ ttsVoice: "marin" });
    if (voiceSettings().ttsVoice !== "marin") fail("OpenAI voice not stored");
    ok("switching engine does not carry the previous engine's voice id across");

    // Kokoro gets its own slot; going back restores each engine's own pick.
    setVoiceSettings({ ttsProvider: "local-tts" });
    setVoiceSettings({ ttsVoice: "bm_george" });
    setVoiceSettings({ ttsProvider: "elevenlabs" });
    if (voiceSettings().ttsVoice !== "21m00Tcm4TlvDq8ikWAM") fail("ElevenLabs pick not restored");
    setVoiceSettings({ ttsProvider: "openai-tts" });
    if (voiceSettings().ttsVoice !== "marin") fail("OpenAI pick not restored");
    setVoiceSettings({ ttsProvider: "local-tts" });
    if (voiceSettings().ttsVoice !== "bm_george") fail("Kokoro pick not restored");
    ok("all three engines remember their own voice across switches");

    setVoiceSettings({ ttsAutoSpeak: true });
    if (voiceSettings().ttsAutoSpeak !== true) fail("auto-speak did not persist");
    ok("auto-speak persists once switched on");

    // P-VOICE.3: conversation mode is the other half of auto-speak. The stored preference must SURVIVE
    // auto-speak being switched off, but must never read back as on - nothing may open the mic on its own
    // while the agent is silent.
    setVoiceSettings({ ttsConversation: true });
    if (voiceSettings().ttsConversation !== true) fail("conversation mode did not persist");
    setVoiceSettings({ ttsAutoSpeak: false });
    if (voiceSettings().ttsConversation !== false) fail("conversation mode must read false while auto-speak is off");
    if (load().ttsConversation !== true) fail("the stored preference should survive, not be erased");
    setVoiceSettings({ ttsAutoSpeak: true });
    if (voiceSettings().ttsConversation !== true) fail("conversation mode should come back with auto-speak");
    ok("conversation mode is gated on auto-speak but remembers the preference");

    // The legacy scalar is a READ fallback until the user picks an ElevenLabs voice for real; at that point
    // the per-engine map owns the value and the scalar is retired so the two can never disagree.
    if (load().ttsVoice !== "21m00Tcm4TlvDq8ikWAM") fail("the legacy scalar should survive until it is superseded");
    setVoiceSettings({ ttsProvider: "elevenlabs" });
    setVoiceSettings({ ttsVoice: "pNInz6obpgDQGcFmaJgB" });
    if (load().ttsVoice !== undefined) fail("the legacy scalar should be retired once the map owns the value");
    if (voiceSettings().ttsVoice !== "pNInz6obpgDQGcFmaJgB") fail("new ElevenLabs pick not read back");
    ok("the legacy ttsVoice scalar is retired the moment the map supersedes it");

    // The server-side guard behind all of that.
    if (resolveVoice("local-tts", "21m00Tcm4TlvDq8ikWAM") !== "af_heart") fail("resolveVoice let a foreign id through");
    ok("resolveVoice falls back to the engine default for a foreign voice id");
  }

  console.log("\n== [2/4] streaming chunker: prose is spoken early, an open code fence is never read ==");
  {
    const reply = [
      "Here is the fix. It has two parts.",
      "",
      "```ts",
      "const x = 1;",
      "```",
      "",
      "That covers it.",
    ].join("\n");
    // Feed it a character at a time, the way tokens actually arrive.
    let cursor = 0;
    let firstSpokenAt = -1;
    const spoken: string[] = [];
    for (let i = 1; i <= reply.length; i++) {
      const r = takeSpeechChunks(reply.slice(0, i), cursor, { minChars: spoken.length ? 180 : 24 });
      if (r.chunks.length && firstSpokenAt < 0) firstSpokenAt = i;
      spoken.push(...r.chunks);
      cursor = r.cursor;
    }
    spoken.push(...takeSpeechChunks(reply, cursor, { flush: true }).chunks);
    const heard = spoken.join(" ");
    if (firstSpokenAt < 0) fail("nothing was ever spoken");
    if (firstSpokenAt > reply.indexOf("two parts.") + 12) fail(`first audio waited too long (char ${firstSpokenAt} of ${reply.length})`);
    ok(`first span emitted at char ${firstSpokenAt} of ${reply.length} - audio starts mid-stream, not at the end`);
    if (!heard.includes("Here is the fix.") || !heard.includes("That covers it.")) fail(`prose missing: ${heard}`);
    ok("every prose sentence was emitted exactly once, in order");
    // The fence content survives to the flush, where speakable() strips it in the renderer; what matters here
    // is that it was NEVER emitted while the fence was still open (that is what would be narrated aloud).
    let openCursor = 0;
    const openFence = reply.slice(0, reply.indexOf("const x = 1;") + 12);
    const mid = takeSpeechChunks(openFence, openCursor, { minChars: 1 });
    openCursor = mid.cursor;
    if (mid.chunks.some((c) => c.includes("```") || c.includes("const x"))) fail(`spoke inside an open fence: ${JSON.stringify(mid.chunks)}`);
    if (openFence.slice(openCursor).indexOf("```") !== 0) fail("the cursor should stop exactly at the open fence");
    ok("an unterminated code fence is withheld, not narrated");
  }

  console.log("\n== [3/4] SpeechQueue: order, prefetch ceiling, cancellation, handle accounting ==");
  {
    const played: string[] = [];
    const opened: string[] = [];
    const closed: string[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    let maxBuffered = 0;
    // A latch the test opens to let the "currently playing" clip finish, so the queue's buffering is
    // observable. Held on an object because a bare `let` is narrowed to `never` across the async boundary.
    const latch = {
      release: null as (() => void) | null,
      /** Let the clip that is currently "playing" finish. A method, not a bare call at each site, because
       *  the compiler cannot see the assignment that happens inside the async play() callback. */
      fire(): void { const r = this.release; this.release = null; r?.(); },
    };
    const deps = (over: Partial<SpeechQueueDeps> = {}): SpeechQueueDeps => ({
      synth: async (text) => { await Promise.resolve(); return { audioB64: `b64:${text}`, mime: "audio/mpeg", note: "" }; },
      open: (b64) => { const h = b64.replace("b64:", "url:"); opened.push(h); return h; },
      play: async (h) => {
        maxConcurrent = Math.max(maxConcurrent, ++concurrent);
        played.push(h);
        await new Promise<void>((res) => { latch.release = res; });
        concurrent--;
      },
      close: (h) => { closed.push(h); },
      onError: () => fail("onError fired on the happy path"),
      onChange: () => {},
      ...over,
    });

    // Ordering + the "one clip at a time" invariant, with playback held open so the queue must buffer.
    const q = new SpeechQueue(deps(), 2);
    for (const s of ["one", "two", "three", "four", "five"]) q.say(s);
    for (let i = 0; i < 5; i++) {
      // Let synthesis run, note how deep the buffer got, then let the current clip finish.
      for (let t = 0; t < 8; t++) await Promise.resolve();
      maxBuffered = Math.max(maxBuffered, opened.length - played.length);
      latch.fire();
      for (let t = 0; t < 8; t++) await Promise.resolve();
    }
    if (played.join(",") !== "url:one,url:two,url:three,url:four,url:five") fail(`out of order: ${played.join(",")}`);
    ok(`five spans played in emission order (${played.length} clips)`);
    if (maxConcurrent !== 1) fail(`${maxConcurrent} clips played at once - voices would overlap`);
    ok("never more than one clip audible at a time");
    if (maxBuffered > 2) fail(`prefetch ceiling breached: ${maxBuffered} clips buffered ahead`);
    ok(`prefetch stayed within the ceiling (max ${maxBuffered} buffered ahead)`);
    if (closed.length !== opened.length) fail(`leaked handles: opened ${opened.length}, closed ${closed.length}`);
    ok(`every handle released exactly once (${closed.length}/${opened.length})`);

    // Cancellation: stop() mid-clip must silence it, drop the rest, and release everything opened.
    opened.length = 0; played.length = 0; closed.length = 0; latch.release = null;
    const q2 = new SpeechQueue(deps(), 2);
    for (const s of ["a", "b", "c", "d"]) q2.say(s);
    for (let t = 0; t < 12; t++) await Promise.resolve();
    if (!q2.speaking) fail("expected a clip to be playing before stop()");
    q2.stop();
    if (q2.busy) fail("stop() left the queue busy");
    const playedAtStop = played.length;
    latch.fire(); // the cancelled clip's play() resolves late - it must not resume the queue
    for (let t = 0; t < 20; t++) await Promise.resolve();
    if (played.length !== playedAtStop) fail("a clip started after stop()");
    if (closed.length !== opened.length) fail(`stop() leaked handles: opened ${opened.length}, closed ${closed.length}`);
    ok(`stop() silenced playback, dropped the queue, and released all ${closed.length} handles`);

    // A dead engine: one visible error for the run, then silence - not one toast per sentence.
    let errors = 0;
    const q3 = new SpeechQueue(deps({
      synth: async () => { await Promise.resolve(); return { audioB64: null, mime: "audio/mpeg", note: "no key" }; },
      onError: (note) => { errors++; if (note !== "no key") fail(`error note lost: ${note}`); },
    }), 2);
    for (const s of ["x", "y", "z"]) q3.say(s);
    for (let t = 0; t < 20; t++) await Promise.resolve();
    if (errors !== 1) fail(`expected exactly one error surface, got ${errors}`);
    if (q3.busy) fail("a failing engine should halt the run, not keep retrying");
    ok("a missing key surfaces once and halts the run");

    // P-VOICE.3: conversation mode hangs the microphone off onIdle, so onIdle MUST fire on a natural drain
    // and MUST NOT fire on stop() - otherwise hitting stop would immediately open the mic again.
    opened.length = 0; played.length = 0; closed.length = 0; latch.release = null;
    let idles = 0;
    const q4 = new SpeechQueue(deps({ onIdle: () => { idles++; } }), 2);
    q4.say("only span");
    for (let t = 0; t < 12; t++) await Promise.resolve();
    if (idles !== 0) fail("onIdle fired while a clip was still playing");
    latch.fire();
    for (let t = 0; t < 20; t++) await Promise.resolve();
    if (idles !== 1) fail(`onIdle should fire exactly once on drain, got ${idles}`);
    ok("onIdle fires once when the agent finishes speaking (conversation mode's cue to listen)");

    idles = 0; latch.release = null;
    const q5 = new SpeechQueue(deps({ onIdle: () => { idles++; } }), 2);
    for (const s of ["p", "q"]) q5.say(s);
    for (let t = 0; t < 12; t++) await Promise.resolve();
    q5.stop();
    latch.fire();
    for (let t = 0; t < 20; t++) await Promise.resolve();
    if (idles !== 0) fail("stop() must NOT fire onIdle - it would re-open the mic the user just silenced");
    ok("stop() never fires onIdle, so silencing the agent does not re-open the microphone");
  }

  console.log("\n== [4/4] popover placement: the picker opens upward and never runs off the bottom ==");
  {
    const MARGIN = 10;
    const VIEW = { width: 1440, height: 900 };
    // The composer's voice chip: bottom-left of the window, exactly where a downward card would be clipped.
    const chip = { top: 846, bottom: 872, left: 120 };
    const inside = (p: { top: number; maxHeight: number }, view: { height: number }): boolean =>
      p.top >= MARGIN && p.top + p.maxHeight <= view.height - MARGIN;

    const tall = placePopover({ anchor: chip, card: { width: 366, height: 520 }, viewport: VIEW });
    if (tall.side !== "above") fail(`a 520px card at y=846 must open upward, got "${tall.side}"`);
    if (tall.maxHeight !== 520) fail(`it fits above (828px of room) so it must not be capped: ${tall.maxHeight}`);
    if (tall.top + tall.maxHeight > chip.top) fail("the card overlaps its own anchor");
    if (!inside(tall, VIEW)) fail(`card escaped the viewport: top=${tall.top} h=${tall.maxHeight}`);
    ok(`a 520px picker flips above the chip (top=${tall.top}, clear of the anchor at ${chip.top})`);

    // The regression the skeleton-then-list repaint caused: measured short, then grew.
    const short = placePopover({ anchor: chip, card: { width: 366, height: 180 }, viewport: VIEW });
    const grown = placePopover({ anchor: chip, card: { width: 366, height: 520 }, viewport: VIEW });
    if (short.top + 520 <= chip.top) fail("test is not exercising the growth case");
    if (grown.top >= short.top) fail("the re-placed card must move UP as it grows, not extend downward");
    if (!inside(grown, VIEW)) fail("the grown card escaped the viewport");
    ok(`repositioning after the list loads moves the card up ${short.top - grown.top}px instead of overflowing`);

    // A short window: the card fits on NEITHER side, so it must cap + scroll rather than clip.
    const SMALL = { width: 1100, height: 620 };
    const lowChip = { top: 566, bottom: 592, left: 120 };
    const capped = placePopover({ anchor: lowChip, card: { width: 366, height: 900 }, viewport: SMALL });
    if (capped.maxHeight >= 900) fail("a 900px card in a 620px window must be capped");
    if (!inside(capped, SMALL)) fail(`capped card still clips: top=${capped.top} h=${capped.maxHeight}`);
    if (capped.side !== "above") fail(`should take the roomier side (above), got "${capped.side}"`);
    ok(`in a ${SMALL.height}px window the card caps to ${capped.maxHeight}px and scrolls instead of clipping`);

    // Anchored near the TOP (a titlebar picker) it should still prefer opening downward.
    const top = placePopover({ anchor: { top: 40, bottom: 66, left: 120 }, card: { width: 366, height: 400 }, viewport: VIEW });
    if (top.side !== "below") fail(`a card with room below must open downward, got "${top.side}"`);
    if (!inside(top, VIEW)) fail("downward card escaped the viewport");
    ok("anchored high in the window it still opens downward (reading order preserved)");

    // Horizontal: a chip near the right edge must pull the card back inside.
    const right = placePopover({ anchor: { top: 846, bottom: 872, left: 1400 }, card: { width: 366, height: 300 }, viewport: VIEW });
    if (right.left + 366 > VIEW.width - MARGIN) fail(`card overhangs the right edge: left=${right.left}`);
    if (right.left < MARGIN) fail("card pushed off the left edge");
    ok(`a right-edge anchor pulls the card back inside (left=${right.left})`);
  }

  console.log("\nP-VOICE.2 demo: ALL CHECKS PASSED");
} catch (e) {
  fail(`unexpected error: ${(e as Error)?.stack ?? String(e)}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
