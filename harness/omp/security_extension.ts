// harness/omp/security_extension.ts
//
// Load this into a real omp session to put the Lucid Agent IDE security gate in
// front of every tool call:
//
//   omp -e harness/omp/security_extension.ts --model <model> "..."
//
// It scans every string in each tool_call (bash command, write content, custom
// tool args, …) through the Python Unicode scanner and BLOCKS the call when the
// content is quarantined — fail-closed if the scanner is unavailable. Each block
// is logged to <repo>/agent_obs.duckdb so it shows up in the dashboard
// (`bun run dashboard:tui`). DB logging is best-effort and never breaks the gate.
//
// Intentionally omp-import-free (typed `any`) so it loads under any omp version —
// it only depends on our own scanner/gate/notification modules.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ScannerClient } from "../security/scanner_client.ts";
import { scanAndDecide, type GatePolicy } from "../security/gate.ts";
import { buildNotification, summarizeNotification } from "../security/notification.ts";
import type { Db } from "../memory/db.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(HERE, "..", "..", "agent_obs.duckdb");
const LIVE_RUN = "omp-live";

const scanner = new ScannerClient();
scanner.start();

// The gate scans the model's OWN tool args (the bash command it wrote, the file content it
// authored, custom-tool inputs). A homoglyph-only hit there is not an injection against the
// model — it's legitimate when the model emits a Greek-letter variable (Δv, νₑ) or writes
// about spoofing — so it is RECORDED-but-not-blocked. The dangerous, never-legitimate vectors
// (zero-width, bidi-control, tag-block, private-use) still hard-block. External / imported
// text is scanned on a different path with the strict DEFAULT_POLICY. See ADR-0019.
const TOOL_POLICY: GatePolicy = { blockAtOrAbove: "high", nonBlockingTypes: new Set(["mixed-script-homoglyph"]) };

let dbHandle: Db | undefined;
let dbInit: Promise<Db | null> | undefined;

/** Lazily open (and migrate) the project DuckDB on first block. Best-effort:
 *  returns null if it can't open (e.g. another session holds the write lock). */
async function getDb(): Promise<Db | null> {
  if (!dbInit) {
    dbInit = (async () => {
      try {
        const { Db } = await import("../memory/db.ts");
        const { startRun } = await import("../runs/lineage.ts");
        const db = await Db.open(DB_PATH);
        await startRun(db, { runId: LIVE_RUN, kind: "root", mode: "build", sandboxProfile: "trusted-local" }).catch(() => {});
        dbHandle = db;
        return db;
      } catch {
        return null;
      }
    })();
  }
  return dbInit;
}

function shutdown(): void {
  scanner.stop();
  try {
    dbHandle?.close();
  } catch {
    /* ignore */
  }
}
process.on("exit", shutdown);
process.on("SIGINT", () => {
  shutdown();
  process.exit(130);
});

/** Collect every string value in a tool_call event (skip metadata keys). */
function collectStrings(value: unknown, skip: ReadonlySet<string> = new Set(["type", "toolCallId"])): string {
  const parts: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string") parts.push(v);
    else if (Array.isArray(v)) for (const x of v) walk(x);
    else if (v && typeof v === "object") for (const [k, val] of Object.entries(v)) if (!skip.has(k)) walk(val);
  };
  walk(value);
  return parts.join("\n");
}

/** Persist a tool call to the project DB (provenance + scan) and gate-promote a
 *  fact from it — so memory fills from ORDINARY turns, with provenance, across
 *  sessions. Suspicious/quarantined sources are blocked from promotion (keystone
 *  #2). Best-effort and fire-and-forget: it never affects the security decision. */
async function rememberActivity(toolName: string, text: string): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;
    const { ingestArtifact } = await import("../memory/ingest.ts");
    const { promoteFactGated } = await import("../memory/promotion_gate.ts");
    const art = await ingestArtifact(db, scanner, { runId: LIVE_RUN, sourceType: `omp:${toolName}`, rawContent: text }, {});
    const statement = text.replace(/\s+/g, " ").trim().slice(0, 160);
    if (statement.length >= 12) {
      await promoteFactGated(db, { entityName: `omp:${toolName}`, statement, trustLabel: art.trustLabel, sourceArtifactId: art.artifactId }, {}).catch(() => {});
    }
  } catch {
    /* best-effort; the security decision already stands */
  }
}

