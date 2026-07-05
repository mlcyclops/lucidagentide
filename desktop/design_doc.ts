// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/design_doc.ts — P-DESIGN.1 (ADR-0154): honor a project's DESIGN.md invariants. A workspace-root
// DESIGN.md is the design equivalent of CLAUDE.md: the user's OWN standing guidance for UI/design work (layout,
// spacing, color, typography, components, tone). This module reads it and wraps it into a per-turn preamble
// block so the agent honors it EVERY turn (it never enters the frozen prefix — it rides in the user-turn tail
// like the persona/skill/profile blocks). Pure: the block builder + path/detection are unit-testable.
//
// TRUST NOTE: DESIGN.md is the user's project file, delivered as trusted STANDING INSTRUCTIONS (like CLAUDE.md)
// — the whole point is the agent obeys it. It is NOT untrusted-delimited data (that would defeat the feature).

import { join } from "node:path";

export const DESIGN_DOC_NAME = "DESIGN.md";
export const MAX_DESIGN_CHARS = 12_000; // clip so a huge doc can't dominate the turn / balloon tokens

/** Absolute path to a workspace's DESIGN.md. */
export function designDocPath(workspaceDir: string): string {
  return join(workspaceDir, DESIGN_DOC_NAME);
}

/** True when a write/edit path targets the workspace DESIGN.md (any directory separator, case-insensitive).
 *  P-FIGMA.2: the backend watches tool calls for this so the UI can offer to pop DESIGN.md out in the IDE. */
export function isDesignDocPath(p: string): boolean {
  return typeof p === "string" && new RegExp(`(^|[\\\\/])${DESIGN_DOC_NAME}$`, "i").test(p);
}

/** Wrap DESIGN.md content into a standing `<design-invariants>` guidance block for the user-turn preamble.
 *  Returns "" when absent/empty. Clipped to MAX_DESIGN_CHARS. */
export function designInvariantsBlock(designMd: string | null | undefined): string {
  const body = (designMd ?? "").trim();
  if (!body) return "";
  const clipped = body.length > MAX_DESIGN_CHARS ? body.slice(0, MAX_DESIGN_CHARS) + "\n…(truncated — see DESIGN.md)" : body;
  return `<design-invariants>
This project has DESIGN.md invariants. Honor them in ALL UI / design / styling work — layout, spacing, color, typography, components, copy tone, and accessibility. If a request would conflict with them, say so and propose an option that fits rather than silently violating them.

${clipped}
</design-invariants>`;
}
