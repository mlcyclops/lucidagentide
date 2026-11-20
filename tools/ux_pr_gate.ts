// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// tools/ux_pr_gate.ts: the UX review gate for pull requests (P-SETUX.1, ADR-0617, AGENTS.md invariant #12).
//
//   bun run tools/ux_pr_gate.ts --base <ref> --head <ref> --body-file <path>
//   bun run tools/ux_pr_gate.ts                      # base origin/master, head HEAD, body from $PR_BODY
//
// When the PR changes any UI surface (desktop/renderer/** except tests, bundles and vendor; desktop/*.html;
// mockups/**), the PR body must carry the "## UX review" section from .github/pull_request_template.md with
// EVERY checklist box ticked, or one explicit line `UX: N/A (reason)`. Independently, every ADDED line of a
// UI file is scanned for U+2014 (em dash, forbidden by AGENTS.md "Writing style"); hits fail with file:line.
// The decision is the pure `evaluateUxGate`; only the CLI below touches git. Checklist: docs/UX-PR-CHECKLIST.md.

import { readFileSync } from "node:fs";

/** The checklist items, in template order. A box matches an item when its text starts with `key`. */
export const UX_CHECKLIST: readonly { key: string; text: string }[] = [
  { key: "Complexity budget", text: "a new control, card, rail button or overlay removes, merges or justifies one; new count stated" },
  { key: "Discoverability", text: "every button that opens a surface lands on the relevant section, in front of the current view" },
  { key: "Z-order", text: "any new overlay declares its layer in the documented stack (docs/UX-REVIEW.md)" },
  { key: "Text layout", text: "invariant #11: one-line ellipsized labels, minmax(220px,1fr) or wider, no prose in a flex row" },
  { key: "No em dashes", text: "no U+2014 in any added string, comment or doc" },
  { key: "Honest states", text: "empty, loading and error states say what is true; no wall of zeros, no fake success" },
  { key: "Keyboard and focus", text: "Esc closes, focus moves in and returns, every icon button has an accessible name" },
  { key: "Light and dark themes", text: "checked in both themes" },
  { key: "New-user path", text: "a first-run user can reach and understand the change without reading docs" },
  { key: "Served bytes", text: "build-renderer, then a marker grepped in the served /app.js or /styles.css; screenshot or recording attached" },
  { key: "Real-UI check", text: "the changed control driven with real input in every layout it lives in; elementFromPoint proves it is on top; kept as desktop/scripts/demo_<id>.mjs" },
  { key: "Spacing", text: "auditBoxes (desktop/scripts/demo_p_spacing_1.mjs) passes on the changed surface in every layout: no touching boxes, stacked fields share a width, even card rhythm" },
];

const EM_DASH = "\u2014";

