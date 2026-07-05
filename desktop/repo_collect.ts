// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/repo_collect.ts
//
// P-REPORT.9 (ADR-0162): the desktop-side collector behind the Reports panel's multi-repo option. It
// resolves the candidate repos (current workspace + recents + report-only tracked repos), lets the user
// add new ones (local path or clone URL), and - for the repos the user ticks - FETCHES each remote
// READ-ONLY (git fetch: never a pull/merge, so no working-tree mutation), enumerates recent commits across
// branches, and (opt-in, GitHub only, when `gh` is authed) lists pull requests via the GitHub CLI.
//
// This is a FIRST-PARTY control-plane action, exactly like desktop/workspace.ts cloneRepo: server-side
// Bun.spawn of git/gh behind the loopback + token gate (dev.ts), NOT routed through the agent tool
// security gate. It hands raw output to the PURE harness/brief/repo_activity.ts parser/renderer.

import { existsSync } from "node:fs";
import { load, save } from "./settings_store.ts";
import { cloneRepo, currentWorkspace, isGitRepo, wsName } from "./workspace.ts";
import { buildRepoActivity, parseRemoteUrl, type PrStatus, type RemoteRef, type RepoActivity, type RepoRaw } from "../harness/brief/repo_activity.ts";
import { emitSecurityEvent, type SecurityEventInput } from "./audit_export.ts";

export interface ReportRepo { path: string; name: string; isGit: boolean; remoteUrl: string; host: string; isGitHub: boolean; lastActive: number }
export interface CollectOptions { fetch: boolean; prs: boolean; window: number }
export interface RepoSelection { path: string; fetch?: boolean; prs?: boolean }

const MAX_BRANCHES = 8; // per repo, most-recently-committed first (keeps a busy monorepo bounded)
const FETCH_TIMEOUT_MS = 25_000; // network op - generous but bounded, per repo
const GIT_TIMEOUT_MS = 8_000; // local read ops

// ASYNC git runner. Generate collects across several repos (fetch + branch enum + logs + diff); a
// blocking spawnSync per call froze the whole Bun.serve event loop for the duration (the app stalled
// while a report generated). Non-blocking spawn keeps the server responsive; timeout-bounded via kill().
async function gitOut(repo: string, args: string[], timeoutMs = GIT_TIMEOUT_MS): Promise<{ ok: boolean; out: string; err: string }> {
  try {
    const p = Bun.spawn(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => { try { p.kill(); } catch { /* already exited */ } }, timeoutMs);
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    clearTimeout(timer);
    return { ok: code === 0, out, err };
  } catch (e) { return { ok: false, out: "", err: String((e as Error)?.message ?? e).slice(0, 200) }; }
}

/** origin remote URL (empty when there's no remote). Async so the picker can resolve every repo's
 *  remote CONCURRENTLY - a sequential spawn-per-repo was ~1s each over OneDrive-synced dirs, so the
 *  picker took 10-15s to appear with a dozen repos. Timeout-bounded like the sync gitOut. */
