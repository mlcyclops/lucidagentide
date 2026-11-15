// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/attach_kinds.ts - P-ATTACH.1 (ADR-0598): what a file attachment is, shared by the engine and the
// renderer. Pure, no imports, so both sides (and the tests) read one table.
//
// A file the user adds to a prompt bar is COPIED into a managed folder, its text is extracted and scanned
// fail-closed, and only then can it go with a prompt. Known binary formats have extractors (PDF, Word, Excel,
// PowerPoint); any other file is accepted only when its bytes are UTF-8 text, so nothing that cannot be scanned
// reaches a model. Images keep the composer's image path (ADR-0136).

export type AttachKind = "pdf" | "word" | "sheet" | "slides" | "markdown" | "text" | "code" | "data" | "web" | "image" | "other";

/** How a kind's text is obtained on the engine. */
export type AttachExtract = "pdf" | "docx" | "xlsx" | "pptx" | "utf8" | "image";

export interface AttachKindInfo { kind: AttachKind; label: string; extract: AttachExtract }

/** Known extensions (lower case, no dot). Anything else is "other", accepted only as UTF-8 text. */
export const ATTACH_EXT: Record<string, AttachKindInfo> = {
  pdf: { kind: "pdf", label: "PDF document", extract: "pdf" },
  docx: { kind: "word", label: "Word document", extract: "docx" },
  xlsx: { kind: "sheet", label: "Excel workbook", extract: "xlsx" },
  csv: { kind: "sheet", label: "CSV spreadsheet", extract: "utf8" },
  tsv: { kind: "sheet", label: "TSV spreadsheet", extract: "utf8" },
  pptx: { kind: "slides", label: "PowerPoint presentation", extract: "pptx" },
  md: { kind: "markdown", label: "Markdown document", extract: "utf8" },
  markdown: { kind: "markdown", label: "Markdown document", extract: "utf8" },
  txt: { kind: "text", label: "Plain text", extract: "utf8" },
  log: { kind: "text", label: "Log file", extract: "utf8" },
  rtf: { kind: "text", label: "Rich text", extract: "utf8" },
  json: { kind: "data", label: "JSON data", extract: "utf8" },
  jsonl: { kind: "data", label: "JSON Lines data", extract: "utf8" },
  yaml: { kind: "data", label: "YAML data", extract: "utf8" },
  yml: { kind: "data", label: "YAML data", extract: "utf8" },
  toml: { kind: "data", label: "TOML data", extract: "utf8" },
  xml: { kind: "data", label: "XML data", extract: "utf8" },
  ini: { kind: "data", label: "INI settings", extract: "utf8" },
  sql: { kind: "data", label: "SQL script", extract: "utf8" },
  html: { kind: "web", label: "HTML page", extract: "utf8" },
  htm: { kind: "web", label: "HTML page", extract: "utf8" },
  css: { kind: "web", label: "CSS stylesheet", extract: "utf8" },
  svg: { kind: "web", label: "SVG drawing", extract: "utf8" },
  ts: { kind: "code", label: "TypeScript source", extract: "utf8" },
  tsx: { kind: "code", label: "TypeScript React source", extract: "utf8" },
  js: { kind: "code", label: "JavaScript source", extract: "utf8" },
  jsx: { kind: "code", label: "JavaScript React source", extract: "utf8" },
  mjs: { kind: "code", label: "JavaScript module", extract: "utf8" },
  py: { kind: "code", label: "Python source", extract: "utf8" },
  rs: { kind: "code", label: "Rust source", extract: "utf8" },
  go: { kind: "code", label: "Go source", extract: "utf8" },
  java: { kind: "code", label: "Java source", extract: "utf8" },
  kt: { kind: "code", label: "Kotlin source", extract: "utf8" },
  cs: { kind: "code", label: "C# source", extract: "utf8" },
  c: { kind: "code", label: "C source", extract: "utf8" },
  h: { kind: "code", label: "C header", extract: "utf8" },
  cpp: { kind: "code", label: "C++ source", extract: "utf8" },
  hpp: { kind: "code", label: "C++ header", extract: "utf8" },
  rb: { kind: "code", label: "Ruby source", extract: "utf8" },
  php: { kind: "code", label: "PHP source", extract: "utf8" },
  swift: { kind: "code", label: "Swift source", extract: "utf8" },
  sh: { kind: "code", label: "Shell script", extract: "utf8" },
  ps1: { kind: "code", label: "PowerShell script", extract: "utf8" },
  bat: { kind: "code", label: "Batch script", extract: "utf8" },
  png: { kind: "image", label: "PNG image", extract: "image" },
  jpg: { kind: "image", label: "JPEG image", extract: "image" },
  jpeg: { kind: "image", label: "JPEG image", extract: "image" },
  webp: { kind: "image", label: "WebP image", extract: "image" },
  gif: { kind: "image", label: "GIF image", extract: "image" },
};

