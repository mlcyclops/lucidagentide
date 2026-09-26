// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/process_view.ts - P-INTERJECT.1: the unified "what is running right now" shape.
//
// Pure: this module owns only the ProcessView type and the browser-session source seam. The actual
// list is assembled in dev.ts (GET /api/processes) from the live sources it already holds - the
// master backend's mid-turn state, fleet.status() lanes, and the active import job - plus whatever
// browserProcesses() reports. Wave 2 registers real browser sessions through setBrowserProcessSource;
// until then the hook returns [] so the route works day one.

/** One running activity, normalized for the Processes view (renderer + PWA). */
export interface ProcessView {
  id: string;
  kind: "master-turn" | "lane" | "import" | "browser";
  label: string;
  status: string;
  startedAt: number | null;
  lastActivityAt: number | null;
  detail: string;
}

let browserSource: (() => ProcessView[]) | null = null;

/** Wave-2 seam: the browser-control subsystem registers its live-session snapshot here. */
export function setBrowserProcessSource(fn: () => ProcessView[]): void {
  browserSource = fn;
}

/** Live browser sessions, or [] until a source is registered. Fail-quiet: a throwing source must
 *  never break the processes route. */
export function browserProcesses(): ProcessView[] {
  if (!browserSource) return [];
  try {
    const out = browserSource();
    return Array.isArray(out) ? out : [];
  } catch {
    return [];
  }
}
