// harness/knowledge/chunk.ts
//
// P-RAG.1 (ADR-0054): pure text chunking for the local knowledge store. No I/O — splits a document
// into overlapping, roughly word-bounded windows so each chunk embeds to a coherent vector and
// retrieval returns readable spans. Deterministic (same input → same chunks), so the ingest pipeline
// and its tests are reproducible.
//
// Strategy: normalize whitespace, then accumulate words up to ~maxChars, preferring to break at a
// sentence/paragraph boundary near the end of the window. Consecutive chunks overlap by ~overlapChars
// so a fact split across a boundary is still retrievable from at least one chunk.

export interface ChunkOptions {
  /** Soft upper bound on chunk length in characters. Default 800 (~150-200 tokens). */
  maxChars?: number;
  /** Characters of trailing context repeated at the start of the next chunk. Default 120. */
  overlapChars?: number;
}

const DEFAULTS: Required<ChunkOptions> = { maxChars: 800, overlapChars: 120 };

/** Collapse runs of whitespace but keep paragraph breaks (double newline) as soft boundaries. */
function normalize(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Split into chunks of at most ~maxChars, breaking at the latest sentence/whitespace boundary
 *  within the window, with overlapChars of carry-over between consecutive chunks. */
export function chunkText(text: string, opts: ChunkOptions = {}): string[] {
  const maxChars = Math.max(1, opts.maxChars ?? DEFAULTS.maxChars);
  const overlap = Math.max(0, Math.min(opts.overlapChars ?? DEFAULTS.overlapChars, maxChars - 1));
  const norm = normalize(text);
  if (!norm) return [];
  if (norm.length <= maxChars) return [norm];

  const chunks: string[] = [];
  let start = 0;
  while (start < norm.length) {
    let end = Math.min(start + maxChars, norm.length);
    if (end < norm.length) {
      // Prefer a boundary in the last third of the window: paragraph > sentence > whitespace.
      const window = norm.slice(start, end);
      const floor = Math.floor(maxChars * 0.6);
      const para = window.lastIndexOf("\n\n");
      const sentence = Math.max(window.lastIndexOf(". "), window.lastIndexOf(".\n"), window.lastIndexOf("! "), window.lastIndexOf("? "));
      const space = window.lastIndexOf(" ");
      const brk = [para, sentence, space].find((i) => i >= floor);
      if (brk !== undefined && brk > 0) end = start + brk + 1;
    }
    const piece = norm.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end >= norm.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
}
