// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/fleet_dock_model.ts - P-FLEET.DOCK1: the pure rules behind two fleet grid fixes. DOM-free and
// tested (fleet_dock_model.test.ts); fleet_grid.ts and app.ts only gather the state and act on the answer.
//
//   1. The Fleet button (#ctFleet). It used to route by the "which view opens first" pin alone, so with the orbit
//      pinned a MINIMIZED grid was torn down (the orbit closes the grid when it opens) instead of coming back, and
//      the button never knew a minimized grid existed. fleetButtonAction reads what is actually on screen first.
//   2. Lane card backfill. A card only rendered turns it streamed itself, so a turn started anywhere else (another
//      client's POST /api/fleet/prompt, the main composer, before the page loaded) left the card blank while the
//      lane worked. The card now seeds from the engine's lane transcript and follows the lane's watch stream while
//      it works; seedTail decides which transcript records are new to the card, so nothing the card already shows
//      (its own streamed turns included) is painted twice. pickFollows caps those watches (FOLLOW_MAX) so they never
//      take the browser's few connections to the engine away from the status poll and the chat stream.

// ---------------------------------------------------------------- 1. the Fleet button

/** The grid dock: not built, built but minimized to its status-bar pill, or built and shown. */
export type GridState = "none" | "minimized" | "shown";

export type FleetButtonAction = "restore-grid" | "open-grid" | "close-grid" | "open-orbit" | "close-orbit";

/** What a Fleet button press does. A minimized grid always comes back (whichever view is pinned: the user put it
 *  there, and opening the orbit would destroy it). A shown surface toggles closed, the orbit first because it
 *  covers the grid. Only with nothing up does the pin choose what opens. */
export function fleetButtonAction(s: { home: "grid" | "orbit"; grid: GridState; orbit: boolean }): FleetButtonAction {
  if (s.grid === "minimized") return "restore-grid";
  if (s.orbit) return "close-orbit";
  if (s.grid === "shown") return "close-grid";
  return s.home === "grid" ? "open-grid" : "open-orbit";
}

// ---------------------------------------------------------------- 2. lane card backfill

/** The lane states with a turn running. */
export function laneBusy(status: string): boolean {
  return status === "working" || status === "needs-approval";
}

/** Whether a card should hold a FOLLOW (the lane's read-only watch stream) open: only while it is on screen, never
 *  while the card owns the lane's stream itself (its own prompt, drain or retry would arrive twice), and only while
 *  a turn it did not start can be running: the main composer drives the lane, or the lane is busy. An idle lane
 *  holds no connection, so a large fleet cannot exhaust the browser's per-host stream limit. */
export function shouldFollow(s: { card: boolean; streaming: boolean; promoted: boolean; status: string }): boolean {
  return s.card && !s.streaming && s.status !== "stopped" && (s.promoted || laneBusy(s.status));
}

/** At most this many AUTOMATIC follows (turns the card did not start) at once. The engine is HTTP/1.1 on one host, so
 *  the browser has six connections for everything: the status poll, the chat stream, every card's own turn. A watch
 *  per busy lane would starve them all with six busy lanes. */
export const FOLLOW_MAX = 2;

/** A lane that wants a follow (shouldFollow), with what ranks it. */
export interface FollowCandidate {
  id: string;
  /** The main composer drives it: its card is the one the user is acting through. */
  promoted: boolean;
  /** Its card is inside the dock's visible area. */
  visible: boolean;
  /** It holds a watch now; among equals it keeps it, so a follow is not torn down and reopened every poll. */
  following: boolean;
  lastActivityAt: number;
}

/** Which candidates get a watch: the promoted lane first, then cards the user can see, then the most recent activity,
 *  at most `cap`. Recomputed every poll, so a slot freed by a lane that went idle goes to the next in line. Lanes left
 *  out get no stream; the card reads their transcript when their turn count changes or they stop working. */
export function pickFollows(cands: readonly FollowCandidate[], cap: number = FOLLOW_MAX): Set<string> {
  const rank = [...cands].sort((a, b) =>
    Number(b.promoted) - Number(a.promoted) || Number(b.visible) - Number(a.visible)
    || Number(b.following) - Number(a.following) || b.lastActivityAt - a.lastActivityAt);
  return new Set(rank.slice(0, Math.max(0, cap)).map((c) => c.id));
}

/** One record of the engine's bounded lane transcript (/api/fleet/transcript, the watch stream's seed). */
export interface SeedRecord {
  role: "user" | "assistant";
  text: string;
  thinking?: string;
  tools?: SeedTool[];
  error?: string;
}

/** A recorded tool call (collab/frames.ts CollabToolRecord, the fields a lane card renders). */
export interface SeedTool {
  id?: string;
  name: string;
  detail: string;
  code?: { path: string; content?: string; oldText?: string; newText?: string; patch?: string };
  input?: string;
  intent?: string;
  ok?: boolean;
  elapsedMs?: number;
}

/** How many leading characters of a turn identify it. Long enough to tell prompts apart, short enough that a queued
 *  prompt's clipped preview (140 characters) and the recorded full text agree. */
export const KEY_CHARS = 120;

const RAN_LINE = /^\[ran: [^\n]*\]$/;
const ERROR_TAIL = /\n?\[turn ended in error: [\s\S]*\]$/;
/** How many `[ran: ...]` titles the engine keeps per turn (fleet_lanes.ts liveTools), and each title's length. */
const RAN_TITLES_MAX = 40;
const RAN_TITLE_CHARS = 160;

