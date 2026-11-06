// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/controller/lane_store.ts - ADR-0496: what a controller lane needs to come back after an engine restart.
//
// A lane is an omp child of the engine, so a restart ends it. Its IDENTITY does not have to end with it: the lane
// id the controller holds, the pairing that owns it, its cwd (the workspace, or its review worktree, ADR-0497), its
// model, its omp session and its bounded transcript (what `result` indexes) live here, so the engine can respawn
// the same lane on the same session at boot. A turn the engine started and never saw settle is `inFlight`; at boot
// it becomes `interrupted` and is reported, never re-run.
//
// Ownership stays in the pairing store (Pairing.lanes): a record here only restores a lane its pairing still owns.
// The file sits beside the pairing store, owner-only (0600) through temp + rename. A file that exists but does
// not parse is not treated as empty: nothing is restored from it, it is never overwritten, and new controller
// lanes are refused until a human fixes it (the PairingStore rule), because a lane that cannot be recorded would
// silently fail to come back.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { LANE_ID_RE, type LaneTurnRecord } from "../fleet_lanes.ts";

export interface ControllerLane {
  /** The engine lane id the controller addresses (`lane-<8 hex>`), kept across restarts. */
  id: string;
  pairingId: string;
  name: string;
  /** Where the lane runs: the pairing's workspace, or the matching folder of its review worktree. */
  cwd: string;
  model: string;
  /** The omp session the lane holds; a restart loads it again. */
  sessionId: string | null;
  /** Settled turns. */
  turns: number;
  /** The lane's bounded transcript as of its last settled turn (result indices, the fallback resume memory). */
  transcript: LaneTurnRecord[];
  /** ADR-0497: the review worktree of a remote lane in a git workspace. */
  worktree?: { root: string; path: string; branch: string };
  /** A turn the engine started and has not seen settle: its run id, when it started, and the text it sent. */
  inFlight?: { runId: string; at: string; text: string };
  /** When the turn an engine restart cut off had started. Cleared by the next accepted prompt. */
  interrupted?: string;
}

export class ControllerLaneStore {
  readonly #file: string;
  #lanes: ControllerLane[] = [];
  #broken: string | null = null;

  constructor(file: string) {
    this.#file = file;
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      this.#broken = `controller lane store unreadable: ${(e as Error).message}`;
      return;
    }
    try {
      const parsed = JSON.parse(raw) as { lanes?: unknown };
      if (!Array.isArray(parsed.lanes) || !parsed.lanes.every(isControllerLane)) throw new Error("bad shape");
      this.#lanes = parsed.lanes;
    } catch {
      this.#broken = "controller lane store is malformed";
    }
  }

  /** Why nothing can be recorded (a broken file), or null. */
  get broken(): string | null {
    return this.#broken;
  }

  get(id: string): ControllerLane | null {
    const l = this.#lanes.find((x) => x.id === id);
    return l ? structuredClone(l) : null;
  }

  all(): ControllerLane[] {
    return structuredClone(this.#lanes);
  }

  /** Insert or replace by id. False on a broken store (nothing written). */
  put(lane: ControllerLane): boolean {
    if (this.#broken) return false;
    const i = this.#lanes.findIndex((x) => x.id === lane.id);
    const copy = structuredClone(lane);
    if (i < 0) this.#lanes.push(copy); else this.#lanes[i] = copy;
    this.#save();
    return true;
  }

  delete(id: string): void {
    if (this.#broken) return;
    const i = this.#lanes.findIndex((x) => x.id === id);
    if (i < 0) return;
    this.#lanes.splice(i, 1);
    this.#save();
  }

  #save(): void {
    mkdirSync(dirname(this.#file), { recursive: true, mode: 0o700 });
    const tmp = `${this.#file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ lanes: this.#lanes }, null, 1) + "\n", { mode: 0o600 });
    renameSync(tmp, this.#file);
  }
}

const str = (v: unknown): v is string => typeof v === "string";

function isControllerLane(v: unknown): v is ControllerLane {
  const l = v as ControllerLane;
  return !!l && str(l.id) && LANE_ID_RE.test(l.id) && str(l.pairingId) && str(l.name) && str(l.cwd) && str(l.model)
    && (l.sessionId === null || str(l.sessionId)) && Number.isSafeInteger(l.turns) && l.turns >= 0
    && Array.isArray(l.transcript) && l.transcript.every((t) => !!t && (t.role === "user" || t.role === "assistant") && str(t.text))
    && (l.worktree === undefined || (!!l.worktree && str(l.worktree.root) && str(l.worktree.path) && str(l.worktree.branch)))
    && (l.inFlight === undefined || (!!l.inFlight && str(l.inFlight.runId) && str(l.inFlight.at) && str(l.inFlight.text)))
    && (l.interrupted === undefined || str(l.interrupted));
}
