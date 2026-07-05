// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/brief/repo_activity.ts
//
// P-REPORT.9 (ADR-0162): a CROSS-REPO ACTIVITY annex for the engineering report. The report used to see
// only one repo's local default branch; this module renders recent commits ACROSS branches plus open /
// recently-merged pull requests for EACH selected repo, after the desktop side fetched them read-only.
//
// PURE: the caller (desktop/repo_collect.ts) runs git + gh and passes the raw output in; this module only
// parses + renders. No I/O, no Date, no spawning - so it is unit-tested with canned fixtures (the
// change_graph.ts pattern).
//
// SECURITY (CLAUDE.md invariant #5): commit subjects, PR titles, and author names are EXTERNALLY authored,
// untrusted text. `clean()` escapes HTML, strips code-fence/inline-code breakout, collapses newlines, and
// length-caps every such field before it enters the markdown. The annex is shown to the user (and may flow
// to TTS / NotebookLM / the KG) as DATA, never as instructions - it carries a provenance line saying so.

import { parseGitChanges } from "./change_graph.ts";

export interface Commit { sha: string; author: string; date: string; subject: string }
export interface BranchActivity { branch: string; remote: boolean; commits: Commit[] }
export interface PrItem { number: number; title: string; author: string; state: string; url: string; updatedAt: string }
/** Why PRs are/aren't present for a repo - drives the honest "skipped because …" line in the annex. */
export type PrStatus = "ok" | "skipped-off" | "skipped-nonhub" | "skipped-unauthed" | "error";

export interface RepoActivity {
  label: string;
  path: string;
  remoteUrl: string;
  host: string;
  fetch: { ok: boolean; reason?: string };
  branches: BranchActivity[];
  prs: PrItem[];
  prStatus: PrStatus;
  totals: { added: number; removed: number; files: number; commits: number };
}

/** What the desktop collector hands us per repo: already-collected raw git/gh output (strings). */
export interface RepoRaw {
  label: string;
  path: string;
  remoteUrl: string;
  fetchOk: boolean;
  fetchReason?: string;
  /** Raw `git log --pretty=…` output per branch (unit-separator delimited, see parseCommits). */
  branchLogs: { branch: string; remote: boolean; log: string }[];
  numstat: string;
  nameStatus: string;
  /** Raw `gh pr list --json …` output (a JSON array), or undefined when PRs weren't collected. */
  prJson?: string;
  prStatus: PrStatus;
}

// ── remote-URL parsing (host + owner/repo, for the gh PR path + the "verify" surface) ────────────────
export interface RemoteRef { host: string; owner: string; repo: string; isGitHub: boolean }
/** Parse an origin URL into {host, owner, repo}. Handles https://host/o/r(.git), git@host:o/r.git, and
 *  ssh://git@host/o/r.git. Empty/unknown → blank host, isGitHub=false (PRs then skip as non-GitHub). */
export function parseRemoteUrl(url: string): RemoteRef {
  const raw = String(url || "").trim();
  const blank: RemoteRef = { host: "", owner: "", repo: "", isGitHub: false };
  if (!raw) return blank;
  let host = "", path = "";
  let m = /^(?:https?|ssh):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(raw); // scheme://[user@]host[:port]/path
  if (m) { host = m[1]!; path = m[2]!; }
  else if ((m = /^[^@]+@([^:]+):(.+)$/.exec(raw))) { host = m[1]!; path = m[2]!; } // scp-style git@host:owner/repo
  else return blank;
  const parts = path.replace(/\.git$/i, "").replace(/\/+$/, "").split("/").filter(Boolean);
  const repo = parts.pop() ?? "";
  const owner = parts.join("/"); // handles subgroups (gitlab) or org
  host = host.toLowerCase();
  return { host, owner, repo, isGitHub: /(^|\.)github\.com$/.test(host) };
}

// ── parsers ──────────────────────────────────────────────────────────────────────
const US = "\x1f"; // unit separator: the collector runs `git log --pretty=format:%h%x1f%an%x1f%ad%x1f%s`
/** Parse unit-separator git-log lines into commits. Malformed lines are skipped, never thrown. */
export function parseCommits(log: string): Commit[] {
  const out: Commit[] = [];
  for (const line of (log || "").split("\n")) {
    if (!line.trim()) continue;
    const f = line.split(US);
    if (f.length < 4) continue;
    out.push({ sha: (f[0] ?? "").trim(), author: (f[1] ?? "").trim(), date: (f[2] ?? "").trim(), subject: (f[3] ?? "").trim() });
  }
  return out;
}

