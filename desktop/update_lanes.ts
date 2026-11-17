// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/update_lanes.ts - P-HOLDER.2 (ADR-0574): the lanes an IDE update meets, sorted the way the update prompt
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
 *  restart button at all, and an idle or stuck one is installable only once stopped. The last choice is "Later".
 *  `"unavailable"`: the lanes could not be read, so only "Later" is offered. */
export function updatePrompt(version: string, c: UpdateCheck | null | "unavailable"): { detail: string; choices: UpdateChoice[]; stop: string[] } {
  const later: UpdateChoice = { label: "Later", stop: false, install: false };
  // The engine was asked and did not answer (a timeout, a crash). A held lane may still run from the install folder,
  // so not knowing is not "no lanes": the update waits (fail-closed). `null` means there is no fleet to ask at all.
  if (c === "unavailable") return { detail: `LUCID could not check which agent lanes are running, so ${version} waits rather than install over a lane that may still be using these files. It is offered again at the next launch, or quit LUCID and start it again to install it now.`, choices: [later], stop: [] };
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

/** The engine's `update-check` answer as the IDE's main process reads it, or null when it is not one. All or nothing:
 *  one row (or one required field) this parser cannot read makes the whole answer unreadable, so the prompt offers
 *  only "Later". Skipping the row, or reading a missing `blocksInstall` as false, could install over a lane that
 *  still runs from the install folder. */
export function parseUpdateCheck(v: unknown): UpdateCheck | null {
  if (!v || typeof v !== "object" || !("lanes" in v) || !Array.isArray(v.lanes)) return null;
  const lanes: UpdateLane[] = [];
  for (const raw of v.lanes) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const l: Record<string, unknown> = { ...raw };
    const group = GROUPS.find((g) => g === l.group);
    if (typeof l.id !== "string" || typeof l.name !== "string" || typeof l.status !== "string" || !group) return null;
    if (typeof l.held !== "boolean" || typeof l.blocksInstall !== "boolean") return null;
    if (typeof l.lastActivityAt !== "number" || !Number.isFinite(l.lastActivityAt)) return null;
    lanes.push({ id: l.id, name: l.name.slice(0, 80), status: l.status as LaneView["status"], group, held: l.held, blocksInstall: l.blocksInstall, lastActivityAt: l.lastActivityAt });
  }
  const n = (g: UpdateLaneGroup) => lanes.filter((l) => l.group === g).length;
  return { lanes, working: n("working"), idle: n("idle"), stuck: n("stuck"), blocking: lanes.filter((l) => l.blocksInstall).length };
}

/** P-HOLDER.2 (ADR-0574): the engine's view of the lanes an update meets, its stop of the ones the person chose (only
 *  those still idle or stuck), and its install commit (`on: true`: no held lane starts from the install folder from
 *  now on; `pending` counts such starts still in progress; `on: false` lifts it). Null when the engine did not answer. */
export interface UpdateLaneDeps {
  check(): Promise<UpdateCheck | null>;
  stop(laneIds: string[]): Promise<{ stopped: string[] } | null>;
  commit(on: boolean): Promise<{ pending: number } | null>;
}

/** What follows a click in the update prompt: install, or the reason the update waits ("Update waits" dialog), or
 *  nothing (`waits: null`, "Later"). Every install choice ends here: the install is committed (no new held lane starts
 *  from the install folder), the chosen lanes are stopped, and the lanes are read one final time. It installs only
 *  when that read succeeds and no lane runs, or is starting, from the install folder; otherwise the commit is lifted.
 *  `lanes` undefined: there is no fleet to ask. */
export async function decideInstall(choice: UpdateChoice | undefined, stopIds: readonly string[], lanes: UpdateLaneDeps | undefined): Promise<{ install: true } | { install: false; waits: string | null }> {
  if (!choice?.install) return { install: false, waits: null };
  if (!lanes) return { install: true };
  const refuse = async (waits: string) => { await lanes.commit(false).catch(() => null); return { install: false as const, waits }; };
  if (choice.stop && stopIds.length) await lanes.stop([...stopIds]).catch(() => null);
  const committed = await lanes.commit(true).catch(() => null);
  if (!committed) return refuse("LUCID could not keep new agent lanes from starting from the install folder. It is offered again at the next launch.");
  if (committed.pending > 0) return refuse(`${committed.pending === 1 ? "An agent lane is" : `${committed.pending} agent lanes are`} starting from the install folder. It is offered again at the next launch.`);
  const last = await lanes.check().catch(() => null);
  if (!last) return refuse("LUCID could not check the agent lanes right before installing. It is offered again at the next launch.");
  const blocking = last.lanes.filter((l) => l.blocksInstall);
  if (blocking.length) return refuse(`${laneNames(blocking)} still ${blocking.length === 1 ? "runs" : "run"} from the install folder. It is offered again at the next launch.`);
  return { install: true };
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
