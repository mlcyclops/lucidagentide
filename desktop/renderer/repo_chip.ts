// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/repo_chip.ts - P-REPO.1 (ADR-0406): the "which repo, and where do commits go" chip.
//
// One look everywhere a session is named: the titlebar (whatever the composer drives, Main or an attached
// spoke), the sidebar workspace bar, every lane card on the grid, every spoke on the orbit, the hub, and
// the spoke banner. The chip reads `repo · branch` then the push target (`GitHub owner/repo`), or says
// plainly that the work is local only. Clicking the titlebar chip opens the details with a link to the
// repo's web page. Wording comes from repo_identity.ts, so every surface says the same thing.

import { $ } from "./dom.ts";
import { esc } from "./format.ts";
import { icon } from "./icons.ts";
import { popover } from "./ui.ts";
import type { LucidBridge, RepoContext } from "./bridge.ts";
import { pushLabel, pushSlug, repoTooltip } from "../repo_identity.ts";
import { providerLabel } from "../git_url.ts";

/** How much a chip says. `full`: repo, branch, push target. `compact`: repo and branch (tight spots that
 *  already name the push target elsewhere, or the hub). `push`: branch and push target only, for cards
 *  whose title usually IS the repo name (a spoke named after its folder). The tooltip always says it all. */
export type RepoChipVariant = "full" | "compact" | "push";

/** The chip's inner HTML. */
export function repoChipHtml(ctx: RepoContext | undefined | null, variant: RepoChipVariant = "full"): string {
  const v = ctx?.repo;
  if (!v) {
    if (variant !== "full") return `${icon("folder", 12)}<span class="rc-local">not a git repo</span>`;
    const folder = ctx?.cwd ? ctx.cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || ctx.cwd : "no folder";
    return `${icon("folder", 12)}<span class="rc-name">${esc(folder)}</span>${ctx?.cwd ? `<span class="rc-local">no git</span>` : ""}`;
  }
  const at = v.branch || (v.head ? `@${v.head}` : "");
  const branch = at ? `<span class="rc-branch">${esc(at)}</span>` : "";
  const push = v.push
    ? `${icon("arrowRight", 11)}<span class="rc-slug">${esc(v.push.host ? (v.push.provider === "other" ? `${v.push.host} ${pushSlug(v.push)}` : pushSlug(v.push)) : v.push.remote)}</span>`
    : `<span class="rc-local">${v.remotes === 0 ? "local only" : "no push target"}</span>`;
  if (variant === "push") return `${icon("git", 12)}${branch}${push}`;
  return `${icon("git", 12)}<span class="rc-name">${esc(v.name)}</span>${branch}${variant === "compact" ? "" : push}`;
}

/** The tone class: `local` when commits cannot leave this machine, so the chip reads differently. */
export function repoChipTone(ctx: RepoContext | undefined | null): string {
  const v = ctx?.repo;
  if (!v) return "rc-none";
  return v.push ? "rc-remote" : "rc-local-only";
}

/** Paint a chip element in place (skips the DOM write when nothing changed, the grid polls often). */
export function paintRepoChip(node: HTMLElement, ctx: RepoContext | undefined | null, variant: RepoChipVariant = "full"): void {
  const html = repoChipHtml(ctx, variant);
  if (node.dataset.rcSig !== html) {
    node.innerHTML = html;
    node.dataset.rcSig = html;
    node.classList.remove("rc-none", "rc-remote", "rc-local-only");
    node.classList.add(repoChipTone(ctx));
  }
  // The app's premium tooltip (ui.ts initTooltips), never the OS `title` box: a title line naming the repo,
  // then one fact per line (#tip .d is pre-line).
  const tip = ctx ? repoTooltip(ctx) : { title: "Repository", body: "Checking the repository\u2026" };
  node.removeAttribute("title");
  node.setAttribute("data-tip", `${tip.title.replaceAll("|", "/")}|${tip.body}`);
  node.setAttribute("data-tip-icon", ctx && !ctx.repo ? "folder" : "git");
  node.hidden = false;
}

