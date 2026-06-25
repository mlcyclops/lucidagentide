// harness/knowledge/ingest.ts
//
// P-RAG.1 (ADR-0058): the scan-gated local ingest pipeline + the delimited retrieval wrapper. This is
// the security-load-bearing core of the knowledge store.
//
// ingestText: chunk → SCAN each chunk fail-closed (scanAndDecide / DEFAULT_POLICY, the same seam as
// persona/skill import) → embed only the clean chunks → store with their trust label. A blocked chunk
// (quarantined, suspicious-over-threshold, OR scanner-unavailable) is NEVER embedded and NEVER stored
// (invariant #3 fail-closed, #5 untrusted-only-delimited, keystone #2 — RAG context never auto-promotes
// into semantic memory). The audit hook `onBlock` lets the desktop layer recordBlock() without this
// harness module importing the desktop security log (clean layering).
//
// wrapRetrieved: render top-k chunks inside UNTRUSTED_CONTENT_START/END so injected knowledge enters a
// prompt ONLY as delimited data, in the user-turn tail — never the frozen prefix (invariant #5/#6).

import type { ScannerClient } from "../security/scanner_client.ts";
import { DEFAULT_POLICY, scanAndDecide, type GatePolicy } from "../security/gate.ts";
import { UNTRUSTED_START, UNTRUSTED_END } from "../prompt/assembler.ts";
import { chunkText, type ChunkOptions } from "./chunk.ts";
import type { Embedder } from "./embedder.ts";
import type { KnowledgeStore, RetrievedChunk } from "./store.ts";

export interface BlockedChunk {
  ordinal: number;
  reason: string;
  trustLabel: string;
  findings: number;
}

export interface IngestResult {
  datasetId: string;
  sourcePath: string;
  chunksTotal: number;
  stored: number;
  blocked: number;
  storedChunkIds: string[];
  blockedChunks: BlockedChunk[];
}

export interface IngestArgs {
  store: KnowledgeStore;
  scanner: ScannerClient;
  embedder: Embedder;
  datasetId: string;
  sourcePath: string;
  text: string;
  artifactId?: string | null;
  chunkOptions?: ChunkOptions;
  policy?: GatePolicy;
  /** Audit hook for a blocked chunk — desktop wiring passes recordBlock(). Never used to store. */
  onBlock?: (b: BlockedChunk & { sourcePath: string; datasetId: string }) => void;
}

/** Ingest one text source into a dataset, scanning every chunk fail-closed before it is embedded or
 *  stored. Returns a per-source summary; blocked chunks are reported, audited (onBlock), never stored. */
export async function ingestText(args: IngestArgs): Promise<IngestResult> {
  const { store, scanner, embedder, datasetId, sourcePath } = args;
  const policy = args.policy ?? DEFAULT_POLICY;
  const chunks = chunkText(args.text, args.chunkOptions);

  const result: IngestResult = {
    datasetId, sourcePath, chunksTotal: chunks.length, stored: 0, blocked: 0, storedChunkIds: [], blockedChunks: [],
  };

  // First pass: scan every chunk (fail-closed). Collect only the clean/suspicious-allowed ones, keeping
  // their ORIGINAL ordinal so retrieval citations and overlap order stay faithful to the source.
  const clean: { ordinal: number; text: string; trustLabel: string }[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const text = chunks[i]!;
    let decision: Awaited<ReturnType<typeof scanAndDecide>>;
    try {
      decision = await scanAndDecide(scanner, text, policy);
    } catch (e) {
      // scanAndDecide already fails closed internally; this guards a thrown scanner construction too.
      decision = { block: true, reason: `scan threw: ${String((e as Error)?.message ?? e)}`, trustLabel: "quarantined", findings: [], failClosed: true };
    }
    if (decision.block) {
      const b: BlockedChunk = { ordinal: i, reason: decision.reason, trustLabel: decision.trustLabel, findings: decision.findings.length };
      result.blocked++;
      result.blockedChunks.push(b);
      args.onBlock?.({ ...b, sourcePath, datasetId });
      continue; // NEVER embed or store a blocked chunk
    }
    clean.push({ ordinal: i, text, trustLabel: decision.trustLabel });
  }

  if (clean.length === 0) return result;

  // Embed the clean chunks in one batch, then store each with its trust label.
  const vectors = await embedder.embed(clean.map((c) => c.text));
  for (let j = 0; j < clean.length; j++) {
    const c = clean[j]!;
    const id = await store.addChunk({
      datasetId, artifactId: args.artifactId ?? null, sourcePath, ordinal: c.ordinal, text: c.text, trustLabel: c.trustLabel, embedding: vectors[j]!,
    });
    result.stored++;
    result.storedChunkIds.push(id);
  }
  return result;
}

/** Wrap retrieved chunks for injection: delimited as untrusted data, numbered with provenance, ready to
 *  drop into the USER-turn tail. Empty string when there is nothing to inject. */
export function wrapRetrieved(chunks: RetrievedChunk[]): string {
  if (chunks.length === 0) return "";
  const body = chunks
    .map((c, i) => `[${i + 1}] (${c.source_path}#${c.ordinal})\n${c.text}`)
    .join("\n\n");
  return `${UNTRUSTED_START}\n${body}\n${UNTRUSTED_END}`;
}
