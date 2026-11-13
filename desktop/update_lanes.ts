// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/update_lanes.ts - P-HOLDER.2 (ADR-0573): the lanes an IDE update meets, sorted the way the update prompt
// offers them.
//
//   stuck    the stall detector flags the lane (displayStatus "likely-stuck": a tool call flat for minutes)
//   idle     nothing in flight: waiting for input, done, or failed
//   working  starting, in a turn, or waiting on a person's approval (and not stuck)
//
// Stuck and idle lanes are offered for stopping (their transcript stays; Respawn brings them back). A working lane is
// never stopped by the prompt: a held one keeps running across the update on its own runtime copy and is named as a
// reminder; one that is the engine's own child ends when the IDE restarts, and the prompt says so. A lane that runs
// from the install folder (`blocksInstall`: held before P-HOLDER.2, or the copy failed) keeps the installer from
// replacing those files while it runs, so the prompt does not install over it.

import { displayStatus } from "./collab/fleet_status.ts";
import type { LaneView } from "./fleet_lanes.ts";

export type UpdateLaneGroup = "working" | "idle" | "stuck";

export interface UpdateLane {
  id: string; name: string; status: LaneView["status"]; group: UpdateLaneGroup;
  /** Kept by a holder, so it outlives the IDE (false: it ends when the IDE closes). */
  held: boolean;
  /** It runs from the install folder, so the update cannot install while it runs. */
  blocksInstall: boolean;
  lastActivityAt: number;
}

export interface UpdateCheck { lanes: UpdateLane[]; working: number; idle: number; stuck: number; blocking: number }

export function laneGroup(l: Pick<LaneView, "status" | "progress"> & { stuck?: boolean }): UpdateLaneGroup {
  if (displayStatus(l) === "likely-stuck") return "stuck";
  return l.status === "starting" || l.status === "working" || l.status === "needs-approval" ? "working" : "idle";
}

/** Every lane that still runs something (a stopped lane runs nothing and is left out). */
export function updateCheck(lanes: readonly LaneView[]): UpdateCheck {
  const out: UpdateLane[] = [];
  for (const l of lanes) {
    if (l.status === "stopped") continue;
    out.push({ id: l.id, name: l.name, status: l.status, group: laneGroup(l), held: l.heldRuntime !== undefined, blocksInstall: l.heldRuntime === "install", lastActivityAt: l.lastActivityAt });
  }
  return {
    lanes: out,
    working: out.filter((l) => l.group === "working").length,
    idle: out.filter((l) => l.group === "idle").length,
    stuck: out.filter((l) => l.group === "stuck").length,
    blocking: out.filter((l) => l.blocksInstall).length,
  };
}

/** Lane names for the prompt: the first six, then how many more. */
export function laneNames(lanes: readonly UpdateLane[]): string {
  const shown = lanes.slice(0, 6).map((l) => `"${l.name}"`).join(", ");
  return lanes.length > 6 ? `${shown} and ${lanes.length - 6} more` : shown;
}

/** One button of the update prompt: whether it stops the idle and stuck lanes first, and whether it installs. */
export interface UpdateChoice { label: string; stop: boolean; install: boolean }

/** The update prompt for `c` (updater.ts shows it). `stop`: the idle and stuck lanes "Stop..." stops. A lane that
 *  runs from the install folder keeps the installer from replacing its files: while a WORKING one runs there is no
 *  restart button at all, and an idle or stuck one is installable only once stopped. The last choice is "Later". */
