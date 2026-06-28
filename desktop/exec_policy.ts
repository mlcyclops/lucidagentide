// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/exec_policy.ts
//
// P-EXEC.1 (ADR-0066): per-action approval for the agent's exec tools (bash + eval) — defense in depth
// ON TOP OF the in-process scanner. The scanner catches MALFORMED/hidden content; it does NOT catch a
// perfectly well-formed destructive command (`rm -rf`, `curl … | sh`, `dd`, `sudo`, `git reset --hard`).
// Those are exactly the actions a security/provenance product must put a human in front of.
//
// Mirrors egress_policy.ts (a pure verdict + pure apply + thin persistence + fail-closed), adding a risk
// CLASSIFIER so we don't nag on read-only commands. The five dialog choices map to an ExecChoice:
//   allow-once    → approve, remember nothing.
//   allow-turn    → approve + auto-allow matching risky calls for the REST OF THIS TURN (in-memory only;
//                   NEVER written to disk; the backend holds the turn-scope set, not this store).
//   allow-program → approve + auto-allow this argv0 (`git`, `npm`, …) from now on (persisted).
//   danger        → auto-allow ALL exec from now on. A SEPARATE toggle from egress danger-mode.
//   deny          → block, no persistence.
//
// Fail-closed: anything unparseable / compound-ambiguous / simply unknown is classified RISKY; a
// non-silenceable catastrophic ALWAYS_PROMPT set (sudo, rm -rf, pipe-to-shell, dd/mkfs, fork bomb,
// git reset --hard / clean -f / push --force) prompts regardless of ANY standing allow or danger mode.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { managedConfig, type ManagedExecPolicy } from "./managed_config.ts";

const FILE = join(homedir(), ".omp", "lucid-exec.json");

export type ExecChoice = "allow-once" | "allow-turn" | "allow-program" | "danger" | "deny";
export type ExecVerdict = "allow" | "prompt" | "block";
export type ExecRisk = "safe" | "risky";

export interface ExecStore {
  dangerMode?: boolean;      // global allow-all exec (SEPARATE from egress danger mode)
  allowPrograms?: string[];  // argv0 programs auto-allowed
  denyPrograms?: string[];   // argv0 programs that may NEVER be auto-allowed (managed denylist) — always prompt/block
}

/** The result of classifying a single shell command. Pure; no I/O. */
export interface ExecClass {
  risk: ExecRisk;          // safe → auto-approve in Agent (still scanned); risky → gate
  key: string | null;      // argv0 to pin via allow-program, or null for a compound/unparseable command
  alwaysPrompt: boolean;   // catastrophic — never silenceable by a standing allow or danger mode
  reason: string;          // short human-readable why (for the dialog + audit)
}

// ── the classifier (the over-tested keystone, like the scanner) ──────────────────────────────────────

// Read-only programs that auto-approve when invoked WITHOUT a dangerous flag and WITHOUT shell control
// operators. Conservative on purpose — an unknown program is risky, not safe.
const SAFE_PROGRAMS = new Set([
  "ls", "cat", "head", "tail", "grep", "egrep", "fgrep", "rg", "ag", "pwd", "echo", "printf",
  "wc", "which", "type", "file", "stat", "true", "false", "dirname", "basename", "realpath",
  "readlink", "date", "whoami", "id", "uname", "hostname", "df", "du", "tree", "env", "find", "sort",
]);

// Programs that are read-only by default but DESTRUCTIVE under a flag → forced risky if the flag appears.
const DANGEROUS_FLAGS: Record<string, RegExp> = {
  find: /(^|\s)-(delete|exec|execdir|ok|okdir|fprint|fprintf|fls)\b/,
  sort: /(^|\s)(-o|--output)\b/,
};

// Read-only `git` subcommands (everything else under git → risky; catastrophic forms are ALWAYS_PROMPT).
const GIT_READONLY = new Set([
  "status", "diff", "log", "show", "branch", "rev-parse", "ls-files", "describe", "blame",
  "cat-file", "remote", "config", "shortlog", "reflog", "tag", "stash", "fetch",
]);

