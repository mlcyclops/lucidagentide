// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/git_sweep.ts - P-OWN.1: the commit gate's pure half.
//
// PR #395 happened because `git add -A` does not care who wrote a file. When several sessions share
// a checkout, a sweeping stage/commit/stash from one agent silently carries the others' uncommitted
// edits along. The gate refuses exactly those commands (`git add -A|--all|.|-u|--update`,
// `git commit -a|--all|-am`, bare `git stash`/`stash push`/`stash save` without a pathspec) while the
// tree holds dirty files owned by SOMEONE ELSE, names the owner, and tells the agent to stage the
// explicit paths it owns.
//
// Two pure functions, no I/O: `gitSweeps` parses a bash command line the way the agent's bash tool
// receives it (compound commands, quotes, `git -C dir`, global `-c k=v` options) and lists the
// sweeping git calls it contains; `sweepDecision` combines that with the ownership picture from
// checkout_owners.ts. The parse is deliberately conservative and well-defined rather than a full
// shell: this gate is a coordination guard between cooperating sessions, not a trust boundary (the
// security gate stays authoritative), so a missed exotic spelling costs a collision, not a breach.

import type { Owner } from "./checkout_owners.ts";

export type SweepKind = "add-all" | "add-update" | "commit-all" | "stash-all";
export type GitSweep = { kind: SweepKind; text: string };

// Inside double quotes bash only honors a backslash before these; elsewhere `\P` stays two chars,
// which is what keeps a quoted Windows path like "C:\Program Files\Git\bin\git.exe" intact.
const DQ_ESCAPABLE: Record<string, true> = { $: true, "`": true, '"': true, "\\": true, "\n": true };

/** Split a bash command line into simple-command segments on unquoted `&&`, `||`, `|`, `;`, `&`,
 *  newlines, parentheses and backticks. Quotes and backslash escapes are honored so a `;` inside a
 *  commit message does not split. */
function splitSegments(command: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      cur += ch;
      if (ch === "\\" && quote === '"' && i + 1 < command.length && DQ_ESCAPABLE[command[i + 1]!]) { cur += command[++i]; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) { cur += ch + command[++i]; continue; }
    if (ch === "'" || ch === '"') { quote = ch; cur += ch; continue; }
    if (ch === "&" || ch === "|" || ch === ";" || ch === "\n" || ch === "(" || ch === ")" || ch === "`") {
      out.push(cur);
      cur = "";
      if ((ch === "&" || ch === "|") && command[i + 1] === ch) i++;
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Whitespace tokenizer that strips quotes and resolves backslash escapes. */
function tokenize(segment: string): string[] {
  const out: string[] = [];
  let cur = "";
  let has = false;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!;
    if (quote) {
      if (ch === quote) { quote = null; continue; }
      if (ch === "\\" && quote === '"' && i + 1 < segment.length && DQ_ESCAPABLE[segment[i + 1]!]) { cur += segment[++i]; continue; }
      cur += ch;
      continue;
    }
    if (ch === "\\" && i + 1 < segment.length) { cur += segment[++i]; has = true; continue; }
    if (ch === "'" || ch === '"') { quote = ch; has = true; continue; }
    if (ch === " " || ch === "\t" || ch === "\r") {
      if (has) { out.push(cur); cur = ""; has = false; }
      continue;
    }
    cur += ch;
    has = true;
  }
  if (has) out.push(cur);
  return out;
}

const GIT_GLOBAL_WITH_VALUE: Record<string, true> = {
  "-C": true, "-c": true, "--git-dir": true, "--work-tree": true, "--namespace": true, "--super-prefix": true, "--config-env": true,
};

const STASH_NON_SWEEP: Record<string, true> = {
  list: true, show: true, pop: true, apply: true, drop: true, clear: true, branch: true, create: true, store: true,
};

function isGitProgram(tok: string): boolean {
  const base = tok.slice(Math.max(tok.lastIndexOf("/"), tok.lastIndexOf("\\")) + 1).toLowerCase();
  return base === "git" || base === "git.exe";
}

/** Locate the git subcommand in a token list: skip env assignments and `exec`, require a git
 *  program token, then skip global options. Returns the subcommand and its arguments, or null. */
function gitInvocation(tokens: string[]): { sub: string; args: string[] } | null {
  let i = 0;
  while (i < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!) || tokens[i] === "exec")) i++;
  if (i >= tokens.length || !isGitProgram(tokens[i]!)) return null;
  i++;
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (!t.startsWith("-")) break;
    i += GIT_GLOBAL_WITH_VALUE[t] ? 2 : 1;
  }
  if (i >= tokens.length) return null;
  return { sub: tokens[i]!, args: tokens.slice(i + 1) };
}

