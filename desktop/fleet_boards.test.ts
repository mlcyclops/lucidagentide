// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addAgents, BOARDS_FILE, type Boards, type BoardsResult, createBoard, dropAgents, emptyBoards, MAX_BOARD_AGENTS, MAX_BOARDS,
  moveBoard, openBoards, parseBoards, pruneBoards, removeBoard, renameBoard, setLayout,
} from "./fleet_boards.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function ok(r: BoardsResult): Boards {
  if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
  return r.data;
}
function refused(r: BoardsResult): string {
  if (r.ok) throw new Error("expected a refusal");
  return r.error;
}
/** Boards with the given names, created in order (ids b1, b2, ...). */
function withBoards(...names: string[]): Boards {
  return names.reduce((s, n) => ok(createBoard(s, n)), emptyBoards());
}

test("create trims the name, appends the board last and climbs the id", () => {
  const s = withBoards("Front end", "  Back end  ");
  expect(s.boards.map((b) => [b.id, b.name, b.layout, b.agents.length])).toEqual([["b1", "Front end", "side", 0], ["b2", "Back end", "side", 0]]);
  expect(s.next).toBe(3);
});

test("names are 1 to 40 printable characters and unique ignoring case", () => {
  const s = withBoards("Docs");
  expect(refused(createBoard(s, "   "))).toBe("Give the board a name.");
  expect(ok(createBoard(s, "x".repeat(40))).boards[1]!.name).toHaveLength(40);
  expect(refused(createBoard(s, "x".repeat(41)))).toContain("at most 40");
  expect(ok(createBoard(s, "🙂".repeat(40))).boards).toHaveLength(2); // characters, not UTF-16 units
  expect(refused(createBoard(s, "two\nlines"))).toContain("letters, numbers");
  expect(refused(createBoard(s, "DOCS"))).toBe('There is already a board named "DOCS".');
});

test("at most 24 boards", () => {
  const s = withBoards(...Array.from({ length: MAX_BOARDS }, (_, i) => `Board ${i}`));
  expect(s.boards).toHaveLength(24);
  expect(refused(createBoard(s, "One more"))).toContain("at most 24 boards");
});

test("rename keeps the rules, lets a board change its own case, and refuses an unknown id", () => {
  const s = withBoards("Docs", "Tests");
  expect(ok(renameBoard(s, "b1", "DOCS")).boards[0]!.name).toBe("DOCS");
  expect(refused(renameBoard(s, "b1", "tests"))).toContain("already a board");
  expect(refused(renameBoard(s, "b1", ""))).toBe("Give the board a name.");
  expect(refused(renameBoard(s, "b9", "New"))).toBe("That board no longer exists.");
});

test("remove drops only that board, and ids never come back", () => {
  let s = ok(addAgents(withBoards("A", "B"), "b2", ["lane-1"]));
  s = ok(addAgents(s, "b1", ["lane-1"]));
  s = ok(removeBoard(s, "b2"));
  expect(s.boards.map((b) => b.id)).toEqual(["b1"]);
  expect(s.boards[0]!.agents).toEqual(["lane-1"]);
  expect(ok(createBoard(s, "C")).boards[1]!.id).toBe("b3");
  expect(refused(removeBoard(s, "b2"))).toBe("That board no longer exists.");
});

test("move puts a board at the new index and lands at the end when past it", () => {
  const s = withBoards("A", "B", "C");
  const order = (r: BoardsResult) => ok(r).boards.map((b) => b.name).join("");
  expect(order(moveBoard(s, "b1", 2))).toBe("BCA");
  expect(order(moveBoard(s, "b3", 0))).toBe("CAB");
  expect(order(moveBoard(s, "b1", 99))).toBe("BCA");
  expect(order(moveBoard(s, "b3", -5))).toBe("CAB");
  expect(refused(moveBoard(s, "b1", 1.5))).toContain("Pick a place");
  expect(refused(moveBoard(s, "b1", Number.NaN))).toContain("Pick a place");
  expect(refused(moveBoard(s, "b7", 0))).toBe("That board no longer exists.");
});

