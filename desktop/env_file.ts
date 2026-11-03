// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/env_file.ts
//
// P-VAULT-ENV.1 (ADR-0477): the pure half of `.env` import. No fs, no vault, no logging: values pass
// through these functions and are never written anywhere by them.
//   - parseDotEnv: KEY=value lines, an optional `export ` prefix, full-line and inline comments, single,
//     double and backtick quotes, multi-line quoted values, double-quote escapes. Duplicate names: the
//     last assignment wins (what dotenv loaders do), every occurrence keeps its line span.
//   - blankDotEnv: rewrite chosen assignments to `NAME=` placeholders (every occurrence, multi-line values
//     collapsed), leaving comments, blank lines, other names and the line-ending style as they were.
//   - mapEnvName: which vault slot a name lands in: the per-host git token slots (git_url.ts, the same
//     refs Settings > Git saves), the provider key slots (`key:<ENV>`, what settings_store.setKey writes),
//     else the workspace-scoped `ws:<hash>:<ENV>` ref (vault_store.workspaceRef).

import { gitCredRef, gitTokenEnvName } from "./git_url.ts";
import type { VaultKind } from "./engine_vault.ts";

/** One `NAME=value` occurrence. Lines are 1-based and inclusive (a multi-line value spans several). */
export interface DotEnvAssignment { name: string; value: string; startLine: number; endLine: number; exported: boolean }
/** A line the parser could not read; the line number only, never its text (it may hold a secret). */
export interface DotEnvProblem { line: number; reason: string }
export interface DotEnvParse {
  /** Every assignment in file order (duplicates included). */
  assignments: DotEnvAssignment[];
  /** One per name, the LAST assignment of that name, in order of first appearance. */
  entries: DotEnvAssignment[];
  problems: DotEnvProblem[];
}

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ASSIGN_RE = /^(\s*)(export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s?(.*)$/;

/** Decode the escapes a double-quoted dotenv value understands; anything else keeps its backslash. */
function unescapeDouble(s: string): string {
  return s.replace(/\\([nrt"\\$`'])/g, (_m, c: string) => (c === "n" ? "\n" : c === "r" ? "\r" : c === "t" ? "\t" : c));
}

/** Index of the closing quote in `s` from `from`, honoring backslash escapes for double quotes. -1 if none. */
function closingQuote(s: string, q: string, from: number): number {
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (q === "\"" && c === "\\") { i++; continue; }
    if (c === q) return i;
  }
  return -1;
}

export function parseDotEnv(text: string): DotEnvParse {
  const lines = String(text ?? "").replace(/^\uFEFF/, "").split(/\r?\n/);
  const assignments: DotEnvAssignment[] = [];
  const problems: DotEnvProblem[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = ASSIGN_RE.exec(raw);
    if (!m) { problems.push({ line: i + 1, reason: "not a NAME=value line" }); continue; }
    const exported = !!m[2];
    const name = m[3]!;
    const rest = m[4]!.replace(/^\s+/, "");
    const q = rest[0];
    if (q === "\"" || q === "'" || q === "`") {
      // A quoted value: it may close on this line or continue over the following ones.
      let buf = rest.slice(1);
      let end = closingQuote(buf, q, 0);
      let j = i;
      while (end < 0 && j + 1 < lines.length) {
        j++;
        buf += "\n" + lines[j]!;
        end = closingQuote(buf, q, 0);
      }
      if (end < 0) { problems.push({ line: i + 1, reason: "a quoted value is never closed" }); continue; }
      const inner = buf.slice(0, end);
      // After the closing quote: nothing, whitespace, or a whitespace-led `#` comment.
      if (!/^\s*(#.*)?$/.test(buf.slice(end + 1))) {
        problems.push({ line: j + 1, reason: "unexpected text after the closing quote" });
        i = j;
        continue;
      }
      assignments.push({ name, value: q === "\"" ? unescapeDouble(inner) : inner, startLine: i + 1, endLine: j + 1, exported });
      i = j;
      continue;
    }
    // Unquoted: an inline comment starts at a `#` preceded by whitespace (`a#b` keeps its `#`).
    const hash = rest.search(/\s#/);
    const value = (hash >= 0 ? rest.slice(0, hash) : rest.startsWith("#") ? "" : rest).trimEnd();
    assignments.push({ name, value, startLine: i + 1, endLine: i + 1, exported });
  }
  const last = new Map<string, DotEnvAssignment>();
  const order: string[] = [];
  for (const a of assignments) {
    if (!last.has(a.name)) order.push(a.name);
    last.set(a.name, a);
  }
  return { assignments, entries: order.map((n) => last.get(n)!), problems };
}

/** Replace the chosen names' assignments with `NAME=` placeholders (all names when `names` is omitted).
 *  Indentation and an `export ` prefix are kept; every other line is untouched, byte for byte. */
export function blankDotEnv(text: string, names?: ReadonlySet<string>): string {
  const src = String(text ?? "");
  const bom = src.startsWith("\uFEFF") ? "\uFEFF" : "";
  const eol = src.includes("\r\n") ? "\r\n" : "\n";
  const lines = src.slice(bom.length).split(/\r?\n/);
  const { assignments } = parseDotEnv(src);
  const replace = new Map<number, { endLine: number; text: string }>();
  for (const a of assignments) {
    if (names && !names.has(a.name)) continue;
    const indent = /^\s*/.exec(lines[a.startLine - 1] ?? "")?.[0] ?? "";
    replace.set(a.startLine, { endLine: a.endLine, text: `${indent}${a.exported ? "export " : ""}${a.name}=` });
  }
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const r = replace.get(i + 1);
    if (r) { out.push(r.text); i = r.endLine - 1; continue; }
    out.push(lines[i]!);
  }
  return bom + out.join(eol);
}

// ── mapping a name to its vault slot ─────────────────────────────────────────────────────────────────

/** The git-host token names `hostTokenForUrl` (workspace.ts) already reads, and the host whose saved
 *  token slot each one fills. GITHUB_TOKEN outranks GH_TOKEN, the same order hostTokenForUrl picks. */
export const GIT_HOST_ENV: Readonly<Record<string, string>> = {
  GITHUB_TOKEN: "github.com",
  GH_TOKEN: "github.com",
  GITLAB_TOKEN: "gitlab.com",
  AZURE_DEVOPS_EXT_PAT: "dev.azure.com",
};

export type EnvSlotKind = "git-host" | "provider-key" | "workspace";
export interface EnvSlot {
  slot: EnvSlotKind;
  /** The vault ref the value is stored under. */
  ref: string;
  /** The env var the engine injects it as (`LUCID_GIT_PAT_<HOST>` for a git slot). */
  envName: string;
  kind: VaultKind;
  /** Git host for a git slot. */
  host?: string;
}

/** A reasonable kind for a workspace secret from its name and shape (metadata only; never decisive). */
export function guessKind(name: string, value: string): VaultKind {
  if (/^-----BEGIN [A-Z ]+-----/.test(value.trim())) return "pem";
  if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/.test(value)) return "jwt";
  const n = name.toUpperCase();
  if (/(^|_)PAT$/.test(n)) return "pat";
  if (/(API_?KEY|_KEY|SECRET_KEY|ACCESS_KEY)$/.test(n)) return "apikey";
  if (/(TOKEN|BEARER)$/.test(n)) return "token";
  if (/(PASSWORD|PASSWD|PASS|PWD)$/.test(n)) return "password";
  return "other";
}

/** The slot `name` imports into. `workspaceRefOf` is vault_store.workspaceRef bound to the workspace
 *  realpath (injected so this module stays pure); `providerEnvs` is the provider key env names. */
export function mapEnvName(
  name: string, value: string, providerEnvs: ReadonlySet<string>, workspaceRefOf: (envName: string) => string,
): EnvSlot {
  if (!NAME_RE.test(name)) throw new Error("invalid environment variable name");
  const host = GIT_HOST_ENV[name];
  if (host) return { slot: "git-host", ref: gitCredRef(host), envName: gitTokenEnvName(host), kind: "pat", host };
  if (providerEnvs.has(name)) return { slot: "provider-key", ref: `key:${name}`, envName: name, kind: "apikey" };
  return { slot: "workspace", ref: workspaceRefOf(name), envName: name, kind: guessKind(name, value) };
}
