// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-HERD-OSC.1 (ADR-0530) - `lucid hub` reports the fleet to its terminal with OSC 7501, so a
// terminal that speaks the Program Status Protocol (Herdr, Ghostty, Rex) shows what LUCID's fleet
// is doing without scraping the screen.
//
// One ROOT record for the whole fleet plus one CHILD record per lane (id = the lane id cut to the
// segment grammar, title = the lane name, app=lucid). The LaneStatus vocabulary (fleet_lanes.ts)
// maps to the protocol's states:
//   needs-approval -> blocked, kind=permission   (a tool call waits for the human's allow/deny)
//   awaiting-input -> idle                       (the lane is at rest, ready for its next prompt:
//                                                 spawn, a settled cancel and a respawn all land here;
//                                                 it asked nothing, so it is not "blocked/question")
//   working, starting -> working
//   done -> done                                 (a finished turn, ready to look at)
//   error -> error
//   stopped -> idle, msg "Stopped"               (still in the fleet, revivable and dismissable on the
//                                                 Agents deck; a record is CLEARED only when the lane
//                                                 leaves the fleet, so the terminal's count is the hub's)
// Root: blocked (kind of the first blocked lane) if any lane is blocked, else working if any works,
// else done if any is done, else idle; msg counts lanes ("2 lanes need you", plus "1 lane failed").
//
// Lane msgs are fixed phrases on purpose: a terminal may forward a record off the machine (Rex pushes
// to phones), and an approval summary or lane output is agent-derived text that stays inside LUCID.
//
// Everything here is pure except ProgramStatusEmitter, which only remembers what it last wrote and
// calls the sink it was given. Change detection compares exact report bytes, so a poll tick that
// changes nothing writes nothing.

import {
  buildProgramStatus, cleanStatusText, CLEAR_ALL_PROGRAM_STATUS, LIMITS,
  type ProgramKind, type ProgramState, type ProgramStatusReport,
} from "./program_status.ts";

export const PROGRAM_STATUS_APP = "lucid";
/** The env switch: `LUCID_PROGRAM_STATUS=0` (or false/off/no) turns the reports off. */
export const PROGRAM_STATUS_ENV = "LUCID_PROGRAM_STATUS";
/** The map key of the root record (a report with no id). Never a valid record id. */
export const ROOT_RECORD = "";

const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

/** Reports go out only on a real terminal, and only while the env switch has not turned them off. */
export function programStatusEnabled(env: Readonly<Record<string, string | undefined>>, isTTY: boolean): boolean {
  if (!isTTY) return false;
  const v = (env[PROGRAM_STATUS_ENV] ?? "").trim().toLowerCase();
  return !["0", "false", "off", "no"].includes(v);
}

/** One LaneStatus as a protocol state, with the lane record's fixed msg. An unknown status (a newer
 *  engine) is idle and says its own name, never dropped. */
export function laneProgramState(status: string): { state: ProgramState; kind?: ProgramKind; msg: string } {
  switch (status) {
    case "needs-approval": return { state: "blocked", kind: "permission", msg: "Needs your approval" };
    case "awaiting-input": return { state: "idle", msg: "Ready for a prompt" };
    case "working": return { state: "working", msg: "Working" };
    case "starting": return { state: "working", msg: "Starting" };
    case "done": return { state: "done", msg: "Turn finished" };
    case "error": return { state: "error", msg: "Failed" };
    case "stopped": return { state: "idle", msg: "Stopped" };
    default: return { state: "idle", msg: cleanStatusText(status, 64) || "Unknown status" };
  }
}

/** A lane id cut to the segment grammar `[A-Za-z0-9_.+-]{1,32}`: every other run becomes `-`. */
export function laneRecordId(laneId: string): string {
  return laneId.replace(/[^A-Za-z0-9_.+-]+/g, "-").slice(0, LIMITS.segment) || "lane";
}

const lanesWord = (n: number): string => `${n} lane${n === 1 ? "" : "s"}`;

