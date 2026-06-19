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
import { DEFAULT_POLICY, scanAndDecide } from "../security/gate.ts";
import { buildNotification, summarizeNotification } from "../security/notification.ts";
import type { Db } from "../memory/db.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(HERE, "..", "..", "agent_obs.duckdb");
const LIVE_RUN = "omp-live";

const scanner = new ScannerClient();
scanner.start();

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

// omp extensions are `(pi) => void` and register handlers via pi.on(...).
export default function securityExtension(pi: any): void {
  pi.on("tool_call", async (event: any) => {
    const toolName: string = event?.toolName ?? "tool";
    const text = collectStrings(event);
    const decision = await scanAndDecide(scanner, text, DEFAULT_POLICY);
    if (!decision.block) {
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
    void rememberActivity(toolName, text); // fire-and-forget; never blocks the gate
    return { block: true, reason: `Blocked by LucidAgentIDE security gate: ${decision.reason}` };
  });
}
