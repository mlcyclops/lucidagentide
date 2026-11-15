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

// Non-silenceable catastrophic patterns (T4). Each ALWAYS prompts (interactive) / ALWAYS blocks
// (unattended), regardless of any standing allow or danger mode — mirroring an egress ask-site pin.
// Two of the set are read from the lexed command rather than its text (#618): rm's flags (rmRecursiveForce) and a
// pipe into an interpreter (INTERPRETER, on a real pipeline segment, so a `|` inside quotes is text).
interface Catastrophic { re: RegExp; why: string }
const RM_RF = "recursive force-delete (rm -rf)";
const PIPE_TO_INTERPRETER = "pipes downloaded code into an interpreter";
/** How many levels of substitution and launcher (`bash -c`, `iex`, ...) the floor reads; deeper always asks. */
const MAX_NESTING = 5;
const TOO_DEEP = "nested too deeply to read (more than five levels of substitution or launcher)";
/** The interpreters a pipe may feed, by bare program name (base() has removed a path, a module such as
 *  `Microsoft.PowerShell.Utility\`, and `.exe`). PowerShell's `iex` / `Invoke-Expression` runs the text piped into
 *  it, as `sh` does (`irm <url> | iex`). */
const INTERPRETER = /^(?:sh|bash|zsh|dash|ksh|python[0-9.]*|node|perl|ruby|iex|invoke-expression)(?!\w)/;
const ALWAYS_PROMPT: Catastrophic[] = [
  { re: /(^|\s)(sudo|doas)\b/i, why: "runs as root (sudo/doas)" },
  { re: /(^|\s)dd\b/i, why: "raw disk write (dd)" },
  { re: /(^|\s)mkfs\b/i, why: "formats a filesystem (mkfs)" },
  { re: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, why: "fork bomb" },
  { re: /(^|\s)git\b[^|;&]*\breset\b[^|;&]*--hard/i, why: "git reset --hard (discards work)" },
  { re: /(^|\s)git\b[^|;&]*\bclean\b[^|;&]*\s-[a-z]*f/i, why: "git clean -f (deletes untracked files)" },
  { re: /(^|\s)git\b[^|;&]*\bpush\b[^|;&]*(?:--force(?:-with-lease)?|\s-f\b)/i, why: "git push --force (rewrites remote history)" },
  // #616: the Windows forms. cmd's recursive switches, PowerShell's -Recurse (any abbreviation on Remove-Item and
  // `ri`; at least `-rec` on the aliases rm/rmdir/rd/del/erase, so POSIX `rm -r` keeps its tier), drive formats.
  { re: /(^|\s)(del|erase)\b[^|;&]*\s\/s\b/i, why: "recursive delete (del /s)" },
  { re: /(^|\s)(rd|rmdir)\b[^|;&]*\s\/s\b/i, why: "recursive directory delete (rd /s)" },
  { re: /(^|\s)(remove-item|ri)\b[^|;&]*\s-r[a-z]*\b/i, why: "recursive delete (Remove-Item -Recurse)" },
  { re: /(^|\s)(rm|rmdir|rd|del|erase)\b[^|;&]*\s-rec[a-z]*\b/i, why: "recursive delete (Remove-Item -Recurse)" },
  { re: /(^|\s)format(\.com)?\s+[a-z]:/i, why: "formats a drive (format)" },
  { re: /(^|\s)(format-volume|clear-disk)\b/i, why: "formats or wipes a disk" },
];

/** The launchers whose argument is itself a command (#616): a shell's `-c`, cmd's `/c` or `/k`, PowerShell's
 *  `-Command` (any abbreviation) or `-EncodedCommand`, `iex` / `Invoke-Expression`. Returns the command they
 *  would run, or null. */
