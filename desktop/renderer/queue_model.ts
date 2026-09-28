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

export interface QueuedItem {
  text: string;
  mode: "hold" | "push";
}

export interface AddQueuedResult {
  items: QueuedItem[];
  ok: boolean;
  reason?: string;
}

/** Stage a prompt. Trims; refuses empty text, an exact duplicate of the LAST staged item (double-Enter
 *  protection - a deliberate repeat elsewhere in the stack is allowed), and a full queue. Never mutates
 *  `items` - the caller swaps in the returned array. */
export function addQueued(items: QueuedItem[], text: string, mode: "hold" | "push", cap = 8): AddQueuedResult {
  const t = text.trim();
  if (!t) return { items, ok: false, reason: "empty prompt" };
  const last = items[items.length - 1];
  if (last && last.text === t) return { items, ok: false, reason: "already staged (same as the last item)" };
  if (items.length >= cap) return { items, ok: false, reason: `queue is full (${cap} staged)` };
  return { items: [...items, { text: t, mode }], ok: true };
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
