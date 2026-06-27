// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/metrics/token_speed.ts
//
// P-TPS.1 (ADR-0044): the shared, UI-agnostic core for the streaming OUTPUT-token
// readout — a live "tokens generated this turn + tokens/sec", deliberately
// EXCLUDING the system prompt / cached prefix / any input. It answers the user
// ask: "show the streaming count minus the whole system prompt so nobody thinks
// that gets charged every turn." The number here is OUTPUT only by construction —
// it is fed exclusively from assistant text/thinking/tool-call deltas (and, when
// available, the provider's `usage.output`, which omp documents as "Total output
// tokens for the turn, including thinking, assistant text, and tool-call argument
// tokens"). Input / cacheRead / cacheWrite never enter it.
//
// This is a near-verbatim vendoring of the PURE engine from the upstream
// `pi-token-speed` extension (Gabriel Sanhueza, MIT — https://github.com/gsanhueza/pi-token-speed),
// chosen because the published package cannot be loaded into omp directly: its
// settings/commands modules import `@earendil-works/pi-coding-agent` and
// `@earendil-works/pi-tui` at RUNTIME (this tree is `@oh-my-pi/*`), and its only
// renderer is omp's TUI status bar, which is a no-op in our ACP/desktop UI
// context. So we lift the algorithm (engine + sliding window + estimator),
// decouple it from the package's `~/.pi/agent/settings.json` loader (config is
// injected, not read from disk), and drive it from two thin adapters:
// harness/omp/token_speed_extension.ts (terminal status bar) and the desktop HUD.
//
// Original engine © Gabriel Sanhueza, MIT License. Modifications: config injected
// via constructor, an injectable clock for deterministic tests, and a plain-text
// formatter (no ANSI) so the same string renders in a terminal or the DOM.

export type DisplayMode = "tps" | "ttft" | "stats" | "full";

/** `estimate`: approximate tokens from delta text (word/punctuation boundaries).
 *  `direct`: count 1 token per delta. Estimate is the better default for chunked
 *  streams (ACP/omp deltas carry many characters each, not one token). */
export type CountStrategy = "estimate" | "direct";

export interface TokenSpeedConfig {
  /** Sliding-window duration (ms) for the live tok/s figure. */
  slidingWindowMs: number;
  /** How to count when no provider `usage.output` is supplied. */
  countStrategy: CountStrategy;
  /** Prefer the provider-reported cumulative `usage.output` over the local
   *  estimate when a delta carries one. Exact when available; falls back to the
   *  estimate for the deltas that arrive before the first usage figure. */
  useProviderTokens: boolean;
  /** Injectable clock (ms). Defaults to Date.now; overridden in tests. */
  now: () => number;
}

export const DEFAULT_TOKEN_SPEED_CONFIG: TokenSpeedConfig = {
  slidingWindowMs: 1000,
  countStrategy: "estimate",
  useProviderTokens: false,
  now: () => Date.now(),
};

/** Drop dead prefix entries once this many have aged out of the window. */
const COMPACTION_THRESHOLD = 5000;

/**
 * Time-based sliding window for tokens-per-second. Records timestamped token
 * batches and sums those within the most recent `windowMs`. Compacts the dead
 * prefix periodically so memory stays bounded on long turns.
 *
 * Vendored verbatim from pi-token-speed (MIT), with the clock injected so the
 * window is testable without real time passing.
 */
export class SlidingWindow {
  private readonly events: { time: number; tokens: number }[] = [];
  private windowStartIndex = 0;

  constructor(private readonly windowMs: number, private readonly now: () => number) {}

  record(tokens: number): void {
    this.events.push({ time: this.now(), tokens });
    if (this.windowStartIndex >= COMPACTION_THRESHOLD) this.compact();
  }

  /** Tokens/sec within the window as of `now`. Uses the actual time span of the
   *  in-window tokens (not the full window) for finer precision; 0 when empty. */
  getTps(now: number): number {
    if (this.events.length === 0) return 0;
    const windowStart = now - this.windowMs;
    while (
      this.windowStartIndex < this.events.length &&
      this.events[this.windowStartIndex]!.time < windowStart
    ) {
      this.windowStartIndex++;
    }
    if (this.windowStartIndex >= this.events.length) return 0;

    let windowTokenCount = 0;
    for (let i = this.windowStartIndex; i < this.events.length; i++) {
      windowTokenCount += this.events[i]!.tokens;
    }
    if (windowTokenCount === 0) return 0;

    // Floor the divisor: chunky transports (ACP surfaces one ~100-token text
    // delta at a single timestamp, unlike omp's per-token deltas) can land a big
    // batch as the only in-window event, making the actual span ~0 and spiking the
    // rate into the thousands for one frame. Clamp the span to a small minimum so a
    // single fat chunk can't divide by near-zero. (Modification vs upstream.)
    const windowDuration = Math.max((now - this.events[this.windowStartIndex]!.time) / 1000, 0.2);
    return windowTokenCount / windowDuration;
  }

  private compact(): void {
    if (this.windowStartIndex === 0) return;
    this.events.splice(0, this.windowStartIndex);
    this.windowStartIndex = 0;
  }

  reset(): void {
    this.events.length = 0;
    this.windowStartIndex = 0;
  }
}

/**
 * Per-turn output-token speedometer. Lifecycle, mirroring a streaming turn:
 *   startTTFT()  — at prompt submit (begins the time-to-first-token clock)
 *   start()      — when the assistant message begins
 *   recordDelta()— for every text / thinking / tool-call-arg delta
 *   stopTTFT()   — on the first content delta (freezes TTFT, aligns the tok/s
 *                  clock to first-token so the readout measures generation, not
 *                  the provider's queue wait)
 *   reconcileTotal() — on message end, snap the count to the authoritative usage
 *   stop()       — when the turn ends
 *
 * Config is INJECTED (no disk read), the one intentional departure from the
 * upstream engine, so the same core runs unchanged in the omp child and the
 * browser renderer.
 */