function launcherPayload(prog: string, rest: string[]): string | null {
  if (/^(sh|bash|zsh|dash|ksh|fish)$/.test(prog)) {
    const i = rest.findIndex((t) => /^-[a-z]*c[a-z]*$/i.test(t));
    return i >= 0 && i + 1 < rest.length ? rest[i + 1]! : null;
  }
  if (prog === "cmd") {
    // cmd also takes the command glued to the switch (`/c"del /s /q C:\*"`), strips one pair of outer quotes, and
    // runs a `( ... )` group around the whole payload as the command inside it (`/c(del /s /q C:\*)`).
    const i = rest.findIndex((t) => /^\/[ck]/i.test(t));
    if (i < 0) return null;
    return unwrapParens([rest[i]!.slice(2), ...rest.slice(i + 1)].filter(Boolean).join(" ").replace(/^"([\s\S]*)"$/, "$1"), 1);
  }
  if (prog === "iex" || prog === "invoke-expression") {
    // Its string argument (or -Command's, any abbreviation) is the command it runs, also when the argument is
    // wrapped in invocation parentheses (`iex ('Remove-Item ...')`; the words arrive with their quotes removed).
    const args = rest.filter((t) => !/^-c(o(m(m(a(n(d)?)?)?)?)?)?$/i.test(t));
    return args.length ? unwrapParens(args.join(" ")) : null;
  }
  if (prog === "powershell" || prog === "pwsh") {
    const enc = rest.findIndex((t) => /^-e(c|n(c(o(d(e(d(c(o(m(m(a(n(d)?)?)?)?)?)?)?)?)?)?)?)?)?$/i.test(t));
    // -EncodedCommand is base64 of UTF-16LE text: read the command it carries.
    if (enc >= 0) return Buffer.from(rest[enc + 1] ?? "", "base64").toString("utf16le");
    // -Command, or the arguments themselves when no -File names a script (5.1 runs them as a command).
    return rest.join(" ");
  }
  return null;
}

/** `s` without the balanced parentheses around the whole of it, at most `pairs` of them: `(('x'))` is `'x'`, while
 *  `(a) + (b)` stays as it is. Linear: every parenthesis is matched once. */
function unwrapParens(s: string, pairs = Infinity): string {
  const match = new Map<number, number>();
  const open: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "(") open.push(i);
    else if (s[i] === ")" && open.length) match.set(open.pop()!, i);
  }
  let l = 0;
  let r = s.length - 1;
  const trim = (): void => {
    while (l <= r && /\s/.test(s[l]!)) l++;
    while (r >= l && /\s/.test(s[r]!)) r--;
  };
  trim();
  for (let n = 0; n < pairs && s[l] === "(" && match.get(l) === r; n++) {
    l++;
    r--;
    trim();
  }
  return s.slice(l, r + 1);
}

/** One command of a list or pipeline, as its own text; `piped` when a `|` (or `|&`) feeds it. */
interface Segment { text: string; piped: boolean }
/** A command as one pass of the lexer reads it. */
interface Lexed {
  /** The top-level commands, split at unquoted `|`, `||`, `|&`, `&&`, `&`, `;` and line breaks. */
  segments: Segment[];
  /** Every substitution body at every depth, each once (escape reading only). */
  subs: string[];
  /** A list operator, a substitution or an unquoted `>` was seen: the command is not one plain program. */
  compound: boolean;
  /** How deep substitutions nest (0 when there are none). */
  nesting: number;
}
/** What stands in for a substitution in the text around it, so each character is classified in one body only. */
const SUB = "_";
interface Frame {
  /** `paren`: `$(`, `<(`, `>(`. `tick`: a live backtick. `quoted`: a `$(...)` or backtick inside single quotes,
   *  which bash does not run but the floor reads (fail-closed); it ends at its own close or at the closing quote. */
  kind: "root" | "paren" | "tick" | "quoted";
  /** The frame's own text so far (a nested substitution is SUB) and where the uncopied rest starts. */
  parts: string[];
  from: number;
  quote: "" | "'" | '"';
  /** Unquoted plain `(` inside a paren or quoted-paren frame, so `$(f (x))` closes at the last `)`. */
  depth: number;
  /** A quoted frame's closer: `)` or a backtick. */
  close: string;
}

/**
 * The single-pass shell lexer of the floor (#618): a stack of open `$(`, `<(`, `>(` and backtick frames, each with
 * its own quote state, as bash keeps it (a `$(` inside double quotes starts fresh quoting). With `escapes` a
 * backslash escapes the next character as bash reads it (outside single quotes); without, it is literal, as cmd and
 * PowerShell read it. A backtick body ends at the first unescaped backtick and is unescaped one level (`` \` ``,
 * `\\`, `\$`) so a nested one is found when it is classified in turn. Inside single quotes a `$(` or backtick still
 * opens a body (fail-closed), but that body ends at the closing quote and never takes a backtick outside it. An
 * unclosed frame runs to the end of the text (fail-closed). Every character is visited once and copied into one
 * frame's text, so the cost is linear in the input.
 */
