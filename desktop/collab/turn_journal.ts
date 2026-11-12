// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/collab/turn_journal.ts - P-REMOTE.16 (ADR-0431): the host's bounded, seq-numbered journal of the
// master session's RICH turns, and the pure replay bounder every welcome/lane-sync passes through.
//
// Why: a phone that reconnects (Cloud Run's hourly WebSocket cap, a screen lock) must get back EXACTLY what
// it missed - prompts, thinking, tool calls with code/diff detail, gate blocks, answers - and nothing it
// already holds. So every settled turn carries a monotonic `seq`; the guest says the highest seq it has
// (`hello.since`) and the host replays only what came after, plus the trailing in-flight turn, and says
// honestly whether its window still covers that whole range (`complete`).
//
// Fold rules mirror `pwa_view.ts foldEvent` and `fleet_grid.ts onLaneEvent`: token/thinking append, tool
// pushes a record (with the +/- diffstat precomputed via the desktop's own `toolChip` convention, so a
// replay that has to shed code to fit a frame still shows the stat), tool-meta settles the record by id,
// block records the gate refusal, done/no-response settle the turn. Everything else is not conversation.
//
// PURE and DOM-free: no I/O, no globals, no timers. Every accessor returns COPIES, never internal arrays.

import type { ChatEvent } from "../renderer/chat_events.ts";
import { toolChip } from "../renderer/answer_chips.ts"; // the ONE diffstat convention (pwa_view uses it too)
import type { CollabToolRecord, CollabTranscriptTurn } from "./frames.ts";

/** Per-turn answer text cap in a replay (keeps a welcome bounded). Was host.ts's clip before P-REMOTE.16. */
export const TRANSCRIPT_CLIP = 4_000;
/** Per-turn thinking cap. */
export const THINKING_CLIP = 4_000;
/** Cap per authored-code field on a recorded tool call (mirrors fleet_lanes CODE_CAP). */
export const TOOL_CODE_CLIP = 16 * 1024;
/** Cap on a recorded tool call's arguments (mirrors fleet_lanes INPUT_CAP). */
export const TOOL_INPUT_CLIP = 4 * 1024;
/** Cap on the compact detail line of a recorded tool call. */
const TOOL_DETAIL_CLIP = 1_024;
/** Tool calls recorded per turn; later calls in the same turn are not recorded. */
export const MAX_TOOLS_PER_TURN = 64;
/** Settled turns retained by default. */
export const DEFAULT_MAX_TURNS = 80;
/** Target JSON size of one replay (welcome / lane-sync): well under the relay's 512 KiB sealed-frame cap. */
export const DEFAULT_REPLAY_BUDGET_BYTES = 384 * 1024;

/** The clip convention shared with the old host transcript: cut + a single ellipsis character. */
export function clip(text: string, max = TRANSCRIPT_CLIP): string {
  const t = text ?? "";
  return t.length > max ? `${t.slice(0, max)}\u2026` : t;
}

interface LiveTurn {
  seq: number;
  text: string;
  thinking: string;
  tools: CollabToolRecord[];
  blocks: { reason: string; severity: string }[];
}

export class TurnJournal {
  readonly #maxTurns: number;
  #settled: CollabTranscriptTurn[] = [];
  #live: LiveTurn | null = null;
  #nextSeq = 1;
  /** Highest seq ever evicted from the retained window (0 = nothing evicted yet). */
  #evictedThrough = 0;

  constructor(opts: { maxTurns?: number } = {}) {
    const n = opts.maxTurns;
    this.#maxTurns = typeof n === "number" && Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_TURNS;
  }

