// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/ooxml_text.ts - P-ATTACH.1 (ADR-0598): the text of a Word, Excel or PowerPoint file.
//
// An .docx/.xlsx/.pptx is a ZIP of XML parts. This module reads the central directory itself, inflates only
// the XML parts that hold text, and turns their markup into plain text. It is bounded on purpose: a file
// the user drags in may be hostile, so the reader caps the entry count, each entry's size, the total
// inflated, and the compression ratio (a zip bomb), and it refuses zip64, encryption and unknown methods.
//
// FAIL-CLOSED. Anything malformed THROWS (a bad directory, a lying size, broken XML, an unknown entity). The
// caller turns a throw into a refused file; nothing here ever returns "no text" for a file it could not read.

import { inflateRawSync } from "node:zlib";

export type OoxmlFormat = "docx" | "xlsx" | "pptx";

export interface OoxmlLimits {
  /** Entries in the central directory. */
  maxEntries: number;
  /** Uncompressed bytes of one entry that is read. */
  maxEntryBytes: number;
  /** Uncompressed bytes across every entry read for one file. */
  maxTotalBytes: number;
  /** Uncompressed / compressed, for entries above `ratioFloorBytes`. */
  maxRatio: number;
  /** Entries smaller than this are not ratio-checked (tiny XML compresses well and is harmless). */
  ratioFloorBytes: number;
  /** Characters of text produced; past it the file is refused. */
  maxChars: number;
}

export const OOXML_LIMITS: OoxmlLimits = {
  maxEntries: 10_000,
  maxEntryBytes: 96 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  maxRatio: 400,
  ratioFloorBytes: 1024 * 1024,
  maxChars: 4_000_000,
};

export interface OoxmlText {
  text: string;
  /** Sheets (xlsx) or slides (pptx) read; paragraphs are not counted for docx (0). */
  parts: number;
}

// ── ZIP ────────────────────────────────────────────────────────────────────────────────────────────────

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

interface CentralEntry { name: string; method: number; flags: number; compSize: number; size: number; localOffset: number }

/** A read-only view over a ZIP's directory that inflates named entries under the limits. */
export class BoundedZip {
  readonly #buf: Buffer;
  readonly #entries = new Map<string, CentralEntry>();
  readonly #limits: OoxmlLimits;
  #inflated = 0;

  constructor(data: Uint8Array, limits: OoxmlLimits = OOXML_LIMITS) {
    this.#buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    this.#limits = limits;
    this.#readDirectory();
  }

