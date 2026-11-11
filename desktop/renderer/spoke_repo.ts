// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/spoke_repo.ts
//
// P-HUB-PICK.1 (ADR-0553): which codebase a spoke works on, named and colored the same way on every surface
// (the orbit node, the grid card, the Hubs menu, the spoke switch menu). The repo chip (ADR-0406) exists only
// for a repo that pushes to a hosted remote; a spoke in a local git repo or a plain folder had no name for its
// codebase at all, so two spokes on different repos read alike. Every spoke gets a label here: the hosted
// repo, else the git repo's folder, else the spoke's own folder. Same codebase = same key = same hue.

import type { RepoContext } from "../repo_identity.ts";

export interface SpokeRepo {
  /** Stable identity: `host/owner/repo` for a hosted repo, else the repo root, else the folder (lowercased,
   *  forward slashes), so two clones of one GitHub repo share a color and two unrelated folders never do. */
  key: string;
  /** What the user reads: the repo's name, else the folder's last segment. */
  name: string;
  /** 0-359, derived from `key` only. */
  hue: number;
}

/** FNV-1a over the key, folded to a hue. Deterministic across runs and machines. */
function hueOf(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0) % 360;
}

/** The codebase a spoke (or Main) works on. `repo` is the engine's probe (absent until it lands). */
export function spokeRepo(s: { cwd: string; repo?: RepoContext | null }): SpokeRepo {
  const v = s.repo?.repo ?? null;
  const p = v?.push;
  const key = p?.host && p.repo
    ? `${p.host}/${p.owner ? `${p.owner}/` : ""}${p.repo}`.toLowerCase()
    : (v?.root || s.cwd).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const name = p?.host && p.repo ? p.repo : v?.name || s.cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || s.cwd;
  return { key, name, hue: hueOf(key) };
}

/** Split `ids` (already in display order) into one section per codebase, sections by repo name, the
 *  relative order of ids inside a section kept. `repoOf` answers null for an id it no longer knows. */
export function repoSections(ids: readonly string[], repoOf: (id: string) => SpokeRepo | null): { repo: SpokeRepo; ids: string[] }[] {
  const by = new Map<string, { repo: SpokeRepo; ids: string[] }>();
  for (const id of ids) {
    const r = repoOf(id);
    if (!r) continue;
    let s = by.get(r.key);
    if (!s) { s = { repo: r, ids: [] }; by.set(r.key, s); }
    s.ids.push(id);
  }
  return [...by.values()].sort((a, b) => a.repo.name.localeCompare(b.repo.name, undefined, { sensitivity: "base" }) || a.repo.key.localeCompare(b.repo.key));
}