async function remoteUrlAsync(repo: string): Promise<string> {
  try {
    const p = Bun.spawn(["git", "remote", "get-url", "origin"], { cwd: repo, stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => { try { p.kill(); } catch { /* already exited */ } }, GIT_TIMEOUT_MS);
    const code = await p.exited;
    clearTimeout(timer);
    return code === 0 ? (await new Response(p.stdout).text()).trim() : "";
  } catch { return ""; }
}

// ── report-target repos (union of workspace ∪ recents ∪ the report-only list) ────────────────────────
/** The de-duplicated, still-existing set of repos the user can include in a report. `reportRepos` are
 *  tracked for reporting WITHOUT being opened as the active workspace (so listing one never restarts omp). */
export function reportRepoPaths(): string[] {
  const s = load();
  const all = [currentWorkspace(), ...(s.recentWorkspaces ?? []), ...(s.reportRepos ?? [])];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of all) {
    const k = p.replace(/[\\/]+$/, "");
    if (!k || seen.has(k) || !existsSync(p)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}

export async function listReportRepos(): Promise<ReportRepo[]> {
  return Promise.all(reportRepoPaths().map(async (path) => {
    const git = isGitRepo(path);
    // remote URL + last-commit time (epoch secs, for the "most recently active" sort) — concurrent.
    const [url, lastActive] = git
      ? await Promise.all([remoteUrlAsync(path), lastCommitEpoch(path)])
      : ["", 0];
    const ref = parseRemoteUrl(url);
    return { path, name: wsName(path), isGit: git, remoteUrl: url, host: ref.host, isGitHub: ref.isGitHub, lastActive };
  }));
}

/** Unix time (secs) of the repo's most recent commit on any branch; 0 if unknown. Feeds the "Recent" sort. */
async function lastCommitEpoch(repo: string): Promise<number> {
  const r = await gitOut(repo, ["for-each-ref", "--sort=-committerdate", "--count=1", "--format=%(committerdate:unix)", "refs/heads", "refs/remotes"]);
  const n = Number(r.out.trim());
  return Number.isFinite(n) ? n : 0;
}

// ── gh auth availability (cached 60s; a spawn per poll would be wasteful) ─────────────────────────────
// ASYNC so the request handler never blocks the Bun.serve event loop on the gh spawn (a blocking
// spawnSync here starved /api/report/repos behind the boot-time poll storm and the picker hung).
let ghCache: { at: number; ok: boolean } | null = null;
export async function ghAvailable(): Promise<boolean> {
  const now = Date.now();
  if (ghCache && now - ghCache.at < 60_000) return ghCache.ok;
  let ok = false;
  try {
    const p = Bun.spawn(["gh", "auth", "status"], { stdout: "ignore", stderr: "ignore" });
    const timer = setTimeout(() => { try { p.kill(); } catch { /* already exited */ } }, 6_000);
    ok = (await p.exited) === 0;
    clearTimeout(timer);
  } catch { ok = false; }
  ghCache = { at: now, ok };
  return ok;
}

// ── add a report-target repo (local path, or clone a URL) - persisted, workspace UNCHANGED ────────────
export async function addReportRepo(input: { path?: string; url?: string }): Promise<{ ok: boolean; error?: string }> {
  const url = String(input.url ?? "").trim();
  const path = String(input.path ?? "").trim();
  let target = "";
  if (url) {
    const r = await cloneRepo(url); // reuses ~/.omp/lucid-workspaces + git clone (already a first-party op)
    if (!r.ok || !r.path) return { ok: false, error: r.error || "clone failed" };
    target = r.path;
  } else if (path) {
    if (!existsSync(path)) return { ok: false, error: "That path does not exist." };
    if (!isGitRepo(path)) return { ok: false, error: "That folder is not a git repository." };
    target = path;
  } else {
    return { ok: false, error: "Enter a local repo path or a clone URL." };
  }
  const s = load();
  const norm = target.replace(/[\\/]+$/, "");
  s.reportRepos = [target, ...(s.reportRepos ?? []).filter((p) => p.replace(/[\\/]+$/, "") !== norm)].slice(0, 20);
  save(s);
  return { ok: true };
}

// ── the read-only collection itself ──────────────────────────────────────────────────────────────────
async function branchCommits(repo: string, window: number): Promise<RepoRaw["branchLogs"]> {
  // Most-recently-committed branches first (local heads + origin remotes), capped. `%(refname:short)`
  // gives `main` / `origin/feature-x`; we tag the remote ones and de-dup a head vs its own origin/<head>.
  const ref = await gitOut(repo, ["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads", "refs/remotes/origin"]);
  // Drop the remote's HEAD symref — its short name is a bare `origin` (or `…/HEAD`), a duplicate of the
  // default branch, not a real branch of its own.
  const names = ref.ok ? ref.out.split("\n").map((s) => s.trim()).filter(Boolean).filter((n) => n !== "origin" && !n.endsWith("/HEAD")) : [];
  const picked: { name: string; remote: boolean }[] = [];
  const seenLocal = new Set<string>();
  for (const name of names) {
    if (picked.length >= MAX_BRANCHES) break;
    const remote = name.startsWith("origin/");
    const shortName = remote ? name.slice("origin/".length) : name;
    if (remote && seenLocal.has(shortName)) continue; // a local head already covers this branch
    if (!remote) seenLocal.add(shortName);
    picked.push({ name, remote });
  }
  // Fetch each branch's log concurrently (non-blocking) — much faster than serial over slow storage.
  const logs = await Promise.all(picked.map(async ({ name, remote }) => {
    const lg = await gitOut(repo, ["log", "-n", String(Math.max(1, window)), "--pretty=format:%h%x1f%an%x1f%ad%x1f%s", "--date=short", name, "--"]);
    return lg.ok && lg.out.trim() ? { branch: name, remote, log: lg.out } : null;
  }));
  return logs.filter(Boolean) as RepoRaw["branchLogs"];
}

async function windowDiff(repo: string, window: number): Promise<{ numstat: string; nameStatus: string }> {
  const cnt = Number((await gitOut(repo, ["rev-list", "--count", "HEAD"])).out.trim());
  const range = Number.isFinite(cnt) && cnt > 1 ? [`HEAD~${Math.min(window, cnt - 1)}..HEAD`] : [];
  const [ns, nst] = await Promise.all([gitOut(repo, ["diff", "--numstat", ...range]), gitOut(repo, ["diff", "--name-status", ...range])]);
  return { numstat: ns.out, nameStatus: nst.out };
}

/** Run `gh` non-blocking (async), timeout-bounded like gitOut. */
async function ghOut(repo: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    const p = Bun.spawn(["gh", ...args], { cwd: repo, stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => { try { p.kill(); } catch { /* already exited */ } }, FETCH_TIMEOUT_MS);
    const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
    clearTimeout(timer);
    return { ok: code === 0, out };
  } catch { return { ok: false, out: "" }; }
}

async function collectPrs(repo: string, isGitHub: boolean, wantPrs: boolean): Promise<{ prJson?: string; prStatus: PrStatus }> {
  if (!wantPrs) return { prStatus: "skipped-off" };
  if (!isGitHub) return { prStatus: "skipped-nonhub" };
  if (!(await ghAvailable())) return { prStatus: "skipped-unauthed" };
  // Open PRs + a handful of the most-recently-updated merged ones. `-R <repo dir>` isn't a gh flag, so we
  // run gh with cwd = the repo (it reads the origin remote itself). Fail-soft → prStatus "error".
  const fields = "number,title,author,state,url,updatedAt";
  const [open, merged] = await Promise.all([
    ghOut(repo, ["pr", "list", "--state", "open", "--limit", "20", "--json", fields]),
    ghOut(repo, ["pr", "list", "--state", "merged", "--limit", "10", "--json", fields]),
  ]);
  if (!open.ok) return { prStatus: "error" };
  let arr: unknown[] = [];
  try { arr = JSON.parse(open.out || "[]"); } catch { arr = []; }
  if (merged.ok) { try { arr = arr.concat(JSON.parse(merged.out || "[]")); } catch { /* keep open-only */ } }
  return { prJson: JSON.stringify(arr), prStatus: "ok" };
}

// ── P-REPORT.10 (ADR-0164): audit every first-party network reach-out ─────────────────────────────────
// The report collector reaches out to the network on the user's behalf (git fetch of a remote; gh PR
// list) as a FIRST-PARTY control-plane action - deliberately NOT routed through the agent tool security
// gate (see the file header). That left those reach-outs invisible to the audit trail. Each ACTUAL
// reach-out now emits a canonical desktop SecurityEvent (audit_export.ts / ADR-0069) into the same
// OCSF/SIEM stream as gate decisions: category "egress", decision "allow" (a permitted first-party op),
// severity "info". Metadata ONLY - the reason carries the remote HOST (credential-free; parseRemoteUrl
// strips any user:token@ userinfo), never the raw URL. Reuses the existing SecurityEvent seam, so it adds
// NO contracts.ts EventName values (invariant #8), matching the P-SANDBOX.1 precedent.
//
// PURE + total: given what the collector already knows after a reach-out (was a fetch attempted, did it
// succeed, and the PR-list outcome), it returns the 0-2 events to emit. A SKIPPED PR list (non-GitHub /
// unauthed / off) performed NO reach-out, so it emits nothing - the audit reflects reality.
export interface ReachoutOutcome { fetched: boolean; fetchOk: boolean; prStatus: PrStatus }
export function reachoutAuditEvents(ref: RemoteRef, o: ReachoutOutcome): SecurityEventInput[] {
  const events: SecurityEventInput[] = [];
  if (o.fetched) {
    const target = ref.host || "(local/unparsed remote)";
    events.push({ category: "egress", type: "report_fetch", decision: "allow", severity: "info", tool: "git", reason: `report: git fetch ${target} (${o.fetchOk ? "ok" : "failed"})` });
  }
  // A gh PR list only reaches out when it actually ran: "ok" = succeeded, "error" = ran-but-failed. The
  // skipped-* statuses never spawned gh (no egress), so they emit nothing.
  if (o.prStatus === "ok" || o.prStatus === "error") {
    events.push({ category: "egress", type: "report_pr_list", decision: "allow", severity: "info", tool: "gh", reason: `report: gh pr list ${ref.host || "github.com"} (${o.prStatus === "ok" ? "ok" : "failed"})` });
  }
  return events;
}

/** Collect (read-only) activity for each selected repo. Fail-soft per repo: a fetch failure still yields
 *  local history (flagged); a bad repo contributes an empty-but-labeled entry rather than throwing.
 *  `emit` (default the real SecurityEvent dispatcher) audits each network reach-out; injectable for tests. */
export async function collectRepoActivity(sel: RepoSelection[], opts: CollectOptions, emit: (e: SecurityEventInput) => void = emitSecurityEvent): Promise<RepoActivity[]> {
  const window = Math.min(50, Math.max(1, opts.window || 10));
  const out: RepoActivity[] = [];
  for (const s of sel) {
    const repo = s.path;
    const label = wsName(repo);
    if (!existsSync(repo) || !isGitRepo(repo)) {
      out.push(buildRepoActivity({ label, path: repo, remoteUrl: "", fetchOk: false, fetchReason: "not a git repository", branchLogs: [], numstat: "", nameStatus: "", prStatus: "skipped-off" }));
      continue;
    }
    const url = await remoteUrlAsync(repo);
    const ref = parseRemoteUrl(url);
    // 1) read-only fetch (opt-in, and only when there IS a remote)
    let fetchOk = true, fetchReason: string | undefined;
    const wantFetch = (s.fetch ?? opts.fetch) && !!url;
    if (wantFetch) {
      const f = await gitOut(repo, ["fetch", "--prune", "--no-tags", "origin"], FETCH_TIMEOUT_MS);
      fetchOk = f.ok;
      if (!f.ok) fetchReason = (f.err.trim().split("\n").pop() || "git fetch failed").slice(0, 160);
    } else if (!url) {
      fetchOk = false; fetchReason = "no remote configured";
    }
    // 2) branches + commits + diff totals (concurrent, non-blocking)
    const [branchLogs, { numstat, nameStatus }] = await Promise.all([branchCommits(repo, window), windowDiff(repo, window)]);
    // 3) pull requests (opt-in, GitHub + gh-authed)
    const { prJson, prStatus } = await collectPrs(repo, ref.isGitHub, s.prs ?? opts.prs);
    // P-REPORT.10 (ADR-0164): audit the actual network reach-outs this repo triggered (fetch / gh PR list).
    for (const ev of reachoutAuditEvents(ref, { fetched: wantFetch, fetchOk, prStatus })) emit(ev);
    out.push(buildRepoActivity({ label, path: repo, remoteUrl: url, fetchOk, fetchReason, branchLogs, numstat, nameStatus, prJson, prStatus }));
  }
  return out;
}
