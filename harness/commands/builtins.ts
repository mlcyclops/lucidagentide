// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/commands/builtins.ts — P-CMD.2 (ADR-0148): commands LUCID ships, presented exactly like the
// user's own saved "/" commands (same UserCommand shape, same expansion, same autocomplete). Merged into
// the list SERVER-side by `withBuiltins`: a user-saved command with the same name SHADOWS the builtin
// (their vocabulary wins), and deleting that user command resurfaces the builtin — no special cases
// anywhere downstream. Builtins are code, not workspace files, so the import gate/scanner path does not
// apply; they change only through a PR to this file.

import type { UserCommand } from "./spec.ts";

const NOW = 1_751_700_000_000;

/** /licensing — a guided, approval-gated walkthrough that applies the user's company license headers
 *  across their codebase. Interactive by design: it NEVER writes before the user approves the plan, and
 *  vendored/third-party trees are excluded loudly, not silently relicensed. */
const LICENSING: UserCommand = {
  name: "licensing",
  description: "Apply your company's license headers across the codebase — guided, approval-gated",
  mode: "send",
  spec_version: 1,
  created_at: NOW,
  updated_at: NOW,
  body: [
    "You are running LUCID's guided LICENSING walkthrough. Work with me interactively; NEVER write a file before I approve the plan.",
    "",
    "Context seed (may be empty): $ARGS",
    "",
    "1) DISCOVER the current state first: detect any existing license convention (LICENSE/COPYING files, SPDX headers, a header-check script, a pre-commit hook) and report it with counts — files WITH vs WITHOUT headers, grouped by top-level directory.",
    "2) INTERVIEW me for what you could not infer, in ONE short question set: the legal owner name exactly as it should appear; the license (an SPDX id like MIT / Apache-2.0 / BUSL-1.1, or proprietary text I paste); the copyright year or range; which trees are FIRST-PARTY vs vendored/generated. NEVER relicense vendor/, node_modules/, dist/, build outputs, or third-party code — list your planned exclusions and let me amend them.",
    "3) PLAN before touching anything: show the exact header block per file type using each language's comment syntax (// for TS/JS/Go/Rust/C-family, # for Python/shell/YAML/TOML, <!-- --> for HTML/Markdown/XML, /* */ for CSS, ; for INI), plus the per-directory counts the plan will touch. WAIT for my explicit approval.",
    "4) APPLY idempotently after approval: skip files already carrying the SPDX line or the exact header; insert AFTER a shebang or XML declaration when present; read each file then write it (never exists-then-read). Batch by directory and report progress as counts, not per-file noise.",
    "5) FINISH with totals (headered / already-had / excluded), then offer: (a) a header-check script suitable for CI, (b) a pre-commit hook that auto-applies headers to staged files, and (c) a LICENSE file if none exists. If any file's ownership looks ambiguous (mixed third-party code, a different pre-existing header), list it for my manual review instead of guessing.",
  ].join("\n"),
};

export const BUILTIN_COMMANDS: readonly UserCommand[] = [LICENSING];

/** User-saved commands first; builtins fill the names the user has not claimed. */
export function withBuiltins(userCommands: UserCommand[]): UserCommand[] {
  const taken = new Set(userCommands.map((c) => c.name));
  return [...userCommands, ...BUILTIN_COMMANDS.filter((b) => !taken.has(b.name))];
}
