// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/queue_model.ts - P-INTERJECT.2: the composer's staged-prompt queue, pure.
//
// While the master turn streams, the composer stages prompts instead of dropping them. Each staged
// item carries a mode: "hold" waits for the turn to end (the first hold item auto-fires as the next
// prompt), "push" was interjected into the running turn and stays only as a visible record until the
// user removes it. DOM-free on purpose - app.ts owns rendering; this module owns the ordering rules,
// so they stay testable without a browser.

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

/** The prompt to auto-fire when the turn ends: the FIRST "hold" item, plus the queue without it.
 *  "push" items are never returned - they already went mid-turn; they keep their place in `rest`. */
export function nextHold(items: QueuedItem[]): { item: QueuedItem | null; rest: QueuedItem[] } {
  const i = items.findIndex((q) => q.mode === "hold");
  if (i < 0) return { item: null, rest: items };
  return { item: items[i]!, rest: items.filter((_, n) => n !== i) };
}