  /** Append a settled user turn and return its seq. A fresh prompt ends the previous answer, so any
   *  in-flight assistant turn is settled FIRST (with whatever it streamed). */
  user(text: string, from?: string): number {
    if (this.#live) this.#settleLive(clip(this.#live.text));
    const seq = this.#nextSeq++;
    const turn: CollabTranscriptTurn = { role: "user", text: clip(text), seq };
    if (from) turn.from = from;
    this.#push(turn);
    return seq;
  }

  /** Fold one master-session ChatEvent. Returns the seq of the turn it folded into, or null when the
   *  journal ignores the event (usage, progress, permission, ... - status, not conversation). */
  fold(e: ChatEvent): number | null {
    switch (e.type) {
      case "token": {
        const live = this.#ensureLive();
        if (live.text.length < TRANSCRIPT_CLIP) live.text += e.text;
        return live.seq;
      }
      case "thinking": {
        const live = this.#ensureLive();
        if (live.thinking.length < THINKING_CLIP) live.thinking += e.text;
        return live.seq;
      }
      case "tool": {
        const live = this.#ensureLive();
        if (live.tools.length < MAX_TOOLS_PER_TURN) live.tools.push(toolRecord(e));
        return live.seq;
      }
      case "tool-meta": {
        const live = this.#live;
        if (!live || !e.id) return null;
        const rec = live.tools.find((t) => t.id === e.id);
        if (!rec) return null;
        if (typeof e.ok === "boolean") rec.ok = e.ok;
        if (typeof e.elapsedMs === "number" && Number.isFinite(e.elapsedMs)) rec.elapsedMs = e.elapsedMs;
        return live.seq;
      }
      case "block": {
        const live = this.#ensureLive();
        live.blocks.push({ reason: String(e.reason ?? ""), severity: String(e.severity ?? "") });
        return live.seq;
      }
      case "done": {
        const authoritative = typeof e.text === "string" && e.text ? e.text : null;
        if (!this.#live && !authoritative) return null; // nothing streamed, nothing said: not a turn
        const live = this.#ensureLive();
        const seq = live.seq;
        this.#settleLive(clip(authoritative ?? live.text));
        return seq;
      }
      case "no-response": {
        const live = this.#ensureLive();
        const seq = live.seq;
        this.#settleLive("");
        return seq;
      }
      default:
        return null;
    }
  }

  /** A copy of the in-flight assistant turn (`live: true`), or null when idle. */
  live(): CollabTranscriptTurn | null {
    const live = this.#live;
    if (!live) return null;
    const turn = this.#turnOf(live, clip(live.text));
    turn.live = true;
    return turn;
  }

  /** Settled turns with seq > `since` (ALL retained turns when `since` is undefined), then the live turn
   *  last. `complete` is false when a turn after `since` has already been evicted from the window. */
  since(since?: number): { turns: CollabTranscriptTurn[]; complete: boolean } {
    const settled = since === undefined ? this.#settled : this.#settled.filter((t) => (t.seq ?? 0) > since);
    const turns = settled.map(copyTurn);
    const live = this.live();
    if (live) turns.push(live);
    return { turns, complete: since === undefined ? true : this.#evictedThrough <= since };
  }

  /** The newest settled turn's seq (0 when none). */
  lastSettledSeq(): number {
    return this.#settled[this.#settled.length - 1]?.seq ?? 0;
  }

  // ── internals ────────────────────────────────────────────────────────────

  /** The assistant turn's seq is minted LAZILY on its first event, so an idle session mints nothing. */
  #ensureLive(): LiveTurn {
    if (!this.#live) this.#live = { seq: this.#nextSeq++, text: "", thinking: "", tools: [], blocks: [] };
    return this.#live;
  }

  #settleLive(text: string): void {
    const live = this.#live;
    if (!live) return;
    this.#live = null;
    this.#push(this.#turnOf(live, text));
  }

  #turnOf(live: LiveTurn, text: string): CollabTranscriptTurn {
    const turn: CollabTranscriptTurn = { role: "assistant", text, seq: live.seq };
    if (live.thinking) turn.thinking = clip(live.thinking, THINKING_CLIP);
    if (live.tools.length) turn.tools = live.tools.map(copyTool);
    if (live.blocks.length) turn.blocks = live.blocks.map((b) => ({ reason: b.reason, severity: b.severity }));
    return turn;
  }

  #push(turn: CollabTranscriptTurn): void {
    this.#settled.push(turn);
    const over = this.#settled.length - this.#maxTurns;
    if (over > 0) {
      const dropped = this.#settled.splice(0, over);
      this.#evictedThrough = Math.max(this.#evictedThrough, dropped[dropped.length - 1]?.seq ?? 0);
    }
  }
}

/** Build the recorded form of a live `tool` event: the same fields the event carries, bounded, plus the
 *  +/- diffstat sized from the UNCLIPPED code so the stat is exact even when the stored code is cut. */
