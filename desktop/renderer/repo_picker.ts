// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/repo_picker.ts - P-REPO.1 (ADR-0404): pick the repo a new spoke works on instead of
// typing a folder path or a clone URL.
//
// Two lists, one search box. "On this machine" is every folder LUCID already knows (the workspace, live
// spokes' folders, recent workspaces, report repos) plus the git checkouts sitting directly inside the
// workspace and the LUCID clone folder, each with its branch and push target. "On GitHub" is the user's
// own repositories (the GitHub CLI sign-in, or a saved GitHub token), minus any already cloned here, so
// picking one clones it; picking a local one just points the spoke at that folder. Both spawn forms (the
// grid's New lane card and the orbit's New spoke panel) mount this and map the pick onto their existing
// folder and repo-URL fields, which stay available under "Other folder or URL" for anything not listed.

import { $ } from "./dom.ts";
import { esc } from "./format.ts";
import { icon } from "./icons.ts";
import type { GithubRepoList, LocalRepoChoice, LucidBridge, RemoteRepoChoice } from "./bridge.ts";
import { providerLabel } from "../git_url.ts";

export type RepoPickerDeps = Pick<LucidBridge, "repoChoices" | "repoGithub">;
export type RepoPick =
  | { kind: "local"; path: string; name: string }
  /** `via`: how the engine listed it, which is also how it will authenticate the clone. */
  | { kind: "github"; cloneUrl: string; slug: string; name: string; via: "gh" | "token" };

/** The clone note for a GitHub pick: the engine clones with the same sign-in that listed the repo, so no
 *  token field is needed (the forms hide theirs when this returns text). */
export function githubPickNote(pick: RepoPick, parent: string): string | null {
  if (pick.kind !== "github") return null;
  const how = pick.via === "gh" ? "your GitHub CLI sign-in" : "your saved GitHub token";
  return `GitHub: ${pick.slug} - clones into ${parent || "the shared LUCID workspaces folder"}, reusing it if already there. Uses ${how}; no token needed here.`;
}

type Row = { kind: "local"; c: LocalRepoChoice } | { kind: "github"; c: RemoteRepoChoice };

const SOURCE_LABEL: Record<LocalRepoChoice["source"], string> = {
  workspace: "workspace", lane: "a spoke works here", recent: "recent", report: "in reports", nearby: "in the workspace", clone: "LUCID clone",
};

/** The picker's markup. Mount it with mountRepoPicker once it is in the DOM. */
export function repoPickerHtml(): string {
  return `<div class="repo-pick" data-repo-pick>
    <div class="repo-pick-search">${icon("search", 12)}<input type="text" data-repo-q spellcheck="false" autocomplete="off" placeholder="Search repositories" aria-label="Search repositories"></div>
    <div class="repo-pick-list" data-repo-list role="listbox" aria-label="Repositories"><div class="repo-pick-empty">Loading repositories\u2026</div></div>
  </div>`;
}

function localRow(c: LocalRepoChoice, i: number, on: boolean): string {
  const push = c.slug
    ? `${c.branch ? `<span class="rp-branch">${esc(c.branch)}</span> ` : ""}${icon("arrowRight", 10)} <span class="rp-slug">${esc(c.slug)}</span>`
    : `${c.branch ? `<span class="rp-branch">${esc(c.branch)}</span> ` : ""}<span class="rp-local">${c.isGit ? "local only, no remote" : "not a git repo"}</span>`;
  const title = [c.path, c.isGit ? `Branch: ${c.branch || "detached"}` : "Not a git repository", c.slug ? `Pushes to ${c.provider ? providerLabel(c.provider) : ""} ${c.slug}` : "", c.worktree ? "A git worktree" : ""].filter(Boolean).join("\n");
  return `<button type="button" class="repo-pick-row${on ? " on" : ""}" data-pick-i="${i}" role="option" aria-selected="${on}" title="${esc(title)}">
    ${icon(c.isGit ? "git" : "folder", 13)}<span class="rp-main"><span class="rp-top"><span class="rp-name">${esc(c.name)}</span><span class="rp-src">${esc(c.worktree ? "worktree" : SOURCE_LABEL[c.source])}</span></span><span class="rp-sub">${push}</span></span>
  </button>`;
}

function githubRow(c: RemoteRepoChoice, i: number, on: boolean): string {
  const title = [c.slug, c.description, c.private ? "Private" : "Public", "Picking it clones it, reusing an existing clone in the same folder."].filter(Boolean).join("\n");
  return `<button type="button" class="repo-pick-row gh${on ? " on" : ""}" data-pick-i="${i}" role="option" aria-selected="${on}" title="${esc(title)}">
    ${icon("download", 13)}<span class="rp-main"><span class="rp-top"><span class="rp-name">${esc(c.slug)}</span><span class="rp-src">${c.private ? "private" : "public"}</span></span><span class="rp-sub">${esc(c.description || "Not on this machine yet: picking it clones it")}</span></span>
  </button>`;
}

