// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/util_conn.ts — P-KG-INGEST.4 (ADR-0085): the routing contract for utility completions (import /
// AI-learn extraction + the /goal checker). Extracted as pure functions so the fail-safe + the "when to
// yield to chat" rule are documented and unit-testable (the spawn/ACP plumbing in acp_backend can't be).

export type CompletionPath = "dedicated" | "shared-fallback";

/** Use the DEDICATED util omp connection when it spawned; otherwise fall back to the shared chat
 *  connection. Fail-safe: a failed second-omp spawn (`utilConnReady === false`) degrades to today's
 *  proven shared-connection behavior, never an error. */
export function completionPath(utilConnReady: boolean): CompletionPath {
  return utilConnReady ? "dedicated" : "shared-fallback";
}

/** Whether the completion must YIELD to a live chat turn (the P-KG-INGEST.3 ChatGate). Only the shared
 *  fallback shares the chat connection, so only it yields; the dedicated connection runs truly
 *  concurrently and never yields (zero chat impact, import runs flat-out). */
export function needsChatYield(path: CompletionPath): boolean {
  return path === "shared-fallback";
}