export function updatePrompt(version: string, c: UpdateCheck | null): { detail: string; choices: UpdateChoice[]; stop: string[] } {
  const later: UpdateChoice = { label: "Later", stop: false, install: false };
  const lanes = c?.lanes ?? [];
  if (!lanes.length) return { detail: "Restart to apply the update. Your session and credentials are kept.", choices: [{ label: "Restart now", stop: false, install: true }, later], stop: [] };
  const stuck = lanes.filter((l) => l.group === "stuck"), idle = lanes.filter((l) => l.group === "idle"), working = lanes.filter((l) => l.group === "working");
  const keeps = working.filter((l) => l.held && !l.blocksInstall), ends = working.filter((l) => !l.held), blocks = working.filter((l) => l.blocksInstall);
  const lines: string[] = [];
  if (stuck.length) lines.push(`Look stuck (${stuck.length}): ${laneNames(stuck)}.`);
  if (idle.length) lines.push(`Idle, doing nothing (${idle.length}): ${laneNames(idle)}.`);
  if (keeps.length) lines.push(`Working (${keeps.length}): ${laneNames(keeps)}. They keep running on the previous version; restart them later to pick up ${version}.`);
  if (ends.length) lines.push(`Working, ends when the IDE restarts (${ends.length}): ${laneNames(ends)}.`);
  if (blocks.length) lines.push(`Working from the install folder (${blocks.length}): ${laneNames(blocks)}. The update cannot install while they run: let them finish or stop them, then restart.`);
  const stop = [...stuck, ...idle].map((l) => l.id);
  if (stop.length) lines.push("", "Stopping keeps each lane's transcript; Respawn brings it back.");
  const detail = lines.join("\n");
  if (blocks.length) return { detail, choices: [later], stop };
  const choices: UpdateChoice[] = [];
  if (stop.length) choices.push({ label: `Stop ${stop.length} idle or stuck ${stop.length === 1 ? "lane" : "lanes"} and restart`, stop: true, install: true });
  // Keeping every lane installs only when none of the idle or stuck ones runs from the install folder.
  if (!lanes.some((l) => l.blocksInstall)) choices.push({ label: stop.length ? "Restart and keep every lane" : "Restart now", stop: false, install: true });
  return { detail, choices: [...choices, later], stop };
}

const GROUPS: readonly UpdateLaneGroup[] = ["working", "idle", "stuck"];

/** The engine's `update-check` answer as the IDE's main process reads it, or null when it is not one. */
export function parseUpdateCheck(v: unknown): UpdateCheck | null {
  if (!v || typeof v !== "object" || !("lanes" in v) || !Array.isArray(v.lanes)) return null;
  const lanes: UpdateLane[] = [];
  for (const raw of v.lanes) {
    if (!raw || typeof raw !== "object") continue;
    const l: Record<string, unknown> = { ...raw };
    const group = GROUPS.find((g) => g === l.group);
    if (typeof l.id !== "string" || typeof l.name !== "string" || typeof l.status !== "string" || !group) continue;
    lanes.push({ id: l.id, name: l.name.slice(0, 80), status: l.status as LaneView["status"], group, held: l.held === true, blocksInstall: l.blocksInstall === true, lastActivityAt: typeof l.lastActivityAt === "number" ? l.lastActivityAt : 0 });
  }
  const n = (g: UpdateLaneGroup) => lanes.filter((l) => l.group === g).length;
  return { lanes, working: n("working"), idle: n("idle"), stuck: n("stuck"), blocking: lanes.filter((l) => l.blocksInstall).length };
}

/** Stop the lanes in `ids` that are idle or stuck NOW (one that started working since the prompt was shown is kept,
 *  as is one that is gone). `stop` is the fleet's own stop (transcript kept, Respawn allowed). */
export function stopForUpdate(ids: readonly string[], lanes: readonly LaneView[], stop: (laneId: string) => { ok: boolean }): { stopped: string[]; kept: { id: string; why: string }[] } {
  const stopped: string[] = [];
  const kept: { id: string; why: string }[] = [];
  for (const id of ids) {
    const l = lanes.find((x) => x.id === id);
    if (!l || l.status === "stopped") { kept.push({ id, why: "not running" }); continue; }
    if (laneGroup(l) === "working") { kept.push({ id, why: "it started working" }); continue; }
    if (stop(id).ok) stopped.push(id);
    else kept.push({ id, why: "the fleet did not stop it" });
  }
  return { stopped, kept };
}
