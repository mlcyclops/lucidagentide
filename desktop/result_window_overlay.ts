// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/result_window_overlay.ts - P-CTX.2b (ADR-0579): write the tool-result window as an omp `--config`
// overlay. Engine only: the policy it writes is the pure result_window.ts, which the renderer also bundles.

import { closeSync, openSync, writeFileSync } from "node:fs";
import { resultWindowOverlayYaml, type ResultWindow } from "./result_window.ts";

/** Write the overlay through ONE descriptor (open-then-write, never exists-then-write). */
export function writeResultWindowOverlay(path: string, win: ResultWindow | null): void {
  const fd = openSync(path, "w");
  try { writeFileSync(fd, resultWindowOverlayYaml(win), "utf8"); } finally { closeSync(fd); }
}
