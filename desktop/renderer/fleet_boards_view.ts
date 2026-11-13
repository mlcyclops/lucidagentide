// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/fleet_boards_view.ts - P-FLEET-BOARDS.1 (ADR-0577, phase 2 of ADR-0575): the PURE rules behind the Fleet window's boards.
// The engine owns the boards (desktop/fleet_boards.ts, /api/fleet/boards/*); this file only answers the
// questions the grid asks of them: which agents a board shows, which agents need the user, where "Next that
// needs you" goes, which tabs carry a dot, and which remote keys are safe to prune. DOM-free and IO-free, so
// every rule is unit-tested headless; fleet_grid.ts owns the tabs, the menus and the calls.
//
// An agent KEY is a local lane id or `rs:<node>:<task>` for a remote agent (remote_spokes_model RemoteLane.key).
// "Everything" (id `all`) is virtual: every live agent, never a stored board.

import { displayStatus } from "../collab/fleet_status.ts";
import type { BoardLayout, BoardsView, BoardView } from "./bridge.ts";

/** The virtual board that shows every live agent. */
export const EVERYTHING = "all";
/** The engine's caps (desktop/fleet_boards.ts), mirrored so the UI can say what is wrong in plain words before it asks. */
export const BOARD_NAME_MAX = 40;
export const BOARDS_MAX = 24;
export const BOARD_AGENTS_MAX = 200;

/** The four layout presets, in menu order, with the words the menu shows. */
export const BOARD_LAYOUTS: readonly { id: BoardLayout; label: string }[] = [
  { id: "side", label: "Side by side" },
  { id: "grid4", label: "Grid of four" },
  { id: "focus", label: "Focus one" },
  { id: "free", label: "Free" },
];

/** What the "needs you" rule reads: a local lane's view (its displayed status decides), or a remote lane's state. */
export type AgentState = { kind: "local"; lane: Parameters<typeof displayStatus>[0] } | { kind: "remote"; state: string };

/** Local displayed statuses that need the user. An idle ready lane sits in `awaiting-input`, so that state is NOT
 *  here: it would put every idle agent in the Next queue. */
const LOCAL_NEEDS: Readonly<Record<string, true>> = { "needs-approval": true, "likely-stuck": true };

/** The ONE "needs you" rule, used by Next and by the tab dots. The pill counts are a different question and keep
 *  their own rule (fleet_status LANE_ATTENTION). */
export function needsYou(a: AgentState): boolean {
  return a.kind === "local" ? Object.hasOwn(LOCAL_NEEDS, displayStatus(a.lane)) : a.state === "approval";
}

/** A live agent as the board rules see it: its key and whether it needs the user right now. */
export interface LiveAgent { key: string; needs: boolean }

/** The stored board with this id, or null (Everything, a removed board, no boards loaded yet). */
export function findBoard(view: BoardsView | null, id: string): BoardView | null {
  return view?.boards.find((b) => b.id === id) ?? null;
}

/** The layout a board (or Everything) is shown in, and its focused agent. Side by side until boards load. */
export function boardLayoutOf(view: BoardsView | null, id: string): { layout: BoardLayout; focus?: string } {
  const b = findBoard(view, id);
  const src = b ?? view?.everything;
  if (!src) return { layout: "side" };
  return src.focus === undefined ? { layout: src.layout } : { layout: src.layout, focus: src.focus };
}

/** The live agents a board shows. Everything: every live agent, in `liveKeys` order (the grid's order: local lanes,
 *  then remote ones). A board: its agents that are live, in BOARD order (the order they were added), each once;
 *  agents on the board that are not live are skipped, never invented. */
