// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/timeline.ts
//
// P-FLEET.L5 (ADR-0274): ONE reviewable timeline across every conversation this machine has had -
// master chats, fleet lane sessions, and kg-ingest throwaways - ordered by time, spanning ALL
// workspaces. The finding that made this an INDEXING problem instead of a recording one: omp already
// persists every session (interactive or ACP) as a .jsonl under ~/.omp/agent/sessions/<encoded-cwd>/;
// lane histories were on disk all along, merely invisible because the sidebar filters to the master's
// cwd and nothing tied a .jsonl to the lane that produced it.
//
// The tie is the LANE-SESSION LEDGER: an append-only JSONL (~/.omp/lucid-fleet-lanes.jsonl, the P-LOC.4
// sidecar pattern) that FleetLaneManager writes through its injected recorder at every spawn and
// recovery. A session id found in the ledger renders as a LANE row with its lane name; the ledger
// survives engine restarts, so a lane stopped last week is still reviewable today.
//
// Topology per the dsh unified-query survey (ADR-0274): one query surface over one corpus, exact reads
// only in this increment; any future FTS is a derived, disposable index. The .jsonl files stay the
// truth - this module never writes to the session corpus, and reading a point reuses sessionMessages.

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { listAllSessions, type SessionRow } from "./sessions.ts";
import type { LaneSessionRecord } from "./fleet_lanes.ts";

/** The durable lane-session ledger. Beside the cred vault dir, not inside the session corpus. */
export const LANE_LEDGER_PATH = (): string => join(homedir(), ".omp", "lucid-fleet-lanes.jsonl");

/** Append one ledger line. Fail-quiet by contract (FleetLaneDeps.recordLaneSession): a broken ledger
 *  must never block a lane; the row is merely unlabeled on the timeline until the next good write. */
export function appendLaneLedger(rec: LaneSessionRecord, path: string = LANE_LEDGER_PATH()): void {
  try { appendFileSync(path, `${JSON.stringify(rec)}\n`); } catch { /* fail-quiet */ }
}

/** Read the ledger, tolerant of torn tails and junk lines (append-only files earn both). */
export function readLaneLedger(path: string = LANE_LEDGER_PATH()): LaneSessionRecord[] {
  if (!existsSync(path)) return [];
  const out: LaneSessionRecord[] = [];
  let text = "";
  try { text = readFileSync(path, "utf8"); } catch { return []; }
  for (const ln of text.split("\n")) {
    if (!ln.trim()) continue;
    try {
      const o: unknown = JSON.parse(ln);
      if (
        o && typeof o === "object" &&
        "sessionId" in o && typeof o.sessionId === "string" && o.sessionId &&
        "laneId" in o && typeof o.laneId === "string" &&
        "name" in o && typeof o.name === "string" &&
        "cwd" in o && typeof o.cwd === "string" &&
        "at" in o && typeof o.at === "number" &&
        "event" in o && (o.event === "spawn" || o.event === "respawn")
      ) {
        out.push({ at: o.at, laneId: o.laneId, name: o.name, cwd: o.cwd, sessionId: o.sessionId, event: o.event });
      }
    } catch { /* torn line - skip, never throw */ }
  }
  return out;
}

/** Closed set. `chat` = a human-driven session (master or any full GUI instance); `lane` = a fleet
 *  worker's session (ledger-matched); `ingest` = a kg-import extractor throwaway. */
export type TimelineKind = "chat" | "lane" | "ingest";

export interface TimelineEntry {
  sessionId: string;
  kind: TimelineKind;
  title: string;
  cwd: string;
  /** The workspace label the row shows - basename(cwd), "" when the session recorded no cwd. */
  wsName: string;
  model: string;
  turns: number;
  updatedAt: number;
  /** Lane rows only: which lane produced this session, and what the user named it. */
  laneId?: string;
  laneName?: string;
  /** Lane rows only: how many ledger events (spawn + respawns) point at this session. */
  laneEvents?: number;
}

export interface TimelinePage { entries: TimelineEntry[]; total: number }

/** PURE merge: classify every session row against the lane ledger, newest first, paged. The ledger's
 *  LATEST record per session wins (a respawn may rename nothing, but the freshest name is the honest
 *  one). Ingest classification rides the parser's own kind - the ledger never overrides it, because a
 *  lane cannot be an extractor throwaway. */
export function buildTimeline(sessions: SessionRow[], ledger: LaneSessionRecord[], opts: { limit?: number; offset?: number } = {}): TimelinePage {
  const byName = (p: string): string => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
  const laneBySession = new Map<string, { laneId: string; name: string; events: number; at: number }>();
  for (const rec of ledger) {
    const cur = laneBySession.get(rec.sessionId);
    if (!cur) laneBySession.set(rec.sessionId, { laneId: rec.laneId, name: rec.name, events: 1, at: rec.at });
    else { cur.events++; if (rec.at >= cur.at) { cur.laneId = rec.laneId; cur.name = rec.name; cur.at = rec.at; } }
  }
  const entries: TimelineEntry[] = sessions.map((s) => {
    const lane = laneBySession.get(s.id);
    const kind: TimelineKind = s.kind === "kg-ingest" ? "ingest" : lane ? "lane" : "chat";
    return {
      sessionId: s.id,
      kind,
      title: s.title,
      cwd: s.cwd,
      wsName: byName(s.cwd),
      model: s.model,
      turns: s.turns,
      updatedAt: s.updatedAt,
      ...(lane ? { laneId: lane.laneId, laneName: lane.name, laneEvents: lane.events } : {}),
    };
  });
  entries.sort((a, b) => b.updatedAt - a.updatedAt);
  const offset = Math.max(0, opts.offset ?? 0);
  const limit = Math.max(1, Math.min(500, opts.limit ?? 100));
  return { entries: entries.slice(offset, offset + limit), total: entries.length };
}

/** The live listing dev.ts serves: corpus scan (index-cached) + ledger read + pure merge. */
export function listTimeline(opts: { limit?: number; offset?: number } = {}, root?: string, ledgerPath?: string): TimelinePage {
  return buildTimeline(listAllSessions(root), readLaneLedger(ledgerPath), opts);
}
