// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/checkout_registry.test.ts - P-OWN.1: the engine-side registry over the pure owners/sweep
// modules: checkout roots (a `.git` file counts, a worktree is its own root), the dirty set is git's
// truth, owner entries for clean files are pruned, and the gate refuses a sweep by owner name.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheckoutRegistry, parsePorcelainZ, type CheckoutSession } from "./checkout_registry.ts";

let root = "";
let other = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lucid-own-"));
  mkdirSync(join(root, ".git"));
  mkdirSync(join(root, "src"));
  other = mkdtempSync(join(tmpdir(), "lucid-own-wt-"));
  writeFileSync(join(other, ".git"), "gitdir: elsewhere\n"); // a linked worktree: `.git` is a file
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); rmSync(other, { recursive: true, force: true }); });

function registry(sessions: CheckoutSession[], dirty: Record<string, string[]>, clock = { now: 0 }): CheckoutRegistry {
  return new CheckoutRegistry({
    sessions: () => sessions,
    gitStatus: async (r) => dirty[r.toLowerCase().replaceAll("\\", "/")] ?? dirty["*"] ?? [],
    now: () => clock.now,
  });
}

describe("root", () => {
  test("walks up to .git (dir or file); outside a checkout is null; relative paths are null", () => {
    const reg = registry([], {});
    expect(reg.root(join(root, "src", "a.ts"))).toBe(reg.root(root));
    expect(reg.root(root)).not.toBeNull();
    expect(reg.root(join(other, "x"))).toBe(reg.root(other));
    expect(reg.root(other)).not.toBe(reg.root(root)); // two working trees, two roots
    expect(reg.root("relative/path")).toBeNull();
  });
});

describe("peers and gate", () => {
  test("a peer is another session with dirty files it wrote, or running here; my files are omitted", async () => {
    const sessions: CheckoutSession[] = [
      { id: "master", name: "main composer", cwd: root, task: "review", running: false },
      { id: "lane-a", name: "alpha", cwd: join(root, "src"), task: "refactor auth", running: true },
      { id: "lane-z", name: "zeta", cwd: other, task: "elsewhere", running: true },
    ];
    const reg = registry(sessions, { "*": ["src/a.ts", "src/b.ts", "notes.md"] });
    reg.recordWrite({ id: "lane-a", name: "alpha" }, "a.ts", join(root, "src"));
    reg.recordWrite({ id: "master", name: "main composer" }, join(root, "src", "b.ts"), root);
    const v = await reg.peers("master", root);
    expect(v.root).toBe(reg.root(root));
    expect(v.peers.map((p) => p.id)).toEqual(["lane-a"]); // zeta is in another working tree
    expect(v.peers[0]!.files).toEqual(["src/a.ts"]);
    expect(v.unowned).toEqual(["notes.md"]);
    const fromLane = await reg.peers("lane-a", join(root, "src"));
    expect(fromLane.peers.map((p) => p.id)).toEqual(["master"]);
    expect(fromLane.peers[0]!.files).toEqual(["src/b.ts"]);
  });

  test("an owner entry for a file git reports clean is pruned; the dirty set is cached briefly", async () => {
    const dirty: Record<string, string[]> = { "*": ["src/a.ts"] };
    const clock = { now: 0 };
    const reg = registry([{ id: "lane-a", name: "alpha", cwd: root, task: "", running: false }], dirty, clock);
    const a = join(root, "src", "a.ts");
    reg.recordWrite({ id: "lane-a", name: "alpha" }, a, root);
    expect((await reg.peers("master", root)).peers[0]!.files).toEqual(["src/a.ts"]);
    dirty["*"] = []; // committed
    clock.now = 1_000; // inside the status TTL: the earlier answer stands, no second git call
    expect((await reg.peers("master", root)).peers[0]!.files).toEqual(["src/a.ts"]);
    clock.now = 5_000; // past it: git is asked again, the file is clean, the entry is pruned
    expect((await reg.peers("master", root)).peers.length).toBe(0);
    expect(reg.owners.owner(reg.root(root)!, a)).toBeNull();
  });

  test("gate: a sweep over another session's dirty file is refused by name; explicit paths pass", async () => {
    const reg = registry([
      { id: "master", name: "main composer", cwd: root, task: "", running: false },
      { id: "lane-a", name: "alpha", cwd: root, task: "scroll fix", running: true },
    ], { "*": ["src/a.ts", "src/mine.ts"] });
    reg.recordWrite({ id: "lane-a", name: "alpha" }, join(root, "src", "a.ts"), root);
    reg.recordWrite({ id: "master", name: "main composer" }, join(root, "src", "mine.ts"), root);
    const sweep = await reg.gate("master", root, "git add -A && git commit -m x");
    expect(sweep.block).toBe(true);
    expect(sweep.reason).toContain("alpha");
    expect(sweep.reason).toContain("src/a.ts");
    expect(sweep.reason).toContain("src/mine.ts");
    expect((await reg.gate("master", root, "git add src/mine.ts && git commit -m x")).block).toBe(false);
    expect((await reg.gate("lane-a", root, "git add -A")).block).toBe(true); // mine.ts is the master's
    expect((await reg.gate("master", "/not/a/checkout", "git add -A")).block).toBe(false);
  });
});

describe("parsePorcelainZ", () => {
  test("reads XY + path entries, skips the rename source field, normalizes slashes", () => {
    const out = [" M src/a.ts", "?? new file.md", "R  b.ts", "old\\b.ts", "A  dir\\c.ts"].join("\0") + "\0";
    expect(parsePorcelainZ(out)).toEqual(["src/a.ts", "new file.md", "b.ts", "dir/c.ts"]);
    expect(parsePorcelainZ("")).toEqual([]);
  });
});