// Shell control operators that make a command compound / write-capable → risky and un-pinnable (key=null).
const COMPOUND = /[|;&]|&&|\|\||\$\(|`|>>|>|<\(/;

// Non-silenceable catastrophic patterns (T4). Each ALWAYS prompts (interactive) / ALWAYS blocks
// (unattended), regardless of any standing allow or danger mode — mirroring an egress ask-site pin.
interface Catastrophic { re: RegExp; why: string }
const ALWAYS_PROMPT: Catastrophic[] = [
  { re: /(^|\s)(sudo|doas)\b/i, why: "runs as root (sudo/doas)" },
  { re: /(^|\s)rm\b(?=[^|;&]*\s-)[^|;&]*\b(?:-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|(?=[^|;&]*\s-[a-z]*r)(?=[^|;&]*\s-[a-z]*f))/i, why: "recursive force-delete (rm -rf)" },
  { re: /\|\s*(?:sudo\s+)?(?:sh|bash|zsh|dash|ksh|python[0-9.]*|node|perl|ruby)\b/i, why: "pipes downloaded code into an interpreter" },
  { re: /(^|\s)dd\b/i, why: "raw disk write (dd)" },
  { re: /(^|\s)mkfs\b/i, why: "formats a filesystem (mkfs)" },
  { re: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, why: "fork bomb" },
  { re: /(^|\s)git\b[^|;&]*\breset\b[^|;&]*--hard/i, why: "git reset --hard (discards work)" },
  { re: /(^|\s)git\b[^|;&]*\bclean\b[^|;&]*\s-[a-z]*f/i, why: "git clean -f (deletes untracked files)" },
  { re: /(^|\s)git\b[^|;&]*\bpush\b[^|;&]*(?:--force(?:-with-lease)?|\s-f\b)/i, why: "git push --force (rewrites remote history)" },
];

/** Strip leading `VAR=val` assignments and an `env`/`command`/`nice`/`time` wrapper to find the real argv0. */
function realArgv0(tokens: string[]): { prog: string | null; rest: string[] } {
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) i++; // VAR=val …
  // unwrap a thin launcher prefix (env FOO=bar prog … / command prog … / nice prog … / time prog …)
  while (i < tokens.length && /^(env|command|nice|time|nohup|stdbuf|setsid)$/.test(base(tokens[i]!))) {
    i++;
    while (i < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!) || /^-/.test(tokens[i]!))) i++;
  }
  const prog = i < tokens.length ? base(tokens[i]!) : null;
  return { prog, rest: tokens.slice(i + 1) };
}
/** basename without a path or `.exe` suffix, lowercased. `/usr/bin/RM` → `rm`. */
function base(tok: string): string {
  const b = tok.replace(/\\/g, "/").split("/").pop() ?? tok;
  return b.replace(/\.exe$/i, "").toLowerCase();
}

/**
 * Classify a shell command into safe/risky + a pin key + the catastrophic flag. Pure, fail-closed.
 * A clean read-only corpus must produce NO risky verdicts; a dangerous corpus must be 100% flagged.
 */
export function classifyCommand(cmd: string): ExecClass {
  const raw = (cmd ?? "").trim();
  if (!raw) return { risk: "risky", key: null, alwaysPrompt: false, reason: "empty/unparseable command" };

  // 1. Catastrophic patterns first — they win over everything, even inside a compound command.
  for (const c of ALWAYS_PROMPT) if (c.re.test(raw)) {
    const { prog } = realArgv0(tokenize(raw));
    return { risk: "risky", key: prog, alwaysPrompt: true, reason: c.why };
  }

  // 2. Compound / write-capable (pipes, chaining, substitution, redirection) → risky, un-pinnable.
  if (COMPOUND.test(raw)) return { risk: "risky", key: null, alwaysPrompt: false, reason: "compound or redirecting command" };

  const tokens = tokenize(raw);
  const { prog } = realArgv0(tokens);
  if (!prog) return { risk: "risky", key: null, alwaysPrompt: false, reason: "no resolvable program" };

  // 3. git — only the read-only subcommands are safe.
  if (prog === "git") {
    const sub = tokens.find((t, idx) => idx > tokens.indexOf("git") && !t.startsWith("-"));
    return GIT_READONLY.has((sub ?? "").toLowerCase())
      ? { risk: "safe", key: "git", alwaysPrompt: false, reason: `read-only git ${sub}` }
      : { risk: "risky", key: "git", alwaysPrompt: false, reason: `git ${sub ?? "(subcommand)"} may mutate the repo` };
  }

  // 4. A safe program — unless it trips its dangerous-flag table.
  if (SAFE_PROGRAMS.has(prog)) {
    const danger = DANGEROUS_FLAGS[prog];
    if (danger && danger.test(raw)) return { risk: "risky", key: prog, alwaysPrompt: false, reason: `${prog} with a writing/executing flag` };
    return { risk: "safe", key: prog, alwaysPrompt: false, reason: `read-only ${prog}` };
  }

  // 5. Everything else is risky (fail-closed) but pinnable by program.
  return { risk: "risky", key: prog, alwaysPrompt: false, reason: `${prog} is not a known read-only command` };
}

/** Split a command into whitespace-separated tokens, honoring simple single/double quotes. */
function tokenize(cmd: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd))) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  return out;
}

/** The `eval` tool runs arbitrary code; there's no command string to classify. Always risky, pinnable by
 *  "eval" (so danger-mode / an explicit allow-program can still silence it), never catastrophic. */
export function classifyEval(): ExecClass {
  return { risk: "risky", key: "eval", alwaysPrompt: false, reason: "eval executes arbitrary code" };
}

// ── pure verdict + choice-folding (mirrors egress) ───────────────────────────────────────────────────

/**
 * Pure decision for a classified call. `unattended` (a /goal loop with no human) BLOCKS where an
 * interactive session would PROMPT. `turnAllowed` is the in-memory allow-turn scope (interactive only —
 * the backend never sets it unattended). Fail-closed throughout.
 */
export function execVerdict(
  store: ExecStore,
  cls: ExecClass,
  opts: { unattended?: boolean; turnAllowed?: boolean } = {},
): ExecVerdict {
  if (cls.risk === "safe") return "allow";
  const gate: ExecVerdict = opts.unattended ? "block" : "prompt";
  // Catastrophic: never silenceable by any standing allow/danger/turn scope.
  if (cls.alwaysPrompt) return gate;
  // A managed denylisted program can never be auto-allowed (overrides danger + pins, like an egress deny).
  if (cls.key && (store.denyPrograms ?? []).includes(cls.key)) return gate;
  if (opts.turnAllowed) return "allow";
  if (cls.key && (store.allowPrograms ?? []).includes(cls.key)) return "allow";
  if (store.dangerMode) return "allow";
  return gate;
}

/** Pure update: fold a user's choice into the store. Returns a NEW store (never mutates). allow-once /
 *  allow-turn / deny persist nothing (turn scope is in-memory on the backend). */
export function applyExecChoice(store: ExecStore, cls: ExecClass, choice: ExecChoice): ExecStore {
  const allow = new Set(store.allowPrograms ?? []);
  let danger = store.dangerMode ?? false;
  switch (choice) {
    // Don't pin a catastrophic program (it always prompts anyway) or an un-pinnable compound (key=null).
    case "allow-program": if (cls.key && !cls.alwaysPrompt) allow.add(cls.key); break;
    case "danger": danger = true; break;
    case "allow-once": case "allow-turn": case "deny": break; // no persistence
  }
  return { dangerMode: danger, allowPrograms: [...allow], denyPrograms: store.denyPrograms };
}

/** ADR-0068 (P-ENT.1): tighten the user's exec store by the managed CEILING — never riskier than theirs.
 *  `denylist` programs are dropped from allow + pinned to always-prompt; `disableDangerMode` forbids
 *  allow-all. Pure, tighten-only. (The `maxAutoTier` ceiling governs the unattended loop — ADR-0067.) */
export function clampExec(store: ExecStore, managed?: ManagedExecPolicy): ExecStore {
  if (!managed) return store;
  const norm = (p: string) => p.trim().toLowerCase();
  const denied = new Set((managed.denylist ?? []).map(norm).filter(Boolean));
  const allow = (store.allowPrograms ?? []).map(norm).filter((p) => !denied.has(p));
  const deny = new Set([...(store.denyPrograms ?? []).map(norm), ...denied]);
  const danger = managed.disableDangerMode ? false : store.dangerMode ?? false;
  return { dangerMode: danger, allowPrograms: [...new Set(allow)], denyPrograms: [...deny] };
}

// ── thin persistence (machine-level, like settings + egress) ─────────────────────────────────────────
export function loadExec(): ExecStore {
  try { return existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : {}; } catch { return {}; }
}
function saveExec(s: ExecStore): void {
  try { writeFileSync(FILE, JSON.stringify(s, null, 2), "utf8"); } catch { /* best-effort; never break a turn */ }
}

/** Read-side: the live (managed-clamped) exec store. */
export function execStore(): ExecStore {
  return clampExec(loadExec(), managedConfig().config?.security?.exec);
}
/** Write-side: persist the user's choice (allow-once/allow-turn/deny are no-ops on disk). */
export function recordExec(cls: ExecClass, choice: ExecChoice): void {
  saveExec(applyExecChoice(loadExec(), cls, choice));
}