/** The fleet as protocol records, keyed by record id (ROOT_RECORD = the root), lanes in fleet order
 *  then the root. Two lane ids that cut to the same segment stay distinct (`+2`, `+3` ... suffix). */
export function fleetRecords(lanes: readonly Record<string, unknown>[]): Map<string, ProgramStatusReport> {
  const out = new Map<string, ProgramStatusReport>();
  const counts = { blocked: 0, working: 0, done: 0, idle: 0, error: 0 };
  let rootKind: ProgramKind | undefined;
  for (const lane of lanes) {
    const laneId = str(lane.id);
    const s = laneProgramState(str(lane.status));
    counts[s.state]++;
    if (s.state === "blocked" && !rootKind) rootKind = s.kind;
    const base = laneRecordId(laneId);
    let id = base;
    for (let n = 2; out.has(id); n++) id = `${base.slice(0, LIMITS.segment - String(n).length - 1)}+${n}`;
    const title = cleanStatusText(str(lane.name), LIMITS.title) || cleanStatusText(laneId, LIMITS.title) || id;
    out.set(id, { state: s.state, ...(s.kind ? { kind: s.kind } : {}), id, title, app: PROGRAM_STATUS_APP, msg: s.msg });
  }
  const state: ProgramState = counts.blocked ? "blocked" : counts.working ? "working" : counts.done ? "done" : "idle";
  const head =
    state === "blocked" ? `${lanesWord(counts.blocked)} ${counts.blocked === 1 ? "needs" : "need"} you`
    : state === "working" ? `${lanesWord(counts.working)} working`
    : state === "done" ? `${lanesWord(counts.done)} finished`
    : lanes.length === 0 ? "No lanes"
    : counts.idle ? `${lanesWord(counts.idle)} idle` : "";
  const msg = [head, counts.error ? `${lanesWord(counts.error)} failed` : ""].filter(Boolean).join(", ");
  out.set(ROOT_RECORD, { state, ...(state === "blocked" && rootKind ? { kind: rootKind } : {}), app: PROGRAM_STATUS_APP, msg });
  return out;
}

/** The records as exact report bytes, same keys. A record the builder refuses is left out (the
 *  inputs are cleaned first, so that is a bug guard, never a path a real fleet takes). */
export function fleetReports(lanes: readonly Record<string, unknown>[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, report] of fleetRecords(lanes)) {
    const r = buildProgramStatus(report);
    if (r.ok) out.set(key, r.seq);
  }
  return out;
}

/** What to write to go from `prev` to `next`: `state=clear:id=<lane>` for each lane record that
 *  left, then every record whose bytes changed or that is new, in `next` order. Nothing when equal. */
export function diffReports(prev: ReadonlyMap<string, string>, next: ReadonlyMap<string, string>): string[] {
  const out: string[] = [];
  for (const key of prev.keys()) {
    // The root is in every snapshot; a lane key is a valid id (fleetRecords built it), so ok holds.
    if (next.has(key) || key === ROOT_RECORD) continue;
    const r = buildProgramStatus({ state: "clear", id: key });
    if (r.ok) out.push(r.seq);
  }
  for (const [key, seq] of next) if (prev.get(key) !== seq) out.push(seq);
  return out;
}

/** Writes the fleet's reports through `write` (the hub's terminal), only what changed, each batch
 *  as ONE write so no report lands inside another sequence; `clear()` removes every record. */
export class ProgramStatusEmitter {
  readonly #write: (bytes: string) => void;
  #last: ReadonlyMap<string, string> = new Map();
  #reported = false;

  constructor(write: (bytes: string) => void) {
    this.#write = write;
  }

  update(lanes: readonly Record<string, unknown>[]): void {
    const next = fleetReports(lanes);
    const out = diffReports(this.#last, next);
    this.#last = next;
    if (out.length === 0) return;
    this.#reported = true;
    this.#write(out.join(""));
  }

  /** `state=clear` with no id, once, and only when something was reported. */
  clear(): void {
    if (!this.#reported) return;
    this.#reported = false;
    this.#last = new Map();
    this.#write(CLEAR_ALL_PROGRAM_STATUS);
  }
}
