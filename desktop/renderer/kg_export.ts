// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/kg_export.ts - pure helper behind the export-toast affordances (increment B-KG.2,
// issue #115). Kept DOM-free so the decision (what actions to offer, whether to persist the toast) is
// unit-testable headlessly and provable via `make demo-B-KG.2`.

export interface ExportActionPlan {
  reveal: boolean;  // offer "Open folder" (native reveal - only when a dest exists AND the shell can do it)
  copy: boolean;    // offer "Copy path" (works anywhere there's a dest, via the clipboard)
  persist: boolean; // keep the toast up (timeout 0) instead of auto-dismissing - so the path stays recoverable
}

/** Decide the export-toast affordances for a destination path.
 *
 *  The bug (#115): the export destination flashed in a toast for a few seconds and was gone - the user
 *  forgot where the vault landed. With a real dest we now keep the toast up and offer Copy path (and, in
 *  the desktop app, Open folder). With no dest (export failed before writing) we offer nothing and let the
 *  toast auto-dismiss as before. */
export function exportActionPlan(dest: string | null | undefined, canReveal: boolean): ExportActionPlan {
  const hasDest = typeof dest === "string" && dest.length > 0;
  return { reveal: hasDest && canReveal, copy: hasDest, persist: hasDest };
}
