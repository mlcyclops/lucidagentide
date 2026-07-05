// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/goal_memory.ts
//
// P-GOAL.3 (ADR-0046): the loop's durable on-disk MEMORY. A markdown file under
// `<workspace>/.omp/loops/` that survives the conversation — Osmani's point that "the model forgets
// everything between runs, so the memory has to be on disk, not in the context. The agent forgets, the
// repo doesn't." The loop appends what each iteration did + the checker's verdict, then the result, so
// the run is auditable on disk and a future P-GOAL.4 can read it back to RESUME from where it stopped.
//
// The loop owns this file (server-side writes), confined under the loops root via pathWithin.

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathWithin } from "./path_guard.ts";
import { type LoopRunRecord, parseRunLog, runRecordLine } from "./loop_runlog.ts";

export interface GoalMemory { path: string; rel: string }

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "goal";
}

/** Create the memory file and write its header. Returns null if the path is unsafe or unwritable
 *  (the loop still runs — the memory is best-effort durability, never a precondition). */
export function startGoalMemory(workspace: string, id: string, opts: { goal: string; condition: string; command?: string }): GoalMemory | null {
  const root = join(workspace, ".omp", "loops");
  const file = `${id}-${slugify(opts.goal)}.md`;
  const target = pathWithin(root, join(root, file));
  if (!target) return null;
  try {
    mkdirSync(dirname(target), { recursive: true });
    const head =
      `# Goal loop: ${opts.goal}\n\n` +
      `- condition: ${opts.condition}\n` +
      (opts.command ? `- verify: \`${opts.command}\`\n` : "") +
      `- status: running\n\n`;
    writeFileSync(target, head, "utf8");
    return { path: target, rel: join(".omp", "loops", file) };
  } catch { return null; }
}

/** Append one iteration's outcome (the maker's summary + the checker's verdict). */
export function appendGoalIteration(mem: GoalMemory | null, n: number, summary: string, verdict: { done: boolean; reason: string }): void {
  if (!mem) return;
  const body =
    `## Iteration ${n}\n` +
    `${(summary || "(no summary)").trim().slice(0, 1200)}\n\n` +
    `**checker:** ${verdict.done ? "condition met" : "not yet"} · ${verdict.reason}\n\n`;
  try { appendFileSync(mem.path, body, "utf8"); } catch { /* best-effort */ }
}

/** Record the loop's final outcome. */
export function finishGoalMemory(mem: GoalMemory | null, result: string): void {
  if (!mem) return;
  try { appendFileSync(mem.path, `## Result\n${result}\n`, "utf8"); } catch { /* best-effort */ }
}

/** P-GOAL.9 (ADR-0054): write the loop's After-Action Report next to its memory file (same
 *  `<id>-<slug>` stem, `.report.md`). Best-effort like the memory itself — a failed write never
 *  affects the loop's outcome. Returns the workspace-relative path on success, else null. */
export function saveGoalReport(workspace: string, id: string, goal: string, markdown: string): string | null {
  const root = join(workspace, ".omp", "loops");
  const file = `${id}-${slugify(goal)}.report.md`;
  const target = pathWithin(root, join(root, file));
  if (!target) return null;
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, markdown, "utf8");
    return join(".omp", "loops", file);
  } catch { return null; }
}

/** P-GOAL.12 (ADR-0057): write a Pre-Flight Audit's Loop Design report under `.omp/loops/`
 *  (`<id>-<slug>.preflight.md`). Best-effort; returns the workspace-relative path or null. */
export function savePreflightReport(workspace: string, id: string, goal: string, markdown: string): string | null {
  const root = join(workspace, ".omp", "loops");
  const file = `${id}-${slugify(goal)}.preflight.md`;
  const target = pathWithin(root, join(root, file));
  if (!target) return null;
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, markdown, "utf8");
    return join(".omp", "loops", file);
  } catch { return null; }
}

// ── P-GOAL.14 (ADR-0112): browse PAST After-Action Reports ─────────────────────────────────────────

export interface PastReport { rel: string; id: string; goal: string; outcome: string; updatedAt: number }