test("agents: added in order without repeats, local and remote keys, at most 200, one agent on several boards", () => {
  let s = withBoards("A", "B");
  s = ok(addAgents(s, "b1", ["lane-1", "rs:spoke-01:t7", "lane-1"]));
  s = ok(addAgents(s, "b1", ["rs:spoke-01:t7", "lane-2"]));
  s = ok(addAgents(s, "b2", ["lane-1"]));
  expect(s.boards[0]!.agents).toEqual(["lane-1", "rs:spoke-01:t7", "lane-2"]);
  expect(s.boards[1]!.agents).toEqual(["lane-1"]);
  expect(refused(addAgents(s, "b1", [""]))).toBe("One of those is not an agent.");
  expect(refused(addAgents(s, "b1", ["a\u0000b"]))).toBe("One of those is not an agent.");

  const full = ok(addAgents(withBoards("Full"), "b1", Array.from({ length: MAX_BOARD_AGENTS }, (_, i) => `lane-${i}`)));
  expect(full.boards[0]!.agents).toHaveLength(200);
  expect(ok(addAgents(full, "b1", ["lane-0"])).boards[0]!.agents).toHaveLength(200); // already there: no growth
  expect(refused(addAgents(full, "b1", ["lane-200"]))).toContain("at most 200 agents");
});

test("dropping an agent drops a focus on it; other boards keep it", () => {
  let s = ok(addAgents(withBoards("A", "B"), "b1", ["lane-1", "lane-2"]));
  s = ok(addAgents(s, "b2", ["lane-1"]));
  s = ok(setLayout(s, "b1", "focus", "lane-1"));
  s = ok(setLayout(s, "b2", "focus", "lane-1"));
  s = ok(dropAgents(s, "b1", ["lane-1", "not-there"]));
  expect(s.boards[0]).toEqual({ id: "b1", name: "A", agents: ["lane-2"], layout: "focus" });
  expect(s.boards[1]!.focus).toBe("lane-1");
  expect(refused(dropAgents(s, "b9", ["lane-2"]))).toBe("That board no longer exists.");
});

test("layout: known layouts only, a focus must be on the board, a focus left out clears it", () => {
  let s = ok(addAgents(withBoards("A"), "b1", ["lane-1"]));
  expect(refused(setLayout(s, "b1", "mosaic"))).toContain("side, grid4, focus or free");
  expect(refused(setLayout(s, "b4", "grid4"))).toBe("That board no longer exists.");
  s = ok(setLayout(s, "b1", "focus", "lane-1"));
  expect(s.boards[0]!.focus).toBe("lane-1");
  expect(ok(setLayout(s, "b1", "focus", "elsewhere")).boards[0]).toEqual({ id: "b1", name: "A", agents: ["lane-1"], layout: "focus" });
  expect(ok(setLayout(s, "b1", "grid4")).boards[0]!.focus).toBeUndefined();
});

test("Everything takes any agent as its focus and is never stored as a board", () => {
  const s = ok(setLayout(emptyBoards(), "all", "focus", "rs:spoke-02:t1"));
  expect(s.everything).toEqual({ layout: "focus", focus: "rs:spoke-02:t1" });
  expect(s.boards).toEqual([]);
  expect(ok(setLayout(s, "all", "free", "")).everything).toEqual({ layout: "free" });
  expect(refused(setLayout(s, "all", "tiles"))).toContain("side, grid4, focus or free");
});

test("prune forgets agents that are gone, from every board and every focus", () => {
  let s = ok(addAgents(withBoards("A", "B"), "b1", ["lane-1", "lane-2", "rs:n:t"]));
  s = ok(addAgents(s, "b2", ["lane-2"]));
  s = ok(setLayout(s, "b1", "focus", "lane-2"));
  s = ok(setLayout(s, "b2", "focus", "lane-2"));
  s = ok(setLayout(s, "all", "focus", "lane-2"));
  const kept = ok(setLayout(s, "all", "focus", "rs:n:t"));

  const p = pruneBoards(s, ["lane-1", "rs:n:t"]);
  expect(p.boards[0]).toEqual({ id: "b1", name: "A", agents: ["lane-1", "rs:n:t"], layout: "focus" });
  expect(p.boards[1]).toEqual({ id: "b2", name: "B", agents: [], layout: "focus" });
  expect(p.everything).toEqual({ layout: "focus" });
  expect(pruneBoards(kept, ["rs:n:t"]).everything).toEqual({ layout: "focus", focus: "rs:n:t" });
  expect(p.next).toBe(s.next);
});

