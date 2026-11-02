// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/queue_model.ts - P-INTERJECT.2: the composer's staged-prompt queue, pure.
//
// While the master turn streams, the composer stages prompts instead of dropping them. Each staged
// item carries a mode: "hold" waits for the turn to end (the first hold item auto-fires as the next
// prompt), "push" was interjected into the running turn and stays only as a visible record until the
// user removes it. DOM-free on purpose - app.ts owns rendering; this module owns the ordering rules,
// so they stay testable without a browser.

import type { InterjectResult } from "./bridge.ts";
import type { Attachment } from "./composer_attachments.ts";

export interface QueuedItem {
  text: string;
  mode: "hold" | "push";
  /** P-QUEUE-IMG.1 (ADR-0469): the images pasted into the composer when THIS prompt was staged. The item
   *  owns them: they leave the composer at staging and go out with this item (drain, Send now), never with
   *  whatever the composer sends next. Absent means text only. */
  atts?: Attachment[];
}

export interface AddQueuedResult {
  items: QueuedItem[];
  ok: boolean;
  reason?: string;
}

/** Stage a prompt. Trims; refuses an item with neither text nor images, an exact text-only duplicate of
 *  the LAST staged item (double-Enter protection - a deliberate repeat elsewhere in the stack, or the same
 *  words with images, is allowed), and a full queue. `atts` become the item's own images. `before` re-stages
 *  an item pulled out by Update at its old slot: it lands just ahead of the item that followed it, or at the
 *  end when that item is gone (ran, or removed) or was null. Never mutates `items` - the caller swaps in the
 *  returned array. */
export function addQueued(items: QueuedItem[], text: string, mode: "hold" | "push", opts: { atts?: Attachment[]; before?: QueuedItem | null; cap?: number } = {}): AddQueuedResult {
  const t = text.trim();
  const atts = opts.atts ?? [];
  const cap = opts.cap ?? 8;
  if (!t && !atts.length) return { items, ok: false, reason: "empty prompt" };
  const last = items[items.length - 1];
  if (last && last.text === t && !atts.length) return { items, ok: false, reason: "already staged (same as the last item)" };
  if (items.length >= cap) return { items, ok: false, reason: `queue is full (${cap} staged)` };
  const item: QueuedItem = atts.length ? { text: t, mode, atts: atts.slice() } : { text: t, mode };
  const at = opts.before ? items.indexOf(opts.before) : -1;
  return { items: at < 0 ? [...items, item] : [...items.slice(0, at), item, ...items.slice(at)], ok: true };
}

/** P-QUEUE-IMG.1 (ADR-0469): Update on a staged "next turn" item. It leaves the queue and its text and its
 *  own images go back into the composer for editing. Refused (nothing moves) when the composer holds a
 *  draft, text OR images, because a draft is never overwritten or merged into; and for a "push" record,
 *  which already went into the running turn. `before` is the item that followed it, for addQueued to
 *  re-stage the edited prompt in the same slot. */
export function editQueued(items: QueuedItem[], i: number, draft: { text: string; atts: number }): { ok: true; item: QueuedItem; rest: QueuedItem[]; before: QueuedItem | null } | { ok: false; code: "gone" | "pushed" | "draft" } {
  const item = items[i];
  if (!item) return { ok: false, code: "gone" };
  if (item.mode !== "hold") return { ok: false, code: "pushed" };
  if (draft.text.trim() || draft.atts > 0) return { ok: false, code: "draft" };
  return { ok: true, item, rest: items.filter((_, n) => n !== i), before: items[i + 1] ?? null };
}

/** ADR-0414: where a refused Push puts the user's text. There is deliberately no "drop": `send` runs it
 *  as the next prompt, `stage` keeps it as a "next turn" item above the composer, `composer` puts it back
 *  in the input for the user to edit. */
export interface PushRecovery { keep: "send" | "stage" | "composer"; title: string; desc: string }

/** ADR-0414: the refused-Push decision, pure. `reason` is the engine's own sentence and is always quoted,
 *  so the toast names the actual cause instead of guessing between "cap" and "unreachable".
 *  `draft`: the composer holds text the user typed since (never clobbered, so the note stages instead).
 *  `ownTurnOpen`: this composer's own stream has not settled yet, so a staged "next turn" item fires the
 *  moment it does. */
export function pushRecovery(code: Extract<InterjectResult, { ok: false }>["code"], reason: string, ctx: { draft: boolean; ownTurnOpen: boolean }): PushRecovery {
  const why = reason ? `${reason[0]!.toUpperCase()}${reason.slice(1)}.` : "The note was refused.";
  if (code === "idle") {
    if (ctx.ownTurnOpen) return { keep: "stage", title: "The turn was finishing", desc: `${why} Your note is staged and runs as the next prompt when this one settles.` };
    if (ctx.draft) return { keep: "stage", title: "The turn had already ended", desc: `${why} Your note is staged above the composer; press Send now to run it.` };
    return { keep: "send", title: "Sent as a new prompt", desc: `${why} Your note was sent as the next prompt instead.` };
  }
  if (code === "cap") return { keep: "stage", title: "Push not delivered", desc: `${why} Your note is staged for the next turn instead; press Push now on it once the agent reaches its next step.` };
  if (code === "unreachable") return { keep: "stage", title: "Push not delivered", desc: `${why} Your note is staged for the next turn; nothing was lost.` };
  // unknown-target / too-long / empty / no-target: the text itself needs the user (edit it, or send it
  // somewhere that exists). Back into the composer, unless a draft is there, which is never overwritten.
  if (ctx.draft) return { keep: "stage", title: "Push not delivered", desc: `${why} Your note is staged above the composer.` };
  return { keep: "composer", title: "Push not delivered", desc: `${why} Your text is back in the composer.` };
}

/** The prompt to auto-fire when the turn ends: the FIRST "hold" item, plus the queue without it.
 *  "push" items are never returned - they already went mid-turn; they keep their place in `rest`. */
export function nextHold(items: QueuedItem[]): { item: QueuedItem | null; rest: QueuedItem[] } {
  const i = items.findIndex((q) => q.mode === "hold");
  if (i < 0) return { item: null, rest: items };
  return { item: items[i]!, rest: items.filter((_, n) => n !== i) };
}
