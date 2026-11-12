// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/creator_design.ts - the engine side of the Creator Design suite (design contract section 3).
//
// Three things live here, all pure (no fs, no fetch) so every rule is unit-tested without a running engine:
//
//   1. DesignStore: the document the renderer pushes (POST /api/creator/design/state, validated with the
//      engine's validateDoc, 8 MB cap) and the agent-op queue. Agents POST op batches (validateOps, at most
//      DESIGN_OPS_BATCH_MAX per batch, at most DESIGN_MAX_PENDING batches waiting); every batch is dry-run
//      against the current document with applyOps(..., "agent") so the agent hears about a bad id at once, then
//      queued with a monotonically increasing seq. The renderer pulls `since=<seq>`, applies the batch as ONE
//      undo step, and acks `{ seq, applied, errors }`. Agents may only change structure: applyOps refuses pixel
//      edits for the "agent" actor, and `request` ops (decompose, upscale, ...) run only after the user clicks
//      Allow in the editor. In memory by design: the renderer owns the document, so nothing CUI is written to
//      disk by this module.
//   2. The agent's view: the manifest is REBUILT here from the validated document (buildAgentManifest), never
//      taken from the request, so a renderer bug cannot hand the agent an unfenced model label.
//   3. Export validation (POST /api/creator/design/export): magic bytes per kind, SVG through svgSafetyCheck, a
//      design document through validateDoc (stored re-serialized from the validated value), PNGs refused when
//      they carry text or EXIF chunks, and HyperFrames project files restricted to index.html + assets.

import type { ArtifactKind } from "./creator_image.ts";
import { decodeB64, isRecord, pngInfo, untrustedText } from "./creator_dgx_vision.ts";
import type { DesignDoc, DesignOp } from "../harness/creator/design/types.ts";
import { DESIGN_LIMITS, DESIGN_OPS_BATCH_MAX } from "../harness/creator/design/limits.ts";
import { applyOps, validateDoc, validateOps } from "../harness/creator/design/doc.ts";
import { buildAgentManifest, type AgentManifest } from "../harness/creator/design/agent_view.ts";
import { svgSafetyCheck } from "../harness/creator/design/svg_check.ts";
import { sniffImage } from "../harness/creator/design/sniff.ts";

export const DESIGN_STATE_MAX_BYTES = 8 * 1024 * 1024;
export const DESIGN_THUMB_MAX_BYTES = 2 * 1024 * 1024;
export const DESIGN_THUMB_MAX_SIDE = 1024;
/** Batches the renderer has not acked yet. More than this means the editor is closed or stuck. */
export const DESIGN_MAX_PENDING = 16;
/** Batches kept for result polling (acked ones are dropped oldest first beyond this). */
export const DESIGN_MAX_KEPT = 64;
export const DESIGN_MAX_ACK_ERRORS = 50;

// ── state ───────────────────────────────────────────────────────────────────

export interface DesignState {
  readonly doc: DesignDoc;
  readonly manifest: AgentManifest;
  readonly thumbB64?: string;
  readonly savedAt: number;
}

export type DesignBatchState = "queued" | "applied" | "dropped";

export interface DesignBatch {
  readonly seq: number;
  readonly at: number;
  readonly source: "agent";
  readonly docId: string;
  readonly ops: readonly DesignOp[];
  /** The dry run against the document as it was when the batch was queued. */
  readonly preview: { readonly applied: number; readonly errors: readonly string[]; readonly requests: number };
  state: DesignBatchState;
  ack?: { readonly applied: number; readonly errors: readonly string[]; readonly at: number };
  dropReason?: string;
}

/** What the renderer pulls: one entry per batch, applied as one undo step. */
export interface DesignBatchWire { seq: number; at: number; source: "agent"; docId: string; ops: readonly DesignOp[] }

export type Outcome<T> = { ok: true; data: T } | { ok: false; error: string };

export class DesignStore {
  #state: DesignState | null = null;
  #batches: DesignBatch[] = [];
  #seq = 0;
  readonly #now: () => number;