  #readDirectory(): void {
    const buf = this.#buf;
    if (buf.length < 22) throw new Error("not a ZIP file (too short)");
    let eocd = -1;
    const min = Math.max(0, buf.length - 22 - 0xffff);
    for (let i = buf.length - 22; i >= min; i--) if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
    if (eocd < 0) throw new Error("not a ZIP file (no end of central directory)");
    const disk = buf.readUInt16LE(eocd + 4);
    const cdDisk = buf.readUInt16LE(eocd + 6);
    const count = buf.readUInt16LE(eocd + 10);
    const cdSize = buf.readUInt32LE(eocd + 12);
    const cdOffset = buf.readUInt32LE(eocd + 16);
    if (disk !== 0 || cdDisk !== 0) throw new Error("multi-part ZIP files are not supported");
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new Error("ZIP64 files are not supported");
    if (count > this.#limits.maxEntries) throw new Error(`the file has ${count} parts, more than the ${this.#limits.maxEntries} allowed`);
    if (cdOffset + cdSize > eocd) throw new Error("the ZIP directory is out of bounds");
    let off = cdOffset;
    for (let i = 0; i < count; i++) {
      if (off + 46 > eocd || buf.readUInt32LE(off) !== CEN_SIG) throw new Error("the ZIP directory is corrupt");
      const flags = buf.readUInt16LE(off + 8);
      const method = buf.readUInt16LE(off + 10);
      const compSize = buf.readUInt32LE(off + 20);
      const size = buf.readUInt32LE(off + 24);
      const nameLen = buf.readUInt16LE(off + 28);
      const extraLen = buf.readUInt16LE(off + 30);
      const commentLen = buf.readUInt16LE(off + 32);
      const localOffset = buf.readUInt32LE(off + 42);
      if (off + 46 + nameLen > eocd) throw new Error("the ZIP directory is corrupt");
      const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
      if (compSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) throw new Error("ZIP64 files are not supported");
      if (this.#entries.has(name)) throw new Error(`the ZIP has two parts named ${name}`);
      this.#entries.set(name, { name, method, flags, compSize, size, localOffset });
      off += 46 + nameLen + extraLen + commentLen;
    }
  }

  names(): string[] { return [...this.#entries.keys()]; }

  has(name: string): boolean { return this.#entries.has(name); }

  /** The bytes of one entry, inflated and checked against every limit. Throws when absent or out of bounds. */
  read(name: string): Buffer {
    const e = this.#entries.get(name);
    if (!e) throw new Error(`the file has no ${name}`);
    const L = this.#limits;
    if (e.flags & 0x1) throw new Error("encrypted files cannot be read");
    if (e.method !== 0 && e.method !== 8) throw new Error(`${name} uses an unsupported compression method (${e.method})`);
    if (e.size > L.maxEntryBytes) throw new Error(`${name} is larger than ${L.maxEntryBytes} bytes uncompressed`);
    if (this.#inflated + e.size > L.maxTotalBytes) throw new Error(`the file inflates past ${L.maxTotalBytes} bytes`);
    if (e.size >= L.ratioFloorBytes && e.size > Math.max(1, e.compSize) * L.maxRatio) throw new Error(`${name} is compressed more than ${L.maxRatio} to 1 (a ZIP bomb)`);
    const buf = this.#buf;
    const lo = e.localOffset;
    if (lo + 30 > buf.length || buf.readUInt32LE(lo) !== LOC_SIG) throw new Error(`the local header of ${name} is corrupt`);
    const start = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28);
    const end = start + e.compSize;
    if (end > buf.length) throw new Error(`${name} runs past the end of the file`);
    const raw = buf.subarray(start, end);
    let out: Buffer;
    if (e.method === 0) {
      if (e.compSize !== e.size) throw new Error(`${name} has inconsistent sizes`);
      out = Buffer.from(raw);
    } else {
      // maxOutputLength stops a lying size header from inflating past what was declared.
      try { out = inflateRawSync(raw, { maxOutputLength: Math.max(1, e.size) }); }
      catch (err) { throw new Error(`${name} could not be inflated: ${err instanceof Error ? err.message : String(err)}`); }
    }
    if (out.length !== e.size) throw new Error(`${name} inflated to ${out.length} bytes, not the declared ${e.size}`);
    this.#inflated += out.length;
    return out;
  }

  /** An entry decoded as strict UTF-8 XML text. */
  readXml(name: string): string {
    try { return new TextDecoder("utf-8", { fatal: true }).decode(this.read(name)); }
    catch (err) { throw new Error(err instanceof TypeError ? `${name} is not UTF-8` : err instanceof Error ? err.message : String(err)); }
  }
}

// ── XML ────────────────────────────────────────────────────────────────────────────────────────────────

const NAMED_ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: "\"", apos: "'" };

/** PURE: XML character and entity references decoded. Unknown entities and invalid code points throw. */
export function decodeXmlEntities(s: string): string {
  let amp = s.indexOf("&");
  if (amp < 0) return s;
  const parts: string[] = [];
  let from = 0;
  while (amp >= 0) {
    const semi = s.indexOf(";", amp + 1);
    if (semi < 0 || semi - amp > 12) throw new Error("a bare & in XML text");
    const ent = s.slice(amp + 1, semi);
    let ch: string;
    if (ent[0] === "#") {
      const hex = ent[1] === "x" || ent[1] === "X";
      const digits = ent.slice(hex ? 2 : 1);
      if (!(hex ? /^[0-9a-fA-F]+$/ : /^[0-9]+$/).test(digits)) throw new Error(`invalid character reference &${ent};`);
      const cp = Number.parseInt(digits, hex ? 16 : 10);
      if (cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) throw new Error(`invalid character reference &${ent};`);
      ch = String.fromCodePoint(cp);
    } else {
      if (!Object.hasOwn(NAMED_ENTITIES, ent)) throw new Error(`unknown XML entity &${ent};`);
      ch = NAMED_ENTITIES[ent]!;
    }
    parts.push(s.slice(from, amp), ch);
    from = semi + 1;
    amp = s.indexOf("&", from);
  }
  parts.push(s.slice(from));
  return parts.join("");
}

interface XmlHandlers {
  open(name: string, attrs: string, selfClosing: boolean): void;
  close(name: string): void;
  text(decoded: string): void;
}

/** PURE: walk an XML document's tags and text in order. Comments and processing instructions are skipped; CDATA
 *  is text. A DOCTYPE (entity definitions) or an unterminated construct throws. */
export function walkXml(xml: string, h: XmlHandlers): void {
  let i = 0;
  const n = xml.length;
  while (i < n) {
    const lt = xml.indexOf("<", i);
    if (lt < 0) { h.text(decodeXmlEntities(xml.slice(i))); break; }
    if (lt > i) h.text(decodeXmlEntities(xml.slice(i, lt)));
    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      if (end < 0) throw new Error("unterminated XML comment");
      i = end + 3;
    } else if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      if (end < 0) throw new Error("unterminated CDATA section");
      h.text(xml.slice(lt + 9, end));
      i = end + 3;
    } else if (xml.startsWith("<?", lt)) {
      const end = xml.indexOf("?>", lt + 2);
      if (end < 0) throw new Error("unterminated XML declaration");
      i = end + 2;
    } else if (xml.startsWith("<!", lt)) {
      // Office parts never carry a DOCTYPE; one here can only be trying to define entities.
      throw new Error("a DOCTYPE or markup declaration in an Office part is refused");
    } else {
      // The tag ends at the first ">" outside a quoted attribute value (a value may hold ">").
      let end = -1;
      let quote = "";
      for (let j = lt + 1; j < n; j++) {
        const c = xml[j]!;
        if (quote) { if (c === quote) quote = ""; }
        else if (c === "\"" || c === "'") quote = c;
        else if (c === ">") { end = j; break; }
      }
      if (end < 0) throw new Error("unterminated XML tag");
      const body = xml.slice(lt + 1, end);
      if (body.startsWith("/")) h.close(body.slice(1).trim());
      else {
        const selfClosing = body.endsWith("/");
        const inner = selfClosing ? body.slice(0, -1) : body;
        const m = /^([^\s/>]+)/.exec(inner);
        if (!m) throw new Error("malformed XML tag");
        h.open(m[1]!, inner.slice(m[1]!.length), selfClosing);
      }
      i = end + 1;
    }
  }
}

/** PURE: the attributes of one tag (values entity-decoded). */
export function xmlAttrs(attrs: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrs))) out[m[1]!] = decodeXmlEntities(m[2] ?? m[3] ?? "");
  return out;
}

