// harness/knowledge/pdf_fixture.ts
//
// P-RAG.1c: a minimal, dependency-free PDF *writer* used ONLY by the PDF tests and demo, so the suite
// needs no binary fixture checked into git. It emits a valid PDF 1.4 with one Helvetica text line per
// page (uncompressed content streams, correct xref byte offsets) — enough for pdf.js / unpdf to extract
// the text back out. This is NOT a general PDF library and is never imported by production ingest.

function esc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/** Build a minimal valid PDF: one text line per page (Helvetica, uncompressed). The returned bytes
 *  round-trip through extractPdfText() back to the same per-page strings. */
export function makeTextPdf(pages: string[]): Uint8Array {
  const objs: string[] = [];
  const N = pages.length;
  // obj 1 Catalog, 2 Pages, 3 Font (shared Helvetica); per page i: page = 4 + 2i, content = 5 + 2i.
  objs[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ");
  objs[2] = `<< /Type /Pages /Kids [${kids}] /Count ${N} >>`;
  objs[3] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;
  pages.forEach((text, i) => {
    const pageNo = 4 + i * 2;
    const contentNo = 5 + i * 2;
    objs[pageNo] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentNo} 0 R >>`;
    const stream = `BT /F1 14 Tf 72 720 Td (${esc(text)}) Tj ET`;
    objs[contentNo] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });

  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 1; i < objs.length; i++) {
    offsets[i] = body.length;
    body += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xrefStart = body.length;
  let xref = `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) {
    xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  body += xref;
  body += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return new TextEncoder().encode(body);
}
