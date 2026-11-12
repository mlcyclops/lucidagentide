// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/design_api.ts - view types and fail-closed shape gates for the Design + Vision routes.
//
// bridge.ts imports these (the layering rule: a pane owns its wire types). Everything a model produced
// (labels, captions) is UNTRUSTED: it is capped and stripped of control characters here, at the boundary,
// and the pane only ever shows it through textContent.

import type { DesignOp } from "../../harness/creator/design/types.ts";
import { cleanText } from "../../harness/creator/design/util.ts";

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const str = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;

/** 400 MB of base64 is the most any single image field may carry (the server caps lower). */
const B64_MAX = 400 * 1024 * 1024;

// ── design routes ───────────────────────────────────────────────────────────

/** The server rebuilds the agent manifest from the validated doc; `latestSeq` is the newest queued op batch. */
export interface DesignStateAck { savedAt: number; latestSeq: number; dropped: number }
export const isDesignStateAck = (d: unknown): d is DesignStateAck => isObj(d) && num(d.savedAt) && num(d.latestSeq);

/** One queued agent batch: applied as ONE undo step, and only to the doc it was queued against. */
export interface DesignOpBatch { seq: number; at: number; ops: DesignOp[]; source: string; docId: string }
export interface DesignOpsPull { ops: DesignOpBatch[]; latest: number }
export function isDesignOpsPull(d: unknown): d is DesignOpsPull {
  if (!isObj(d) || !num(d.latest) || !Array.isArray(d.ops) || d.ops.length > 1000) return false;
  // Each op is re-validated by applyOps; this gate only proves the envelope.
  return d.ops.every((b) => isObj(b) && num(b.seq) && num(b.at) && Array.isArray(b.ops) && b.ops.length <= 200 && typeof b.source === "string" && typeof b.docId === "string");
}

export type DesignExportKind = "png" | "gif" | "apng" | "svg" | "psd" | "psb" | "design";
export interface DesignArtifactView { id: string; kind?: string; mime?: string; bytes?: number; title?: string }
export interface DesignExportResult { artifact?: DesignArtifactView; projectDir?: string }
export function isDesignExportResult(d: unknown): d is DesignExportResult {
  if (!isObj(d)) return false;
  if (d.projectDir !== undefined && !str(d.projectDir, 4096)) return false;
  if (d.artifact !== undefined && !(isObj(d.artifact) && str(d.artifact.id, 200))) return false;
  return d.projectDir !== undefined || d.artifact !== undefined;
}

// ── vision routes (dgx-vision via the engine) ───────────────────────────────

export type VisionOp = "segment" | "decompose" | "matte" | "inpaint" | "upscale" | "depth" | "label" | "vectorize";
/** bbox is null when the mask is empty (the engine's SegmentResult). */
export interface VisionSegmentResult { maskB64: string; score: number; bbox: number[] | null; area: number }
export const isVisionSegment = (d: unknown): d is VisionSegmentResult =>
  isObj(d) && str(d.maskB64, B64_MAX) && num(d.score) && (d.bbox === null || Array.isArray(d.bbox)) && num(d.area);

export interface VisionMaskResult { maskB64: string }
export const isVisionMask = (d: unknown): d is VisionMaskResult => isObj(d) && str(d.maskB64, B64_MAX);

export interface VisionPngResult { pngB64: string }
export const isVisionPng = (d: unknown): d is VisionPngResult => isObj(d) && str(d.pngB64, B64_MAX);

export interface VisionJobStart { jobId: string }
export const isVisionJobStart = (d: unknown): d is VisionJobStart => isObj(d) && str(d.jobId, 128) && d.jobId.length > 0;

export interface VisionJobStatus { state: string; progress: number; message?: string; error?: string; result?: unknown }
export const isVisionJobStatus = (d: unknown): d is VisionJobStatus =>
  isObj(d) && str(d.state, 32) && (d.progress === undefined || num(d.progress));

export interface DecomposedLayer { id: string; pngB64: string; x: number; y: number; width: number; height: number; label: string; confidence: number; depth: number; area: number }
export interface DecomposeResult { layers: DecomposedLayer[]; background: { pngB64: string } | null }

/** Gate + normalize a decompose result: at most 32 layers, finite geometry, labels capped and stripped. */
export function parseDecompose(d: unknown): DecomposeResult | null {
  if (!isObj(d) || !Array.isArray(d.layers) || d.layers.length > 32) return null;
  const layers: DecomposedLayer[] = [];
  for (const l of d.layers) {
    if (!isObj(l) || !str(l.pngB64, B64_MAX) || !num(l.x) || !num(l.y) || !num(l.width) || !num(l.height)) return null;
    if (l.width < 1 || l.height < 1) return null;
    layers.push({
      id: typeof l.id === "string" ? cleanText(l.id, 64) : "",
      pngB64: l.pngB64, x: Math.round(l.x), y: Math.round(l.y), width: Math.round(l.width), height: Math.round(l.height),
      label: cleanText(l.label, 200),
      confidence: num(l.confidence) ? Math.min(1, Math.max(0, l.confidence)) : 0,
      depth: num(l.depth) ? Math.min(1, Math.max(0, l.depth)) : 0.5,
      area: num(l.area) ? Math.max(0, l.area) : 0,
    });
  }
  const bg = isObj(d.background) && str(d.background.pngB64, B64_MAX) ? { pngB64: d.background.pngB64 } : null;
  return { layers, background: bg };
}

export interface UpscaleResult { pngB64?: string; width: number; height: number; artifact?: DesignArtifactView }
export const isUpscaleResult = (d: unknown): d is UpscaleResult =>
  isObj(d) && num(d.width) && num(d.height) && (d.pngB64 === undefined || str(d.pngB64, B64_MAX)) && (d.pngB64 !== undefined || isObj(d.artifact));

export interface VisionLabel { box: [number, number, number, number]; text: string; score: number }
/** Labels are model output: capped to 200 chars, control characters stripped, at most 256 entries. */
export function parseLabels(d: unknown): VisionLabel[] | null {
  if (!isObj(d) || !Array.isArray(d.labels)) return null;
  const out: VisionLabel[] = [];
  for (const l of d.labels.slice(0, 256)) {
    if (!isObj(l) || !Array.isArray(l.box) || l.box.length !== 4 || !l.box.every(num)) continue;
    out.push({ box: [l.box[0], l.box[1], l.box[2], l.box[3]] as [number, number, number, number], text: cleanText(l.text, 200), score: num(l.score) ? l.score : 0 });
  }
  return out;
}

export interface VectorizeResult { svg: string }
export const isVectorize = (d: unknown): d is VectorizeResult => isObj(d) && str(d.svg, 20 * 1024 * 1024);
