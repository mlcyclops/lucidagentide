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
}

/** Import normalized conversations into one unlocked store + compartment. The store is saved
 *  ONCE at the end (distillTurn defers its per-turn writes). Best-effort per message: a scan
 *  failure on one message blocks only that message, never the whole import. */
export async function importConversations(
  store: PersonalStore,
  scanner: ScannerClient,
  conversations: ImportedConversation[],
  opts: { vendor: ImportVendor; scope: PersonalScope; extract?: Extractor; extractorKind?: "heuristic" | "model"; maxMessages?: number; telemetry?: Telemetry; onProgress?: (doneConvos: number, totalConvos: number) => void },
): Promise<ImportSummary> {
  const extract = opts.extract ?? heuristicExtractor;
  const extractor = opts.extractorKind ?? "heuristic";
  const cap = opts.maxMessages ?? Infinity; // bound model-mode cost; Infinity for the free heuristic
  const sessionId = `import:${opts.vendor}`;
  let messages = 0, learned = 0, blocked = 0, skipped = 0, idx = 0;
  for (const convo of conversations) {
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
    }
    opts.onProgress?.(++idx, conversations.length);
  }
  if (learned) store.save(); // one re-encrypt+write for the entire import
  opts.telemetry?.emit("personal_facts_imported", { vendor: opts.vendor, scope: opts.scope, extractor, conversations: conversations.length, messages, learned, blocked, skipped });
  return { vendor: opts.vendor, conversations: conversations.length, messages, learned, blocked, skipped, extractor };
}