export function agentsOn(board: BoardView | typeof EVERYTHING, liveKeys: readonly string[]): string[] {
  const live = new Set(liveKeys);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const k of board === EVERYTHING ? liveKeys : board.agents) {
    if (!live.has(k) || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

/** Does any agent this board shows need the user? Drives the tab dot. */
export function boardHasNeeds(board: BoardView | typeof EVERYTHING, live: readonly LiveAgent[]): boolean {
  const on = new Set(agentsOn(board, live.map((a) => a.key)));
  return live.some((a) => a.needs && on.has(a.key));
}

/** One jump of "Next that needs you": the agent, the board to show it on, and the board the round started from
 *  (`anchor`). Hand the last answer back on the next press so the round keeps its order. */
export interface NextJump { key: string; board: string; anchor: string }

/**
 * The next agent that needs the user. The walk order is the anchor board's agents, then the other boards in
 * order, then Everything (agents on no board), each agent once at its first place. A round is anchored on the
 * board shown when it started, and continues while the user stays where the last jump put them; switching
 * boards by hand starts a fresh round from the board now shown. Each press takes the next agent that needs
 * the user after the one just shown, wrapping, so repeated presses visit every one of them (the one just shown
 * comes back only when it is the only one). The agent is shown where the user already is when that view has
 * it, else on the board the walk found it on. Null when nothing needs the user.
 */
export function nextNeedingYou(view: BoardsView | null, currentBoardId: string, liveAgents: readonly LiveAgent[], lastJumped: NextJump | null): NextJump | null {
  if (!liveAgents.some((a) => a.needs)) return null;
  const curBoard = findBoard(view, currentBoardId);
  const cur = curBoard ? curBoard.id : EVERYTHING;
  const last = lastJumped !== null && lastJumped.board === cur && (lastJumped.anchor === EVERYTHING || findBoard(view, lastJumped.anchor) !== null) ? lastJumped : null;
  const anchor = last ? last.anchor : cur;
  const liveKeys = liveAgents.map((a) => a.key);
  const order: { key: string; board: string }[] = [];
  const placed = new Set<string>();
  const walk = (keys: readonly string[], board: string): void => {
    for (const k of keys) { if (!placed.has(k)) { placed.add(k); order.push({ key: k, board }); } }
  };
  // A round from Everything walks the grid's own order and never switches boards.
  const anchorBoard = findBoard(view, anchor);
  if (anchorBoard) {
    walk(agentsOn(anchorBoard, liveKeys), anchorBoard.id);
    for (const b of view?.boards ?? []) if (b.id !== anchor) walk(agentsOn(b, liveKeys), b.id);
  }
  walk(liveKeys, EVERYTHING);
  const needs = new Set(liveAgents.filter((a) => a.needs).map((a) => a.key));
  const lastKey = last?.key;
  const from = lastKey === undefined ? -1 : order.findIndex((o) => o.key === lastKey);
  let pick: { key: string; board: string } | null = null;
  for (let step = 1; step <= order.length && !pick; step++) {
    const o = order[(from + step + order.length) % order.length]!;
    if (needs.has(o.key)) pick = o;
  }
  if (!pick) return null;
  const shownHere = cur === EVERYTHING || (curBoard?.agents.includes(pick.key) ?? false);
  return { key: pick.key, board: shownHere ? cur : pick.board, anchor };
}

/**
 * The `live` list for `/api/fleet/boards/prune`. The engine drops every board key not in it, so a remote agent
 * this machine cannot SEE right now must be kept: every remote key on a board is kept when the remote lanes were
 * not read (`remoteKeys` null), and otherwise when its computer is not answering (offline, silent, checking or
 * deactivated: its tasks may come back). Only a remote agent on an answering computer that no longer lists it is
 * dropped. Local lanes are taken as given (call this only after a successful local status read).
 */
export function liveForPrune(localIds: readonly string[], remoteKeys: readonly string[] | null, answeringNodes: ReadonlySet<string>, onBoards: readonly string[]): string[] {
  const out = new Set<string>([...localIds, ...(remoteKeys ?? [])]);
  for (const k of onBoards) {
    if (out.has(k) || !k.startsWith("rs:")) continue;
    if (remoteKeys === null || !answeringNodes.has(k.split(":")[1] ?? "")) out.add(k);
  }
  return [...out];
}

/** Why a board name would be refused, in plain words, or null when it is fine. Mirrors the engine's rules: 1-40
 *  printable characters after trimming, unique ignoring case (the board being renamed may keep its own name). */
export function boardNameProblem(view: BoardsView | null, name: string, exceptId?: string): string | null {
  const n = name.trim();
  if (!n) return "Give the board a name.";
  if ([...n].length > BOARD_NAME_MAX) return `Board names can be ${BOARD_NAME_MAX} characters at most.`;
  if (/\p{Cc}/u.test(n)) return "Board names cannot hold control characters.";
  const low = n.toLowerCase();
  if (view?.boards.some((b) => b.id !== exceptId && b.name.toLowerCase() === low)) return "Another board already has that name.";
  return null;
}

/** The name a new board starts with: the lowest free "Board <n>", ignoring case. */
export function nextBoardName(view: BoardsView | null): string {
  const taken = new Set((view?.boards ?? []).map((b) => b.name.toLowerCase()));
  let n = 1;
  while (taken.has(`board ${n}`)) n++;
  return `Board ${n}`;
}
