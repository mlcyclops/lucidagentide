// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-SWITCH.2 (ADR-0404): one omp session, one owner. Main (the master omp process) or ONE live fleet lane
// may hold a session; never both, never two lanes. Two holders means two omp processes appending to the
// same .jsonl, so the history interleaves and each process's memory disagrees with the file. Pure and
// DOM-free: dev.ts and fleet_lanes.ts enforce it, the renderer paints it, all from this one rule.

/** A lane whose child is gone (user-stopped, or crashed) no longer holds its session file. Every other
 *  status (starting, working, needs-approval, awaiting-input, done) has a live omp process on it. */
export function laneHoldsSession(status: string): boolean {
  return status !== "stopped" && status !== "error";
}

/** The fields of a lane the ownership rule reads (a LaneView satisfies it). */
export interface OwnerLane { id: string; name: string; sessionId: string | null; status: string }

/** Where a session is live right now, as the sidebar shows it. Absent = on disk only. */
export type SessionLive =
  | { where: "main"; busy: boolean }
  | { where: "spoke"; laneId: string; name: string; status: string };
export type SessionLiveSpoke = Extract<SessionLive, { where: "spoke" }>;

/** Who holds session `id`: a live lane, Main, or nobody. */
export function sessionLive(id: string, main: { sessionId: string | null; busy: boolean }, lanes: OwnerLane[]): SessionLive | null {
  const lane = lanes.find((l) => l.sessionId === id && laneHoldsSession(l.status));
  if (lane) return { where: "spoke", laneId: lane.id, name: lane.name, status: lane.status };
  return main.sessionId === id ? { where: "main", busy: main.busy } : null;
}

/** Stamp each listed session with where it is live, leaving the rest untouched. */
export function withLiveState<S extends { id: string }>(sessions: S[], main: { sessionId: string | null; busy: boolean }, lanes: OwnerLane[]): (S & { live?: SessionLive })[] {
  return sessions.map((s) => {
    const live = sessionLive(s.id, main, lanes);
    return live ? { ...s, live } : s;
  });
}
