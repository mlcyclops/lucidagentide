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
//
// Renderer-local view state in localStorage (the `lucid.*` convention), read once and cached: the HUD reads
// these every second. Storage failures degrade to the defaults and never throw.

import { ETA_ESTIMATING, humanMs } from "../turn_progress.ts";
import type { SequenceEntry } from "../workspace_gate.ts";

export type StatusDetail = "line" | "full";

const DETAIL_KEY = "lucid.status-detail";
const ETA_KEY = "lucid.status-eta";

let detail: StatusDetail | null = null;
let eta: boolean | null = null;

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
