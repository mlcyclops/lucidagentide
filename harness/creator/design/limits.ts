// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/creator/design/limits.ts - hard caps for the Design suite (contract section 1).
//
// maxSide and maxRasterPixels mirror Chromium's canvas limits (kMaxSkiaDim 65535, kMaxCanvasArea
// 32768 * 8192). Every parser and encoder in this folder refuses input beyond these, fail-closed.

export const DESIGN_LIMITS = {
  maxSide: 65535,
  maxRasterPixels: 268_435_456,
  maxLayers: 512,
  maxShapes: 20_000,
  maxPathCmds: 200_000,
  maxHints: 256,
  maxKeys: 10_000,
  maxFrames: 1_000,
  maxGifFrames: 600,
  maxLabel: 200,
  defaultTileBudgetBytes: 1_610_612_736,
} as const;

/** Agent op batches are capped per request (contract section 3). */
export const DESIGN_OPS_BATCH_MAX = 200;
/** Strokes per hint and points per stroke: a traced hint is small structured data, never a bulk channel. */
export const DESIGN_MAX_STROKES_PER_HINT = 256;
export const DESIGN_MAX_POINTS_PER_STROKE = 20_000;
/** Text content of a vector text shape. */
export const DESIGN_MAX_TEXT = 2_000;
