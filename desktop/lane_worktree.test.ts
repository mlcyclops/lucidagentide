// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-FLEET.WT1: where a lane's own worktree goes. A worktree inside the repo would show up as untracked files
// in the checkout the other agents share, and a lane started at the repo root when the user picked a
// subfolder would work in the wrong place; both are placement bugs this pins.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { worktreePlan } from "./lane_worktree.ts";

const root = join("C:", "work", "myrepo");

describe("worktreePlan", () => {
  test("the worktree sits beside the repo, never inside it, and the lane starts in the subfolder the user picked", () => {
    const p = worktreePlan(root, join(root, "desktop", "renderer"), "UI polish", "a1b2c3");
    expect(p.path).toBe(join("C:", "work", "myrepo.lucid-worktrees", "ui-polish-a1b2c3"));
    expect(p.path.startsWith(root + (root.includes("\\") ? "\\" : "/"))).toBe(false);
    expect(p.laneCwd).toBe(join(p.path, "desktop", "renderer"));
    expect(worktreePlan(root, root, "x", "1").laneCwd).toBe(worktreePlan(root, root, "x", "1").path);
  });

  test("any lane name becomes a valid branch and folder name", () => {
    expect(worktreePlan(root, root, "Fix: the ../../ login bug!", "ff").branch).toBe("lucid/fix-the-login-bug-ff");
    expect(worktreePlan(root, root, "***", "ff").branch).toBe("lucid/lane-ff");
  });
});
