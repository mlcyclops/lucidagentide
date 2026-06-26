// harness/knowledge/pdf.ts
//
// P-RAG.1c (ADR-0064): PDF -> text, then through the UNCHANGED scan-gated ingest path. A PDF is just
// another text SOURCE: extractPdfText() pulls the text layer out, and ingestPdf() hands that text to
// ingestText() (ingest.ts) verbatim — so every page of a PDF is chunked, SCANNED fail-closed, embedded,
// and stored exactly like a .txt source. No new trust path: poisoned text lifted out of a PDF is gated
// by the same DEFAULT_POLICY (invariants #3 fail-closed, #5 untrusted-only-delimited, keystone #2).
//
// unpdf (pdf.js serverless build) is pure JS — no native binary — so this stays air-gap clean (ADR-0053)
// and bundles into the packaged app without a platform-specific addon.
//
// Fail-closed posture: a buffer that is not a PDF, or that pdf.js cannot parse, THROWS — it is never
// silently treated as empty text. A PDF with no extractable text layer (e.g. a pure scanned image) is a
// distinct, non-error outcome: zero chunks, nothing stored (OCR/image captioning is a later 1c slice).

import { extractText, getDocumentProxy } from "unpdf";
import { ingestText, type IngestArgs, type IngestResult } from "./ingest.ts";

const PDF_MAGIC = "%PDF-";
const PDF_MAGIC_BYTES = Uint8Array.from(PDF_MAGIC, (c) => c.charCodeAt(0));

export interface PdfText {
  /** Page count reported by pdf.js. */
  totalPages: number;
  /** Extracted text, one entry per page (page order preserved). */
  pages: string[];
}

/** Extract the text layer of a PDF, page by page. Fail-closed: a non-PDF buffer (no %PDF- header) or a
 *  buffer pdf.js cannot parse THROWS, rather than being read as empty text. */
export async function extractPdfText(data: Uint8Array): Promise<PdfText> {
  // Sniff the magic header (raw bytes, %PDF- is pure ASCII) so an obviously-not-a-PDF buffer is rejected
  // loudly before pdf.js — never read as empty text.
  const ok = data.length >= PDF_MAGIC_BYTES.length && PDF_MAGIC_BYTES.every((b, i) => data[i] === b);
  if (!ok) {
    throw new Error(`not a PDF: missing %PDF- header`);
  }
  // pdf.js TRANSFERS (detaches) the typed array it is handed, which would corrupt the caller's buffer
  // and make a second extract throw. Copy so extractPdfText is non-destructive and idempotent.
  const pdf = await getDocumentProxy(data.slice());
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  return { totalPages, pages: text };
}

export type IngestPdfArgs = Omit<IngestArgs, "text"> & { data: Uint8Array };

/** Ingest a PDF: extract its text layer, then run it through the SAME scan-gated ingestText pipeline.
 *  Pages are joined with a blank line so chunking spans page breaks naturally; provenance (sourcePath)
 *  and the fail-closed gate are unchanged. Returns ingestText's per-source summary. */
export async function ingestPdf(args: IngestPdfArgs): Promise<IngestResult> {
  const { data, ...rest } = args;
  const { pages } = await extractPdfText(data);
  const text = pages.join("\n\n");
  return ingestText({ ...rest, text });
}