/** Normalize a repo-relative path (Windows separators, leading ./). */
function norm(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

/** True when `path` is a UI surface: desktop/renderer/** (not *.test.ts, *.bundle.js, vendor/), desktop/*.html, mockups/**. */
export function isUiPath(path: string): boolean {
  const p = norm(path);
  if (p.startsWith("desktop/renderer/")) {
    if (p.endsWith(".test.ts")) return false;
    if (p.endsWith(".bundle.js")) return false;
    if (p.startsWith("desktop/renderer/vendor/")) return false;
    return true;
  }
  if (/^desktop\/[^/]+\.html$/.test(p)) return true;
  return p.startsWith("mockups/");
}

/** Drop HTML comments so template hints (and boxes inside them) never count as answers. */
export function stripHtmlComments(text: string): string {
  return text.replace(/<!--[\s\S]*?(?:-->|$)/g, "");
}

/** The reason from a `UX: N/A (reason)` line, or null. Placeholder reasons ("reason", "why") do not count. */
export function naReason(body: string): string | null {
  for (const line of stripHtmlComments(body).split(/\r?\n/)) {
    const m = /^\s*(?:[-*]\s+)?\**UX:\**\s*N\/A\s*\((.*)\)\s*$/i.exec(line);
    if (!m) continue;
    const reason = (m[1] ?? "").trim();
    if (reason.length < 3 || /^(reason|why)$/i.test(reason)) continue;
    return reason;
  }
  return null;
}

/** The lines of the "UX review" section (heading level 2 or 3), up to the next heading of the same or higher level. */
export function uxSection(body: string): string[] | null {
  const lines = stripHtmlComments(body).split(/\r?\n/);
  const start = lines.findIndex((l) => /^#{2,3}\s+UX review\b/i.test(l.trim()));
  if (start < 0) return null;
  const level = /^#+/.exec(lines[start]!.trim())![0].length;
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const h = /^(#{1,6})\s/.exec(line.trim());
    if (h && h[1]!.length <= level) break;
    out.push(line);
  }
  return out;
}

export interface Checkbox { checked: boolean; text: string }

/** Markdown task-list items (`- [ ] x`, `* [x] x`). */
export function checkboxes(lines: readonly string[]): Checkbox[] {
  const out: Checkbox[] = [];
  for (const line of lines) {
    const m = /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/.exec(line);
    if (m) out.push({ checked: m[1] !== " ", text: (m[2] ?? "").trim() });
  }
  return out;
}

export interface AddedLine { file: string; line: number; text: string }

/** Every added line of a unified diff (`git diff --unified=0` or wider), with its new-file line number. */
export function parseAddedLines(diff: string): AddedLine[] {
  const out: AddedLine[] = [];
  let file: string | null = null;
  let inHunk = false;
  let next = 0;
  for (const raw of diff.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.startsWith("diff --git ")) { file = null; inHunk = false; continue; }
    if (!inHunk) {
      if (line.startsWith("+++ ")) {
        const target = line.slice(4).replace(/\t$/, ""); // git appends a tab after names containing spaces
        file = target === "/dev/null" ? null : norm(target.replace(/^b\//, ""));
      }
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) { inHunk = true; next = Number(hunk[1]); continue; }
    if (!inHunk || file === null) continue;
    if (line.startsWith("+")) { out.push({ file, line: next, text: line.slice(1) }); next++; }
    else if (line.startsWith(" ")) next++;
  }
  return out;
}

export interface UxGateInput {
  changedFiles: readonly string[];
  prBody: string;
  addedLines: readonly AddedLine[];
}

export interface UxGateResult {
  ok: boolean;
  uiFiles: string[];
  /** "skip": no UI file changed; "na": an explicit N/A line; "checklist": the section was evaluated. */
  mode: "skip" | "na" | "checklist";
  errors: string[];
  emDashes: AddedLine[];
}

/** The whole decision. Pure: no git, no network, no filesystem. */
export function evaluateUxGate(input: UxGateInput): UxGateResult {
  const uiFiles = input.changedFiles.map(norm).filter((p) => p !== "" && isUiPath(p));
  const emDashes = input.addedLines.filter((a) => isUiPath(a.file) && a.text.includes(EM_DASH));
  const errors: string[] = [];
  let mode: UxGateResult["mode"] = "skip";

  if (uiFiles.length > 0) {
    if (naReason(input.prBody) !== null) {
      mode = "na";
    } else {
      mode = "checklist";
      const section = uxSection(input.prBody);
      if (section === null) {
        errors.push(
          `This PR changes ${uiFiles.length} UI file(s) but the PR body has no "## UX review" section and no "UX: N/A (reason)" line. ` +
            "Copy the section from .github/pull_request_template.md (checklist: docs/UX-PR-CHECKLIST.md).",
        );
      } else {
        const boxes = checkboxes(section);
        for (const item of UX_CHECKLIST) {
          const want = item.key.toLowerCase();
          const box = boxes.find((b) => b.text.replace(/^[*_`\s]+/, "").toLowerCase().startsWith(want));
          if (!box) errors.push(`UX review: the "${item.key}" checkbox is missing.`);
          else if (!box.checked) errors.push(`UX review: "${item.key}" is not checked.`);
        }
      }
    }
  }

  for (const hit of emDashes) {
    errors.push(`${hit.file}:${hit.line}: added line contains an em dash (U+2014); use a comma, colon, period or hyphen.`);
  }
  return { ok: errors.length === 0, uiFiles, mode, errors, emDashes };
}

// ---------------------------------------------------------------- CLI (the only part that runs git)

function git(args: string[]): string {
  const r = Bun.spawnSync(["git", "-c", "core.quotePath=false", ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString().trim()}`);
  return r.stdout.toString();
}

function flag(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const base = flag(args, "--base") ?? process.env.BASE_SHA ?? "origin/master";
  const head = flag(args, "--head") ?? process.env.HEAD_SHA ?? "HEAD";
  const bodyFile = flag(args, "--body-file");
  const prBody = bodyFile ? readFileSync(bodyFile, "utf8") : (process.env.PR_BODY ?? "");
  const range = `${base}...${head}`;

  const changedFiles = git(["diff", "--name-only", "--no-renames", range]).split("\n").filter((l) => l.trim() !== "");
  const uiChanged = changedFiles.filter(isUiPath);
  const addedLines = uiChanged.length > 0
    ? parseAddedLines(git(["diff", "--unified=0", "--no-color", "--no-ext-diff", "--no-renames", range, "--", ...uiChanged]))
    : [];

  const result = evaluateUxGate({ changedFiles, prBody, addedLines });
  const gha = process.env.GITHUB_ACTIONS === "true";
  if (gha) for (const hit of result.emDashes) console.log(`::error file=${hit.file},line=${hit.line}::em dash (U+2014) in an added UI line`);

  if (result.mode === "skip") console.log("ux-pr-gate: no UI surface changed; checklist not required.");
  else console.log(`ux-pr-gate: ${result.uiFiles.length} UI file(s) changed; ${result.mode === "na" ? "UX: N/A declared" : "UX review checklist evaluated"}.`);
  if (result.ok) {
    console.log("ux-pr-gate: pass.");
  } else {
    for (const e of result.errors) console.error(gha ? `::error::${e}` : `x ${e}`);
    console.error(`ux-pr-gate: FAIL (${result.errors.length} problem(s)). See docs/UX-PR-CHECKLIST.md.`);
    process.exit(1);
  }
}