function lex(text: string, escapes: boolean): Lexed {
  const subs: string[] = [];
  const segments: Segment[] = [];
  let compound = false;
  let piped = false;
  let nesting = 0;
  const frame = (kind: Frame["kind"], from: number, close = ""): Frame => ({ kind, parts: [], from, quote: "", depth: 0, close });
  const own = (f: Frame, end: number): string => f.parts.join("") + text.slice(f.from, end);
  const root = frame("root", 0);
  const stack: Frame[] = [root];
  const open = (kind: Frame["kind"], at: number, from: number, close = ""): void => {
    const parent = stack[stack.length - 1]!;
    parent.parts.push(text.slice(parent.from, at), SUB);
    stack.push(frame(kind, from, close));
    nesting = Math.max(nesting, stack.length - 1);
    compound = true;
  };
  const shut = (end: number, next: number): void => {
    const f = stack.pop()!;
    stack[stack.length - 1]!.from = next;
    if (!escapes) return; // only the bash reading's substitutions are classified
    const body = f.kind === "tick" ? own(f, end).replace(/\\([`\\$])/g, "$1") : own(f, end);
    if (body.trim()) subs.push(body);
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const f = stack[stack.length - 1]!;
    if (f.kind === "tick") {
      if (c === "\\" && escapes) i++;
      else if (c === "`") shut(i, i + 1);
      continue;
    }
    if (f.kind === "quoted") {
      if (c === "'") {
        shut(i, i);
        stack[stack.length - 1]!.quote = "";
      } else if (f.close === "`" ? c === "`" : c === ")" && f.depth-- === 0) shut(i, i + 1);
      else if (c === "(" && f.close === ")") f.depth++;
      continue;
    }
    const subOpen = text[i + 1] === "(" && (c === "$" || c === "<" || c === ">");
    if (f.quote === "'") {
      if (c === "'") f.quote = "";
      else if (c === "`") open("quoted", i, i + 1, "`");
      else if (subOpen) open("quoted", i, ++i + 1, ")");
      continue;
    }
    if (c === "\\" && escapes) {
      i++;
      continue;
    }
    if (f.quote === '"') {
      if (c === '"') f.quote = "";
      else if (c === "`") open("tick", i, i + 1);
      else if (c === "$" && subOpen) open("paren", i, ++i + 1);
      continue;
    }
    if (c === "'" || c === '"') f.quote = c;
    else if (c === "`") open("tick", i, i + 1);
    else if (subOpen) open("paren", i, ++i + 1);
    else if (c === ">") compound = true;
    else if (f.kind === "paren") {
      if (c === "(") f.depth++;
      else if (c === ")" && f.depth-- === 0) shut(i, i + 1);
    } else if (c === "|" || c === "&" || c === ";" || c === "\n" || c === "\r") {
      compound = true;
      segments.push({ text: own(root, i), piped });
      root.parts = [];
      const pair = text.slice(i, i + 2);
      piped = pair === "|&" || (c === "|" && pair !== "||");
      if (pair === "||" || pair === "&&" || pair === "|&") i++;
      root.from = i + 1;
    }
  }
  while (stack.length > 1) shut(text.length, text.length);
  segments.push({ text: own(root, text.length), piped });
  return { segments, subs, compound, nesting };
}

/** The words a shell passes for `seg`, quotes removed, with the offset just past each in `seg`. With `escapes` a
 *  backslash escapes as bash reads it; without, it is literal, as cmd and PowerShell read it (`C:\Windows`). */
function shellWords(seg: string, escapes: boolean): { text: string; end: number }[] {
  const out: { text: string; end: number }[] = [];
  let word = "";
  let inWord = false;
  let quote = "";
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i]!;
    if (quote === "'") {
      if (c === "'") quote = "";
      else word += c;
    } else if (quote === '"') {
      if (c === '"') quote = "";
      else if (c === "\\" && escapes && i + 1 < seg.length && '$`"\\\n'.includes(seg[i + 1]!)) word += seg[++i]!;
      else word += c;
    } else if (/\s/.test(c)) {
      if (inWord) out.push({ text: word, end: i });
      word = "";
      inWord = false;
    } else {
      inWord = true;
      if (c === "'" || c === '"') quote = c;
      else if (c === "\\" && escapes && i + 1 < seg.length) word += seg[++i]!;
      else word += c;
    }
  }
  if (inWord) out.push({ text: word, end: seg.length });
  return out;
}

