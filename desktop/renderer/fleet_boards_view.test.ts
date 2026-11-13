// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/fleet_boards_view.test.ts - P-FLEET-BOARDS.1 (ADR-0577): the pure board rules behind the Fleet window.
// Pinned: the "needs you" rule (an idle agent is NOT urgent), which agents a board shows and in what order,
// the Next walk (current board first, every agent visited, a hand switch restarts the round), the tab dot,
// the prune guard that never drops a remote agent this machine cannot see, and the board name rules.

import { describe, expect, it } from "bun:test";
import type { BoardsView, BoardView } from "./bridge.ts";
import {
  agentsOn, boardHasNeeds, boardLayoutOf, boardNameProblem, EVERYTHING, liveForPrune, needsYou, nextBoardName, nextNeedingYou,
  type LiveAgent, type NextJump,
} from "./fleet_boards_view.ts";

const board = (id: string, name: string, agents: string[]): BoardView => ({ id, name, agents, layout: "side" });
const view = (...boards: BoardView[]): BoardsView => ({ v: 1, next: boards.length + 1, boards, everything: { layout: "side" } });
const agents = (spec: Record<string, boolean>): LiveAgent[] => Object.entries(spec).map(([key, needs]) => ({ key, needs }));

describe("needsYou", () => {
  it("a local agent needs you on approval or when likely stuck, never when idle and ready", () => {
    expect(needsYou({ kind: "local", lane: { status: "needs-approval" } })).toBe(true);
    expect(needsYou({ kind: "local", lane: { status: "awaiting-input" } })).toBe(false);
    expect(needsYou({ kind: "local", lane: { status: "working" } })).toBe(false);
    expect(needsYou({ kind: "local", lane: { status: "stopped" } })).toBe(false);
  });

  it("reads the DISPLAYED status: a working lane whose call looks stuck needs you", () => {
    expect(needsYou({ kind: "local", lane: { status: "working", progress: { liveness: { state: "stuck" } } } })).toBe(true);
    expect(needsYou({ kind: "local", lane: { status: "working", stuck: true } })).toBe(true);
    expect(needsYou({ kind: "local", lane: { status: "working", progress: { liveness: { state: "alive" } } } })).toBe(false);
  });

  it("a remote agent needs you only while its lane waits on approval", () => {
    expect(needsYou({ kind: "remote", state: "approval" })).toBe(true);
    for (const s of ["busy", "idle", "error", "offline", "silent", "checking"]) expect(needsYou({ kind: "remote", state: s })).toBe(false);
  });
});

describe("agentsOn", () => {
  it("Everything is every live agent in the grid's order", () => {
    expect(agentsOn(EVERYTHING, ["l2", "l1", "rs:n:t"])).toEqual(["l2", "l1", "rs:n:t"]);
  });

  it("a board shows its live agents in board order, skipping gone ones and repeats", () => {
    const b = board("b1", "Fixes", ["rs:n:t", "gone", "l1", "l1"]);
    expect(agentsOn(b, ["l1", "l2", "rs:n:t"])).toEqual(["rs:n:t", "l1"]);
    expect(agentsOn(board("b2", "Empty", []), ["l1"])).toEqual([]);
  });
});

describe("boardHasNeeds", () => {
  it("a tab dot only when an agent that board shows needs you", () => {
    const live = agents({ l1: false, l2: true });
    expect(boardHasNeeds(board("b1", "A", ["l1"]), live)).toBe(false);
    expect(boardHasNeeds(board("b2", "B", ["l2"]), live)).toBe(true);
    expect(boardHasNeeds(board("b3", "C", ["gone"]), agents({ gone: false }))).toBe(false);
    expect(boardHasNeeds(EVERYTHING, live)).toBe(true);
    expect(boardHasNeeds(EVERYTHING, agents({ l1: false }))).toBe(false);
  });
});

describe("boardLayoutOf", () => {
  it("a board's own layout and focus, Everything's for the virtual board, side by side before boards load", () => {
    const v: BoardsView = { v: 1, next: 2, boards: [{ id: "b1", name: "A", agents: ["l1"], layout: "focus", focus: "l1" }], everything: { layout: "grid4" } };
    expect(boardLayoutOf(v, "b1")).toEqual({ layout: "focus", focus: "l1" });
    expect(boardLayoutOf(v, EVERYTHING)).toEqual({ layout: "grid4" });
    expect(boardLayoutOf(v, "b9")).toEqual({ layout: "grid4" });
    expect(boardLayoutOf(null, "b1")).toEqual({ layout: "side" });
  });
});

