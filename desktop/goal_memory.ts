// desktop/goal_memory.ts
//
// P-GOAL.3 (ADR-0046): the loop's durable on-disk MEMORY. A markdown file under
// `<workspace>/.omp/loops/` that survives the conversation — Osmani's point that "the model forgets
// everything between runs, so the memory has to be on disk, not in the context. The agent forgets, the
// repo doesn't." The loop appends what each iteration did + the checker's verdict, then the result, so
// the run is auditable on disk and a future P-GOAL.4 can read it back to RESUME from where it stopped.
//
// The loop owns this file (server-side writes), confined under the loops root via pathWithin.

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathWithin } from "./path_guard.ts";

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