test("parse: junk reads as the empty default", () => {
  for (const junk of [null, undefined, 7, "boards", [], { v: 2, boards: [] }, { boards: [] }]) expect(parseBoards(junk)).toEqual(emptyBoards());
});

test("parse: a valid file round-trips exactly", () => {
  let s = ok(addAgents(withBoards("A", "B"), "b2", ["lane-1", "rs:spoke:t"]));
  s = ok(setLayout(s, "b2", "focus", "rs:spoke:t"));
  s = ok(setLayout(s, "all", "grid4", "lane-1"));
  s = ok(removeBoard(s, "b1"));
  expect(parseBoards(JSON.parse(JSON.stringify(s)))).toEqual(s);
});

test("parse: bad boards, keys and unknown fields are dropped, and next climbs past every kept id", () => {
  const raw = {
    v: 1, next: 2, extra: true,
    boards: [
      { id: "b7", name: "Good", agents: ["lane-1", "lane-1", 5, "", "lane-2"], layout: "grid4", focus: "lane-9", color: "red" },
      { id: "b8", name: "good", agents: [], layout: "side" }, // name taken, ignoring case
      { id: "b7", name: "Again", agents: [], layout: "side" }, // id taken
      { id: "x1", name: "Bad id", agents: [], layout: "side" },
      { id: "b9", name: "Bad layout", agents: [], layout: "mosaic" },
      { id: "b10", name: "  untrimmed ", agents: [], layout: "side" },
      { id: "b11", name: "y".repeat(41), agents: [], layout: "side" },
      "not a board",
      { id: "b12", name: "Focused", agents: ["lane-3"], layout: "focus", focus: "lane-3" },
    ],
    everything: { layout: "nope", focus: "lane-1" },
  };
  expect(parseBoards(raw)).toEqual({
    v: 1, next: 13,
    boards: [
      { id: "b7", name: "Good", agents: ["lane-1", "lane-2"], layout: "grid4" },
      { id: "b12", name: "Focused", agents: ["lane-3"], layout: "focus", focus: "lane-3" },
    ],
    everything: { layout: "side" },
  });
});

test("parse: caps hold on a hand-edited file", () => {
  const boards = Array.from({ length: 30 }, (_, i) => ({ id: `b${i + 1}`, name: `B${i}`, agents: Array.from({ length: 250 }, (_, j) => `l${j}`), layout: "side" }));
  const s = parseBoards({ v: 1, next: 1, boards, everything: { layout: "free" } });
  expect(s.boards).toHaveLength(24);
  expect(s.boards[0]!.agents).toHaveLength(200);
  expect(s.next).toBe(25);
  expect(s.everything).toEqual({ layout: "free" });
});

test("store: a missing file reads as the default, an update is saved and read back", () => {
  const dir = mkdtempSync(join(tmpdir(), "lucid-boards-"));
  dirs.push(dir);
  const store = openBoards(dir);
  expect(store.read()).toEqual(emptyBoards());
  const made = ok(store.update((s) => createBoard(s, "Docs")));
  ok(store.update((s) => addAgents(s, "b1", ["lane-1"])));
  expect(refused(store.update((s) => createBoard(s, "docs")))).toContain("already a board");
  const back = openBoards(dir).read();
  expect(back.boards).toEqual([{ id: "b1", name: "Docs", agents: ["lane-1"], layout: "side" }]);
  expect(back.next).toBe(made.next);
  expect(JSON.parse(readFileSync(join(dir, BOARDS_FILE), "utf8"))).toEqual(back);
});

test("store: a corrupt file reads as the default and the next update replaces it", () => {
  const dir = mkdtempSync(join(tmpdir(), "lucid-boards-"));
  dirs.push(dir);
  writeFileSync(join(dir, BOARDS_FILE), "{ not json");
  const store = openBoards(dir);
  expect(store.read()).toEqual(emptyBoards());
  ok(store.update((s) => createBoard(s, "Fresh")));
  expect(store.read().boards.map((b) => b.name)).toEqual(["Fresh"]);
});
