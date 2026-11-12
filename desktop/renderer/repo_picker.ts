// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/repo_picker.ts - P-REPO.1 (ADR-0406): pick the repo a new spoke works on instead of
// typing a folder path or a clone URL.
//
// Discovery is OPT-IN (operator request, 2026-09-27). The forms lead with a Folder field prefilled with
// the master's folder plus Browse (the real OS dialog), and spawning from that needs no discovery at all.
// Mounting the picker fetches nothing. Under "Find repos" two checkboxes, both unchecked by default,
// choose the sources, and only the Search button runs them: "On this machine" (repoChoices: git probes of
// the workspace, recents and nearby checkouts) and "On GitHub (GitHub CLI)" (repoGithub: `gh api
// user/repos`, up to 15 s). The checked sources run in parallel and each list paints the moment its own
// answer lands, so a slow gh never holds the local list back. The box states persist under
// REPO_FIND_KEY, but a checked box still waits for the button. Spawning never waits on a search.
//
// Once a list exists, one search box filters both. "On this machine" is every folder LUCID already knows
// (the workspace, live spokes' folders, recent workspaces, report repos) plus the git checkouts directly
// inside the workspace and the LUCID clone folder, each with its branch and push target. "On GitHub" is
// the user's own repositories (the GitHub CLI sign-in, or a saved GitHub token), minus any already cloned
// here, so picking one clones it; picking a local one just points the spoke at that folder. Both spawn
// forms (the grid's New lane card and the orbit's New spoke panel) mount this and map the pick onto their
// own Folder and clone-URL fields.

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

/** Where the two "Find repos" checkboxes persist. Their state only chooses what the Search button runs. */
export const REPO_FIND_KEY = "lucid.repoFind.v1";
export type FindSource = "local" | "github";
export type FindChecks = Record<FindSource, boolean>;

/** The stored box states; anything missing or malformed reads as unchecked (the default is no discovery). */
export function parseFindChecks(raw: string | null): FindChecks {
  try {
    const v: unknown = JSON.parse(raw ?? "{}");
    if (!v || typeof v !== "object") return { local: false, github: false };
    return { local: "local" in v && v.local === true, github: "github" in v && v.github === true };
  } catch { return { local: false, github: false }; }
}

/** The sources one press of Search runs: exactly the checked ones. Empty disables the button. */
export function sourcesToRun(c: FindChecks): FindSource[] {
  return (["local", "github"] as const).filter((s) => c[s]);
}

/** Start every requested source at once. Each answer goes to its own callback the moment it lands, so a
 *  slow `gh` never holds the local list back; a failed or empty answer lands as null. */
export function runFind(
  deps: RepoPickerDeps,
  sources: readonly FindSource[],
  land: { local: (r: LocalRepoChoice[] | null) => void; github: (r: GithubRepoList | null) => void },
  refresh = false,
): void {
  if (sources.includes("local")) void deps.repoChoices().catch(() => null).then(land.local);
  if (sources.includes("github")) void deps.repoGithub(refresh).catch(() => null).then(land.github);
}

/** The picker's markup. Mount it with mountRepoPicker once it is in the DOM. Nothing is listed (or fetched)
 *  until the user checks a source and presses Search. */
