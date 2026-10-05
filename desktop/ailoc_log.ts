// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// The GUI-owned, lock-free AI-LOC ledger mirrors completed successful mutations for the dashboard.
// Only paths, attribution, and authoritative line counts are persisted, never authored code.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { AILOC_LOG_PATH, type AiLocSample } from "./ailoc_read.ts";

/** A completed mutation with counts established by the capture tracker. */
export interface AiLocCapture {
  model: string;
  identity: string;
  identitySource: string;
  repo: string;
  filePath?: string;
  tool: string;
  added: number;
  removed: number;
  sessionId?: string;
}

/** Best-effort append. Empty changes and invalid counts never produce a sample. */
export function recordAiLoc(c: AiLocCapture, opts: { logPath?: string } = {}): AiLocSample | null {
  try {
    const { added, removed } = c;
    if (!Number.isSafeInteger(added) || !Number.isSafeInteger(removed) || added < 0 || removed < 0 || (added === 0 && removed === 0)) return null;
    const sample: AiLocSample = {
      id: Snowflake.next(),
      ts: Date.now(),
      model: c.model && c.model.length > 0 ? c.model : "unknown",
      identity: c.identity || "unknown",
      identitySource: c.identitySource || "unknown",
      repo: c.repo || "",
      filePath: c.filePath ?? null,
      tool: c.tool || "edit",
      added,
      removed,
      sessionId: c.sessionId || undefined,
    };
    const path = opts.logPath ?? AILOC_LOG_PATH;
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(sample) + "\n");
    return sample;
  } catch {
    return null; // Provenance failure must never break the chat.
  }
}