/** A tool title as the engine writes it into a `[ran: ...]` line: ONE line (whitespace folded), clipped. */
export function ranTitle(title: string): string {
  return title.replace(/\s+/g, " ").trim().slice(0, RAN_TITLE_CHARS);
}

/** An assistant text whose leading `[ran: ...]` block has ONE line per call. Older engines wrote each title raw
 *  (`slice(0, 160)`), so a heredoc command spanned lines and every reader that strips the block line by line stopped
 *  there, leaving the rest of the block as prose (a wall of `[ran: ...]` text instead of chips). The block is rebuilt
 *  from the turn's own tool records and, when the text starts with it, replaced by the folded form. Unchanged
 *  otherwise (no records, or a text that does not start with them). */
export function foldRanBlock(text: string, tools: readonly SeedTool[] | undefined): string {
  const titled = (tools ?? []).filter((t) => t.detail).slice(0, RAN_TITLES_MAX);
  if (!titled.length) return text;
  const raw = `${titled.map((t) => `[ran: ${t.detail.slice(0, RAN_TITLE_CHARS)}]`).join("\n")}\n`;
  // A turn with no prose was trimmed to end on its last title, without the newline.
  const rest = text.startsWith(raw) ? text.slice(raw.length) : text === raw.slice(0, -1) ? "" : null;
  if (rest === null) return text;
  return `${titled.map((t) => `[ran: ${ranTitle(t.detail)}]`).join("\n")}\n${rest}`;
}

/** An assistant text without the engine's leading `[ran: ...]` lines, when the turn has tool records (the card draws
 *  those as chips; without records the lines are the only trace and stay). */
function stripRan(text: string, tools: readonly SeedTool[] | undefined): string {
  if (!tools?.length) return text;
  const lines = foldRanBlock(text, tools).split("\n");
  let n = 0;
  while (n < lines.length && RAN_LINE.test(lines[n]!)) n++;
  return lines.slice(n).join("\n");
}

/** An assistant record's text as the card shows it: the engine prefixes the tool titles as `[ran: ...]` lines and
 *  appends `[turn ended in error: ...]` for its resume memory; the card draws both as chips and an error line. */
export function seedText(r: SeedRecord): string {
  if (r.role !== "assistant") return r.text;
  const text = stripRan(r.text, r.tools);
  return (r.error ? text.replace(ERROR_TAIL, "") : text).trim();
}

/** A turn's identity for matching a card turn against a transcript record, or undefined when it has no text to
 *  match on (an error-only turn). Strips what only one side carries: the engine's `[ran: ...]` and error lines and
 *  `[attached N images]` note, a drained turn's ` [N images, M files]` note and its preview's ellipsis, the
 *  engine's truncation mark; whitespace is collapsed. */
export function turnKey(role: "user" | "assistant", text: string): string | undefined {
  let s = text;
  if (role === "assistant") {
    s = s.split("\n").filter((l) => !RAN_LINE.test(l)).join("\n").replace(ERROR_TAIL, "");
  } else {
    s = s.replace(/\n\[attached \d+ images?\]$/, "").replace(/ \[\d+ (?:images?|files?)(?:, \d+ files?)?\]$/, "");
  }
  s = s.replace(/\u2026(?:\[truncated\])?$/, "").replace(/\s+/g, " ").trim().slice(0, KEY_CHARS);
  return s ? `${role}:${s}` : undefined;
}

/** Which transcript records are NEW to a card: the index into `seed` from which to append, or null when the card has
 *  turns but none of them can be found in the transcript (append nothing rather than risk painting a turn twice).
 *
 *  The anchor is the card's LAST turn that has a key and is found in the transcript (its last occurrence there).
 *  Card turns after the anchor were not found: a keyed one exists only on the card (a refused prompt), an unkeyed one
 *  (a `partial` reply the card saw only part of, an error-only turn) stands for the next transcript record of its
 *  role, which is then skipped. Everything after that is new. */
export function seedTail(local: readonly CardTurn[], seed: readonly { role: "user" | "assistant"; text: string; tools?: SeedTool[] }[]): number | null {
  if (local.length === 0) return 0;
  // A record's whole `[ran: ...]` block goes first (a multi-line title would leave fragments in its key).
  const keys = seed.map((r) => turnKey(r.role, r.role === "assistant" ? stripRan(r.text, r.tools) : r.text));
  const own = local.map((t) => (t.partial ? undefined : turnKey(t.role, t.text)));
  // A short reply ("Done.") recurs: an occurrence counts only if the turn before it matches the card's turn before
  // (by key, or by role for an unkeyed one). The window's first record and the card's first turn have no "before".
  const fits = (i: number, j: number): boolean =>
    i === 0 || j === 0 || (own[i - 1] === undefined ? seed[j - 1]!.role === local[i - 1]!.role : keys[j - 1] === own[i - 1]);
  for (let i = local.length - 1; i >= 0; i--) {
    const key = own[i];
    if (key === undefined) continue;
    let j = keys.lastIndexOf(key);
    while (j > 0 && !fits(i, j)) j = keys.lastIndexOf(key, j - 1);
    if (j < 0) continue;
    let k = j + 1;
    for (let n = i + 1; n < local.length; n++) {
      if (own[n] === undefined && k < seed.length && seed[k]!.role === local[n]!.role) k++;
    }
    return k;
  }
  return null;
}

/** A turn already on a card. `partial`: a followed reply folded before the card saw all of it (the follow may have
 *  joined mid-turn), so its text cannot identify it. */
export interface CardTurn { role: "user" | "assistant"; text: string; partial?: boolean }
