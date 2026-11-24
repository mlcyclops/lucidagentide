// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-RAIL.AGENTS1: the decisions behind the Agents rail's three Activate choices (app.ts activateAgentFolder runs
// them). Pure, so every branch is testable without a browser:
//   - takeover: the main composer moves to the Agent's folder; whatever Main holds goes to a Fleet lane first
//     (planTakeover, takeoverQueue for "After this turn"),
//   - fleet / world: a new lane in the folder; only their wording lives here.
// Order matters for the takeover: Main switches folder BEFORE the lane resuming its session starts, so one
// session is never loaded by two omp processes at once (the P-SWITCH.1 rule). A lane that then fails to start
// leaves the session on disk, in Sessions history, and the user is told so.

/** What Main is doing when Take over is chosen. `prompt` = the prompt of the turn running now ("" when unknown). */
export interface MainView {
  folder: string | null;
  busy: boolean;
  sessionId: string | null;
  /** The session holds a conversation worth keeping (an empty fresh chat is not handed to a lane). */
  hasWork: boolean;
  prompt: string;
}

/** The busy confirm's answers: stop now and continue in a lane, hand off when the turn ends, or change nothing. */
export type BusyChoice = "now" | "after" | "stay";

/** One step of a takeover, run in order; a failed step ends the run (see app.ts runTakeover). */
export type TakeoverStep =
  | "stop-main" // end Main's turn through the Stop path and wait until the engine reports it idle
  | "switch-main" // applyWorkspace(folder): Main restarts in the Agent's folder and lets go of its session
  | "spawn-lane" // a Fleet lane in Main's old folder resuming Main's old session (not promoted)
  | "stage-prompt" // the interrupted prompt staged on that lane, so the work goes on there
  | "focus"; // the main composer's input

export type TakeoverPlan =
  | { kind: "steps"; steps: TakeoverStep[] }
  | { kind: "ask" } // busy: show the confirm (BusyChoice)
  | { kind: "queue" } // "After this turn": wait for Main's turn to end, then plan again
  | { kind: "none" }; // "Stay here"

/** Comparable form of a folder path: one separator, no trailing separator, and a Windows drive path case-folded. */
export function folderKey(path: string): string {
  let p = path.trim().replace(/\\/g, "/");
  while (p.length > 1 && p.endsWith("/") && !/^[A-Za-z]:\/$/.test(p)) p = p.slice(0, -1);
  return /^[A-Za-z]:/.test(p) ? p.toLowerCase() : p;
}

export function sameFolder(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && folderKey(a) === folderKey(b);
}

/** The folder's last segment, for messages ("api-gateway" from "C:\\code\\api-gateway\\"). */
export function folderName(path: string): string {
  const t = path.trim().replace(/[\\/]+$/, "");
  return t.split(/[\\/]/).pop() || path.trim();
}

/** What Take over does for this Main and folder. `choice` is the confirm's answer (null before it is asked). */
export function planTakeover(main: MainView, folder: string, choice: BusyChoice | null): TakeoverPlan {
  // Main already works here: the composer IS this Agent's, busy or not (a busy one stages or interjects as usual).
  if (sameFolder(main.folder, folder)) return { kind: "steps", steps: ["focus"] };
  const keep = !!main.sessionId && main.hasWork;
  if (!main.busy) return { kind: "steps", steps: keep ? ["switch-main", "spawn-lane", "focus"] : ["switch-main", "focus"] };
  if (choice === null) return { kind: "ask" };
  if (choice === "stay") return { kind: "none" };
  if (choice === "after") return { kind: "queue" };
  // A running turn always has a session behind it: stop, switch, resume it in a lane, then send the prompt on.
  return { kind: "steps", steps: ["stop-main", "switch-main", "spawn-lane", ...(main.prompt.trim() ? ["stage-prompt" as const] : []), "focus"] };
}

/** The handoff queued by "After this turn". One at a time: a newer one replaces it (the caller drops the old
 *  one's status). `onTurnEnd` is called when Main's turn ends (its done, a Stop, or the backstop check): it hands
 *  the job over exactly once, and only while Main is idle (a held prompt can start the next turn at once; the
 *  handoff then waits for that one too). */