/** Formats refused with a reason the user can act on (binary, no extractor). */
export const ATTACH_REFUSED_EXT: Record<string, string> = {
  doc: "Save it as .docx and add it again: the old Word format cannot be read safely.",
  xls: "Save it as .xlsx or .csv and add it again: the old Excel format cannot be read safely.",
  ppt: "Save it as .pptx and add it again: the old PowerPoint format cannot be read safely.",
  exe: "Programs cannot be attached.",
  dll: "Programs cannot be attached.",
  msi: "Installers cannot be attached.",
  zip: "Archives cannot be attached: add the files inside it instead.",
  "7z": "Archives cannot be attached: add the files inside it instead.",
  rar: "Archives cannot be attached: add the files inside it instead.",
};

/** Limits; a managed policy may lower them (never raise past these). */
export const ATTACH_LIMITS = {
  /** Files per message, images included. */
  files: 10,
  /** Bytes per file. */
  bytes: 25 * 1024 * 1024,
  /** Extracted characters kept per file; the rest stays in the staged text file the agent can read. */
  promptCharsPerFile: 40_000,
  /** Extracted characters across all files in one prompt. */
  promptCharsTotal: 120_000,
  /** Characters extracted and scanned per file at most (the large scanner's ceiling is 8,000,000). */
  extractChars: 4_000_000,
  /** Days a staged copy is kept. */
  retentionDays: 7,
  /** Files staged from one folder. */
  folderFiles: 25,
} as const;

/** PURE: the lower-case extension of a file name, without the dot ("" when none). */
export function attachExt(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 && dot < base.length - 1 ? base.slice(dot + 1).toLowerCase() : "";
}

/** PURE: what a file is, from its name. Unknown extensions are "other" (accepted only as UTF-8 text). */
export function attachKindOf(name: string): AttachKindInfo {
  const ext = attachExt(name);
  return Object.hasOwn(ATTACH_EXT, ext) ? ATTACH_EXT[ext]! : { kind: "other", label: ext ? `.${ext} file` : "File", extract: "utf8" };
}

/** PURE: why a file cannot be attached by its name alone, or null. */
export function attachRefusal(name: string): string | null {
  const ext = attachExt(name);
  return Object.hasOwn(ATTACH_REFUSED_EXT, ext) ? ATTACH_REFUSED_EXT[ext]! : null;
}

/** PURE: a byte count for people ("812 B", "14.2 KB", "3.1 MB"). */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** A staged attachment as the engine reports it to the renderer. Paths are display data. */
export interface StagedAttachment {
  id: string;
  name: string;
  ext: string;
  kind: AttachKind;
  label: string;
  bytes: number;
  /** Where the user's file came from (absent in a plain browser, which hides it). */
  sourcePath?: string;
  /** The managed copy. */
  stagedPath: string;
  /** Characters of text extracted (0 for an image). */
  chars: number;
  /** True when more text exists than goes into a prompt. */
  truncated: boolean;
  pages?: number;
}

export type StageResult = { ok: true; attachment: StagedAttachment } | { ok: false; error: string; blocked?: boolean };

/** The managed policy as the renderer sees it. */
export interface AttachPolicyView { enabled: boolean; files: number; bytes: number; retentionDays: number }
