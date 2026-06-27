// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/personal/importer.ts — P9.7: feed a parsed third-party chat export (ChatGPT / Claude)
// through the SAME fail-closed, gated distiller the live chat uses. Every imported USER message
// is scanned; only clean, trusted messages contribute facts (keystone #2 — a poisoned old
// transcript can't sneak instructions into the personalization store). Assistant messages are
// never distilled (the profile is built from the user's own words). Provenance: facts carry
// source_session_id = `import:<vendor>` so the knowledge graph shows where they came from.

import { distillTurn, heuristicExtractor, type Extractor } from "./distiller.ts";
import type { ScannerClient } from "../security/scanner_client.ts";
import type { Telemetry } from "../telemetry/events.ts";
import type { PersonalScope, PersonalStore } from "./store.ts";
import type { ImportedConversation, ImportVendor } from "./import_adapters.ts";

export interface ImportSummary {
  vendor: ImportVendor;
  conversations: number; // conversations seen
  messages: number; // user messages scanned
  learned: number; // facts remembered
  blocked: number; // user messages the gate refused (suspicious/quarantined source)
  skipped: number; // user messages NOT processed because maxMessages was hit (never silent)
  extractor: "heuristic" | "model"; // which extractor ran (for the UI summary)
  cancelled?: boolean; // the run was cancelled mid-flight (facts learned so far are kept — fail-safe)
}

// P-KG-INGEST.1 (ADR-0076): a per-message progress tick, so a long import can show a live countdown
// instead of freezing silently for ~25 minutes.
export interface ImportProgressTick {
  conversations: number;      // conversations finished
  totalConversations: number;
  messages: number;           // user messages processed so far
  totalMessages: number;      // user messages that WILL be processed (after the cap)
  learned: number;            // facts remembered so far
  blocked: number;            // messages the gate refused so far
}

/** Import normalized conversations into one unlocked store + compartment. The store is saved
 *  ONCE at the end (distillTurn defers its per-turn writes). Best-effort per message: a scan
 *  failure on one message blocks only that message, never the whole import. */
export async function importConversations(
  store: PersonalStore,
  scanner: ScannerClient,
  conversations: ImportedConversation[],
  opts: { vendor: ImportVendor; scope: PersonalScope; extract?: Extractor; extractorKind?: "heuristic" | "model"; maxMessages?: number; telemetry?: Telemetry; onProgress?: (tick: ImportProgressTick) => void; signal?: AbortSignal },
): Promise<ImportSummary> {
  const extract = opts.extract ?? heuristicExtractor;
  const extractor = opts.extractorKind ?? "heuristic";
  const cap = opts.maxMessages ?? Infinity; // bound model-mode cost; Infinity for the free heuristic
  const sessionId = `import:${opts.vendor}`;
  // Count the user messages we'll actually process (after the cap) so the UI can show a real countdown.
  const totalUserMsgs = conversations.reduce((n, c) => n + c.messages.filter((m) => m.role === "user" && m.text.trim()).length, 0);
  const totalMessages = Math.min(totalUserMsgs, cap === Infinity ? totalUserMsgs : cap);
  let messages = 0, learned = 0, blocked = 0, skipped = 0, idx = 0, cancelled = false;
  const tick = () => opts.onProgress?.({ conversations: idx, totalConversations: conversations.length, messages, totalMessages, learned, blocked });
  tick(); // emit an initial 0/total so the UI can render immediately
  for (const convo of conversations) {
    if (opts.signal?.aborted) { cancelled = true; break; } // cancel at a conversation boundary — fail-safe
    const runId = `${sessionId}:${idx}`;
    for (const m of convo.messages) {
      if (m.role !== "user" || !m.text.trim()) continue; // only the user's own words teach
      if (messages >= cap) { skipped++; continue; } // over the cap — count it, never drop silently
      messages++;
      try {
        const r = await distillTurn(store, scanner, { userText: m.text, scope: opts.scope, sessionId, runId, extract, persist: false });
        learned += r.learned;
        if (r.blocked) blocked++;
      } catch { blocked++; } // fail-closed: an unscannable message teaches nothing
      tick(); // per-message so the countdown is smooth even within one long conversation
    }
    idx++;
    tick();
  }
  if (learned) store.save(); // one re-encrypt+write for the entire import (incl. a cancelled run's partial facts)
  opts.telemetry?.emit("personal_facts_imported", { vendor: opts.vendor, scope: opts.scope, extractor, conversations: idx, messages, learned, blocked, skipped });
  return { vendor: opts.vendor, conversations: conversations.length, messages, learned, blocked, skipped, extractor, cancelled };
}