function classifyAdd(args: string[]): SweepKind | null {
  let kind: SweepKind | null = null;
  let afterDashDash = false;
  for (const a of args) {
    if (!afterDashDash && a === "--") { afterDashDash = true; continue; }
    if (!afterDashDash && a.startsWith("-")) {
      if (a === "--all" || a === "--no-ignore-removal") return "add-all";
      if (a === "--update") kind = kind ?? "add-update";
      if (/^-[A-Za-z]+$/.test(a)) {
        if (a.includes("A")) return "add-all";
        if (a.includes("u")) kind = kind ?? "add-update";
      }
      continue;
    }
    if (a === "." || a === "./" || a === ":/" || a === ":/." || a === "*") return "add-all";
  }
  return kind;
}

function classifyCommit(args: string[]): SweepKind | null {
  for (const a of args) {
    if (a === "--") break;
    if (a === "--all") return "commit-all";
    if (/^-[A-Za-z]+$/.test(a) && a.includes("a")) return "commit-all";
  }
  return null;
}

function classifyStash(args: string[]): SweepKind | null {
  let i = 0;
  const first = args[0];
  if (first !== undefined && !first.startsWith("-")) {
    if (STASH_NON_SWEEP[first]) return null;
    if (first === "save") return "stash-all";
    if (first !== "push") return null;
    i = 1;
  }
  // Implicit or explicit `push`: any pathspec narrows the stash to those paths.
  for (; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") return i + 1 < args.length ? null : "stash-all";
    if (a === "-m" || a === "--message") { i++; continue; }
    if (a.startsWith("-")) continue;
    return null;
  }
  return "stash-all";
}

/** Every sweeping git call in `command`, in order, with the segment text it came from. */
export function gitSweeps(command: string): GitSweep[] {
  const out: GitSweep[] = [];
  for (const segment of splitSegments(command)) {
    const inv = gitInvocation(tokenize(segment));
    if (!inv) continue;
    let kind: SweepKind | null = null;
    if (inv.sub === "add") kind = classifyAdd(inv.args);
    else if (inv.sub === "commit") kind = classifyCommit(inv.args);
    else if (inv.sub === "stash") kind = classifyStash(inv.args);
    if (kind) out.push({ kind, text: segment });
  }
  return out;
}

export type DirtyFile = { path: string; owner: Owner | null };

const OWNER_FILES_CAP = 8;
const UNOWNED_CAP = 8;
const MINE_CAP = 12;

function fileList(paths: string[], cap: number): string {
  const shown = paths.slice(0, cap).join(", ");
  return paths.length > cap ? `${shown} (+${paths.length - cap} more)` : shown;
}

/** Block iff `sweeps` is non-empty AND some dirty file belongs to a session other than `me`. The
 *  reason names each foreign owner with its files, warns about unowned dirty files, and ends with
 *  the explicit `git add` the agent should run instead. */
export function sweepDecision(input: { sweeps: GitSweep[]; me: Owner; dirty: DirtyFile[] }): { block: boolean; reason?: string } {
  if (input.sweeps.length === 0) return { block: false };
  const foreign = new Map<string, { owner: Owner; files: string[] }>();
  const unowned: string[] = [];
  const mine: string[] = [];
  for (const d of input.dirty) {
    if (!d.owner) { unowned.push(d.path); continue; }
    if (d.owner.id === input.me.id) { mine.push(d.path); continue; }
    let f = foreign.get(d.owner.id);
    if (!f) { f = { owner: d.owner, files: [] }; foreign.set(d.owner.id, f); }
    f.files.push(d.path);
  }
  if (foreign.size === 0) return { block: false };
  const owners = [...foreign.values()].sort((a, b) => (a.owner.name < b.owner.name ? -1 : a.owner.name > b.owner.name ? 1 : 0));
  const first = input.sweeps[0]!;
  const lines = [`Refused: \`${first.text}\` would sweep uncommitted edits owned by another session in this checkout.`];
  for (const o of owners) lines.push(`- "${o.owner.name}" (${o.owner.id}): ${fileList(o.files.sort(), OWNER_FILES_CAP)}`);
  if (unowned.length > 0) lines.push(`Warning: unowned dirty files (no session on record; likely the operator): ${fileList(unowned.sort(), UNOWNED_CAP)}`);
  const suggestion = mine.length > 0
    ? `git add ${mine.sort().slice(0, MINE_CAP).map((p) => (/\s/.test(p) ? `"${p}"` : p)).join(" ")}`
    : "you have no recorded edits in this checkout";
  lines.push(`Stage explicit paths you own instead: ${suggestion}`);
  return { block: true, reason: lines.join("\n") };
}
