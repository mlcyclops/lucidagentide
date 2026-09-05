// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/composer_target.ts - P-FLEET.L8: the PURE model behind "promote a fleet lane into the main
// composer, then pull it back".
//
// The composer ATTACHES to a still-running lane; it never moves or migrates the ACP session. The lane's omp
// child keeps streaming into its own card the whole time, which is why promotion is legal MID-TURN and why
// demotion is instant (nothing has to be handed back). This module owns the target type, the badge wording,
// the capability mask, the transcript seed, and the provenance strings. DOM-free / IO-free so the wording and
// the fail-closed refusals are unit-tested headless; app.ts owns the DOM and the wiring.

/** What the MAIN composer is currently driving. */
export type ComposerTarget =
  | { kind: "master" }
  | { kind: "lane"; laneId: string; name: string; cwd: string; model: string };

/** Frozen: this singleton is compared by value everywhere and handed to callers, so a stray mutation would
 *  silently retarget every composer holding it. */
export const MASTER_TARGET: ComposerTarget = Object.freeze({ kind: "master" as const });

export function isLaneTarget(t: ComposerTarget): t is Extract<ComposerTarget, { kind: "lane" }> {
  return t.kind === "lane";
}

/** Identity is the laneId alone: a lane can be renamed, can cd, and can swap models mid-run without becoming
 *  a different attachment target. */
export function sameTarget(a: ComposerTarget, b: ComposerTarget): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "master" || b.kind === "master") return true;
  return a.laneId === b.laneId;
}

/** The composer badge shown while attached. `label` is the one-line chip text (lane name + folder basename),
 *  `title` the hover (full cwd + model), `back` the demote verb. null for the master target: the master
 *  composer shows no badge at all. Invariant #11: `label` is ONE text child, already ellipsis-safe. */
export interface TargetBadge { label: string; title: string; back: string }

/** How much of the lane name survives into the chip. The badge shares a flex row with the composer controls,
 *  so a pathological name is clipped here as well as by CSS ellipsis; the full name stays in `title`. */
const LABEL_NAME_CAP = 48;

export function targetBadge(t: ComposerTarget): TargetBadge | null {
  if (!isLaneTarget(t)) return null;
  const cwd = oneLine(t.cwd);
  const model = oneLine(t.model);
  const id = oneLine(t.laneId);
  const shown = oneLine(t.name) || (id ? `lane ${id}` : "unnamed lane");
  const folder = folderName(cwd);
  // The BASENAME only: a full Windows path in the chip would blow the composer row apart.
  const label = `${shown.length <= LABEL_NAME_CAP ? shown : `${shown.slice(0, LABEL_NAME_CAP - 1)}\u2026`} · ${folder || "folder not reported"}`;
  const title = `Lane "${shown}" · ${cwd || "working folder not reported"} · model ${model || "not reported"}`;
  // The verb names the DESTINATION as the user understands it: the action sends the agent back to its
  // fleet window, it does not navigate you to the master chat. "Back to main chat" described the wrong
  // object and read as a navigation, so the button looked unrelated to the lane it releases.
  return { label, title, back: "Return to Fleet Agent" };
}

/** What a lane target CANNOT do, so the UI hides those controls instead of shipping dead ones.
 *  A lane's wire has no image block on this path, no master session config, and no goal loop. */
export interface TargetCaps { images: boolean; modes: boolean; goalLoop: boolean; slashCommands: boolean; why: string }

export function targetCaps(t: ComposerTarget): TargetCaps {
  if (!isLaneTarget(t)) return { images: true, modes: true, goalLoop: true, slashCommands: true, why: "" };
  return {
    images: false,
    modes: false,
    goalLoop: false,
    slashCommands: false,
    why: "A lane runs its own omp child, so the composer is only a front end for it: the lane wire carries no "
      + "image block, so pasted images cannot be sent; modes live in the master session config the lane does "
      + "not share, so the mode picker is hidden; the goal loop drives the master session only, so it cannot "
      + "steer a lane; slash commands are expanded by the master composer and would never reach the lane. "
      + "Demote back to the main chat to use any of these.",
  };
}