export interface TakeoverQueue<T> {
  pending(): T | null;
  /** Queue `job`; returns the job it replaced, if any. */
  queue(job: T): T | null;
  /** Drop the queued job; returns it, if any. */
  cancel(): T | null;
  onTurnEnd(mainBusy: boolean): T | null;
}

export function takeoverQueue<T>(): TakeoverQueue<T> {
  let job: T | null = null;
  return {
    pending: () => job,
    queue: (next) => { const was = job; job = next; return was; },
    cancel: () => { const was = job; job = null; return was; },
    onTurnEnd: (mainBusy) => {
      if (mainBusy || job === null) return null;
      const run = job;
      job = null;
      return run;
    },
  };
}

// ------------------------------------------------------------------------------------------------ wording

const NO_ANSWER = "the engine did not answer";

/** The engine's refusal as a clause: trimmed, without a trailing period, never empty. */
export function reasonText(reason: string | null | undefined): string {
  const r = (reason ?? "").replace(/\s+/g, " ").trim().replace(/[.\s]+$/, "");
  return r || NO_ANSWER;
}

/** A lane that did not start (fleet and world): the engine's reason, verbatim (pressure admission, folder gone). */
export function startFailure(reason: string | null | undefined): string {
  return `The agent could not start: ${reasonText(reason)}.`;
}

/** The world lane started but Agent Worlds never showed its node. */
export function worldMissing(laneName: string): string {
  return `${laneName} started in the Fleet, but Agent Worlds did not show it within 45 seconds. Open it from the Fleet dock.`;
}

/** Take over could not stop Main's turn: nothing moved. */
export const STOP_FAILED = "Main did not stop its turn, so nothing moved. Try again, or choose After this turn.";

/** Main could not open the folder: it stayed where it was, with its session. `promptBack`: Move it now had already
 *  stopped the turn, and its prompt is back in the composer to send again. */
export function switchFailure(toName: string, promptBack: boolean): string {
  return `Main could not open ${toName}, so it stayed where it was with its session.${promptBack ? " The stopped prompt is back in the composer." : ""}`;
}

/** Main switched, but the lane that should carry its old session did not start. The session is on disk. */
export function handoffFailure(fromName: string, toName: string, reason: string | null | undefined): string {
  return `Main now works in ${toName}, but your session from ${fromName} could not start in a Fleet lane: ${reasonText(reason)}. It is safe in Sessions history.`;
}

/** The toast after a handoff. `staged` = false when the interrupted prompt could not be staged on the lane. */
export function handoffToast(fromName: string, toName: string, laneName: string, staged: boolean | null, stageReason?: string | null): { title: string; desc: string } {
  const base = `Your work on ${fromName} continues in Fleet lane ${laneName}.`;
  const tail = staged === false ? ` The interrupted prompt was not staged there (${reasonText(stageReason)}); prompt the lane to go on.` : "";
  return { title: `Main is on ${toName}`, desc: base + tail };
}

/** The quiet status while a handoff waits for Main's turn. */
export function pendingCopy(toName: string): { title: string; desc: string } {
  return { title: "Handoff after this turn", desc: `When Main's turn ends, its session moves to a Fleet lane and Main opens ${toName}.` };
}

/** The busy confirm (docked above the composer like the session-switch sheet). */
export interface TakeoverSheetCopy { title: string; body: string; after: string; afterHint: string; now: string; nowHint: string; stay: string }

export function takeoverSheetCopy(fromName: string, toName: string): TakeoverSheetCopy {
  return {
    title: "Main is still working",
    body: `Main has a turn running in ${fromName}. Its work moves to a Fleet lane before Main opens ${toName}. Choose when.`,
    after: "After this turn",
    afterHint: `Main finishes, then its session continues in a Fleet lane and Main opens ${toName}.`,
    now: "Move it now",
    nowHint: "Stops the turn here and sends your prompt again in a Fleet lane, so the work goes on there.",
    stay: "Stay here",
  };
}