export function repoPickerHtml(): string {
  return `<div class="repo-pick" data-repo-pick>
    <div class="repo-pick-find">
      <div class="repo-pick-find-h"><span class="repo-pick-find-t">Find repos</span><button type="button" class="btn-mini repo-pick-go" data-repo-go disabled title="Search the checked sources">${icon("search", 11)} Search</button></div>
      <label class="repo-pick-src" title="Git checkouts in the workspace, recent workspaces and live spokes' folders"><input type="checkbox" data-repo-find="local"><span>On this machine</span></label>
      <label class="repo-pick-src" title="Your repositories, listed with the GitHub CLI sign-in (or a saved GitHub token)"><input type="checkbox" data-repo-find="github"><span>On GitHub (GitHub CLI)</span></label>
    </div>
    <div class="repo-pick-search" data-repo-search hidden>${icon("search", 12)}<input type="text" data-repo-q spellcheck="false" autocomplete="off" placeholder="Filter repositories" aria-label="Filter repositories"></div>
    <div class="repo-pick-list" data-repo-list role="listbox" aria-label="Repositories" hidden></div>
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
 *  `onPick` receives the choice and maps it onto the form's own fields. Mounting fetches nothing: only the
 *  Search button (for the checked sources) and the GitHub list's refresh button call the engine. */
export function mountRepoPicker(root: HTMLElement, deps: RepoPickerDeps, current: () => string, onPick: (p: RepoPick) => void): void {
  const box = $("[data-repo-pick]", root) as HTMLElement | null;
  const list = box ? ($("[data-repo-list]", box) as HTMLElement | null) : null;
  const q = box ? ($("[data-repo-q]", box) as HTMLInputElement | null) : null;
  const search = box ? ($("[data-repo-search]", box) as HTMLElement | null) : null;
  const go = box ? ($("[data-repo-go]", box) as HTMLButtonElement | null) : null;
  if (!box || !list || !q || !search || !go) return;
  let checks: FindChecks;
  try { checks = parseFindChecks(localStorage.getItem(REPO_FIND_KEY)); } catch { checks = { local: false, github: false }; }
  /** Which sources the user has asked for in this form; an unasked source paints nothing at all. */
  const asked: FindChecks = { local: false, github: false };
  /** Bumped per request so an older answer (a re-search, a refresh) never overwrites a newer one. */
  const gen: Record<FindSource, number> = { local: 0, github: 0 };
  let local: LocalRepoChoice[] | null = null; // null while its latest request is in flight
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
    if (asked.local) {
      parts.push(`<div class="repo-pick-h">On this machine</div>`);
      if (!local) parts.push(`<div class="repo-pick-empty">Searching this machine\u2026</div>`);
      else if (!l.length) parts.push(`<div class="repo-pick-empty">${needle ? "No local match" : "No repositories found next to the workspace"}</div>`);
      else l.forEach((c, i) => parts.push(localRow(c, i, norm(c.path) === cur)));
    }
    if (asked.github) {
      if (!github) parts.push(`<div class="repo-pick-h">On GitHub</div><div class="repo-pick-empty">Asking GitHub through the GitHub CLI\u2026</div>`);
      else if (github.via === "none") parts.push(`<div class="repo-pick-h">On GitHub</div><div class="repo-pick-empty">Sign in with the GitHub CLI (<code>gh auth login</code>) or save a GitHub token to list your repositories here.</div>`);
      else {
        parts.push(`<div class="repo-pick-h">On GitHub${github.via === "gh" ? " (GitHub CLI sign-in)" : ""}<button type="button" class="repo-pick-refresh" data-repo-refresh title="Fetch the list again">${icon("refresh", 11)}</button></div>`);
        if (github.error) parts.push(`<div class="repo-pick-empty bad">${esc(github.error)}</div>`);
        else if (!g.length) parts.push(`<div class="repo-pick-empty">${needle ? "No GitHub match" : "Every GitHub repository you have is already on this machine"}</div>`);
        else g.forEach((c, i) => parts.push(githubRow(c, l.length + i, picked === `gh:${c.slug.toLowerCase()}`)));
      }
    }
    list.innerHTML = parts.join("");
  };

  /** Run the given sources now. Nothing here blocks the form: its Spawn button never looks at a search. */
  const find = (sources: FindSource[], refresh: boolean): void => {
    if (!sources.length) return;
    for (const s of sources) { asked[s] = true; gen[s]++; }
    if (sources.includes("local")) local = null;
    if (sources.includes("github")) github = null;
    list.hidden = false;
    search.hidden = false;
    paint();
    const { local: tl, github: tg } = gen;
    runFind(deps, sources, {
      local: (r) => { if (tl !== gen.local) return; local = r ?? []; paint(); },
      github: (r) => { if (tg !== gen.github) return; github = r ?? { repos: [], via: "gh", error: "The engine did not answer." }; paint(); },
    }, refresh);
  };

  for (const cb of Array.from(box.querySelectorAll<HTMLInputElement>("[data-repo-find]"))) {
    const s = cb.dataset.repoFind;
    if (s !== "local" && s !== "github") continue;
    cb.checked = checks[s];
    cb.addEventListener("change", () => {
      checks = { ...checks, [s]: cb.checked };
      try { localStorage.setItem(REPO_FIND_KEY, JSON.stringify(checks)); } catch { /* degrade to per-form state */ }
      go.disabled = sourcesToRun(checks).length === 0;
    });
  }
  go.disabled = sourcesToRun(checks).length === 0;
  go.addEventListener("click", () => find(sourcesToRun(checks), false));

  q.addEventListener("input", paint);
  list.addEventListener("click", (e) => {
    const t = e.target instanceof HTMLElement ? e.target : null;
    if (t?.closest("[data-repo-refresh]")) { find(["github"], true); return; }
    const btn = t?.closest<HTMLElement>("[data-pick-i]");
    const row = btn ? rows[Number(btn.dataset.pickI)] : undefined;
    if (!row) return;
    if (row.kind === "local") { picked = norm(row.c.path); onPick({ kind: "local", path: row.c.path, name: row.c.name }); }
    else { picked = `gh:${row.c.slug.toLowerCase()}`; onPick({ kind: "github", cloneUrl: row.c.cloneUrl, slug: row.c.slug, name: row.c.name, via: github?.via === "token" ? "token" : "gh" }); }
    paint();
  });
}