export class TokenSpeedEngine {
  private readonly cfg: TokenSpeedConfig;
  private readonly window: SlidingWindow;

  private _isStreaming = false;
  private _tokenCount = 0;
  private _startTime = 0;
  private _endTime = 0;
  private _ttftStart = 0;
  private _ttftEnd = 0;
  private _countedUsageOutput = 0;

  constructor(config: Partial<TokenSpeedConfig> = {}) {
    this.cfg = { ...DEFAULT_TOKEN_SPEED_CONFIG, ...config };
    this.window = new SlidingWindow(this.cfg.slidingWindowMs, this.cfg.now);
  }

  /** Record one streaming delta. `usageOutput` is the provider's CUMULATIVE
   *  output-token count for the turn when the delta carries one (omp's
   *  `ev.partial?.usage?.output`); we add only the increment since we last saw
   *  it. Without it (or when useProviderTokens is off) we estimate/direct-count. */
  recordDelta(delta: string, usageOutput?: number): void {
    if (!this._isStreaming) return;

    const useProvider =
      this.cfg.useProviderTokens &&
      usageOutput !== undefined &&
      usageOutput > this._countedUsageOutput;

    if (useProvider) {
      this.recordTokens(usageOutput! - this._countedUsageOutput);
      this._countedUsageOutput = usageOutput!;
      return;
    }

    if (this.cfg.countStrategy === "estimate") this.recordTokens(estimateTokens(delta));
    else this.recordTokens(1);
  }

  /** Snap the running count to the authoritative end-of-turn usage so the final
   *  total/average is exact even if the per-delta estimate drifted. */
  reconcileTotal(tokens: number): void {
    if (tokens > 0) this._tokenCount = tokens;
  }

  get isStreaming(): boolean { return this._isStreaming; }
  get tokenCount(): number { return this._tokenCount; }

  get elapsedMs(): number {
    if (this._startTime === 0) return 0;
    if (this._isStreaming) return this.cfg.now() - this._startTime;
    return this._endTime - this._startTime;
  }
  get elapsedSeconds(): number { return this.elapsedMs / 1000; }

  /** Tokens/sec: the windowed rate once the window has filled, otherwise the
   *  running average (so the figure is stable from the first delta). Best for
   *  fine-grained per-token streams (the omp terminal). */
  get tps(): number {
    if (this.elapsedMs < this.cfg.slidingWindowMs) return this.averageTps;
    if (!this._isStreaming) return this.averageTps;
    return this.window.getTps(this.cfg.now());
  }

  /** Running average tokens/sec (total ÷ elapsed). Strobe-free regardless of how
   *  lumpily deltas arrive — the right readout for chunky transports (ACP delivers
   *  a whole reasoning burst in one delta, which makes a windowed rate spike). */
  get averageTps(): number {
    const s = this.elapsedSeconds;
    return s === 0 ? 0 : this._tokenCount / s;
  }

  /** Time-to-first-token (ms). */
  get ttft(): number { return Math.max(this._ttftEnd - this._ttftStart, 0); }

  start(): void {
    this._tokenCount = 0;
    this._isStreaming = true;
    this._startTime = this.cfg.now();
    this._endTime = this._startTime;
    this._countedUsageOutput = 0;
    this.window.reset();
  }

  startTTFT(): void {
    this._ttftStart = this.cfg.now();
    this._ttftEnd = 0;
  }

  /** Freeze TTFT on the first content delta and realign the tok/s clock to that
   *  moment — the pre-token wait (queue / provider latency) is not generation. */
  stopTTFT(): void {
    if (this._ttftEnd !== 0) return;
    this._ttftEnd = this.cfg.now();
    this._startTime = this._ttftEnd;
  }

  stop(): void {
    this._isStreaming = false;
    this._endTime = this.cfg.now();
    this.window.reset();
  }

  private recordTokens(tokens: number): void {
    if (!this._isStreaming || tokens <= 0) return;
    this._tokenCount += tokens;
    this.window.record(tokens);
  }
}

/** Estimate tokens in a chunk via word/punctuation boundaries — counts words and
 *  standalone punctuation separately. The fallback when no provider count exists.
 *  Vendored from pi-token-speed (MIT). */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const matches = text.match(/\w+|[^\s\w]/g);
  return matches ? matches.length : 0;
}

/** Render the readout as PLAIN text (no ANSI) so the identical string works in a
 *  terminal status bar and the desktop DOM. The leading bolt + label is left to
 *  the caller (the terminal adds a themed "⚡ TPS:"; the desktop draws its own). */
export function formatReadout(engine: TokenSpeedEngine, mode: DisplayMode): string {
  const tps = engine.tps;
  const rate = tps > 0 ? `${tps.toFixed(1)} tok/s` : "--";
  const stats = () => {
    const s = engine.elapsedSeconds;
    return s > 0 ? `${engine.tokenCount} tok in ${s.toFixed(1)}s` : `${engine.tokenCount} tok`;
  };
  const ttft = () => `TTFT: ${engine.ttft} ms`;
  switch (mode) {
    case "ttft": return `${rate} (${ttft()})`;
    case "stats": return `${rate} (${stats()})`;
    case "full": return `${rate} (${stats()} · ${ttft()})`;
    default: return rate;
  }
}
