// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/fleet_goal.ts - P-AOS.1 (ADR-0452): the engine's AOS-1 orchestrator state. One standing fleet
// goal, persisted to ~/.omp/lucid-fleet-goal.json (written only when the goal changes, atomically: temp
// file then rename), and an in-memory heartbeat that beats every AOS_INTERVAL_S. The heartbeat is the
// engine's own pulse, so an observer that sees it age past 1.5x / 3x the interval is looking at a frozen
// or dead engine (the failure P-TL.4 found: a synchronous scan blocking the event loop for seconds).
// All the rules live in aos.ts; this file is clock, timer and disk.

import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  AOS_INTERVAL_S, control, newGoal, parseGoal, setCriterion, spentUsd, tick, validateGoalInput,
  type AosControl, type AosGoal, type AosHeartbeat, type AosLaneInput, type AosSnapshot,
} from "./aos.ts";

export const FLEET_GOAL_PATH = (): string => join(homedir(), ".omp", "lucid-fleet-goal.json");

export interface FleetGoalDeps {
  /** The lanes the heartbeat observes (synchronous: a tick never awaits). */
  lanes: () => AosLaneInput[];
  now?: () => number;
  path?: string;
}

type Reply = { ok: true; data: AosSnapshot } | { ok: false; error: string };

export class FleetGoal {
  #goal: AosGoal | null;
  #hb: AosHeartbeat;
  #agents: AosSnapshot["agents"] = [];
  #timer: Timer | null = null;
  readonly #lanes: () => AosLaneInput[];
  readonly #now: () => number;
  readonly #path: string;

  constructor(deps: FleetGoalDeps) {
    this.#lanes = deps.lanes;
    this.#now = deps.now ?? Date.now;
    this.#path = deps.path ?? FLEET_GOAL_PATH();
    let text = "";
    try { text = readFileSync(this.#path, "utf8"); } catch { /* no goal yet */ }
    this.#goal = text ? parseGoal(text) : null;
    this.#hb = { seq: 0, ts: 0, intervalS: AOS_INTERVAL_S, status: "running", lastTickMs: 0, consecutiveErrors: 0 };
  }

  /** Start beating. The first beat is immediate so an observer never reads a never-stamped heartbeat. */
  start(): void {
    if (this.#timer) return;
    this.beat();
    this.#timer = setInterval(() => this.beat(), AOS_INTERVAL_S * 1000);
    this.#timer.unref?.();
  }

  stop(): void {
    clearInterval(this.#timer ?? undefined);
    this.#timer = null;
  }

  /** One heartbeat tick. Synchronous, so two ticks can never overlap. A failure counts as a heartbeat
   *  error and never throws out of the timer. */
  beat(): void {
    const t0 = this.#now();
    try {
      const r = tick(this.#goal, this.#hb, this.#lanes(), t0);
      this.#agents = r.agents;
      if (r.changed) this.#save(r.goal);
      this.#goal = r.goal;
      this.#hb = { ...r.heartbeat, lastTickMs: Math.max(0, this.#now() - t0), consecutiveErrors: 0 };
    } catch (e) {
      this.#hb = { ...this.#hb, consecutiveErrors: this.#hb.consecutiveErrors + 1 };
      console.error(`[aos] heartbeat tick failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  snapshot(): AosSnapshot {
    const g = this.#goal;
    return {
      goal: g,
      heartbeat: this.#hb,
      agents: this.#agents,
      spentUsd: g ? spentUsd(g) : 0,
      elapsedS: g ? Math.max(0, (g.status === "achieved" || g.status === "cancelled" ? g.updatedAt : this.#now()) - g.createdAt) / 1000 : 0,
    };
  }

  /** Set the standing goal. AOS-1: exactly one active goal, so an open one must be cancelled first. */
  set(raw: unknown): Reply {
    if (this.#goal && (this.#goal.status === "active" || this.#goal.status === "blocked")) return { ok: false, error: "A fleet goal is already open. Cancel it before setting a new one." };
    const v = validateGoalInput(raw);
    if (!v.ok) return v;
    const now = this.#now();
    const g = newGoal(v.input, `goal-${randomUUID()}`, this.#lanes(), now);
    const saved = this.#save(g);
    if (!saved.ok) return saved;
    this.#goal = g;
    this.#hb = { ...this.#hb, status: "running" };
    this.beat();
    return { ok: true, data: this.snapshot() };
  }

  criterion(id: unknown, met: unknown): Reply {
    if (typeof id !== "string" || typeof met !== "boolean") return { ok: false, error: "criterion needs an id and met: true|false" };
    const r = setCriterion(this.#goal, id, met, this.#now());
    if (!r.ok) return r;
    if (r.goal !== this.#goal) {
      const saved = this.#save(r.goal);
      if (!saved.ok) return saved;
      this.#goal = r.goal;
    }
    this.beat(); // Verify now: ticking the last criterion achieves the goal without waiting for the next beat
    return { ok: true, data: this.snapshot() };
  }

  control(action: unknown): Reply {
    if (action !== "pause" && action !== "resume" && action !== "cancel" && action !== "dismiss") return { ok: false, error: "action must be pause, resume, cancel, or dismiss" };
    const r = control(this.#goal, this.#hb, action as AosControl, this.#now());
    if (!r.ok) return r;
    if (r.goal !== this.#goal) {
      const saved = this.#save(r.goal);
      if (!saved.ok) return saved;
      this.#goal = r.goal;
    }
    this.#hb = r.heartbeat;
    if (action === "resume") this.beat();
    return { ok: true, data: this.snapshot() };
  }

  /** Persist the goal (null deletes the file). Temp file then rename, so a crash mid-write leaves the
   *  previous goal, never a torn one. */
  #save(goal: AosGoal | null): { ok: true } | { ok: false; error: string } {
    try {
      if (!goal) { try { unlinkSync(this.#path); } catch { /* already gone */ } return { ok: true }; }
      const tmp = `${this.#path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(goal, null, 2), { encoding: "utf8", mode: 0o600 });
      renameSync(tmp, this.#path);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: `Could not save the fleet goal: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
}