function toolRecord(e: Extract<ChatEvent, { type: "tool" }>): CollabToolRecord {
  const rec: CollabToolRecord = { name: String(e.name ?? "tool"), detail: clip(String(e.detail ?? ""), TOOL_DETAIL_CLIP) };
  if (e.id) rec.id = e.id;
  if (e.code && typeof e.code.path === "string") {
    const code: NonNullable<CollabToolRecord["code"]> = { path: e.code.path };
    if (typeof e.code.content === "string") code.content = clip(e.code.content, TOOL_CODE_CLIP);
    if (typeof e.code.oldText === "string") code.oldText = clip(e.code.oldText, TOOL_CODE_CLIP);
    if (typeof e.code.newText === "string") code.newText = clip(e.code.newText, TOOL_CODE_CLIP);
    if (typeof e.code.patch === "string") code.patch = clip(e.code.patch, TOOL_CODE_CLIP);
    rec.code = code;
  }
  if (typeof e.input === "string") rec.input = clip(e.input, TOOL_INPUT_CLIP);
  if (typeof e.intent === "string") rec.intent = e.intent;
  const stat = toolChip(e.name, e.detail, e.code).diffstat;
  if (stat) { rec.add = stat.add; rec.del = stat.del; }
  return rec;
}

/** Deep copy of a tool record (code object included), so a caller can never reach journal state. */
export function copyTool(t: CollabToolRecord): CollabToolRecord {
  const out: CollabToolRecord = { name: t.name, detail: t.detail };
  if (t.id !== undefined) out.id = t.id;
  if (t.code) {
    const code: NonNullable<CollabToolRecord["code"]> = { path: t.code.path };
    if (t.code.content !== undefined) code.content = t.code.content;
    if (t.code.oldText !== undefined) code.oldText = t.code.oldText;
    if (t.code.newText !== undefined) code.newText = t.code.newText;
    if (t.code.patch !== undefined) code.patch = t.code.patch;
    out.code = code;
  }
  if (t.input !== undefined) out.input = t.input;
  if (t.intent !== undefined) out.intent = t.intent;
  if (t.ok !== undefined) out.ok = t.ok;
  if (t.elapsedMs !== undefined) out.elapsedMs = t.elapsedMs;
  if (t.add !== undefined) out.add = t.add;
  if (t.del !== undefined) out.del = t.del;
  return out;
}

/** Deep copy of a transcript turn. Field-by-field on purpose: an engine-only field added to a source
 *  record later cannot ride to a guest by accident. */
export function copyTurn(t: CollabTranscriptTurn): CollabTranscriptTurn {
  const out: CollabTranscriptTurn = { role: t.role, text: t.text };
  if (t.seq !== undefined) out.seq = t.seq;
  if (t.from !== undefined) out.from = t.from;
  if (t.thinking !== undefined) out.thinking = t.thinking;
  if (t.tools) out.tools = t.tools.map(copyTool);
  if (t.blocks) out.blocks = t.blocks.map((b) => ({ reason: b.reason, severity: b.severity }));
  if (t.error !== undefined) out.error = t.error;
  if (t.live !== undefined) out.live = t.live;
  return out;
}

/**
 * Fit a replay under the frame budget (JSON length as the byte proxy), shedding the least valuable detail
 * first and the oldest first within each tier:
 *   1. tool code bodies (content/oldText/newText/patch), keeping `code.path` and the precomputed add/del;
 *   2. thinking;
 *   3. whole turns, oldest first - the only step that loses conversation, so only it sets `trimmed`.
 * Returns copies; the input is never mutated.
 */
export function boundTranscript(turns: CollabTranscriptTurn[], budgetBytes = DEFAULT_REPLAY_BUDGET_BYTES): { turns: CollabTranscriptTurn[]; trimmed: boolean } {
  const out = turns.map(copyTurn);
  const sizes = out.map((t) => JSON.stringify(t).length);
  // `[a,b,c]` = the items + a comma per gap + the two brackets.
  const total = () => sizes.reduce((a, b) => a + b, 0) + Math.max(0, out.length - 1) + 2;
  if (total() <= budgetBytes) return { turns: out, trimmed: false };

  for (let i = 0; i < out.length; i++) {
    const turn = out[i]!;
    if (!turn.tools) continue;
    for (const t of turn.tools) {
      const c = t.code;
      if (!c || (c.content === undefined && c.oldText === undefined && c.newText === undefined && c.patch === undefined)) continue;
      t.code = { path: c.path };
      sizes[i] = JSON.stringify(turn).length;
      if (total() <= budgetBytes) return { turns: out, trimmed: false };
    }
  }
  for (let i = 0; i < out.length; i++) {
    const turn = out[i]!;
    if (turn.thinking === undefined) continue;
    delete turn.thinking;
    sizes[i] = JSON.stringify(turn).length;
    if (total() <= budgetBytes) return { turns: out, trimmed: false };
  }
  let trimmed = false;
  while (out.length && total() > budgetBytes) {
    out.shift();
    sizes.shift();
    trimmed = true;
  }
  return { turns: out, trimmed };
}
