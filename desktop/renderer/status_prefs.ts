// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/status_prefs.ts - P-PROGRESS.3 (ADR-0412): how much a working agent reports while it
// works. Shared by the master HUD, the tool and subagent rows, the fleet lane cards, the grid's folder queues
// and the orbit glance.
//
// Beta.10 made the footer quiet on operator request (ADR-0409 and ADR-0408 amendments): one HUD line, a
// Restart line only when the agent process is gone, no ETAs anywhere. That stays the default for everyone.
// Two opt-ins bring back what engineers asked for, without changing what anyone else sees:
//
// 1. Detail: "line" (default) is the quiet footer; the HUD line's Details pill opens the P-PROGRESS.1 strip
//    (progress line, liveness pill, signal age, folder queue) for that turn only. "full" keeps the strip
//    open on every turn and every lane card, and shows each subagent run's liveness words.
// 2. The time estimate is EXPERIMENTAL and off by default. It is a percentile of this machine's recent turns
//    and runs, blind to task size. Off means no number anywhere: no "left (est.)", no percent, no expected
//    start time, and the bar runs indeterminate. On shows a number only once history supports one: the
//    "ETA estimating" placeholder the operator objected to is never shown.
// 3. The progress ring (on by default, beta.10 follow-up from the operator): a small green ring at the right
//    end of the HUD line, drawn like the context ring in the status bar, with a premium tooltip. It shows how
//    far the turn is against recent turns, never a time; it is empty until there is history. Every fleet lane
//    card carries the same ring in its header while that lane's turn runs.
//
// Renderer-local view state in localStorage (the `lucid.*` convention), read once and cached: the HUD reads
// these every second. Storage failures degrade to the defaults and never throw.

import { ETA_ESTIMATING, humanMs, type ProgressView } from "../turn_progress.ts";
import type { SequenceEntry } from "../workspace_gate.ts";

export type StatusDetail = "line" | "full";

const DETAIL_KEY = "lucid.status-detail";
const ETA_KEY = "lucid.status-eta";
const RING_KEY = "lucid.status-ring";

let detail: StatusDetail | null = null;
let eta: boolean | null = null;
let ring: boolean | null = null;

function read(key: string): string {
  try { return localStorage.getItem(key) ?? ""; } catch { return ""; }
}
function write(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* storage unavailable: this session still applies */ }
}

export function statusDetail(): StatusDetail {
  return detail ??= read(DETAIL_KEY) === "full" ? "full" : "line";
}
export function setStatusDetail(v: StatusDetail): void {
  detail = v === "full" ? "full" : "line";
  write(DETAIL_KEY, detail);
}

/** The experimental time estimate is shown. */
export function statusEta(): boolean {
  return eta ??= read(ETA_KEY) === "1";
}
export function setStatusEta(on: boolean): void {
  eta = on;
  write(ETA_KEY, on ? "1" : "0");
}

/** The progress ring beside the HUD line is shown (on unless the user turned it off). */
export function statusRing(): boolean {
  return ring ??= read(RING_KEY) !== "0";
}
export function setStatusRing(on: boolean): void {
  ring = on;
  write(RING_KEY, on ? "1" : "0");
}

/** What the progress ring shows: the arc (0-95 while a turn runs; null = no history yet, empty ring), a tone
 *  (red only when the agent process is gone), and its premium tooltip ("Title|Body"). Pure. The arc is how far
 *  this turn is against the typical length of recent turns on this machine, so it never claims a finish
 *  time; the time left joins the tooltip only when the user opted into the experimental estimate. `restart`
 *  names the button that revives the process where this ring sits (the HUD's, or a fleet lane card's). */
export interface RingView { pct: number | null; tone: "run" | "dead"; tip: string }
export function ringView(p: ProgressView, showEta: boolean, restart = "Restart agent"): RingView {
  const steps = p.stepsDone + p.stepsOpen.length;
  const sofar = `${humanMs(p.elapsedMs)} so far${steps ? `, step ${steps}` : ""}.`;
  const e = p.estimate;
  if (p.liveness.state === "dead") {
    // A lane whose turn already ended when its process died has no elapsed time left to report.
    const ran = p.elapsedMs > 0 ? ` ${sofar}` : "";
    return { pct: e.percent, tone: "dead", tip: `Progress: stopped|The agent process exited. Use ${restart} below; the conversation is kept.${ran}` };
  }
  if (e.typicalMs === null || e.percent === null) {
    return { pct: null, tone: "run", tip: `Progress|Working. This machine has not finished enough turns yet to show how far along a turn is; the ring fills in once it has. ${sofar}` };
  }
  if (e.overrun) {
    return { pct: e.percent, tone: "run", tip: `Progress: longer than usual|This turn is running longer than your recent turns (typically ${humanMs(e.typicalMs)}). That is often fine for a bigger task. ${sofar}` };
  }
  const left = showEta && e.etaMs !== null ? ` About ${humanMs(e.etaMs)} left (experimental estimate).` : "";
  return { pct: e.percent, tone: "run", tip: `Progress: about ${e.percent}%|Measured against how long your recent turns took on this machine, so it is a guide, not a promise.${left} ${sofar}` };
}

/** An ETA phrase as the user may see it. Pure. "" with the estimate off, and "" for the no-history
 *  placeholder, so an opted-in user sees a number or nothing. */
export function shownEta(phrase: string, showEta: boolean): string {
  return showEta && phrase !== ETA_ESTIMATING ? phrase : "";
}

/** One folder-queue entry's timing words. Pure. With the estimate off, no expected time is ever printed. */
export function queueWhen(e: SequenceEntry, now: number, showEta: boolean): string {
  if (e.state === "running") {
    const since = `running since ${humanMs(Math.max(0, now - e.sinceAt))} ago`;
    return showEta && e.etaMs !== null ? `${since}, about ${humanMs(e.etaMs)} left (est.)` : since;
  }
  if (!showEta) return "waits its turn";
  return e.expectedStartAt !== null ? `waits, starts in about ${humanMs(Math.max(0, e.expectedStartAt - now))} (est.)` : "waits, start time unknown";
}