/** Wire a mounted picker. `current()` is the folder the form holds right now (its row shows selected);
 *  `onPick` receives the choice and maps it onto the form's own fields. */
export function mountRepoPicker(root: HTMLElement, deps: RepoPickerDeps, current: () => string, onPick: (p: RepoPick) => void): void {
  const box = $("[data-repo-pick]", root) as HTMLElement | null;
  const list = box ? ($("[data-repo-list]", box) as HTMLElement | null) : null;
  const q = box ? ($("[data-repo-q]", box) as HTMLInputElement | null) : null;
  if (!box || !list || !q) return;
  let local: LocalRepoChoice[] | null = null;
  let github: GithubRepoList | null = null;
  let rows: Row[] = [];
  let picked = "";

  const norm = (p: string): string => p.replace(/[\\/]+/g, "/").replace(/\/$/, "").toLowerCase();
  const paint = (): void => {
    const needle = q.value.trim().toLowerCase();
    const hit = (...parts: string[]): boolean => !needle || parts.some((s) => s.toLowerCase().includes(needle));
    const cur = picked || norm(current());
    const localSlugs = new Set((local ?? []).map((c) => c.slug.toLowerCase()).filter(Boolean));
    const l = (local ?? []).filter((c) => hit(c.name, c.slug, c.branch, c.path));
    const g = (github?.repos ?? []).filter((c) => !localSlugs.has(c.slug.toLowerCase()) && hit(c.slug, c.description));
    rows = [...l.map((c): Row => ({ kind: "local", c })), ...g.map((c): Row => ({ kind: "github", c }))];
    const parts: string[] = [];
    parts.push(`<div class="repo-pick-h">On this machine</div>`);
    if (!local) parts.push(`<div class="repo-pick-empty">Loading\u2026</div>`);
    else if (!l.length) parts.push(`<div class="repo-pick-empty">${needle ? "No local match" : "No repositories found next to the workspace"}</div>`);
    else l.forEach((c, i) => parts.push(localRow(c, i, norm(c.path) === cur)));
    if (!github) parts.push(`<div class="repo-pick-h">On GitHub</div><div class="repo-pick-empty">Loading\u2026</div>`);
    else if (github.via === "none") parts.push(`<div class="repo-pick-h">On GitHub</div><div class="repo-pick-empty">Sign in with the GitHub CLI (<code>gh auth login</code>) or save a GitHub token to list your repositories here.</div>`);
    else {
      parts.push(`<div class="repo-pick-h">On GitHub${github.via === "gh" ? " (GitHub CLI sign-in)" : ""}<button type="button" class="repo-pick-refresh" data-repo-refresh title="Fetch the list again">${icon("refresh", 11)}</button></div>`);
      if (github.error) parts.push(`<div class="repo-pick-empty bad">${esc(github.error)}</div>`);
      else if (!g.length) parts.push(`<div class="repo-pick-empty">${needle ? "No GitHub match" : "Every GitHub repository you have is already on this machine"}</div>`);
      else g.forEach((c, i) => parts.push(githubRow(c, l.length + i, picked === `gh:${c.slug.toLowerCase()}`)));
    }
    list.innerHTML = parts.join("");
  };

  const loadGithub = (refresh: boolean): void => {
    github = null;
    paint();
    void deps.repoGithub(refresh).then((r) => { github = r ?? { repos: [], via: "gh", error: "The engine did not answer." }; paint(); });
  };
  void deps.repoChoices().then((r) => { local = r ?? []; paint(); });
  loadGithub(false);

  q.addEventListener("input", paint);
  list.addEventListener("click", (e) => {
    const t = e.target instanceof HTMLElement ? e.target : null;
    if (t?.closest("[data-repo-refresh]")) { loadGithub(true); return; }
    const btn = t?.closest<HTMLElement>("[data-pick-i]");
    const row = btn ? rows[Number(btn.dataset.pickI)] : undefined;
    if (!row) return;
    if (row.kind === "local") { picked = norm(row.c.path); onPick({ kind: "local", path: row.c.path, name: row.c.name }); }
    else { picked = `gh:${row.c.slug.toLowerCase()}`; onPick({ kind: "github", cloneUrl: row.c.cloneUrl, slug: row.c.slug, name: row.c.name, via: github?.via === "token" ? "token" : "gh" }); }
    paint();
  });
}
