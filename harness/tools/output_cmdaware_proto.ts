// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/tools/output_cmdaware_proto.ts
//
// ┌──────────────────────────────────────────────────────────────────────────┐
// │  PROTOTYPE — pre-increment, pre-ADR. NOT wired into result_adapter.ts.     │
// │  Purpose: MEASURE whether COMMAND-AWARE filtering reaches rtk's headline    │
// │  numbers (~80% on `git status`, ~90% on test runners) on REAL output.      │
// └──────────────────────────────────────────────────────────────────────────┘
//
// Unlike the generic ANSI+dedup passes (output_minify_proto.ts), these know the
// SHAPE of one specific command's output. That is exactly why rtk ships a Rust
// parser per runner instead of one regex: command-aware filters can drop whole
// classes of noise (git hint lines, per-test PASS lines) and restructure the
// rest (group files by dir, cap untracked) — the source of the big savings.
//
// Safety stance carried from the generic prototype:
//   • PURE + total (no I/O, never throws). Parsing the human output, not spawning.
//   • filterTestFailuresOnly is KEEP-BY-DEFAULT: it drops only lines it POSITIVELY
//     recognizes as pass-noise. Anything unrecognized (failures, errors, stack
//     traces, summaries) is always kept — a filter bug loses noise, never signal.
//   • Capping in filterGitStatus always emits a "+N more" marker so a downstream
//     recovery path (artifact:// in the real layer) can restore the full list.

// ---------------------------------------------------------------------------
// git status  (long "human" format) -> compact, dir-grouped
// ---------------------------------------------------------------------------

interface GitEntry {
  status: string; // single-letter: M A D R C T U ?
  path: string;
}

const STATUS_WORD =
  /^\t(new file|modified|deleted|renamed|copied|typechange|both modified|both added|added by them|added by us|deleted by them|deleted by us):\s+(.*)$/;

function shortStatus(word: string): string {
  switch (word) {
    case "new file":
      return "A";
    case "modified":
      return "M";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "copied":
      return "C";
    case "typechange":
      return "T";
    default:
      return "U"; // any of the merge-conflict variants
  }
}

/** "Your branch is ahead of 'origin/x' by 2 commits." -> "ahead:2"; up-to-date -> "". */
function compactTrack(line: string): string {
  const ahead = line.match(/ahead of .* by (\d+)/);
  const behind = line.match(/behind .* by (\d+)/);
  const diverged = line.match(/have (\d+) and (\d+) different/);
  if (diverged) return `ahead:${diverged[1]} behind:${diverged[2]}`;
  if (ahead) return `ahead:${ahead[1]}`;
  if (behind) return `behind:${behind[1]}`;
  return ""; // "up to date" is pure noise
}

function dirOf(path: string): string {
  // renamed entries look like "old -> new"; group by the destination.
  const p = path.includes(" -> ") ? path.slice(path.indexOf(" -> ") + 4) : path;
  const slash = p.lastIndexOf("/");
  return slash === -1 ? "." : p.slice(0, slash);
}

function baseOf(path: string): string {
  const p = path.includes(" -> ") ? path.slice(path.indexOf(" -> ") + 4) : path;
  const slash = p.lastIndexOf("/");
  return slash === -1 ? p : p.slice(slash + 1);
}

/** Group changed entries by directory and render `  <dir>/: M a.ts, A b.ts (+K)`. */
function renderGrouped(out: string[], entries: GitEntry[], perGroupCap: number): void {
  const byDir = new Map<string, GitEntry[]>();
  for (const e of entries) {
    const d = dirOf(e.path);
    const g = byDir.get(d);
    if (g) g.push(e);
    else byDir.set(d, [e]);
  }
  for (const [dir, es] of byDir) {
    const shown = es.slice(0, perGroupCap).map((e) => `${e.status} ${baseOf(e.path)}`);
    const extra = es.length - shown.length;
    out.push(`  ${dir}/: ${shown.join(", ")}${extra > 0 ? ` (+${extra} more)` : ""}`);
  }
}

export interface GitStatusOptions {
  /** Max files listed per directory group before "+N more". Default 12. */
  perGroupCap?: number;
  /** Max directories summarized for untracked before "+N dirs". Default 20. */
  untrackedDirCap?: number;
}

/** Parse `git status` long output; emit a compact, directory-grouped view.
 *  Drops branch-tracking chatter, `(use "git …")` hints, and section boilerplate. */
