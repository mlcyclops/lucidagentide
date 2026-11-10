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
  if (code === "cap") return { keep: "stage", title: "Push not delivered", desc: `${why} Your note is staged for the next turn instead; right-click it and choose Steer running turn once the agent reaches its next step.` };
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

// ── P-PUSH.PAR1 (ADR-pending): Push now runs the staged prompt in PARALLEL ─────────────────────────────
// Push now used to interject the running turn (that is now "Steer running turn" in the chip's menu). It now
// spawns a NEW lane in its own git worktree on the source's repo and sends it the prompt, so the request
// starts at once while the busy agent keeps going. The rules (which folder, which name, what the new agent
// and the user are told, when to fall back) live here so they are testable without a browser.

/** Who the staged prompt was waiting behind: the main composer's agent, or a fleet lane. */
export interface PushSource { kind: "master" | "lane"; name: string; cwd: string; model: string }

/** The sibling folder LUCID's lane worktrees live in (lane_worktree.worktreePlan): `<repo>.lucid-worktrees/<slug>`. */
const WORKTREES_DIR_SUFFIX = ".lucid-worktrees";

/** The source's MAIN checkout. A source lane that itself runs in a LUCID worktree (`<repo>.lucid-worktrees/
 *  <slug>[/sub]`) maps back to `<repo>[/sub]`, so a push from it branches off the repo's main checkout and its
 *  worktree lands beside the repo, never in a `<slug>.lucid-worktrees` folder beside another worktree. Any
 *  other path is returned unchanged. Separator style is preserved. */
export function mainCheckoutCwd(cwd: string): string {
  const sep = cwd.includes("\\") ? "\\" : "/";
  let parts = cwd.split(/[\\/]/);
  for (;;) {
    let k = -1;
    for (let i = parts.length - 2; i >= 0; i--) {
      const seg = parts[i]!;
      if (seg.length > WORKTREES_DIR_SUFFIX.length && seg.toLowerCase().endsWith(WORKTREES_DIR_SUFFIX) && parts[i + 1]) { k = i; break; }
    }
    if (k < 0) return parts.join(sep);
    parts = [...parts.slice(0, k), parts[k]!.slice(0, -WORKTREES_DIR_SUFFIX.length), ...parts.slice(k + 2)];
  }
}

/** The new lane's name: `<source>-push-<n>`, the smallest n no live lane uses (case-insensitive). A push
 *  from a push lane does not stack suffixes (`api-push-1` pushes as `api-push-2`, not `api-push-1-push-1`).
 *  The main composer's agent pushes as `main-push-<n>`. */
