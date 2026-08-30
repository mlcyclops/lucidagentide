// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/collab/sync_state.ts - P-PWA-FOCUS.2: the phone's cross-target SYNC decision, as pure functions.
//
// The phone screen auto-locks mid-turn. While it is dark the guest connection keeps folding events for every
// conversation the phone tracks (the master session, plus each fleet lane), so on return there is a backlog the
// user never actually looked at. This module answers the only two questions the phone UI has: WHERE does the
// unseen run begin, per conversation, and may we jump there WITHOUT asking first.
//
// PURE by contract: no DOM, no timers, no globals, no IO. The PWA bundle imports this, and the decision is
// exactly the kind of thing that must be testable headless at every boundary: a lane whose replay SHRANK the
// stream, a clock that went backwards, the precise edge of the auto window.
//
// The rendered stream for a target is conceptually `prior` turns followed by the folded live `items`, so a
// position in it is an index into that concatenation and `prior.length + items.length` is its total length.
// Everything here is expressed in those stream positions, never in turns or items separately.

/** One conversation the phone tracks: the master session, or a fleet lane. */
export interface TargetProgress {
  /** "master", or a lane id. */
  target: string;
  /** Display name for the summary line (a lane's name; "main session" for master). */
  label: string;
  /** Rendered stream length right now: prior turns + folded live items. */
  total: number;
  /** Stream length the user had actually LOOKED at (focused + page visible). */
  seen: number;
}

export interface TargetUnseen { target: string; label: string; count: number; firstUnseen: number }

export interface SyncPlan {
  /** Targets with unseen updates. ORDER: the FOCUSED target first when it has any (that is where the user
   *  already is, so it is the cheapest place to land them), then the rest by DESCENDING count, ties broken
   *  by label for a stable render. */
  unseen: TargetUnseen[];
  totalUnseen: number;
  /** True when the phone should apply this WITHOUT asking: a short absence is a glance, not a departure. */
  auto: boolean;
  /** One line, e.g. "12 updates in 2 conversations" / "3 updates in Stella". "" when nothing is unseen. */
  summary: string;
}

export const SYNC_AUTO_WINDOW_MS = 60_000;

/** Decide what the phone owes the user after the screen came back: the unseen runs per conversation, ranked,
 *  and whether to apply the jump silently. */
export function planSync(
  targets: ReadonlyArray<TargetProgress>,
  focus: string,
  awayMs: number,
  autoWindowMs: number = SYNC_AUTO_WINDOW_MS,
): SyncPlan {
  // WHY the clamp: a negative or non-finite absence means the clock moved backwards or was never sampled (a
  // suspended tab, a device that resynced its clock while dark). Reading that as 0 fails toward auto-syncing
  // rather than stranding the user behind a control they have to hunt for.
  const away = Number.isFinite(awayMs) && awayMs > 0 ? awayMs : 0;
  const windowMs = Number.isFinite(autoWindowMs) ? autoWindowMs : SYNC_AUTO_WINDOW_MS;
  // WHY INCLUSIVE, and WHY computed even with nothing unseen: a lock that lasted exactly the window is still a
  // glance, and the caller may want to know it was a glance in order to restore scroll quietly, so it must not
  // have to re-derive this rule from `awayMs` itself.
  const auto = away <= windowMs;

  const unseen: TargetUnseen[] = [];
  for (const t of targets) {
    // WHY the clamp: a target can SHRINK. A fresh `lane-sync` replay legitimately replaces a longer live item
    // list with a shorter authoritative one, so `seen` can exceed `total` for a moment. Fail closed toward
    // "nothing new" (zero unseen, omitted entirely) rather than reporting a negative count, and treat a length
    // that is not a real number as read in full rather than inventing updates out of NaN.
    const total = Number.isFinite(t.total) ? Math.max(0, Math.floor(t.total)) : 0;
    const seen = Number.isFinite(t.seen) ? Math.min(total, Math.max(0, Math.floor(t.seen))) : total;
    const count = total - seen;
    if (count <= 0) continue;
    // WHY `firstUnseen` IS the seen length: positions are indices into `prior` then `items`, so the amount that
    // was read is the index where the unread run starts, which is where the divider belongs.
    unseen.push({ target: t.target, label: t.label, count, firstUnseen: seen });
  }

  // WHY this order: the FOCUSED conversation leads when it has anything, because it is the screen the user is
  // already looking at and the cheapest place to land them. The rest rank by how much they missed (loudest
  // first), and equal counts fall back to the label so two renders of one backlog never disagree.
  unseen.sort((a, b) =>
    Number(b.target === focus) - Number(a.target === focus)
    || b.count - a.count
    || a.label.localeCompare(b.label),
  );

  let totalUnseen = 0;
  for (const u of unseen) totalUnseen += u.count;
  const first = unseen[0];
  // WHY name the lone conversation: with one backlog the name IS the useful part ("3 updates in Stella"); with
  // several, the user only needs the shape of the pile before choosing. This branch means two or more, since
  // every entry carries at least one update, so "conversations" is always plural here.
  const where = unseen.length === 1 && first ? first.label : `${unseen.length} conversations`;
  const summary = totalUnseen === 0 ? "" : `${totalUnseen} update${totalUnseen === 1 ? "" : "s"} in ${where}`;
  return { unseen, totalUnseen, auto, summary };
}