/** True when an `rm` among `words` gets both a recursive and a force flag (#618): from the shell-decoded words, so
 *  `rm "--rec" "--for" /` counts. A cluster (`-rf`, `-R`, PowerShell's `-Force`) counts each letter; a long option
 *  counts in any abbreviation getopt_long accepts (`--r` to `--recursive`, `--f` to `--force`; no other rm option
 *  starts with r or f). Options end at `--`. Options after an operand still count, as getopt_long permutes them. */
function rmRecursiveForce(words: string[]): boolean {
  let active = false;
  let r = false;
  let f = false;
  for (const w of words) {
    if (!active) {
      if (base(w) === "rm") [active, r, f] = [true, false, false];
      continue;
    }
    if (w === "--") {
      if (r && f) return true;
      active = false;
      continue;
    }
    const long = /^--([a-z][a-z-]*)(?:=|$)/i.exec(w)?.[1]?.toLowerCase();
    if (long) {
      r ||= "recursive".startsWith(long);
      f ||= "force".startsWith(long);
    } else if (/^-[a-z]+$/i.test(w)) {
      r ||= /r/i.test(w);
      f ||= /f/i.test(w);
    }
  }
  return active && r && f;
}

/** The catastrophic reason for `raw` (#616, #618), or null: the raw text first (the patterns of ALWAYS_PROMPT), then
 *  each substitution the lexer found, then each command segment with its program resolved to a bare name (`/bin/rm`,
 *  `env X=1 rm`), its rm flags read from its words, a pipe into an interpreter, and the command a launcher (`bash -c`,
 *  `cmd /c`, `powershell -Command`, `iex`) would run. Only the program position is rewritten, so a quoted argument
 *  (`grep "rm -rf" log`) is not read as a command. Segments are read twice when the text has a backslash: as bash
 *  reads it and as cmd and PowerShell read it; either reading that is catastrophic asks. A command nested deeper
 *  than MAX_NESTING levels (substitutions and launchers counted together) asks without being read (fail-closed). */
function catastrophicIn(raw: string, depth = 0): string | null {
  for (const c of ALWAYS_PROMPT) if (c.re.test(raw)) return c.why;
  const bash = lex(raw, true);
  if (depth + bash.nesting > MAX_NESTING) return TOO_DEEP;
  for (const sub of new Set(bash.subs)) {
    const hit = catastrophicIn(sub, depth + 1);
    if (hit) return hit;
  }
  const readings: [Segment[], boolean][] = [[bash.segments, true]];
  if (raw.includes("\\")) readings.push([lex(raw, false).segments, false]);
  for (const [segments, escapes] of readings) {
    for (const seg of segments) {
      const hit = segmentCatastrophe(seg, escapes, depth);
      if (hit) return hit;
    }
  }
  return null;
}

/** The catastrophic reason for one lexed command segment, or null. */
function segmentCatastrophe({ text, piped }: Segment, escapes: boolean, depth: number): string | null {
  const spans = shellWords(text, escapes);
  const words = spans.map((s) => s.text);
  if (rmRecursiveForce(words)) return RM_RF;
  const { prog, at } = argv0At(words);
  if (!prog || at < 0) return null;
  if (piped && INTERPRETER.test(prog)) return PIPE_TO_INTERPRETER;
  const norm = `${prog}${text.slice(spans[at]!.end)}`;
  for (const c of ALWAYS_PROMPT) if (c.re.test(norm)) return c.why;
  const payload = launcherPayload(prog, words.slice(at + 1));
  return payload === null ? null : catastrophicIn(payload, depth + 1);
}

/** Strip leading `VAR=val` assignments and an `env`/`command`/`nice`/`time` wrapper to find the real argv0. */
function realArgv0(tokens: string[]): { prog: string | null; rest: string[] } {
  const { prog, at } = argv0At(tokens);
  return { prog, rest: at < 0 ? [] : tokens.slice(at + 1) };
}
/** The real argv0 (basename, lowercased) and its token index, or null and -1 when there is none. */
function argv0At(tokens: string[]): { prog: string | null; at: number } {
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) i++; // VAR=val …
  // unwrap a thin launcher prefix (env FOO=bar prog … / command prog … / nice prog … / time prog …)
  while (i < tokens.length && /^(env|command|nice|time|nohup|stdbuf|setsid|exec)$/.test(base(tokens[i]!))) {
    i++;
    while (i < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!) || /^-/.test(tokens[i]!))) i++;
  }
  return i < tokens.length ? { prog: base(tokens[i]!), at: i } : { prog: null, at: -1 };
}
/** basename without a path or `.exe` suffix, lowercased. `/usr/bin/RM` → `rm`. */
function base(tok: string): string {
  const b = tok.replace(/\\/g, "/").split("/").pop() ?? tok;
  return b.replace(/\.exe$/i, "").toLowerCase();
}