  constructor(now: () => number = Date.now) { this.#now = now; }

  /** POST /api/creator/design/state. `raw` is the parsed body; `rawBytes` its size on the wire. The caller's
   *  manifest is ignored: the agent view is rebuilt from the validated document. */
  setState(raw: unknown, rawBytes: number): Outcome<{ savedAt: number; latestSeq: number; dropped: number }> {
    if (rawBytes > DESIGN_STATE_MAX_BYTES) return { ok: false, error: "The design state is over the 8 MB limit (pixels never ride this route)." };
    if (!isRecord(raw)) return { ok: false, error: "Send { doc, manifest, thumbB64? }." };
    const v = validateDoc(raw.doc);
    if (!v.ok) return { ok: false, error: `The design document was refused: ${v.error}` };
    let thumbB64: string | undefined;
    if (raw.thumbB64 !== undefined && raw.thumbB64 !== null) {
      const t = checkThumb(raw.thumbB64);
      if (!t.ok) return t;
      thumbB64 = raw.thumbB64 as string;
    }
    const savedAt = this.#now();
    const prevId = this.#state?.doc.id;
    this.#state = { doc: v.doc, manifest: buildAgentManifest(v.doc), ...(thumbB64 ? { thumbB64 } : {}), savedAt };
    let dropped = 0;
    if (prevId !== undefined && prevId !== v.doc.id) {
      for (const b of this.#batches) {
        if (b.state === "queued" && b.docId !== v.doc.id) { b.state = "dropped"; b.dropReason = "the editor switched to another document"; dropped++; }
      }
    }
    return { ok: true, data: { savedAt, latestSeq: this.#seq, dropped } };
  }

  /** GET /api/creator/design/state (renderer only). */
  state(): DesignState | null { return this.#state; }

  /** The agent's read: manifest + hints (inside the manifest) + optional thumbnail + queue depth. */
  agentView(includeThumb: boolean): { open: false } | { open: true; manifest: AgentManifest; savedAt: number; ageMs: number; pending: number; thumbB64?: string } {
    const s = this.#state;
    if (!s) return { open: false };
    return {
      open: true, manifest: s.manifest, savedAt: s.savedAt, ageMs: Math.max(0, this.#now() - s.savedAt),
      pending: this.#batches.filter((b) => b.state === "queued").length,
      ...(includeThumb && s.thumbB64 ? { thumbB64: s.thumbB64 } : {}),
    };
  }

  /** POST /api/creator/design/ops (agents). Validated, dry-run, then queued. */
  enqueue(raw: unknown): Outcome<{ seq: number; preview: DesignBatch["preview"] }> {
    if (!isRecord(raw)) return { ok: false, error: "Send { ops: DesignOp[] }." };
    const s = this.#state;
    if (!s) return { ok: false, error: "No design document is open in Creator Studio, so there is nothing to edit. Ask the user to open the Design tab." };
    if (Array.isArray(raw.ops) && raw.ops.length > DESIGN_OPS_BATCH_MAX) return { ok: false, error: `At most ${DESIGN_OPS_BATCH_MAX} ops per batch.` };
    const v = validateOps(raw.ops);
    if (!v.ok) return { ok: false, error: `The ops were refused: ${v.error}` };
    if (!v.ops.length) return { ok: false, error: "Send at least one op." };
    const pending = this.#batches.filter((b) => b.state === "queued").length;
    if (pending >= DESIGN_MAX_PENDING) return { ok: false, error: `The editor has not picked up ${pending} earlier batches yet; wait for them before sending more.` };
    const dry = applyOps(s.doc, v.ops, "agent");
    const preview = { applied: dry.applied, errors: dry.errors.slice(0, DESIGN_MAX_ACK_ERRORS).map((e) => untrustedText(e, 200)), requests: dry.requests.length };
    if (dry.applied === 0 && dry.requests.length === 0) {
      return { ok: false, error: `None of those ops apply to the open document: ${preview.errors.slice(0, 5).join("; ") || "no effect"}` };
    }
    const seq = ++this.#seq;
    this.#batches.push({ seq, at: this.#now(), source: "agent", docId: s.doc.id, ops: v.ops, preview, state: "queued" });
    this.#trim();
    return { ok: true, data: { seq, preview } };
  }

  /** GET /api/creator/design/ops?since= (renderer). Queued batches after `since`, oldest first. */
  since(sinceRaw: unknown): { ops: DesignBatchWire[]; latest: number } {
    const n = typeof sinceRaw === "string" && /^\d{1,15}$/.test(sinceRaw) ? Number(sinceRaw) : typeof sinceRaw === "number" && Number.isSafeInteger(sinceRaw) ? sinceRaw : 0;
    const ops = this.#batches
      .filter((b) => b.state === "queued" && b.seq > n)
      .slice(0, DESIGN_MAX_PENDING)
      .map((b) => ({ seq: b.seq, at: b.at, source: b.source, docId: b.docId, ops: b.ops }));
    return { ops, latest: this.#seq };
  }

  /** POST /api/creator/design/ops/ack (renderer). */
  ack(raw: unknown): Outcome<{ seq: number }> {
    if (!isRecord(raw)) return { ok: false, error: "Send { seq, applied, errors }." };
    const seq = raw.seq;
    if (typeof seq !== "number" || !Number.isSafeInteger(seq)) return { ok: false, error: "seq must be a whole number." };
    const b = this.#batches.find((x) => x.seq === seq);
    if (!b) return { ok: false, error: `No batch ${seq} is queued.` };
    if (b.state !== "queued") return { ok: false, error: `Batch ${seq} is already ${b.state}.` };
    const applied = raw.applied;
    if (typeof applied !== "number" || !Number.isSafeInteger(applied) || applied < 0 || applied > b.ops.length) return { ok: false, error: `applied must be 0..${b.ops.length}.` };
    const errs = raw.errors === undefined ? [] : raw.errors;
    if (!Array.isArray(errs)) return { ok: false, error: "errors must be a list of strings." };
    const errors = errs.slice(0, DESIGN_MAX_ACK_ERRORS).filter((e): e is string => typeof e === "string").map((e) => untrustedText(e, 200)).filter(Boolean);
    b.state = "applied";
    b.ack = { applied, errors, at: this.#now() };
    this.#trim();
    return { ok: true, data: { seq } };
  }

  /** GET /api/creator/design/ops/result?seq= (agents): queued, applied (with the renderer's count), or dropped. */
  result(seqRaw: unknown): Outcome<{ seq: number; state: DesignBatchState; preview: DesignBatch["preview"]; applied?: number; errors?: readonly string[]; reason?: string }> {
    const seq = typeof seqRaw === "string" && /^\d{1,15}$/.test(seqRaw) ? Number(seqRaw) : NaN;
    const b = this.#batches.find((x) => x.seq === seq);
    if (!b) return { ok: false, error: "No such batch (it may have aged out)." };
    return {
      ok: true,
      data: {
        seq: b.seq, state: b.state, preview: b.preview,
        ...(b.ack ? { applied: b.ack.applied, errors: b.ack.errors } : {}),
        ...(b.dropReason ? { reason: b.dropReason } : {}),
      },
    };
  }

  #trim(): void {
    while (this.#batches.length > DESIGN_MAX_KEPT) {
      const i = this.#batches.findIndex((b) => b.state !== "queued");
      if (i < 0) break;
      this.#batches.splice(i, 1);
    }
  }
}

function checkThumb(v: unknown): Outcome<null> {
  const d = decodeB64(v, DESIGN_THUMB_MAX_BYTES);
  if (!d.ok) return { ok: false, error: `The thumbnail was refused: ${d.error}.` };
  const info = pngInfo(d.bytes);
  if (!info) return { ok: false, error: "The thumbnail must be a PNG." };
  if (info.width > DESIGN_THUMB_MAX_SIDE || info.height > DESIGN_THUMB_MAX_SIDE) return { ok: false, error: `The thumbnail must fit in ${DESIGN_THUMB_MAX_SIDE}x${DESIGN_THUMB_MAX_SIDE}.` };
  return { ok: true, data: null };
}

// ── exports ─────────────────────────────────────────────────────────────────

export type DesignExportKind = "png" | "gif" | "apng" | "svg" | "psd" | "psb" | "design";
export const DESIGN_EXPORT_KINDS: readonly DesignExportKind[] = ["png", "gif", "apng", "svg", "psd", "psb", "design"] as const;

/** Decoded byte caps per kind. The engine's request body limit (128 MB of base64 JSON) bounds them all. */
export const DESIGN_EXPORT_MAX_BYTES: Record<DesignExportKind, number> = {
  png: 90 * 1024 * 1024, psd: 90 * 1024 * 1024, psb: 90 * 1024 * 1024,
  gif: 64 * 1024 * 1024, apng: 64 * 1024 * 1024, svg: 20 * 1024 * 1024, design: DESIGN_STATE_MAX_BYTES,
};

export interface DesignExportPlan {
  readonly kind: DesignExportKind;
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly mime: string;
  readonly artifactKind: ArtifactKind;
  readonly ext?: string;
  readonly width: number;
  readonly height: number;
}

/** A display name for an export: bare, printable, at most 80 chars. Never a path. */
export function sanitizeExportName(v: unknown): string {
  const s = untrustedText(v, 120);
  let out = "";
  for (const ch of s) {
    const ok = (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9") || ch === " " || ch === "-" || ch === "_" || ch === ".";
    out += ok ? ch : "_";
    if (out.length >= 80) break;
  }
  out = out.replace(/^[.\s]+/, "").trim();
  return out || "design";
}

const PNG_METADATA: Record<string, true> = { tEXt: true, iTXt: true, zTXt: true, eXIf: true, tIME: true };

/** Walk PNG chunks: bounds-checked, ends at IEND. Refuses metadata chunks (text and EXIF are never exported). */
export function checkPngChunks(bytes: Uint8Array): { ok: true; animated: boolean } | { ok: false; error: string } {
  if (!pngInfo(bytes)) return { ok: false, error: "not a PNG" };
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 8;
  let animated = false;
  let sawIdat = false;
  for (let n = 0; n < 4_000_000; n++) {
    if (p + 12 > bytes.length) return { ok: false, error: "the PNG is truncated" };
    const len = dv.getUint32(p);
    const type = String.fromCharCode(bytes[p + 4]!, bytes[p + 5]!, bytes[p + 6]!, bytes[p + 7]!);
    if (len > bytes.length - p - 12) return { ok: false, error: "a PNG chunk overruns the file" };
    if (Object.hasOwn(PNG_METADATA, type)) return { ok: false, error: `the PNG carries a ${type} metadata chunk; exports never include metadata` };
    if (type === "acTL" && !sawIdat) animated = true;
    if (type === "IDAT") sawIdat = true;
    p += 12 + len;
    if (type === "IEND") return sawIdat ? { ok: true, animated } : { ok: false, error: "the PNG has no image data" };
  }
  return { ok: false, error: "the PNG has too many chunks" };
}

const ascii = (b: Uint8Array, at: number, s: string): boolean => {
  for (let i = 0; i < s.length; i++) if (b[at + i] !== s.charCodeAt(i)) return false;
  return true;
};

/** Validate one export body `{ kind, name, dataB64 }` into what storeArtifact needs, or the refusal. */
export function planDesignExport(raw: unknown): Outcome<DesignExportPlan> {
  if (!isRecord(raw)) return { ok: false, error: "Send { kind, name, dataB64 }." };
  const kind = raw.kind;
  if (typeof kind !== "string" || !(DESIGN_EXPORT_KINDS as readonly string[]).includes(kind)) return { ok: false, error: `kind must be one of ${DESIGN_EXPORT_KINDS.join(", ")}, or hyperframes.` };
  const k = kind as DesignExportKind;
  const name = sanitizeExportName(raw.name);
  const d = decodeB64(raw.dataB64, DESIGN_EXPORT_MAX_BYTES[k]);
  if (!d.ok) return { ok: false, error: `That ${k} export was refused: ${d.error}.` };
  const bytes = d.bytes;
  const max = DESIGN_LIMITS.maxSide;
  switch (k) {
    case "png":
    case "apng": {
      const c = checkPngChunks(bytes);
      if (!c.ok) return { ok: false, error: `That ${k} export was refused: ${c.error}.` };
      if (k === "apng" && !c.animated) return { ok: false, error: "That APNG has no animation control chunk before its image data." };
      const info = pngInfo(bytes)!;
      return { ok: true, data: { kind: k, name, bytes, mime: k === "png" ? "image/png" : "image/apng", artifactKind: k === "png" ? "image" : "gif", width: info.width, height: info.height } };
    }
    case "gif": {
      if (!(ascii(bytes, 0, "GIF89a") || ascii(bytes, 0, "GIF87a")) || bytes.length < 14) return { ok: false, error: "That GIF export does not start with a GIF header." };
      const info = sniffImage(bytes);
      const w = bytes[6]! | (bytes[7]! << 8);
      const h = bytes[8]! | (bytes[9]! << 8);
      if (!w || !h) return { ok: false, error: "That GIF states no size." };
      if ((info.frames ?? 1) > DESIGN_LIMITS.maxGifFrames) return { ok: false, error: `That GIF has more than ${DESIGN_LIMITS.maxGifFrames} frames.` };
      if (bytes[bytes.length - 1] !== 0x3b) return { ok: false, error: "That GIF has no trailer; it looks truncated." };
      return { ok: true, data: { kind: k, name, bytes, mime: "image/gif", artifactKind: "gif", width: w, height: h } };
    }
    case "psd":
    case "psb": {
      if (bytes.length < 26 || !ascii(bytes, 0, "8BPS")) return { ok: false, error: `That ${k.toUpperCase()} export does not start with the 8BPS signature.` };
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const version = dv.getUint16(4);
      if (version !== (k === "psd" ? 1 : 2)) return { ok: false, error: `That file is version ${version}, not a ${k.toUpperCase()}.` };
      const h = dv.getUint32(14);
      const w = dv.getUint32(18);
      const sideMax = k === "psd" ? 30_000 : max;
      if (!w || !h || w > sideMax || h > sideMax) return { ok: false, error: `That ${k.toUpperCase()} is ${w}x${h}; the limit is ${sideMax} per side.` };
      return { ok: true, data: { kind: k, name, bytes, mime: "image/vnd.adobe.photoshop", artifactKind: "image", ...(k === "psb" ? { ext: "psb" } : {}), width: w, height: h } };
    }
    case "svg": {
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return { ok: false, error: "That SVG is not valid UTF-8." }; }
      const head = text.slice(0, 512).replace(/^\uFEFF/, "").trimStart();
      if (!head.startsWith("<svg") && !head.startsWith("<?xml")) return { ok: false, error: "That export does not start with an <svg> element." };
      const safe = svgSafetyCheck(text);
      if (!safe.ok) return { ok: false, error: `That SVG was refused: ${safe.reason}` };
      const info = sniffImage(bytes);
      return { ok: true, data: { kind: k, name, bytes, mime: "image/svg+xml", artifactKind: "vector", width: info.width ?? 0, height: info.height ?? 0 } };
    }
    case "design": {
      let parsed: unknown;
      try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { return { ok: false, error: "That design document is not valid JSON." }; }
      const v = validateDoc(parsed);
      if (!v.ok) return { ok: false, error: `That design document was refused: ${v.error}` };
      const canonical = new TextEncoder().encode(JSON.stringify(v.doc));
      return { ok: true, data: { kind: k, name, bytes: canonical, mime: "application/vnd.lucid.design+json", artifactKind: "design", width: v.doc.width, height: v.doc.height } };
    }
  }
}

// ── HyperFrames project export ──────────────────────────────────────────────

export const HF_MAX_FILES = 520;
export const HF_MAX_TOTAL_BYTES = 90 * 1024 * 1024;
export const HF_MAX_INDEX_BYTES = 2 * 1024 * 1024;
const HF_ASSET = /^assets\/[A-Za-z0-9_-]{1,64}\.(png|svg)$/;
/** Substrings that would make headless Chrome reach outside the project or run script. */
const HF_FORBIDDEN = ["http:", "https:", "//", "<script", "javascript:", "file:", "data:text/html", "data:image/svg", "data:application", "@import", "<iframe", "<object", "<embed", "<base", "<link", "http-equiv", "srcdoc"];
const isSpace = (c: string | undefined): boolean => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";

export interface HyperframesFile { readonly path: string; readonly bytes: Uint8Array }

/** Scan index.html for anything that reaches outside the project folder or runs script. Linear: indexOf over
 *  a lowered copy, no regex over the untrusted text. */
export function checkHyperframesIndex(html: string): string | null {
  const low = html.toLowerCase();
  for (const bad of HF_FORBIDDEN) if (low.includes(bad)) return `index.html contains "${bad}"`;
  // An inline event handler: `on<letters>=` right after whitespace, a quote, or a slash (attribute position).
  let i = low.indexOf("on");
  while (i >= 0) {
    const prev = low[i - 1];
    if (i > 0 && (isSpace(prev) || prev === "\"" || prev === "'" || prev === "/")) {
      let j = i + 2;
      while (j < low.length && low.charCodeAt(j) >= 97 && low.charCodeAt(j) <= 122) j++;
      const letters = j > i + 2;
      while (j < low.length && isSpace(low[j])) j++;
      if (letters && low[j] === "=") return "index.html carries an inline event handler";
    }
    i = low.indexOf("on", i + 2);
  }
  let u = low.indexOf("url(");
  while (u >= 0) {
    let j = u + 4;
    while (j < low.length && (isSpace(low[j]) || low[j] === "'" || low[j] === "\"")) j++;
    if (!low.startsWith("assets/", j) && low[j] !== "#") return "index.html has a url() that is not a project asset";
    u = low.indexOf("url(", j);
  }
  return null;
}

/** Validate `{ kind: "hyperframes", name, files: [{ path, dataB64 }] }` into files to write under a fresh dir. */
export function planHyperframesExport(raw: unknown): Outcome<{ name: string; files: HyperframesFile[] }> {
  if (!isRecord(raw) || raw.kind !== "hyperframes") return { ok: false, error: "Send { kind: \"hyperframes\", name, files }." };
  if (!Array.isArray(raw.files) || !raw.files.length) return { ok: false, error: "Send the project files." };
  if (raw.files.length > HF_MAX_FILES) return { ok: false, error: `At most ${HF_MAX_FILES} project files.` };
  const seen = new Set<string>();
  const files: HyperframesFile[] = [];
  let total = 0;
  for (const f of raw.files) {
    if (!isRecord(f) || typeof f.path !== "string") return { ok: false, error: "Every project file needs a path." };
    const path = f.path;
    if (path !== "index.html" && !HF_ASSET.test(path)) return { ok: false, error: `${untrustedText(path, 80)} is not index.html or assets/<name>.png|svg.` };
    if (seen.has(path)) return { ok: false, error: `${path} appears twice.` };
    seen.add(path);
    const d = decodeB64(f.dataB64, path === "index.html" ? HF_MAX_INDEX_BYTES : HF_MAX_TOTAL_BYTES);
    if (!d.ok) return { ok: false, error: `${path}: ${d.error}.` };
    total += d.bytes.length;
    if (total > HF_MAX_TOTAL_BYTES) return { ok: false, error: "The project is over the 90 MB limit." };
    if (path === "index.html") {
      let html: string;
      try { html = new TextDecoder("utf-8", { fatal: true }).decode(d.bytes); } catch { return { ok: false, error: "index.html is not valid UTF-8." }; }
      const bad = checkHyperframesIndex(html);
      if (bad) return { ok: false, error: `${bad}; HyperFrames projects from Design must be self-contained.` };
    } else if (path.endsWith(".png")) {
      const c = checkPngChunks(d.bytes);
      if (!c.ok) return { ok: false, error: `${path}: ${c.error}.` };
    } else {
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(d.bytes); } catch { return { ok: false, error: `${path} is not valid UTF-8.` }; }
      const safe = svgSafetyCheck(text);
      if (!safe.ok) return { ok: false, error: `${path} was refused: ${safe.reason}` };
    }
    files.push({ path, bytes: d.bytes });
  }
  if (!seen.has("index.html")) return { ok: false, error: "The project has no index.html." };
  return { ok: true, data: { name: sanitizeExportName(raw.name), files } };
}
