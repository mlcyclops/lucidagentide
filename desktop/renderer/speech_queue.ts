// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/speech_queue.ts
//
// P-VOICE.2 (ADR-0246): the ordering + cancellation brain behind live read-aloud.
//
// Auto-speak synthesizes a reply one sentence at a time so audio starts after sentence one instead of after
// the whole answer. That turns read-aloud into a concurrency problem, and the failure modes are all audible:
// two clips playing over each other, sentence three arriving before sentence two, a cancelled turn still
// talking over the next one, or a leaked blob URL per sentence. This class owns exactly that, and nothing
// else - no DOM, no fetch, no Audio. Everything external is a dep, so the interleaving is testable
// (harness/scripts/demo_pvoice2.ts) instead of only observable by ear.
//
// The contract:
//   · Spans play in the order they were said. Synthesis is serial, so a fast sentence can never overtake.
//   · At most `prefetch` synthesized clips are held ahead of the speaker - enough to hide request latency
//     between sentences, few enough that stopping hasn't already paid for clips nobody will hear.
//   · stop() is absolute: queued text is dropped, every open handle is closed exactly once, and work already
//     in flight is discarded when it lands (a generation counter, not a flag, so a slow request from a
//     cancelled turn can't speak over the new one).

export interface SpeechSynthResult {
  audioB64: string | null;
  mime: string;
  note: string;
}

export interface SpeechQueueDeps {
  /** Synthesize one span of text. May resolve to null / a note-only result when the engine can't speak it. */
  synth(text: string): Promise<SpeechSynthResult | null>;
  /** Turn synthesized audio into a playable handle (a blob URL in the renderer). */
  open(audioB64: string, mime: string): string;
  /** Play one handle to completion. MUST resolve on end AND on error - a rejection would wedge the queue. */
  play(handle: string): Promise<void>;
  /** Release a handle. Called exactly once per handle returned by `open`. */
  close(handle: string): void;
  /** The engine returned no audio. Fired at most once per run, then the run stops. */
  onError(note: string): void;
  /** The queue's visible state changed (something started/finished) - repaint any indicator. */
  onChange(): void;
  /** The last clip finished and nothing is queued or synthesizing: the agent has stopped talking. Fires on
   *  natural drain ONLY, never from stop() - conversation mode hangs the microphone off this, and a user who
   *  hit stop wants silence, not an open mic. */
  onIdle?(): void;
}

export class SpeechQueue {
  private pending: string[] = [];   // spans awaiting synthesis
  private ready: string[] = [];     // synthesized handles awaiting playback, in order
  private gen = 0;                  // cancellation token: bumped by stop()
  private synthing = false;
  private playing: string | null = null;
  private noted = false;

  constructor(private readonly deps: SpeechQueueDeps, private readonly prefetch = 2) {}

  /** A clip is audible right now. */
  get speaking(): boolean { return this.playing !== null; }

  /** Anything queued, synthesizing, or playing — i.e. the "Speaking" indicator should be visible. */
  get busy(): boolean { return this.playing !== null || this.ready.length > 0 || this.pending.length > 0 || this.synthing; }

  /** Queue one span. Callers pass text that is already speech-shaped (markdown/code stripped). */
  say(text: string): void {
    const span = text.trim();
    if (!span) return;
    this.pending.push(span);
    void this.pumpSynth();
    this.deps.onChange();
  }

  /** Silence everything and invalidate work in flight. Safe to call when idle. */
  stop(): void {
    this.gen++;
    this.pending.length = 0;
    for (const handle of this.ready) this.deps.close(handle);
    this.ready.length = 0;
    this.synthing = false;
    if (this.playing) { this.deps.close(this.playing); this.playing = null; }
    this.noted = false;
    this.deps.onChange();
  }

  /** Synthesize the next span, keeping at most `prefetch` clips buffered ahead of the speaker. */
  private async pumpSynth(): Promise<void> {
    if (this.synthing || !this.pending.length || this.ready.length >= this.prefetch) return;
    const gen = this.gen;
    const text = this.pending.shift()!;
    this.synthing = true;
    const r = await this.deps.synth(text).catch(() => null);
    if (gen !== this.gen) return; // stopped while in flight — this audio belongs to a dead run
    this.synthing = false;
    if (!r?.audioB64) {
      // Without this the whole reply fails silently, span by span, with no clue why.
      if (!this.noted) { this.noted = true; this.deps.onError(r?.note ?? ""); }
      this.stop();
      return;
    }
    this.ready.push(this.deps.open(r.audioB64, r.mime));
    void this.pumpPlay();
    void this.pumpSynth();
    this.deps.onChange();
  }

  /** Play the next ready clip. Re-entrant-safe: a clip already playing short-circuits. */
  private async pumpPlay(): Promise<void> {
    if (this.playing || !this.ready.length) return;
    const gen = this.gen;
    const handle = this.ready.shift()!;
    this.playing = handle;
    this.deps.onChange();
    void this.pumpSynth(); // a slot just freed up — refill while this clip plays
    await this.deps.play(handle);
    if (gen !== this.gen) return; // stop() already closed this handle
    this.deps.close(handle);
    this.playing = null;
    this.deps.onChange();
    void this.pumpPlay();
    void this.pumpSynth();
    if (!this.busy) this.deps.onIdle?.(); // drained naturally — the agent has finished speaking
  }
}