export function pushLaneName(src: Pick<PushSource, "kind" | "name">, existing: readonly string[]): string {
  const raw = src.kind === "master" ? "main" : src.name.trim();
  const base = raw.replace(/-push-\d+$/i, "") || "lane";
  const taken = new Set(existing.map((n) => n.trim().toLowerCase()));
  for (let n = 1; ; n++) {
    const name = `${base}-push-${n}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

/** The text the new lane receives: a short context preamble, then the user's staged prompt verbatim. It
 *  says another agent is busy in the source checkout, that this agent has its own worktree and branch, and
 *  that it must finish the request there without touching the other checkout. */
export function parallelPushPrompt(src: PushSource, wt: { branch: string; path?: string }, text: string): string {
  const where = wt.path ? ` at ${wt.path}` : "";
  const preamble = [
    `[LUCID parallel push] Another agent (${src.kind === "master" ? "the main LUCID agent" : `lane "${src.name}"`}) is still working on its own task in ${src.cwd || "the main checkout of this repo"}.`,
    `You are a separate agent in your own git worktree of the same repo${where}, on branch ${wt.branch}.`,
    "Complete the request below independently on your branch. Do not edit files in, commit to, or run commands against the other agent's checkout.",
  ].join(" ");
  return `${preamble}\n\n${text}`;
}

/** What the user is told the moment they press Push now (no branch yet) and again once the lane runs (with
 *  its branch). `busy` false: the source is not mid-turn (a stopped or failed lane), which is said plainly
 *  instead of claiming it is still working. */
export function parallelPushNotice(src: PushSource, lane: string, opts: { branch?: string; busy: boolean }): { title: string; desc: string } {
  const where = `in its own worktree${opts.branch ? ` (branch ${opts.branch})` : ""}`;
  const who = src.kind === "master" ? "The main agent" : src.name;
  const desc = opts.busy
    ? `${who} is still working on its current task. Your request is being actioned in parallel by a new lane, ${lane}, ${where}.`
    : `${who} is not running a turn right now. Your request is being actioned by a new lane, ${lane}, ${where}.`;
  return { title: opts.branch ? `Running in parallel: ${lane}` : `Starting ${lane} in parallel`, desc };
}

/** Where Push now on a staged item goes, before any engine call:
 *  - `send`: nothing is running, so the item is simply the next turn (the old Send now; no worktree).
 *  - `parallel`: a turn is running and there is a folder to branch from.
 *  - `steer` / `stage`: no workspace folder, so no worktree is possible. A text-only item steers the running
 *    turn (the old Push now); an item with images stays staged, because a steer note carries no images. */
export type PushNowRoute = { kind: "send" } | { kind: "parallel" } | { kind: "steer" | "stage"; title: string; desc: string };
export function pushNowRoute(ctx: { running: boolean; cwd: string; images: number }): PushNowRoute {
  if (!ctx.running) return { kind: "send" };
  if (ctx.cwd.trim()) return { kind: "parallel" };
  return noWorktreeFallback("No workspace folder is open, so there is no repo to give a parallel lane its own worktree.", ctx.images, true);
}

function noWorktreeFallback(why: string, images: number, steerable: boolean): { kind: "steer" | "stage"; title: string; desc: string } {
  if (steerable && images === 0) return { kind: "steer", title: "Steering the running turn instead", desc: `${why} Your prompt goes into the running turn as a steer note.` };
  return { kind: "stage", title: "Push now could not start a parallel lane", desc: `${why} ${images ? "A steer note cannot carry images, so it" : "It"} stays staged and runs as the next turn.` };
}

/** A refused parallel push (the spawn, or the new lane's first prompt). `code: "no-repo"` means no worktree
 *  is possible in that folder: the main composer (`canSteer`) then steers a text-only item instead. Every
 *  other refusal keeps the item staged with the engine's own reason (ADR-0414: nothing is dropped). */
export function parallelPushRefusal(r: { reason?: string; code?: string }, ctx: { canSteer: boolean; images: number }): { kind: "steer" | "stage"; title: string; desc: string } {
  const reason = (r.reason ?? "").trim().replace(/\.$/, "");
  const why = reason ? `${reason[0]!.toUpperCase()}${reason.slice(1)}.` : "The engine did not answer.";
  if (r.code === "no-repo") return noWorktreeFallback(why, ctx.images, ctx.canSteer);
  return { kind: "stage", title: "Not pushed", desc: `${why} It stays staged and runs as the next turn.` };
}

/** "Steer running turn" (the old Push now) is offered only where it can work: a "next turn" item, while a
 *  turn runs, with no images (the steer note is text only). */
export function canSteer(ctx: { hold: boolean; running: boolean; images: number }): boolean {
  return ctx.hold && ctx.running && ctx.images === 0;
}

/** P-FLEET.L3 + P-PUSH.PAR1: may a lane run its next staged prompt now? Only when it is idle (no stream,
 *  awaiting input or done) with something staged, and NOT while a push from it is in flight: the drain
 *  pops the queue head, and the pushed prompt belongs to the parallel lane. Measured with a real lane
 *  before this rule: a source that finished first ran the pushed prompt on its own checkout too. */
export function laneDrainReady(ctx: { streaming: boolean; queued: number; status: string; pushing: boolean }): boolean {
  return !ctx.streaming && ctx.queued > 0 && !ctx.pushing && (ctx.status === "awaiting-input" || ctx.status === "done");
}