export function filterGitStatus(raw: string, opts?: GitStatusOptions): string {
  const perGroupCap = opts?.perGroupCap ?? 12;
  const untrackedDirCap = opts?.untrackedDirCap ?? 20;
  const lines = raw.replace(/\r\n/g, "\n").split("\n");

  let branch = "";
  let track = "";
  const staged: GitEntry[] = [];
  const unstaged: GitEntry[] = [];
  const untracked: string[] = [];
  let section: "staged" | "unstaged" | "untracked" | "" = "";

  for (const line of lines) {
    if (line.startsWith("On branch ")) {
      branch = line.slice(10).trim();
      continue;
    }
    if (line.startsWith("HEAD detached")) {
      branch = line.trim();
      continue;
    }
    if (line.startsWith("Your branch")) {
      track = compactTrack(line);
      continue;
    }
    if (line.startsWith("Changes to be committed")) {
      section = "staged";
      continue;
    }
    if (line.startsWith("Changes not staged") || line.startsWith("Unmerged paths")) {
      section = "unstaged";
      continue;
    }
    if (line.startsWith("Untracked files")) {
      section = "untracked";
      continue;
    }
    if (line.startsWith("Ignored files")) {
      section = "";
      continue;
    }
    if (line.trimStart().startsWith("(use ")) continue; // hint line
    if (
      line.startsWith("no changes added") ||
      line.startsWith("nothing to commit") ||
      line.startsWith("nothing added")
    )
      continue;

    const m = line.match(STATUS_WORD);
    if (m && (section === "staged" || section === "unstaged")) {
      const entry = { status: shortStatus(m[1]), path: m[2].trim() };
      (section === "staged" ? staged : unstaged).push(entry);
      continue;
    }
    if (section === "untracked" && line.startsWith("\t")) {
      untracked.push(line.trim());
    }
  }

  const out: string[] = [];
  out.push(track ? `${branch} ${track}` : branch);
  if (staged.length) {
    out.push(`staged (${staged.length}):`);
    renderGrouped(out, staged, perGroupCap);
  }
  if (unstaged.length) {
    out.push(`unstaged (${unstaged.length}):`);
    renderGrouped(out, unstaged, perGroupCap);
  }
  if (untracked.length) {
    const byDir = new Map<string, number>();
    for (const p of untracked) byDir.set(dirOf(p), (byDir.get(dirOf(p)) ?? 0) + 1);
    const dirs = [...byDir.entries()].slice(0, untrackedDirCap).map(([d, n]) => `${d}/(${n})`);
    const extraDirs = byDir.size - dirs.length;
    out.push(
      `untracked (${untracked.length}): ${dirs.join(" ")}${extraDirs > 0 ? ` (+${extraDirs} dirs)` : ""}`,
    );
  }
  return out.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// test runner -> keep only failures + summary
// ---------------------------------------------------------------------------

// Positively-recognized PASS-noise across common runners. Case-sensitive on
// purpose: per-test markers (bun "(pass)", cargo "… ok", pytest "PASSED") differ
// from summary lines ("13 pass", "test result: ok", "5 passed") so summaries survive.
const PASS_PATTERNS: RegExp[] = [
  /^\s*\(pass\)/, // bun test
  /^\s*test\b.+\.\.\.\s*ok\s*$/, // cargo / rust libtest
  /\bPASSED\b/, // pytest -v, others
  /^\s*(?:✓|✔|√)\s/, // jest / vitest / mocha
  /^\s*ok\s+\d+\b/, // TAP
];

export interface TestFilterResult {
  text: string;
  hiddenPass: number;
}

/** Drop recognized per-test PASS lines; keep failures, errors, and summaries.
 *  Keep-by-default: unrecognized lines are always retained. */
export function filterTestFailuresOnly(raw: string): TestFilterResult {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let hidden = 0;
  for (const line of lines) {
    if (PASS_PATTERNS.some((re) => re.test(line))) {
      hidden++;
      continue;
    }
    out.push(line);
  }
  return { text: out.join("\n"), hiddenPass: hidden };
}

// ---------------------------------------------------------------------------
// logs  (docker/kubectl logs, journalctl, app logs) -> normalize-then-dedup
// ---------------------------------------------------------------------------
//
// Why this is NOT the generic dedup from output_minify_proto.ts: real log lines
// carry a per-line timestamp (and often a latency), so consecutive lines are
// NEVER byte-identical and exact-match dedup collapses nothing. Here we compute a
// NORMALIZED key per line (mask the volatile tokens), group consecutive lines by
// that key, and emit the FIRST CONCRETE line (real timestamp intact, nothing
// fabricated) + a " (xN)" count. Order-preserving; unique messages are kept.

// All linear-time (character classes, bounded quantifiers, no overlapping repeats).
const RE_ISO = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g;
const RE_CLOCK = /\b\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/g;
const RE_DUR = /[<>=~]?\b\d+(?:\.\d+)?\s?(?:ms|s|us|ns)\b/g;

/** Mask a line's volatile tokens so "same event, different timestamp/latency"
 *  lines share a key. `aggressive` also masks every digit-run (groups e.g.
 *  `/user/1` with `/user/2`) — higher savings, but loses per-id distinction. */
function normalizeKey(line: string, aggressive: boolean): string {
  let k = line.replace(/\r$/, "").replace(RE_ISO, "<ts>").replace(RE_CLOCK, "<t>").replace(RE_DUR, "<dur>");
  if (aggressive) k = k.replace(/\d+/g, "#");
  return k;
}

export interface LogDedupOptions {
  /** Minimum run length before collapsing. Default 2. */
  min?: number;
  /** Also mask all digit-runs when grouping. Default false (conservative). */
  aggressiveNumbers?: boolean;
}

/** Collapse consecutive lines that are identical AFTER volatile-token masking.
 *  Emits the first concrete line of each run + " (xN)". Order-preserving. */
export function filterLogDedup(raw: string, opts?: LogDedupOptions): DedupLike {
  const min = opts?.min ?? 2;
  const aggressive = opts?.aggressiveNumbers ?? false;
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let removed = 0;
  let i = 0;
  while (i < lines.length) {
    const key = normalizeKey(lines[i], aggressive);
    let j = i + 1;
    while (j < lines.length && normalizeKey(lines[j], aggressive) === key) j++;
    const run = j - i;
    const first = lines[i].replace(/\r$/, "");
    if (run >= min) {
      out.push(`${first} (x${run})`);
      removed += run - 1;
    } else {
      out.push(first);
    }
    i = j;
  }
  return { text: out.join("\n"), linesRemoved: removed };
}

export interface DedupLike {
  text: string;
  linesRemoved: number;
}