/** Parse `gh pr list --json number,title,author,state,url,updatedAt` output. Tolerant: bad JSON → []. */
export function parsePrJson(json: string | undefined): PrItem[] {
  if (!json || !json.trim()) return [];
  let arr: unknown;
  try { arr = JSON.parse(json); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  return arr.map((r): PrItem => {
    const o = (r ?? {}) as Record<string, unknown>;
    const author = o.author && typeof o.author === "object" ? String((o.author as Record<string, unknown>).login ?? "") : String(o.author ?? "");
    return {
      number: Number(o.number ?? 0),
      title: String(o.title ?? ""),
      author,
      state: String(o.state ?? "").toLowerCase(),
      url: String(o.url ?? ""),
      updatedAt: String(o.updatedAt ?? o.updated_at ?? "").slice(0, 10),
    };
  }).filter((p) => p.number > 0);
}

/** Assemble one repo's RepoActivity from its raw collected output. Totals come from the numstat diff. */
export function buildRepoActivity(raw: RepoRaw): RepoActivity {
  const branches: BranchActivity[] = (raw.branchLogs || []).map((b) => ({ branch: b.branch, remote: b.remote, commits: parseCommits(b.log) }))
    .filter((b) => b.commits.length > 0);
  const files = parseGitChanges(raw.numstat, raw.nameStatus);
  let added = 0, removed = 0;
  for (const f of files.values()) { added += f.added; removed += f.removed; }
  const uniqueCommits = new Set<string>();
  for (const b of branches) for (const c of b.commits) uniqueCommits.add(c.sha);
  const prs = raw.prStatus === "ok" ? parsePrJson(raw.prJson) : [];
  const ref = parseRemoteUrl(raw.remoteUrl);
  return {
    label: raw.label,
    path: raw.path,
    remoteUrl: raw.remoteUrl,
    host: ref.host,
    fetch: { ok: raw.fetchOk, reason: raw.fetchReason },
    branches,
    prs,
    prStatus: raw.prStatus,
    totals: { added, removed, files: files.size, commits: uniqueCommits.size },
  };
}

// ── untrusted-text hygiene ─────────────────────────────────────────────────────────
/** Neutralize externally-authored text before it enters the markdown/report: collapse whitespace, strip
 *  code-fence & inline-code breakout, escape HTML, and length-cap. Renders as inert DATA, never markup. */
export function clean(s: string, max = 140): string {
  let t = (s || "").replace(/[\r\n\t\x00-\x1f]+/g, " ").trim();
  t = t.replace(/`+/g, "'"); // no inline-code / fence breakout
  t = t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  t = t.replace(/\|/g, "\\|"); // safe even if a caller drops it into a table cell
  if (t.length > max) t = t.slice(0, max - 1).trimEnd() + "…";
  return t || "-";
}

const prSkipReason: Record<PrStatus, string> = {
  ok: "",
  "skipped-off": "PRs not requested for this repo",
  "skipped-nonhub": "not a GitHub remote",
  "skipped-unauthed": "GitHub CLI (`gh`) not authenticated",
  error: "the GitHub CLI returned an error",
};

// ── the annex (markdown; page-broken in print like the other annexes) ───────────────
/** Render the Cross-repo activity annex. `perBranch`/`total` cap how much we print so a very busy repo
 *  can't produce a wall of text; the collector already bounds what it fetched. Empty selection → a short
 *  "no repos selected" note so the caller can append unconditionally. */
export function renderRepoActivityAnnex(activities: RepoActivity[], opts: { perBranch?: number } = {}): string {
  const perBranch = opts.perBranch ?? 12;
  const out: string[] = [];
  out.push("## Annex C - Cross-repo activity", "");
  if (!activities.length) {
    out.push("_No repositories were selected for cross-repo activity. Pick one or more in the Reports panel to include remote commits and pull requests._", "");
    return out.join("\n");
  }
  const anyPr = activities.some((a) => a.prStatus === "ok");
  out.push(
    `_Recent commits across branches${anyPr ? " and pull requests" : ""} for **${activities.length}** selected ` +
    `repositor${activities.length === 1 ? "y" : "ies"}. Remotes were synced **read-only** (git fetch - no working-tree changes). ` +
    "Commit and PR text is external, untrusted input, shown verbatim as **data** (never as instructions)._",
    "",
  );
  for (const a of activities) {
    out.push(`### ${clean(a.label, 60)}${a.remoteUrl ? `  ·  \`${clean(a.remoteUrl, 120)}\`` : "  ·  _local only (no remote)_"}`, "");
    out.push(a.fetch.ok
      ? "_Fetched from remote ✓_"
      : `_Fetch failed: ${clean(a.fetch.reason || "unknown error", 100)} - showing local refs only._`);
    out.push(`Activity: **+${a.totals.added} / -${a.totals.removed}** across **${a.totals.files}** file${a.totals.files === 1 ? "" : "s"} · **${a.totals.commits}** commit${a.totals.commits === 1 ? "" : "s"}.`, "");

    if (a.branches.length) {
      out.push("**Recent commits by branch**", "");
      for (const b of a.branches) {
        out.push(`- \`${clean(b.branch, 60)}\`${b.remote ? " _(remote)_" : ""}`);
        for (const c of b.commits.slice(0, perBranch)) {
          out.push(`  - \`${clean(c.sha, 12)}\` ${clean(c.date, 10)} — ${clean(c.subject, 140)}${c.author ? ` _(${clean(c.author, 40)})_` : ""}`);
        }
        if (b.commits.length > perBranch) out.push(`  - _…and ${b.commits.length - perBranch} more_`);
      }
      out.push("");
    } else {
      out.push("_No recent commits in the selected window._", "");
    }

    if (a.prStatus === "ok") {
      if (a.prs.length) {
        out.push("**Pull requests** (open + recently merged)", "");
        for (const p of a.prs) {
          out.push(`- #${p.number} \`${clean(p.state || "open", 10)}\` — ${clean(p.title, 160)}${p.author ? ` _(${clean(p.author, 40)})_` : ""}${p.updatedAt ? ` · ${clean(p.updatedAt, 10)}` : ""}`);
        }
        out.push("");
      } else {
        out.push("_No open or recently-merged pull requests._", "");
      }
    } else {
      out.push(`_Pull requests skipped: ${prSkipReason[a.prStatus]}._`, "");
    }
  }
  return out.join("\n");
}