describe("nextNeedingYou", () => {
  const v = view(board("b1", "A", ["a1", "a2"]), board("b2", "B", ["b1"]));
  const live = agents({ a1: false, a2: true, b1: true, x: true });

  it("null when nothing needs you", () => {
    expect(nextNeedingYou(v, "b1", agents({ a1: false, x: false }), null)).toBeNull();
    expect(nextNeedingYou(v, "b1", [], null)).toBeNull();
  });

  it("starts on the board shown", () => {
    expect(nextNeedingYou(v, "b2", live, null)).toEqual({ key: "b1", board: "b2", anchor: "b2" });
    expect(nextNeedingYou(v, "b1", live, null)).toEqual({ key: "a2", board: "b1", anchor: "b1" });
  });

  it("walks the current board, then the other boards in order, then Everything, and wraps", () => {
    let cur = "b1";
    let last: NextJump | null = null;
    const seen: string[] = [];
    for (let i = 0; i < 5; i++) {
      const j = nextNeedingYou(v, cur, live, last);
      if (!j) throw new Error("expected a jump");
      seen.push(`${j.key}@${j.board}`);
      cur = j.board;
      last = j;
    }
    // a2 on A, b1 switches to B, x (on no board) switches to Everything; from Everything nothing switches again.
    expect(seen).toEqual(["a2@b1", "b1@b2", "x@all", "a2@all", "b1@all"]);
  });

  it("skips the one just shown, unless it is the only one", () => {
    const two = agents({ a1: true, a2: true });
    const first = nextNeedingYou(v, "b1", two, null);
    expect(first?.key).toBe("a1");
    expect(nextNeedingYou(v, "b1", two, first)?.key).toBe("a2");
    const one = agents({ a1: false, a2: true });
    const only = nextNeedingYou(v, "b1", one, null);
    expect(nextNeedingYou(v, "b1", one, only)).toEqual(only);
  });

  it("a board switched by hand starts a fresh round there", () => {
    const j = nextNeedingYou(v, "b1", live, null);
    expect(nextNeedingYou(v, "b2", live, j)).toEqual({ key: "b1", board: "b2", anchor: "b2" });
  });

  it("an agent on the board shown stays there even when an earlier board also has it", () => {
    const shared = view(board("b1", "A", ["s"]), board("b2", "B", ["s"]));
    const j = nextNeedingYou(shared, "b2", agents({ s: true }), null);
    expect(j).toEqual({ key: "s", board: "b2", anchor: "b2" });
  });

  it("from Everything the walk is the grid's order and never switches boards", () => {
    const j = nextNeedingYou(v, EVERYTHING, agents({ x: true, b1: true, a2: true }), null);
    expect(j).toEqual({ key: "x", board: EVERYTHING, anchor: EVERYTHING });
  });

  it("a removed board or one not loaded yet counts as Everything", () => {
    expect(nextNeedingYou(v, "b9", live, null)?.board).toBe(EVERYTHING);
    expect(nextNeedingYou(null, "b1", agents({ l1: true }), null)).toEqual({ key: "l1", board: EVERYTHING, anchor: EVERYTHING });
  });

  it("an answered agent drops out and the round goes on from where it was", () => {
    const j: NextJump = { key: "a2", board: "b1", anchor: "b1" };
    expect(nextNeedingYou(v, "b1", agents({ a1: false, a2: false, b1: true, x: true }), j)?.key).toBe("b1");
  });
});

describe("liveForPrune", () => {
  const onBoards = ["l1", "gone", "rs:n1:t1", "rs:n1:t2", "rs:n2:t3"];

  it("drops a gone local agent and a remote one its answering computer no longer lists", () => {
    const live = liveForPrune(["l1"], ["rs:n1:t1"], new Set(["n1"]), onBoards);
    expect(live.sort()).toEqual(["l1", "rs:n1:t1", "rs:n2:t3"]);
  });

  it("keeps every remote agent on a board when the remote lanes were not read", () => {
    expect(liveForPrune(["l1"], null, new Set(), onBoards).sort()).toEqual(["l1", "rs:n1:t1", "rs:n1:t2", "rs:n2:t3"]);
  });

  it("keeps a remote agent whose computer is not answering", () => {
    expect(liveForPrune([], [], new Set(), ["rs:n1:t1"])).toEqual(["rs:n1:t1"]);
  });
});

describe("board names", () => {
  const v = view(board("b1", "Fixes", []));

  it("refuses empty, too long, control characters and a case-insensitive duplicate", () => {
    expect(boardNameProblem(v, "   ")).not.toBeNull();
    expect(boardNameProblem(v, "x".repeat(41))).not.toBeNull();
    expect(boardNameProblem(v, "x".repeat(40))).toBeNull();
    expect(boardNameProblem(v, "a\u0007b")).not.toBeNull();
    expect(boardNameProblem(v, " fixes ")).toBe("Another board already has that name.");
  });

  it("a board may keep its own name on rename", () => {
    expect(boardNameProblem(v, "FIXES", "b1")).toBeNull();
  });

  it("a new board takes the lowest free Board n", () => {
    expect(nextBoardName(null)).toBe("Board 1");
    expect(nextBoardName(view(board("b1", "board 1", []), board("b2", "Board 3", [])))).toBe("Board 2");
  });
});