/** Extract the goal title + outcome badge from a report's markdown (pure) for the past-AAR list. */
export function summarizeReport(markdown: string): { goal: string; outcome: string } {
  const goal = /^#\s+After-Action Report:\s*(.+)$/m.exec(markdown ?? "")?.[1]?.trim() ?? "loop";
  // The outcome line is the first "**<badge>**" after the title, e.g. "**✅ Goal met** - …".
  const outcome = /\*\*(✅[^*]+|⏹️[^*]+|🛑[^*]+|❗[^*]+)\*\*/.exec(markdown ?? "")?.[1]?.trim() ?? "";
  return { goal: goal.slice(0, 120), outcome };
}

/** List the workspace's saved After-Action Reports (`.omp/loops/<id>-<slug>.report.md`), most-recent
 *  first. Best-effort + confined to the loops root; empty when none. The `id` is the loop id (the same
 *  stem the memory + run-log share). */
export function listGoalReports(workspace: string, limit = 50, archived = false): PastReport[] {
  const root = join(workspace, ".omp", "loops");
  const dir = archived ? join(root, "archived") : root;
  if (!existsSync(dir)) return [];
  let files: string[];
  try { files = readdirSync(dir); } catch { return []; }
  const out: PastReport[] = [];
  for (const f of files) {
    if (!f.endsWith(".report.md")) continue; // the `archived/` subdir is a dir → naturally skipped in active
    const target = pathWithin(root, join(dir, f));
    if (!target) continue;
    try {
      const { goal, outcome } = summarizeReport(readFileSync(target, "utf8"));
      out.push({ rel: archived ? join(".omp", "loops", "archived", f) : join(".omp", "loops", f), id: f.replace(/-.*$/, ""), goal, outcome, updatedAt: statSync(target).mtimeMs });
    } catch { /* skip unreadable */ }
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out.slice(0, Math.max(0, limit));
}

/** Read one saved report's markdown, confined to `.omp/loops/` (active OR archived; rejects traversal). */
export function readGoalReport(workspace: string, rel: string): string | null {
  const root = join(workspace, ".omp", "loops");
  const target = pathWithin(root, join(workspace, rel)); // archived rels live under .omp/loops/archived → still within root
  if (!target) return null;
  try { return readFileSync(target, "utf8"); } catch { return null; }
}

// P-REPORT.2 (ADR-0117): two-stage lifecycle for AARs - archive (soft), then permanent delete from archive.
function moveGoalReport(workspace: string, rel: string, toArchive: boolean): boolean {
  const root = join(workspace, ".omp", "loops");
  const src = pathWithin(root, join(workspace, rel));
  if (!src) return false;
  const name = rel.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
  const dstDir = toArchive ? join(root, "archived") : root;
  const dst = pathWithin(root, join(dstDir, name));
  if (!dst) return false;
  try { mkdirSync(dstDir, { recursive: true }); renameSync(src, dst); return true; } catch { return false; }
}
export function archiveGoalReport(workspace: string, rel: string): boolean { return moveGoalReport(workspace, rel, true); }
export function restoreGoalReport(workspace: string, rel: string): boolean { return moveGoalReport(workspace, rel, false); }
/** Permanent delete - ONLY an archived AAR (rel must be under `.omp/loops/archived/`). */
export function deleteGoalReport(workspace: string, rel: string): boolean {
  if (!/[\\/]archived[\\/]/.test(rel)) return false; // guard: never permanently delete an ACTIVE report
  const root = join(workspace, ".omp", "loops");
  const target = pathWithin(root, join(workspace, rel));
  if (!target) return false;
  try { rmSync(target); return true; } catch { return false; } // NO force: a missing file → false (honest)
}

// ── P-GOAL.10 (ADR-0055): the cross-run evaluation ledger (`.omp/loops/run-log.jsonl`) ─────────────

const RUN_LOG = "run-log.jsonl";

/** Append one completed loop to the run-log (append-only JSONL). Best-effort: a failed write never
 *  affects the loop. Returns true on success. */
export function appendRunLog(workspace: string, record: LoopRunRecord): boolean {
  const root = join(workspace, ".omp", "loops");
  const target = pathWithin(root, join(root, RUN_LOG));
  if (!target) return false;
  try {
    mkdirSync(dirname(target), { recursive: true });
    appendFileSync(target, runRecordLine(record) + "\n", "utf8");
    return true;
  } catch { return false; }
}

/** Read the run-log back into records (most-recent first), for the evaluation surface. Empty when the
 *  ledger is missing/unreadable — never throws. */
export function readRunLog(workspace: string): LoopRunRecord[] {
  const root = join(workspace, ".omp", "loops");
  const target = pathWithin(root, join(root, RUN_LOG));
  if (!target) return [];
  try {
    const records = parseRunLog(readFileSync(target, "utf8"));
    return records.sort((a, b) => b.ts - a.ts);
  } catch { return []; }
}

// ── P-GOAL.4: read a memory file back to RESUME a stopped loop ─────────────────

export interface ParsedGoalMemory { goal: string; condition: string; command?: string; iterations: number; succeeded: boolean; result?: string }

/** Pure parser: pull the loop's parameters + progress out of a memory markdown. `succeeded` is true
 *  when the final Result says the goal was met — those loops are NOT resumable. Returns null if the
 *  file isn't a loop-memory record. */
export function parseGoalMemory(content: string): ParsedGoalMemory | null {
  const goal = /^#\s+Goal loop:\s*(.+)$/m.exec(content ?? "")?.[1]?.trim();
  if (!goal) return null;
  const condition = /^-\s*condition:\s*(.+)$/m.exec(content)?.[1]?.trim() ?? "";
  const command = /^-\s*verify:\s*`([^`]+)`/m.exec(content)?.[1]?.trim();
  const iterations = (content.match(/^##\s+Iteration\s+\d+/gm) ?? []).length;
  const result = /##\s+Result\s*\n([\s\S]*?)\s*$/.exec(content)?.[1]?.trim();
  const succeeded = /\bgoal met\b/i.test(result ?? "");
  return { goal, condition, command, iterations, succeeded, result };
}

export interface ResumableLoop { rel: string; goal: string; condition: string; command?: string; iterations: number; updatedAt: number }

/** List incomplete loop-memory files (most-recent first), so a stopped loop can be resumed. */
export function listResumableLoops(workspace: string): ResumableLoop[] {
  const root = join(workspace, ".omp", "loops");
  if (!existsSync(root)) return [];
  const out: (ResumableLoop & { _mt: number })[] = [];
  let files: string[];
  try { files = readdirSync(root); } catch { return []; }
  for (const f of files) {
    if (!f.endsWith(".md")) continue;
    const target = pathWithin(root, join(root, f));
    if (!target) continue;
    try {
      const parsed = parseGoalMemory(readFileSync(target, "utf8"));
      if (!parsed || parsed.succeeded) continue; // only loops that did NOT meet their condition
      out.push({ rel: join(".omp", "loops", f), goal: parsed.goal, condition: parsed.condition, command: parsed.command, iterations: parsed.iterations, updatedAt: statSync(target).mtimeMs, _mt: statSync(target).mtimeMs });
    } catch { /* skip unreadable */ }
  }
  out.sort((a, b) => b._mt - a._mt);
  return out.map(({ _mt, ...r }) => r);
}

/** Resolve an existing loop-memory file (confined to `.omp/loops/`), append a "Resumed" marker, and
 *  return the handle + the prior content to inject into the maker prompt. Null if not found / unsafe. */
export function resumeGoalMemory(workspace: string, rel: string): { mem: GoalMemory; prior: string } | null {
  const root = join(workspace, ".omp", "loops");
  const target = pathWithin(root, join(workspace, rel)); // confined to .omp/loops/ (rejects traversal)
  if (!target) return null;
  try {
    // No existsSync precheck: readFileSync below fails closed (throws → caught → null) when the file is
    // missing, so a separate existence check would only add a check-then-use TOCTOU window (js/file-system-race).
    const prior = readFileSync(target, "utf8");
    appendFileSync(target, `\n## Resumed\n\n`, "utf8");
    return { mem: { path: target, rel }, prior };
  } catch { return null; }
}
