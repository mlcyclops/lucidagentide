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
import { managedConfig, type ManagedExecPolicy, type RiskTier, TIER_ORDER } from "./managed_config.ts";

export type { RiskTier } from "./managed_config.ts";

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
  tier: RiskTier;          // graded ladder T0-T4 (ADR-0067) — what the unattended loop dial reads
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

// ── the graded risk ladder (ADR-0067): T0 read-only · T1 local-mutate · T2 reach-out · T3 destructive ──
const REACH_OUT = new Set(["curl", "wget", "nc", "ncat", "netcat", "scp", "sftp", "rsync", "telnet", "ftp"]);
const DESTRUCTIVE = new Set(["rm", "rmdir", "chmod", "chown", "chgrp", "kill", "killall", "pkill", "shred", "truncate", "ssh"]);
const LOCAL_MUTATE = new Set(["mkdir", "touch", "ln", "cp", "mv", "tee", "sed", "awk", "patch"]);
const PKG = /^(npm|pnpm|yarn|pip|pip3|pipx|apt|apt-get|yum|dnf|brew|gem|cargo|go|bundle|composer)$/;
const PKG_MUTATE = /\b(install|add|upgrade|update|i|get|remove|uninstall)\b/;

/** Tier for a RISKY (non-catastrophic) single program. Fail-closed: an unknown program is T3. */
function riskyTier(prog: string, raw: string): RiskTier {
  if (REACH_OUT.has(prog)) return "T2";
  if (PKG.test(prog) && PKG_MUTATE.test(raw)) return "T2";
  if (DESTRUCTIVE.has(prog)) return "T3";
  if (LOCAL_MUTATE.has(prog)) return "T1";
  return "T3"; // unknown risky → fail-closed to destructive
}

/**
 * Classify a shell command into safe/risky + a graded tier + a pin key + the catastrophic flag. Pure,
 * fail-closed. A clean read-only corpus must produce NO risky verdicts; a dangerous corpus must be 100%
 * flagged; an unparseable/unknown command is T3 (ADR-0067).
 */
export function classifyCommand(cmd: string): ExecClass {
  const raw = (cmd ?? "").trim();
  if (!raw) return { risk: "risky", tier: "T3", key: null, alwaysPrompt: false, reason: "empty/unparseable command" };

  // 1. Catastrophic patterns first — they win over everything, even inside a compound command. (T4)
  for (const c of ALWAYS_PROMPT) if (c.re.test(raw)) {
    const { prog } = realArgv0(tokenize(raw));
    return { risk: "risky", tier: "T4", key: prog, alwaysPrompt: true, reason: c.why };
  }

  // 2. Compound / write-capable (pipes, chaining, substitution, redirection) → risky, un-pinnable (T3).
  if (COMPOUND.test(raw)) return { risk: "risky", tier: "T3", key: null, alwaysPrompt: false, reason: "compound or redirecting command" };

  const tokens = tokenize(raw);
  const { prog } = realArgv0(tokens);
  if (!prog) return { risk: "risky", tier: "T3", key: null, alwaysPrompt: false, reason: "no resolvable program" };

  // 3. git — only the read-only subcommands are safe; push/pull/fetch/clone reach out (T2), else local (T1).
  if (prog === "git") {
    const sub = (tokens.find((t, idx) => idx > tokens.indexOf("git") && !t.startsWith("-")) ?? "").toLowerCase();
    if (GIT_READONLY.has(sub)) return { risk: "safe", tier: "T0", key: "git", alwaysPrompt: false, reason: `read-only git ${sub}` };
    const tier: RiskTier = /^(push|pull|clone|remote|submodule)$/.test(sub) ? "T2" : "T1";
    return { risk: "risky", tier, key: "git", alwaysPrompt: false, reason: `git ${sub || "(subcommand)"} may mutate the repo` };
  }

  // 4. A safe program — unless it trips its dangerous-flag table (find→destructive T3, else local T1).
  if (SAFE_PROGRAMS.has(prog)) {
    const danger = DANGEROUS_FLAGS[prog];
    if (danger && danger.test(raw)) return { risk: "risky", tier: prog === "find" ? "T3" : "T1", key: prog, alwaysPrompt: false, reason: `${prog} with a writing/executing flag` };
    return { risk: "safe", tier: "T0", key: prog, alwaysPrompt: false, reason: `read-only ${prog}` };
  }

  // 5. Everything else is risky (fail-closed) but pinnable by program.
  return { risk: "risky", tier: riskyTier(prog, raw), key: prog, alwaysPrompt: false, reason: `${prog} is not a known read-only command` };
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
 *  "eval" (so danger-mode / an explicit allow-program can still silence it), never catastrophic. T3 —
 *  arbitrary code can be destructive. */
export function classifyEval(): ExecClass {
  return { risk: "risky", tier: "T3", key: "eval", alwaysPrompt: false, reason: "eval executes arbitrary code" };
}

// ── the unattended loop dial (ADR-0067) ──────────────────────────────────────────────────────────────
// The /goal loop runs with no human to prompt, so risk awareness becomes a STANDING posture: a per-
// command-TYPE ceiling. A command auto-runs in the loop IFF its classified tier ≤ that type's dial AND
// it isn't catastrophic (T4 always blocks). An UNCONFIGURED dial defaults to the SAFEST posture (T0).

/** Command/tool TYPES the dial matrix exposes (the normalizeToolName classes that can mutate/reach out).
 *  read + search are fixed T0 (no dial row). */
export type DialType = "shell" | "edit" | "delete" | "web-fetch" | "web-search" | "subagent";
export const DIAL_TYPES: DialType[] = ["shell", "edit", "delete", "web-fetch", "web-search", "subagent"];
export type LoopDial = Partial<Record<DialType, RiskTier>>;

/** The intrinsic tier of a non-shell tool TYPE (shell's tier is per-command from the classifier). */
export const TOOL_TYPE_TIER: Record<DialType, RiskTier> = {
  shell: "T2",        // (only used as a fallback; real shell calls carry a per-command tier)
  edit: "T1",         // local-mutate
  delete: "T3",       // destructive
  "web-fetch": "T2",  // reach-out
  "web-search": "T2", // reach-out
  subagent: "T2",     // spawns more agent work
};

/** Pure loop decision: may a command of `tier` auto-run under a dial set to `dialMax`? Fail-closed:
 *  T4 ALWAYS blocks (no human, never auto-runnable); otherwise auto iff tier ≤ dialMax. An absent dial
 *  defaults to T0 (the safest, most-blocking posture). */
export function loopVerdict(dialMax: RiskTier | undefined, tier: RiskTier): "auto" | "block" {
  if (tier === "T4") return "block";
  const ceil = dialMax ?? "T0";
  return TIER_ORDER[tier] <= TIER_ORDER[ceil] ? "auto" : "block";
}

/** Tighten one dial row by the managed loop ceiling (ADR-0068) — never higher than the org's max. */
export function clampDialRow(row: RiskTier | undefined, managedMax?: RiskTier): RiskTier {
  const r = row ?? "T0";
  if (managedMax && TIER_ORDER[r] > TIER_ORDER[managedMax]) return managedMax;
  return r;
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
