// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/collab/fleet_status.ts - P-PWA-FLEET.2: the ONE place lane status is ordered, named, and counted.
//
// Two surfaces render a fleet roll-up: the desktop's minimized dock pill (fleet_grid.ts) and the phone
// PWA's collapsed fleet bar (tools/remote-pwa). They must never disagree about what amber means or which
// state a glance should land on first, so the order, the wording, and the counting live here once.
//
// PURE, DOM-free, import-free (a `LaneStatus`-shaped string is all it knows), so the PWA bundle can import
// it without dragging in a renderer module, and every rule is unit-testable.
//
// The COLOURS are deliberately NOT here: both surfaces key them off the same `lane-<status>` class through
// the same CSS custom properties (`--lane` / `--lane-dim`), which is what stops a colour edit in one
// stylesheet from silently diverging from the other.

/** Attention-first order: what needs a human, then what is running, then what has settled. Every roll-up
 *  walks this, so the first thing a user sees is always the most urgent thing. */
export const LANE_STATUS_ORDER: readonly string[] = [
  "needs-approval",
  "awaiting-input",
  "working",
  "starting",
  "done",
  "error",
  "stopped",
];

/** Per-state wording, phrased so it reads after a count: "2 need approval", "1 waiting on you". */
export const LANE_STATUS_WORDS: Readonly<Record<string, string>> = {
  "needs-approval": "need approval",
  "awaiting-input": "waiting on you",
  working: "working",
  starting: "starting",
  done: "done",
  error: "errored",
  stopped: "stopped",
};

/** The states that mean a human is BLOCKING the lane. The only ones allowed to animate, on either surface,
 *  so "something is moving" always means "something wants you". */
const ATTENTION: Readonly<Record<string, true>> = { "needs-approval": true, "awaiting-input": true };
/** The states that mean the lane is making progress on its own. */
const BUSY: Readonly<Record<string, true>> = { working: true, starting: true };

/** One state present in a snapshot, with the lanes in it. */
export interface LaneStatusCount {
  status: string;
  count: number;
  /** Lane names, in snapshot order, for the hover and the summary line. */
  names: string[];
  /** This state blocks on a human: the caller may tint and animate it, and nothing else. */
  attention: boolean;
}

/** Everything a fleet roll-up needs, from one pass over the snapshot. */
export interface LaneRollup {
  /** States present, attention-first; empty for an empty snapshot. */
  counts: LaneStatusCount[];
  /** Something needs a human right now. Drives the attention tint + the only animation. */
  attention: boolean;
  /** Something is running. Attention wins wherever only one tone can be shown. */
  busy: boolean;
  /** "2 need approval, 1 working" - attention-first, so the phrase leads with what is blocked on the user.
   *  "" for an empty snapshot: the desktop pill and the phone bar word "no lanes" differently. */
  summary: string;
  /** One line per state naming its lanes ("2 need approval: api, web"), for a hover or a detail list. */
  lines: string[];
}

/**
 * Roll a lane snapshot up for display.
 *
 * An UNKNOWN status (a newer host reporting a state this build has no copy for) is NOT dropped: it sorts
 * after every known state, keeps its raw name as its wording, and still contributes its count. Losing a
 * lane from the roll-up because we did not recognize its state would silently undercount work in flight.
 * It never counts as attention, though - only a state we can actually reason about earns the alarm colour.
 */
export function laneRollup(lanes: ReadonlyArray<{ status: string; name?: string; id?: string }>): LaneRollup {
  // Dynamic grouping keyed by whatever the host sent, so a Map (not a Record): unknown keys, insertion
  // order matters for the unrecognized-state tail.
  const byStatus = new Map<string, string[]>();
  for (const lane of lanes) {
    const names = byStatus.get(lane.status) ?? [];
    names.push(lane.name || lane.id || lane.status);
    byStatus.set(lane.status, names);
  }
  const ordered = [...LANE_STATUS_ORDER, ...[...byStatus.keys()].filter((s) => !LANE_STATUS_ORDER.includes(s))];
  const counts: LaneStatusCount[] = [];
  const lines: string[] = [];
  let attention = false;
  let busy = false;
  for (const status of ordered) {
    const names = byStatus.get(status);
    if (!names?.length) continue;
    const isAttention = ATTENTION[status] === true;
    attention ||= isAttention;
    busy ||= BUSY[status] === true;
    counts.push({ status, count: names.length, names, attention: isAttention });
    lines.push(`${names.length} ${LANE_STATUS_WORDS[status] ?? status}: ${names.join(", ")}`);
  }
  return {
    counts,
    attention,
    busy,
    summary: counts.map((c) => `${c.count} ${LANE_STATUS_WORDS[c.status] ?? c.status}`).join(", "),
    lines,
  };
}
