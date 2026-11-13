// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/fleet_boards.ts
//
// P-FLEET-BOARDS.1 (ADR-0577, phase 2 of ADR-0575): the Fleet window's boards, owned by the engine. A board
// is a named set of agents with a layout. An agent key is a local lane id, or `rs:<node>:<task>` for an
// agent on another computer, and one agent may sit on several boards. "Everything" (id `all`) is virtual:
// every live agent, so only its layout and focus are stored. Every operation is pure and returns a new
// Boards or the refusal in plain words; `openBoards` reads and writes `fleet-boards.json` under the data root.

import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { errCode, withRetry, writeAtomic } from "./atomic_file.ts";

export type BoardLayout = "side" | "grid4" | "focus" | "free";
export interface Board { id: string; name: string; agents: string[]; layout: BoardLayout; focus?: string }
export interface Boards { v: 1; next: number; boards: Board[]; everything: { layout: BoardLayout; focus?: string } }
export type BoardsResult = { ok: true; data: Boards } | { ok: false; error: string };

export const BOARD_LAYOUTS: readonly BoardLayout[] = ["side", "grid4", "focus", "free"];
export const EVERYTHING_ID = "all";
export const MAX_BOARDS = 24;
export const MAX_BOARD_AGENTS = 200;
export const MAX_BOARD_NAME = 40;
/** Longer than any lane id or `rs:<node>:<task>` key; a bound so a junk file or body cannot grow a board. */
const MAX_AGENT_KEY = 256;
const BOARD_ID = /^b[1-9]\d{0,8}$/;
const UNPRINTABLE = /[\p{Cc}\p{Zl}\p{Zp}]/u;

export const BOARDS_FILE = "fleet-boards.json";

export function emptyBoards(): Boards {
  return { v: 1, next: 1, boards: [], everything: { layout: "side" } };
}

export function isBoardLayout(v: unknown): v is BoardLayout {
  return typeof v === "string" && BOARD_LAYOUTS.some((l) => l === v);
}

export function isAgentKey(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= MAX_AGENT_KEY && !UNPRINTABLE.test(v);
}

/** The trimmed name, or why it cannot be one. Length counts characters, not UTF-16 units. */
function checkName(raw: string): { ok: true; name: string } | { ok: false; error: string } {
  const name = raw.trim();
  if (!name) return { ok: false, error: "Give the board a name." };
  if ([...name].length > MAX_BOARD_NAME) return { ok: false, error: `A board name can be at most ${MAX_BOARD_NAME} characters.` };
  if (UNPRINTABLE.test(name)) return { ok: false, error: "A board name can only use letters, numbers, spaces and symbols." };
  return { ok: true, name };
}

function nameTaken(s: Boards, name: string, except?: string): boolean {
  const key = name.toLowerCase();
  return s.boards.some((b) => b.id !== except && b.name.toLowerCase() === key);
}

const NO_BOARD = "That board no longer exists.";

function withBoard(s: Boards, id: string, change: (b: Board) => Board | string): BoardsResult {
  const i = s.boards.findIndex((b) => b.id === id);
  if (i < 0) return { ok: false, error: NO_BOARD };
  const next = change(s.boards[i]!);
  if (typeof next === "string") return { ok: false, error: next };
  return { ok: true, data: { ...s, boards: s.boards.map((b, j) => (j === i ? next : b)) } };
}

/** The one place a board is put together: its focus is kept only while that agent is on the board. */
function makeBoard(b: Omit<Board, "focus">, focus: string | undefined): Board {
  const out: Board = { id: b.id, name: b.name, agents: b.agents, layout: b.layout };
  if (focus !== undefined && b.agents.includes(focus)) out.focus = focus;
  return out;
}

/** A new, empty board at the end of the list. Ids come from `next`, which only climbs. */
export function createBoard(s: Boards, rawName: string): BoardsResult {
  if (s.boards.length >= MAX_BOARDS) return { ok: false, error: `You can have at most ${MAX_BOARDS} boards. Remove one to make room.` };
  const n = checkName(rawName);
  if (!n.ok) return n;
  if (nameTaken(s, n.name)) return { ok: false, error: `There is already a board named "${n.name}".` };
  const board: Board = { id: `b${s.next}`, name: n.name, agents: [], layout: "side" };
  return { ok: true, data: { ...s, next: s.next + 1, boards: [...s.boards, board] } };
}

export function renameBoard(s: Boards, id: string, rawName: string): BoardsResult {
  const n = checkName(rawName);
  if (!n.ok) return n;
  if (nameTaken(s, n.name, id)) return { ok: false, error: `There is already a board named "${n.name}".` };
  return withBoard(s, id, (b) => ({ ...b, name: n.name }));
}

/** Only the board goes; its agents keep running and stay on any other board and on Everything. */
export function removeBoard(s: Boards, id: string): BoardsResult {
  if (!s.boards.some((b) => b.id === id)) return { ok: false, error: NO_BOARD };
  return { ok: true, data: { ...s, boards: s.boards.filter((b) => b.id !== id) } };
}

/** Move a board to index `to` of the list; a position past either end lands at that end. */
export function moveBoard(s: Boards, id: string, to: number): BoardsResult {
  if (!Number.isInteger(to)) return { ok: false, error: "Pick a place in the board list to move it to." };
  const from = s.boards.findIndex((b) => b.id === id);
  if (from < 0) return { ok: false, error: NO_BOARD };
  const boards = s.boards.filter((b) => b.id !== id);
  boards.splice(Math.max(0, Math.min(to, boards.length)), 0, s.boards[from]!);
  return { ok: true, data: { ...s, boards } };
}

