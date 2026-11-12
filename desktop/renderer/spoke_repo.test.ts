// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-HUB-PICK.1 (ADR-0516): every spoke names its codebase, the same codebase always reads and colors the
// same, and different codebases never share a key.

import { expect, test } from "bun:test";
import type { RepoContext } from "./bridge.ts";
import { repoSections, spokeRepo } from "./spoke_repo.ts";

const ctx = (root: string, name: string, push: { host: string; owner: string; repo: string } | null): RepoContext => ({
  cwd: root, source: "folder", others: [],
  repo: { root, name, branch: "main", head: "abc1234", worktree: false, remotes: push ? 1 : 0,
    push: push ? { remote: "origin", branch: "main", provider: "github", webUrl: "", ...push } : null },
});

test("a hosted repo is named by its remote, and two clones of it share key and color", () => {
  const a = spokeRepo({ cwd: "C:\\w\\lucid-wt", repo: ctx("C:\\w\\lucid-wt", "lucid-wt", { host: "github.com", owner: "mlcyclops", repo: "lucidagentide" }) });
  const b = spokeRepo({ cwd: "/home/x/lucidagentide", repo: ctx("/home/x/lucidagentide", "lucidagentide", { host: "github.com", owner: "MLCyclops", repo: "LucidAgentIDE" }) });
  expect(a.name).toBe("lucidagentide");
  expect(a.key).toBe("github.com/mlcyclops/lucidagentide");
  expect([b.key, b.hue]).toEqual([a.key, a.hue]);
});

test("a local repo is named by its root folder, a plain folder by itself, and same-named folders differ", () => {
  const sub = spokeRepo({ cwd: "C:\\code\\shop\\web", repo: ctx("C:\\code\\shop", "shop", null) });
  expect([sub.name, sub.key]).toEqual(["shop", "c:/code/shop"]);
  const plain = spokeRepo({ cwd: "\\\\nas\\data\\notes\\" });
  expect([plain.name, plain.key]).toEqual(["notes", "//nas/data/notes"]);
  expect(spokeRepo({ cwd: "/a/notes" }).key).not.toBe(spokeRepo({ cwd: "/b/notes" }).key);
  expect(plain.hue).toBeGreaterThanOrEqual(0);
  expect(plain.hue).toBeLessThan(360);
});

test("repoSections groups by codebase, sorted by name, keeping card order inside a section and skipping unknown ids", () => {
  const repos: Record<string, string> = { a: "/srv/zeta", b: "/srv/alpha", c: "/srv/zeta", d: "/srv/alpha" };
  const secs = repoSections(["a", "b", "x", "c", "d"], (id) => (repos[id] ? spokeRepo({ cwd: repos[id]! }) : null));
  expect(secs.map((s) => [s.repo.name, s.ids])).toEqual([["alpha", ["b", "d"]], ["zeta", ["a", "c"]]]);
});