/** P-TASK.3 (ADR-0028): record an omp `task` dispatch into the run lineage with its pre-dispatch
 *  sandbox disposition. Clean → a subagent child run (profile auto-downgraded for the assignment's
 *  trust); blocked → a read-only security-review run instead of the dispatch. Best-effort and
 *  fire-and-forget: it NEVER influences the gate's fail-closed decision (already made by the caller). */
async function recordTaskDispatch(decision: { block: boolean; trustLabel: any }): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;
    const { gateTaskDispatch } = await import("../runs/task_gate.ts");
    await gateTaskDispatch(db, LIVE_RUN, { block: decision.block, trustLabel: decision.trustLabel });
  } catch {
    /* best-effort lineage; the security decision already stands */
  }
}

/** P-LOC.1 (ADR-0031): count an AI-authored file mutation that PASSED the gate (a successful
 *  omp `write`/`edit` tool_result) into the AI-LOC attribution ledger. The authoring model and the
 *  attribution identity are threaded in from the IDE via env at omp spawn (LUCID_MODEL / LUCID_IDENTITY /
 *  LUCID_IDENTITY_SOURCE / LUCID_REPO); the lines come from omp's own post-apply diff. Best-effort and
 *  fire-and-forget: it NEVER influences the gate's fail-closed decision. */
async function recordEditLoc(event: any): Promise<void> {
  try {
    if (event?.toolName !== "write" && event?.toolName !== "edit") return;
    const db = await getDb();
    if (!db) return;
    const { recordAiEdit } = await import("../runs/loc_ledger.ts");
    const src = process.env.LUCID_IDENTITY_SOURCE;
    await recordAiEdit(db, event, {
      model: process.env.LUCID_MODEL || "unknown",
      identity: process.env.LUCID_IDENTITY || "unknown",
      identitySource: src === "email" || src === "workstation" ? src : "unknown",
      repo: process.env.LUCID_REPO || process.cwd(),
      runId: LIVE_RUN,
    });
  } catch {
    /* best-effort attribution; the security decision already stands */
  }
}

// omp extensions are `(pi) => void` and register handlers via pi.on(...).
export default function securityExtension(pi: any): void {
  pi.on("tool_call", async (event: any) => {
    const toolName: string = event?.toolName ?? "tool";
    const text = collectStrings(event);
    const decision = await scanAndDecide(scanner, text, TOOL_POLICY);
    const isTask = toolName === "task"; // omp's subagent-spawn tool — gate + bind it to lineage
    if (!decision.block) {
      if (isTask) void recordTaskDispatch(decision); // dispatched: subagent run + sandbox profile
      if (text.trim()) void rememberActivity(toolName, text); // allow + remember (provenance/memory)
      return;
    }

    const notification = buildNotification({
      source: toolName,
      trustLabel: decision.trustLabel,
      findings: decision.findings,
      blocked: `tool_call:${toolName}`,
      reason: decision.reason,
      failClosed: decision.failClosed,
    });
    process.stderr.write(`\n🛡️  [LucidAgentIDE] ${summarizeNotification(notification)}\n`);
    if (isTask) void recordTaskDispatch(decision); // blocked task → routed to read-only security-review
    void rememberActivity(toolName, text); // fire-and-forget; never blocks the gate
    return { block: true, reason: `Blocked by LucidAgentIDE security gate: ${decision.reason}` };
  });

  // P-TASK.4 (ADR-0028): gate a subagent's RETURNED text before it can become durable memory.
  // omp delivers a finished subagent's output in a tool_result carrying a `<task-result …>` block;
  // route that through the keystone-#2 promotion gate so a suspicious result never auto-promotes
  // into semantic memory. Best-effort and override-free — it never changes the tool's output.
  pi.on("tool_result", async (event: any) => {
    // P-LOC.1: count AI-authored write/edit lines into the attribution ledger (independent of the
    // subagent-result gating below; both are best-effort and never affect the tool result).
    void recordEditLoc(event);
    try {
      const text = collectStrings(event);
      if (!text.includes("<task-result")) return; // only finished-subagent results
      const agent = /<task-result[^>]*\bagent="([^"]+)"/.exec(text)?.[1] ?? "task";
      const db = await getDb();
      if (!db) return;
      const { gateSubagentResult } = await import("../runs/task_gate.ts");
      await gateSubagentResult(db, scanner, { runId: LIVE_RUN, agent, resultText: text });
    } catch {
      /* best-effort memory gating; never affects the tool result */
    }
  });
}