/** Seed the composer thread from a lane's bounded transcript. Drops empty entries, collapses the engine's
 *  `[ran: x]` tool prefix lines into a single leading note per assistant turn (they are memory, not prose),
 *  and NEVER reorders. Returns a NEW array. */
export interface SeedTurn { role: "user" | "assistant"; text: string }

/** fleet_lanes.ts #foldLiveTurn prefixes a folded assistant turn with one `[ran: <name>]` line per tool call. */
const RAN_LINE = /^\[ran:\s*([\s\S]*)\]$/;
/** Enough names to be informative; the lane card itself owns the full tool list. */
const NOTE_NAME_CAP = 8;

export function seedTurns(transcript: readonly SeedTurn[]): SeedTurn[] {
  const out: SeedTurn[] = [];
  for (const turn of transcript) {
    if (!turn || typeof turn.text !== "string") continue;
    // A user turn is kept verbatim: the user may have literally typed "[ran: ...]" and we do not rewrite them.
    const text = turn.role === "assistant" ? collapseRanLines(turn.text) : turn.text;
    if (!text.trim()) continue;
    out.push({ role: turn.role, text });
  }
  return out;
}

/** Provenance wording. These strings land in BOTH the transcript notice and the lane-session ledger, so
 *  they are the audit trail: they MUST name the lane, its folder, its model, and the turn count carried. */
export function promoteNotice(t: Extract<ComposerTarget, { kind: "lane" }>, turns: number): string {
  return `Composer attached to ${lanePhrase(t)}, carrying ${turnCount(turns)}. `
    + "The lane keeps running in the fleet; this composer now drives it.";
}

export function demoteNotice(t: Extract<ComposerTarget, { kind: "lane" }>): string {
  return `Composer detached from ${lanePhrase(t)}. `
    + "The lane keeps running in the fleet; the composer is back on the main session.";
}

/** A lane in one of these states cannot be promoted, with the reason to show. `null` = promotion allowed.
 *  Fail-closed: an UNKNOWN status string refuses. A `working` lane IS allowed (that is the in-flight ask). */
export function promoteRefusal(status: string): string | null {
  const s = typeof status === "string" ? status.trim().toLowerCase() : "";
  switch (s) {
    // The whole point of the feature: take over a lane that is mid-turn, without disturbing the turn.
    case "working":
    case "awaiting-input":
    case "done":
      return null;
    case "starting":
      return "This lane is still starting and has no session yet. Promote it once it reports its first status.";
    case "needs-approval":
      return "This lane is waiting on a permission decision. Answer it on the lane card, then promote the lane.";
    case "stopped":
      return "This lane is stopped and its child process is gone. Respawn the lane, then promote it.";
    case "error":
      return "This lane ended in an error and its child process is gone. Respawn the lane, then promote it.";
    default:
      // Fail-closed: an unreported or unrecognized status is NOT evidence that attaching is safe.
      return s
        ? `This lane reports an unrecognized status "${s.length <= 40 ? s : `${s.slice(0, 39)}\u2026`}", so promotion is refused. Refresh the fleet and try again.`
        : "This lane did not report a status, so promotion is refused. Refresh the fleet and try again.";
  }
}

/** The note delivered INTO the agent's own session when the composer attaches or detaches.
 *
 *  This is the fix for a real confusion observed in use: the agent was driven from the main composer for
 *  several turns, then released, and when asked to "restate what was written in the main composer" it had
 *  no idea what that referred to and guessed. The session is the SAME session throughout, so the content
 *  was all there; what was missing was any statement of WHICH SURFACE was driving it. promoteNotice and
 *  demoteNotice only ever reached the human transcript and the ledger, so the model never saw them.
 *
 *  Framed as an operator note (it rides the interject path, which is operator-origin and delivered
 *  outside untrusted delimiters) and it explicitly says to continue, so an attach or release can never
 *  read as a stop order. It names the surface in the user's vocabulary, because the user will refer to it
 *  by those words ("the main composer", "the fleet window") in the very next turn. */