// ── the graded risk ladder (ADR-0067): T0 read-only · T1 local-mutate · T2 reach-out · T3 destructive ──
const REACH_OUT = new Set(["curl", "wget", "nc", "ncat", "netcat", "scp", "sftp", "rsync", "telnet", "ftp"]);
const DESTRUCTIVE = new Set([
  "rm", "rmdir", "chmod", "chown", "chgrp", "kill", "killall", "pkill", "shred", "truncate", "ssh",
  // Windows delete verbs (cmd builtins + PowerShell cmdlet/alias). Windows shells are case-insensitive;
  // base() already lowercases argv0 and strips `.exe`, so DEL / Del / Remove-Item / remove-item all land
  // on these lowercase entries (issue #449, the "fix first" gap).
  "del", "erase", "rd", "remove-item", "ri",
]);
/** P-CTRL-REMOTE.1 (ADR-0531): a remote lane refuses KNOWN destructive programs outright but lets a human decide
 *  on an unknown one (also T3 here, fail-closed), so the two must be told apart. */
export const isDestructiveProgram = (prog: string): boolean => DESTRUCTIVE.has(prog);
const LOCAL_MUTATE = new Set(["mkdir", "touch", "ln", "cp", "mv", "tee", "sed", "awk", "patch"]);
const PKG = /^(npm|pnpm|yarn|pip|pip3|pipx|apt|apt-get|yum|dnf|brew|gem|cargo|go|bundle|composer)$/;
const PKG_MUTATE = /\b(install|add|upgrade|update|i|get|remove|uninstall)\b/;