function detailHtml(ctx: RepoContext, subject: string): string {
  const v = ctx.repo;
  if (!v) {
    return `<div class="rc-pop"><div class="rc-pop-h">${icon("folder", 14)}<b>${esc(subject)} is not in a git repository</b></div>
      <div class="rc-pop-row"><span>Folder</span><code>${esc(ctx.cwd || "none")}</code></div>
      <p class="rc-pop-note">Nothing here is under version control, so there is nothing to commit or push.</p></div>`;
  }
  const push = v.push;
  const provider = push?.host ? (providerLabel(push.provider) === "Git" ? push.host : providerLabel(push.provider)) : "";
  return `<div class="rc-pop">
    <div class="rc-pop-h">${icon("git", 14)}<b>${esc(v.name)}</b>${v.worktree ? `<span class="rc-tag">worktree</span>` : ""}<span class="rc-tag">${esc(subject)}</span></div>
    <div class="rc-pop-row"><span>Folder</span><code>${esc(v.root)}</code></div>
    <div class="rc-pop-row"><span>Branch</span><code>${esc(v.branch || (v.head ? `detached at ${v.head}` : "no commits yet"))}</code></div>
    <div class="rc-pop-row"><span>Pushes to</span><b class="${push ? "" : "rc-warn"}">${esc(pushLabel(v))}</b></div>
    ${push?.host ? `<div class="rc-pop-row"><span>Remote</span><code>${esc(push.remote)} on ${esc(provider)}</code></div>` : ""}
    <p class="rc-pop-note">${ctx.source === "activity" ? "Known from the files this session changed or ran commands in." : "From the session's folder; it updates once the session changes a file."}${ctx.cwd && ctx.cwd !== v.root ? ` Session folder: ${esc(ctx.cwd)}.` : ""}</p>
    ${ctx.others.length ? `<div class="rc-pop-row"><span>Also changed</span><span>${ctx.others.map((o) => esc(o.name)).join(", ")}</span></div>` : ""}
    <div class="rc-pop-acts">
      ${push?.webUrl ? `<button class="btn-mini ok" data-rc-open="${esc(push.webUrl)}">${icon("link", 12)} Open ${esc(pushSlug(push))}</button>` : ""}
      <button class="btn-mini" data-rc-copy="${esc(v.root)}">${icon("copy", 12)} Copy folder path</button>
    </div>
  </div>`;
}

/** Open the details card for a chip. `subject` names whose repo this is ("Main", a spoke's name). */
export function openRepoDetails(anchor: HTMLElement, ctx: RepoContext, subject: string, openUrl: (url: string) => void): void {
  const p = popover(anchor, detailHtml(ctx, subject));
  p.node.addEventListener("click", (e) => {
    const t = e.target instanceof HTMLElement ? e.target : null;
    const open = t?.closest<HTMLElement>("[data-rc-open]");
    if (open?.dataset.rcOpen) { openUrl(open.dataset.rcOpen); p.close(); return; }
    const copy = t?.closest<HTMLElement>("[data-rc-copy]");
    if (copy?.dataset.rcCopy) { void navigator.clipboard.writeText(copy.dataset.rcCopy).catch(() => { /* clipboard denied: the path is on screen */ }); p.close(); }
  });
}

// ---------------------------------------------------------------------------------------- titlebar

export interface TitlebarRepoDeps {
  bridge: Pick<LucidBridge, "repoContext" | "fleetStatus">;
  /** The lane the composer drives, or null for Main. */
  getLaneTarget: () => { laneId: string; name: string } | null;
  openUrl: (url: string) => void;
  /** Main's repo, each time it is re-read (the sidebar workspace bar shows it too). */
  onMainContext: (ctx: RepoContext | null) => void;
}

const POLL_MS = 15_000;
let tbDeps: TitlebarRepoDeps | null = null;
let tbCtx: RepoContext | null = null;
let tbSeq = 0;

/** Wire the titlebar chip (#tbRepo) once. It follows the composer target and refreshes on its own. */
export function initTitlebarRepo(deps: TitlebarRepoDeps): void {
  tbDeps = deps;
  const btn = $("#tbRepo") as HTMLElement | null;
  btn?.addEventListener("click", () => {
    if (!tbCtx || !btn) return;
    const lane = deps.getLaneTarget();
    openRepoDetails(btn, tbCtx, lane ? `spoke ${lane.name}` : "Main", deps.openUrl);
  });
  void refreshTitlebarRepo();
  window.setInterval(() => { if (document.visibilityState === "visible") void refreshTitlebarRepo(); }, POLL_MS);
}

/** Re-read the repo for whatever the composer drives now (after a switch, a turn, a workspace change). */
export async function refreshTitlebarRepo(): Promise<void> {
  if (!tbDeps) return;
  const seq = ++tbSeq;
  const lane = tbDeps.getLaneTarget();
  let ctx: RepoContext | null = null;
  if (lane) {
    const s = await tbDeps.bridge.fleetStatus().catch(() => null);
    ctx = s?.lanes.find((l) => l.id === lane.laneId)?.repo ?? null;
  } else {
    ctx = await tbDeps.bridge.repoContext().catch(() => null);
  }
  if (seq !== tbSeq) return; // a newer refresh (the target switched) owns the chip
  tbCtx = ctx;
  if (!lane) tbDeps.onMainContext(ctx);
  const btn = $("#tbRepo") as HTMLElement | null;
  if (!btn) return;
  if (!ctx) { btn.hidden = true; return; }
  paintRepoChip(btn, ctx);
  btn.classList.toggle("rc-on-lane", !!lane);
}