export function promoteAgentNote(t: Extract<ComposerTarget, { kind: "lane" }>): string {
  return [
    "OPERATOR NOTE (not from the user, no reply needed): your session is now being driven from the MAIN COMPOSER",
    `of the LUCID desktop app instead of your fleet lane card (${lanePhrase(t)}).`,
    "Nothing else changed: same session, same conversation, same working folder, same model.",
    "If the user refers to \"the main composer\" or \"the main chat\", they mean the surface you are reading now.",
    "Continue whatever you were doing.",
  ].join(" ");
}

export function demoteAgentNote(t: Extract<ComposerTarget, { kind: "lane" }>): string {
  return [
    "OPERATOR NOTE (not from the user, no reply needed): your session has been RETURNED to your fleet lane card",
    `(${lanePhrase(t)}); the main composer is back on the master agent.`,
    "Everything you did while the main composer was driving you is still your own history, in this same session.",
    "If the user asks what happened \"in the main composer\", they mean those turns.",
    "Continue whatever you were doing.",
  ].join(" ");
}

// ---------------------------------------------------------------------------------------------------------

/** Collapse to a single line: a lane name arrives from user input and must never break the chip row. */
function oneLine(v: unknown): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
}

/** Last path segment, for BOTH separators: the repo is Windows-first and this module is DOM-free / IO-free,
 *  so it cannot reach for node:path. Trailing separators are ignored ("C:\\work\\lane\\" -> "lane"). */
function folderName(cwd: string): string {
  let end = cwd.length;
  while (end > 0 && (cwd[end - 1] === "/" || cwd[end - 1] === "\\")) end--;
  let start = end;
  while (start > 0 && cwd[start - 1] !== "/" && cwd[start - 1] !== "\\") start--;
  return cwd.slice(start, end);
}

/** The audit phrase both provenance strings share. Naming the lane, its folder and its model identically in
 *  the transcript and in the ledger is what makes the two comparable after the fact; an unreported field says
 *  so rather than rendering as a blank that reads like an empty path. */
function lanePhrase(t: Extract<ComposerTarget, { kind: "lane" }>): string {
  const name = oneLine(t.name) || oneLine(t.laneId) || "unnamed lane";
  const cwd = oneLine(t.cwd) || "a folder that was not reported";
  const model = oneLine(t.model) || "a model that was not reported";
  return `lane "${name}" in ${cwd} on ${model}`;
}

/** Never fake a count: a non-finite or negative turn count is reported as unknown, not as zero. */
function turnCount(turns: number): string {
  if (typeof turns !== "number" || !Number.isFinite(turns) || turns < 0) return "a turn count that was not reported";
  const n = Math.floor(turns);
  return `${n} turn${n === 1 ? "" : "s"} of its transcript`;
}

/** Hoist every `[ran: x]` line into ONE leading note and leave the prose byte-identical. Only blank lines are
 *  trimmed off the ends, so the first prose line keeps its indentation. */
function collapseRanLines(text: string): string {
  const lines = text.split("\n");
  const names: string[] = [];
  const seen = new Set<string>();
  let calls = 0;
  const prose: string[] = [];
  for (const line of lines) {
    const m = RAN_LINE.exec(line.trim());
    if (!m) { prose.push(line); continue; }
    calls++;
    const name = oneLine(m[1]);
    if (name && !seen.has(name)) { seen.add(name); names.push(name); }
  }
  const body = trimBlankEdges(prose).join("\n");
  if (!calls) return body;
  return body ? `${ranNote(calls, names)}\n${body}` : ranNote(calls, names);
}

function ranNote(calls: number, names: string[]): string {
  const head = `[ran ${calls} tool call${calls === 1 ? "" : "s"}`;
  if (!names.length) return `${head}]`; // no name survived: say nothing rather than invent one
  const shown = names.slice(0, NOTE_NAME_CAP).join(", ");
  const rest = names.length - NOTE_NAME_CAP;
  return `${head}: ${shown}${rest > 0 ? `, +${rest} more` : ""}]`;
}

function trimBlankEdges(lines: string[]): string[] {
  let a = 0;
  let b = lines.length;
  while (a < b && !lines[a]!.trim()) a++;
  while (b > a && !lines[b - 1]!.trim()) b--;
  return lines.slice(a, b);
}