// P-OFFICE.1 (ADR-0306, decision 3): `officecli` (iOfficeAI/OfficeCLI) is an EXTERNAL binary, so it hits
// the unknown-program path and fail-closes EVERY call to T3 destructive. Right as a default, wrong in
// practice - reading a .docx must not weigh the same as `rm`. So the tier is keyed by SUBCOMMAND, the
// same shape GIT_READONLY uses for git: one lookup consulted from the classifier, not special cases
// sprinkled around it. A subcommand ABSENT from this table (unrecognized, or added by a future upstream
// release) deliberately falls through to the unknown-program path and keeps its fail-closed T3.
interface OfficeSub { tier: RiskTier; why: string }
const OFFICECLI_SUBS: Record<string, OfficeSub> = {
  // T0 - pure inspection. `view` (including `view html` / `view outline`) and `get` only READ a document
  // and print/emit structure, which is the read the ladder already calls T0 for `cat`.
  view: { tier: "T0", why: "read-only inspection (html/outline/text)" },
  get: { tier: "T0", why: "read-only element query" },
  // T1 - they WRITE document files, but only inside the workspace the agent was already given: exactly
  // the weight the ladder gives `cp` / `mv` / `sed` (LOCAL_MUTATE).
  create: { tier: "T1", why: "creates a document file in the workspace" },
  add: { tier: "T1", why: "writes elements into a workspace document" },
  set: { tier: "T1", why: "edits elements in a workspace document" },
  remove: { tier: "T1", why: "deletes elements from a workspace document" },
  close: { tier: "T1", why: "finalizes and closes a workspace document" },
  // T2, NOT T1 - both escape the workspace, which is what separates reach-out from local-mutate:
  //   `install` copies the binary onto PATH and injects skill files into detected agent config dirs,
  //   i.e. it mutates the MACHINE and other harnesses (ADR-0306 non-goals bar it from touching LUCID's
  //   own skill set at all, so it must never auto-run at the local-mutate dial);
  //   `watch` BINDS a localhost live-preview server (:26315) and keeps serving workspace files for as
  //   long as it runs - a listening socket is a network posture, not a one-shot file write (ADR-0305).
  install: { tier: "T2", why: "copies a binary onto PATH and writes agent config dirs outside the workspace" },
  watch: { tier: "T2", why: "binds a localhost live-preview server" },
};

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

  // 1. Catastrophic patterns first — they win over everything, even inside a compound command, a program named by
  //    path or a launcher's payload (#616). (T4)
  const cata = catastrophicIn(raw);
  if (cata) {
    const { prog } = realArgv0(tokenize(raw));
    return { risk: "risky", tier: "T4", key: prog, alwaysPrompt: true, reason: cata };
  }

  // 2. Compound / write-capable (pipes, chaining, substitution, redirection outside quotes, as the lexer reads it in
  //    either reading of a backslash) → risky, un-pinnable (T3). A quoted `|` is text (#618).
  if (lex(raw, true).compound || (raw.includes("\\") && lex(raw, false).compound))
    return { risk: "risky", tier: "T3", key: null, alwaysPrompt: false, reason: "compound or redirecting command" };

  const tokens = tokenize(raw);
  const { prog, rest } = realArgv0(tokens);
  if (!prog) return { risk: "risky", tier: "T3", key: null, alwaysPrompt: false, reason: "no resolvable program" };

  // 3. git — only the read-only subcommands are safe; push/pull/fetch/clone reach out (T2), else local (T1).
  if (prog === "git") {
    const sub = (tokens.find((t, idx) => idx > tokens.indexOf("git") && !t.startsWith("-")) ?? "").toLowerCase();
    if (GIT_READONLY.has(sub)) return { risk: "safe", tier: "T0", key: "git", alwaysPrompt: false, reason: `read-only git ${sub}` };
    const tier: RiskTier = /^(push|pull|clone|remote|submodule)$/.test(sub) ? "T2" : "T1";
    return { risk: "risky", tier, key: "git", alwaysPrompt: false, reason: `git ${sub || "(subcommand)"} may mutate the repo` };
  }

  // 4. officecli (ADR-0306): tier by SUBCOMMAND via OFFICECLI_SUBS, so a read (`view`/`get`) is T0 like
  //    `cat` while a document write is T1 like `cp`. An unrecognized subcommand matches NOTHING here and
  //    falls through to step 6, keeping the fail-closed T3 default the unknown path already gives it.
  if (prog === "officecli") {
    const sub = (rest.find((t) => !t.startsWith("-")) ?? "").toLowerCase();
    const hit = OFFICECLI_SUBS[sub];
    if (hit) return {
      risk: hit.tier === "T0" ? "safe" : "risky",
      tier: hit.tier, key: prog, alwaysPrompt: false,
      reason: `officecli ${sub}: ${hit.why}`,
    };
  }

  // 5. A safe program — unless it trips its dangerous-flag table (find→destructive T3, else local T1).
  if (SAFE_PROGRAMS.has(prog)) {
    const danger = DANGEROUS_FLAGS[prog];
    if (danger && danger.test(raw)) return { risk: "risky", tier: prog === "find" ? "T3" : "T1", key: prog, alwaysPrompt: false, reason: `${prog} with a writing/executing flag` };
    return { risk: "safe", tier: "T0", key: prog, alwaysPrompt: false, reason: `read-only ${prog}` };
  }

  // 6. Everything else is risky (fail-closed) but pinnable by program.
  return { risk: "risky", tier: riskyTier(prog, raw), key: prog, alwaysPrompt: false, reason: `${prog} is not a known read-only command` };
}

