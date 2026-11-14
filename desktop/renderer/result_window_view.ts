// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/result_window_view.ts - P-CTX.2b (ADR-0579): the line a tool chip shows when omp cut the
// result the model received. Pure (no DOM), so it is unit-tested; app.ts sets it through textContent.

import { humanBytes, type ResultSpill } from "../result_window.ts";

/** PURE: `Output: 3.7 KB shown to the model of 2.1 MB · rest stored as artifact 0`. */
export function resultWindowLine(s: ResultSpill): string {
  const where = s.artifactId !== undefined ? `rest stored as artifact ${s.artifactId}` : "rest not stored";
  return `Output: ${humanBytes(s.shownBytes)} shown to the model of ${humanBytes(s.storedBytes)} · ${where}`;
}