/** Collects text up to a character budget; past it, throws (the caller refuses the file). */
class TextBudget {
  #parts: string[] = [];
  #chars = 0;
  readonly #max: number;
  constructor(max: number) { this.#max = max; }
  push(s: string): void {
    if (!s) return;
    this.#chars += s.length;
    if (this.#chars > this.#max) throw new Error(`the file holds more than ${this.#max} characters of text`);
    this.#parts.push(s);
  }
  toString(): string { return this.#parts.join(""); }
}

// ── Relationships: the order Word, Excel and PowerPoint use for sheets and slides ─────────────────────

/** PURE: a part path resolved against the folder of the part that names it ("../x" and "/x" handled). */
export function resolvePartPath(baseDir: string, target: string): string {
  const segs = target.startsWith("/") ? [] : baseDir.split("/").filter(Boolean);
  for (const s of target.split("/")) {
    if (!s || s === ".") continue;
    if (s === "..") { if (!segs.length) throw new Error(`relationship target ${target} leaves the package`); segs.pop(); }
    else segs.push(s);
  }
  return segs.join("/");
}

/** Relationship id to part path, from a `_rels/*.rels` part. Absent part = empty map. */
function readRels(zip: BoundedZip, relsPath: string, baseDir: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!zip.has(relsPath)) return out;
  walkXml(zip.readXml(relsPath), {
    open(name, attrs) {
      if (name !== "Relationship") return;
      const a = xmlAttrs(attrs);
      if (a.Id && a.Target && a.TargetMode !== "External") out.set(a.Id, resolvePartPath(baseDir, a.Target));
    },
    close() {},
    text() {},
  });
  return out;
}

/** Parts listed in a document's own order (`listTag` items with an `r:id`), else every `fallback` part in
 *  numeric order. Only parts present in the package are returned. */
function orderedParts(zip: BoundedZip, docPart: string, relsPart: string, baseDir: string, itemTag: string, fallback: RegExp): { path: string; label: string }[] {
  const listed: { path: string; label: string }[] = [];
  if (zip.has(docPart)) {
    const rels = readRels(zip, relsPart, baseDir);
    walkXml(zip.readXml(docPart), {
      open(name, attrs) {
        if (name !== itemTag) return;
        const a = xmlAttrs(attrs);
        const path = rels.get(a["r:id"] ?? "");
        if (path && zip.has(path)) listed.push({ path, label: a.name ?? "" });
      },
      close() {},
      text() {},
    });
  }
  if (listed.length) return listed;
  return zip.names()
    .map((p) => ({ p, m: fallback.exec(p) }))
    .filter((x): x is { p: string; m: RegExpExecArray } => !!x.m)
    .sort((a, b) => Number(a.m[1]) - Number(b.m[1]))
    .map((x) => ({ path: x.p, label: "" }));
}

// ── Formats ────────────────────────────────────────────────────────────────────────────────────────────

function docxText(zip: BoundedZip, max: number): OoxmlText {
  const out = new TextBudget(max);
  let inText = 0;
  let inTabStops = 0; // <w:tabs><w:tab .../></w:tabs> in paragraph properties defines stops, not characters
  walkXml(zip.readXml("word/document.xml"), {
    open(name, _attrs, self) {
      if (name === "w:t" && !self) inText++;
      else if (name === "w:tabs" && !self) inTabStops++;
      else if (name === "w:tab" && !inTabStops) out.push("\t");
      else if (name === "w:br" || name === "w:cr") out.push("\n");
    },
    close(name) {
      if (name === "w:t") inText = Math.max(0, inText - 1);
      else if (name === "w:tabs") inTabStops = Math.max(0, inTabStops - 1);
      else if (name === "w:p") out.push("\n");
    },
    text(s) { if (inText) out.push(s); },
  });
  return { text: out.toString().replace(/\n+$/, ""), parts: 0 };
}

/** PURE: a cell reference's zero-based column ("A1" -> 0, "AB7" -> 27). Null when it has no letters. */
export function columnIndex(ref: string): number | null {
  const m = /^([A-Z]{1,3})\d*$/.exec(ref.toUpperCase());
  if (!m) return null;
  let n = 0;
  for (const c of m[1]!) n = n * 26 + (c.charCodeAt(0) - 64);
  return n - 1;
}

const XLSX_MAX_COLUMNS = 16_384; // Excel's own limit (XFD)

function xlsxSharedStrings(zip: BoundedZip, max: number): string[] {
  const out: string[] = [];
  if (!zip.has("xl/sharedStrings.xml")) return out;
  let cur: string[] | null = null;
  let inT = 0;
  let inPhonetic = 0;
  let chars = 0;
  walkXml(zip.readXml("xl/sharedStrings.xml"), {
    open(name, _a, self) {
      if (self) { if (name === "si") out.push(""); return; }
      if (name === "si") cur = [];
      else if (name === "rPh") inPhonetic++;
      else if (name === "t") inT++;
    },
    close(name) {
      if (name === "si") { out.push((cur ?? []).join("")); cur = null; }
      else if (name === "rPh") inPhonetic = Math.max(0, inPhonetic - 1);
      else if (name === "t") inT = Math.max(0, inT - 1);
    },
    text(s) {
      if (!cur || !inT || inPhonetic) return;
      chars += s.length;
      if (chars > max) throw new Error(`the file holds more than ${max} characters of text`);
      cur.push(s);
    },
  });
  return out;
}

function xlsxText(zip: BoundedZip, max: number): OoxmlText {
  const shared = xlsxSharedStrings(zip, max);
  const sheets = orderedParts(zip, "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl", "sheet", /^xl\/worksheets\/sheet(\d+)\.xml$/);
  const out = new TextBudget(max);
  sheets.forEach((sheet, si) => {
    if (si > 0) out.push("\n\n");
    out.push(`Sheet: ${sheet.label || `Sheet ${si + 1}`}\n`);
    let row: string[] | null = null;
    let cell: { col: number; type: string; value: string[]; inV: number; inT: number } | null = null;
    let lines = 0;
    walkXml(zip.readXml(sheet.path), {
      open(name, attrs, self) {
        if (name === "row") { if (self) { if (lines++) out.push("\n"); } else row = []; return; }
        if (name === "c" && row) {
          const a = xmlAttrs(attrs);
          const col = a.r ? columnIndex(a.r.replace(/\d+$/, "")) : row.length;
          if (col === null || col >= XLSX_MAX_COLUMNS) throw new Error(`a cell reference is out of range (${a.r ?? ""})`);
          if (!self) cell = { col: Math.max(col, row.length), type: a.t ?? "n", value: [], inV: 0, inT: 0 };
          return;
        }
        if (!cell || self) return;
        if (name === "v") cell.inV++;
        else if (name === "t") cell.inT++;
      },
      close(name) {
        if (name === "v" && cell) cell.inV = Math.max(0, cell.inV - 1);
        else if (name === "t" && cell) cell.inT = Math.max(0, cell.inT - 1);
        else if (name === "c" && cell && row) {
          const raw = cell.value.join("");
          let v = raw;
          if (cell.type === "s") {
            const idx = Number(raw.trim());
            if (!Number.isInteger(idx) || idx < 0 || idx >= shared.length) throw new Error(`a cell names shared string ${raw.trim()}, which does not exist`);
            v = shared[idx]!;
          } else if (cell.type === "b") v = raw.trim() === "1" ? "TRUE" : raw.trim() === "0" ? "FALSE" : raw;
          while (row.length < cell.col) row.push("");
          row.push(v.replace(/[\t\r\n]+/g, " "));
          cell = null;
        } else if (name === "row" && row) {
          if (lines++) out.push("\n");
          out.push(row.join("\t").replace(/\t+$/, ""));
          row = null;
        }
      },
      text(s) {
        if (!cell) return;
        if (cell.type === "inlineStr" ? cell.inT : cell.inV) cell.value.push(s);
      },
    });
  });
  return { text: out.toString(), parts: sheets.length };
}

function pptxText(zip: BoundedZip, max: number): OoxmlText {
  const slides = orderedParts(zip, "ppt/presentation.xml", "ppt/_rels/presentation.xml.rels", "ppt", "p:sldId", /^ppt\/slides\/slide(\d+)\.xml$/);
  const out = new TextBudget(max);
  slides.forEach((slide, si) => {
    if (si > 0) out.push("\n\n");
    out.push(`Slide ${si + 1}\n`);
    let inT = 0;
    let wrote = false; // this paragraph produced text
    let breakDue = false; // a finished paragraph's line break, written before the next text so none trails
    walkXml(zip.readXml(slide.path), {
      open(name, _a, self) {
        if (name === "a:t" && !self) inT++;
        else if (name === "a:br") out.push("\n");
      },
      close(name) {
        if (name === "a:t") inT = Math.max(0, inT - 1);
        else if (name === "a:p" && wrote) { breakDue = true; wrote = false; }
      },
      text(s) {
        if (!inT || !s) return;
        if (breakDue) { out.push("\n"); breakDue = false; }
        out.push(s);
        wrote = true;
      },
    });
  });
  return { text: out.toString().replace(/\n+$/, ""), parts: slides.length };
}

/** The text of an Office Open XML file. Throws on anything malformed or out of bounds (fail-closed). */
export function extractOoxmlText(format: OoxmlFormat, data: Uint8Array, limits: OoxmlLimits = OOXML_LIMITS): OoxmlText {
  const zip = new BoundedZip(data, limits);
  if (format === "docx") return docxText(zip, limits.maxChars);
  if (format === "xlsx") return xlsxText(zip, limits.maxChars);
  return pptxText(zip, limits.maxChars);
}