/** Add agents to a board, in order, skipping ones already on it. */
export function addAgents(s: Boards, id: string, keys: readonly string[]): BoardsResult {
  if (!keys.every(isAgentKey)) return { ok: false, error: "One of those is not an agent." };
  return withBoard(s, id, (b) => {
    const agents = [...b.agents];
    for (const k of keys) if (!agents.includes(k)) agents.push(k);
    if (agents.length > MAX_BOARD_AGENTS) return `A board can hold at most ${MAX_BOARD_AGENTS} agents.`;
    return makeBoard({ ...b, agents }, b.focus);
  });
}

/** Take agents off a board (they keep running). A focus on one of them is dropped. */
export function dropAgents(s: Boards, id: string, keys: readonly string[]): BoardsResult {
  const gone = new Set(keys);
  return withBoard(s, id, (b) => makeBoard({ ...b, agents: b.agents.filter((k) => !gone.has(k)) }, b.focus));
}

/** Set a board's (or Everything's) layout. A focus that is not on the board is dropped, not refused;
 *  Everything holds every live agent, so any agent key may be its focus. */
export function setLayout(s: Boards, id: string, layout: string, focus?: string): BoardsResult {
  if (!isBoardLayout(layout)) return { ok: false, error: "That layout is not one of side, grid4, focus or free." };
  if (id === EVERYTHING_ID) {
    return { ok: true, data: { ...s, everything: focus !== undefined && isAgentKey(focus) ? { layout, focus } : { layout } } };
  }
  return withBoard(s, id, (b) => makeBoard({ ...b, layout }, focus));
}

/** Forget agents that are no longer live: off every board, and off every focus. */
export function pruneBoards(s: Boards, live: readonly string[]): Boards {
  const alive = new Set(live);
  const { focus, layout } = s.everything;
  return {
    ...s,
    boards: s.boards.map((b) => makeBoard({ ...b, agents: b.agents.filter((k) => alive.has(k)) }, b.focus)),
    everything: focus !== undefined && alive.has(focus) ? { layout, focus } : { layout },
  };
}

/** The stored file's shape before any field is trusted: every field is checked with typeof where it is read. */
interface StoredBoards { v?: unknown; next?: unknown; boards?: unknown; everything?: unknown }
interface StoredBoard { id?: unknown; name?: unknown; agents?: unknown; layout?: unknown; focus?: unknown }
interface StoredEverything { layout?: unknown; focus?: unknown }

/** Strict read of a stored file: anything that is not a v1 object is the empty default; a board that breaks
 *  a rule (id, name, layout, duplicates, the caps) is dropped; bad agent keys and unknown fields are dropped;
 *  `next` is raised past every kept id so a new board never reuses one. */
export function parseBoards(input: unknown): Boards {
  const out = emptyBoards();
  if (typeof input !== "object" || input === null || Array.isArray(input)) return out;
  const raw = input as StoredBoards;
  if (raw.v !== 1) return out;
  let next = typeof raw.next === "number" && Number.isSafeInteger(raw.next) && raw.next >= 1 ? raw.next : 1;
  const seen = new Set<string>();
  for (const item of Array.isArray(raw.boards) ? raw.boards : []) {
    if (out.boards.length >= MAX_BOARDS) break;
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const rb = item as StoredBoard;
    if (typeof rb.id !== "string" || !BOARD_ID.test(rb.id) || typeof rb.name !== "string") continue;
    const n = checkName(rb.name);
    if (!n.ok || rb.name !== n.name || !isBoardLayout(rb.layout)) continue;
    if (seen.has(rb.id) || nameTaken(out, n.name)) continue;
    seen.add(rb.id);
    const agents: string[] = [];
    for (const k of Array.isArray(rb.agents) ? rb.agents : []) {
      if (agents.length >= MAX_BOARD_AGENTS) break;
      if (isAgentKey(k) && !agents.includes(k)) agents.push(k);
    }
    out.boards.push(makeBoard({ id: rb.id, name: n.name, agents, layout: rb.layout }, typeof rb.focus === "string" ? rb.focus : undefined));
    next = Math.max(next, Number(rb.id.slice(1)) + 1);
  }
  out.next = next;
  if (typeof raw.everything === "object" && raw.everything !== null) {
    const { layout, focus } = raw.everything as StoredEverything;
    if (isBoardLayout(layout)) out.everything = isAgentKey(focus) ? { layout, focus } : { layout };
  }
  return out;
}

export interface BoardsStore {
  /** The stored boards; a missing or invalid file reads as the empty default. */
  read(): Boards;
  /** Read, apply `fn`, and save when it succeeds and changed something. Synchronous end to end, so two
   *  updates in this engine never interleave; two engines on one data root: the last writer wins. */
  update(fn: (s: Boards) => BoardsResult): BoardsResult;
}

export function openBoards(dir: string): BoardsStore {
  const path = join(dir, BOARDS_FILE);
  const read = (): Boards => {
    let text: string;
    try { text = withRetry(() => readFileSync(path, "utf8")); } catch (e) {
      if (errCode(e) === "ENOENT") return emptyBoards();
      throw e; // a file we could not read must not be overwritten with the default
    }
    try { return parseBoards(JSON.parse(text)); } catch { return emptyBoards(); }
  };
  return {
    read,
    update(fn) {
      const before = read();
      const r = fn(before);
      if (!r.ok) return r;
      const body = JSON.stringify(r.data, null, 2);
      if (body !== JSON.stringify(before, null, 2)) {
        mkdirSync(dir, { recursive: true });
        writeAtomic(path, body);
      }
      return r;
    },
  };
}
