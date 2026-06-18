// harness/runs/replay.ts
//
// Replay a run (P7.2): reconstruct the run tree, the telemetry timeline across the
// whole subtree, and the suspicious-content / injection / approval lineage. This
// is read-only forensic reconstruction — it renders what happened and where
// suspicious content flowed.

import { getRunTree, type RunNode } from "./lineage.ts";
import type { Db, Row } from "../memory/db.ts";

export interface ReplayTotals {
  runs: number;
  suspicious: number;
  findings: number;
  approvals: number;
}

export interface Replay {
  rootRunId: string;
  tree: RunNode;
  /** Telemetry events across the run subtree, ordered by time (replay timeline). */
  timeline: Row[];
  totals: ReplayTotals;
}

function walk(node: RunNode, visit: (n: RunNode) => void): void {
  visit(node);
  for (const c of node.children) walk(c, visit);
}

export async function buildReplay(db: Db, rootRunId: string): Promise<Replay | undefined> {
  const tree = await getRunTree(db, rootRunId);
  if (!tree) return undefined;

  const runIds: string[] = [];
  const totals: ReplayTotals = { runs: 0, suspicious: 0, findings: 0, approvals: 0 };
  walk(tree, (n) => {
    runIds.push(n.runId);
    totals.runs++;
    totals.suspicious += n.suspiciousArtifacts;
    totals.findings += n.findingCount;
    totals.approvals += n.approvalCount;
  });

  const placeholders = runIds.map((_, i) => `$${i + 1}`).join(",");
  const timeline = runIds.length
    ? await db.all(
        `SELECT ts, event, run_id, artifact_id FROM telemetry_events
         WHERE run_id IN (${placeholders}) ORDER BY ts, event_id`,
        runIds,
      )
    : [];

  return { rootRunId, tree, timeline, totals };
}

/** Render a replay as inspectable text: the run tree (with suspicious flow) + a
 *  totals line + the event timeline. */
export function renderReplay(r: Replay): string {
  const lines: string[] = [`replay of run ${r.rootRunId}`];
  const renderNode = (n: RunNode, depth: number) => {
    const pad = "  ".repeat(depth);
    const flow = `findings=${n.findingCount} approvals=${n.approvalCount} suspicious=${n.suspiciousArtifacts}`;
    lines.push(`${pad}- ${n.kind}/${n.mode ?? "-"} [${n.runId.slice(-6)}] ${n.status} sandbox=${n.sandboxProfile ?? "-"} (${flow})`);
    for (const c of n.children) renderNode(c, depth + 1);
  };
  renderNode(r.tree, 0);
  lines.push(`totals: runs=${r.totals.runs} suspicious=${r.totals.suspicious} findings=${r.totals.findings} approvals=${r.totals.approvals}`);
  lines.push(`timeline: ${r.timeline.length} events`);
  for (const e of r.timeline) lines.push(`  ${e.ts} ${e.event}${e.artifact_id ? ` artifact=${String(e.artifact_id).slice(-6)}` : ""}`);
  return lines.join("\n");
}