/** Split a command into its words, quotes removed and a backslash literal (a Windows path keeps its separators). */
function tokenize(cmd: string): string[] {
  return shellWords(cmd, false).map((s) => s.text);
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

/** P-EXEC.1 (ADR-0066): the exec tools omp is told to PROMPT for, by name. A `command` string in the call's
 *  rawInput is the stronger signal (execCommand). */
export const EXEC_TOOLS = /\b(bash|eval|shell|execute|terminal)\b/;

const record = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

/** The lowercased names a permission ask goes by: the tool call's kind, title and name, plus the request-level tool
 *  names some agents send beside it (`{ tool: "bash", toolCall: {...} }`). */
export function askToolName(toolCall: unknown, ...requestTools: unknown[]): string {
  const tc = record(toolCall);
  return [tc.kind, tc.title, tc.name, tc.toolName, ...requestTools].filter((v) => typeof v === "string" && v).join(" ").toLowerCase();
}

/** Pull the command/code an exec tool call will run, from its rawInput. `command`/`cmd`/`script` always name a
 *  command; `code`/`source`/`input` do only on an exec tool (#616: an edit or apply-patch carries its patch in
 *  `input`, which is text, not a command). */
export function execCommand(toolCall: unknown, toolName: string = askToolName(toolCall)): string | null {
  const tc = record(toolCall);
  const ri = record(tc.rawInput ?? tc.input);
  const keys = EXEC_TOOLS.test(toolName) ? ["command", "cmd", "script", "code", "source", "input"] : ["command", "cmd", "script"];
  for (const k of keys) {
    const v = ri[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/** #612: the floor that no standing scope crosses, for an ask answered WITHOUT a human (Fleet full auto-mode, a
 *  lane's session grant). It is the floor execVerdict keeps under danger mode and allow-turn: a catastrophic
 *  command (ALWAYS_PROMPT) or a managed-denylisted program. Returns why the ask must reach a human, or null when
 *  it is not an exec ask or may run unasked. `requestTools` are the request-level tool names (#616). Pure apart
 *  from `store`. */
export function execFloor(toolCall: unknown, store: ExecStore, ...requestTools: unknown[]): string | null {
  const name = askToolName(toolCall, ...requestTools);
  const cmd = execCommand(toolCall, name);
  if (cmd === null && !EXEC_TOOLS.test(name)) return null;
  const cls = /\beval\b/.test(name) ? classifyEval() : classifyCommand(cmd ?? name);
  return execVerdict({ ...store, dangerMode: true }, cls, { turnAllowed: true }) === "allow" ? null : cls.reason;
}

/** P-EXEC.2 (ADR-0110): omp (≥16.1) delivers its per-tool "Approve/Deny" approval — and plan-mode
 *  approval — as an ACP FORM elicitation whose single `value` property carries the option strings. Pick
 *  the affirmative option to ACCEPT (this elicitation is a redundant INNER gate that only fires after our
 *  own `session/request_permission` gate already allowed the call), or null to DECLINE — a custom
 *  question with no affirmative option must NOT be auto-answered. Pure; matches whole words only so a
 *  "Deny"-only set never counts as approval. */
export function elicitationApproval(options: readonly unknown[]): string | null {
  const opts = (options ?? []).filter((v): v is string => typeof v === "string");
  return opts.find((v) => /\b(approve|allow|yes|proceed|accept)\b/i.test(v)) ?? null;
}

/** P-FLEET.L15 (ADR-0338): the ACP response to omp's form elicitation.
 *  `decline` is the fail-closed default: omp reads anything that is not an explicit accept as a denial. */
export interface ElicitationAnswer { action: "accept" | "decline"; content?: { value: string } }

/** The option strings omp offered, read from the ONE place it actually puts them.
 *
 *  This function exists because a second implementation guessed wrong and denied every tool call in a fleet
 *  lane for as long as it shipped. omp sends a JSON-Schema form, so the choices live at
 *  `requestedSchema.properties.value.enum` as an array of STRINGS. They are NOT at `params.options` (that is
 *  the shape of the OUTER `session/request_permission` request, which is a different message with a
 *  different schema) and not at `params.schema.options` (that shape does not exist anywhere). Reading either
 *  of those yields `[]`, which silently becomes a decline. */
export function elicitationOptions(params: unknown): string[] {
  if (!params || typeof params !== "object" || !("requestedSchema" in params)) return [];
  const schema = params.requestedSchema;
  if (!schema || typeof schema !== "object" || !("properties" in schema)) return [];
  const props = schema.properties;
  if (!props || typeof props !== "object" || !("value" in props)) return [];
  const value = props.value;
  if (!value || typeof value !== "object" || !("enum" in value)) return [];
  const list = value.enum;
  return Array.isArray(list) ? list.filter((v): v is string => typeof v === "string") : [];
}

/** Answer omp's form elicitation by accepting the affirmative option.
 *
 *  This is a REDUNDANT inner gate: it only fires after our authoritative `session/request_permission` gate
 *  already allowed the call, so accepting here re-states a decision a human or an explicit auto-approve
 *  policy already made. A form with no affirmative option is a custom question rather than an approval, and
 *  gets `decline` instead of a synthesized answer, which matches the pre-capability behavior.
 *
 *  The RESPONSE SHAPE is load-bearing too: omp wants `{ action: "accept", content: { value } }`. Returning
 *  a bare `{ value }`, or `{}`, is read as "denied by user" with no prompt shown anywhere. */
export function elicitationAnswer(params: unknown): ElicitationAnswer {
  const approve = elicitationApproval(elicitationOptions(params));
  return approve ? { action: "accept", content: { value: approve } } : { action: "decline" };
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
