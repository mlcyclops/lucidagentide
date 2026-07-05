// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Increment P-DESIGN.1 — honor a project's DESIGN.md invariants (ADR-0154). A workspace-root DESIGN.md is the
// design equivalent of CLAUDE.md: standing guidance the agent obeys for all UI/design work. LUCID reads it each
// turn and injects it into the user-turn preamble (never the frozen prefix). This demo proves the pure pieces.

import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { designInvariantsBlock, designDocPath } from "../design_doc.ts";
import { buildUserTurnPreamble } from "../preamble.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) { console.error("  ✗ " + msg); process.exit(1); }
  console.log("  ✓ " + msg);
}

console.log("== #ADR-0154 P-DESIGN.1: the agent honors DESIGN.md invariants every turn ==\n");

const dir = mkdtempSync(join(tmpdir(), "design-"));
try {
  console.log("[1] a workspace DESIGN.md is read + wrapped as standing design guidance");
  writeFileSync(designDocPath(dir), "# Design invariants\n- 8px spacing grid\n- Brand blue #1e6bff\n- Sentence case, no ALL CAPS\n");
  const block = existsSync(designDocPath(dir)) ? designInvariantsBlock(readFileSync(designDocPath(dir), "utf8")) : "";
  assert(block.includes("<design-invariants>") && block.includes("8px spacing grid"), "DESIGN.md wraps into a <design-invariants> block");
  assert(block.includes("Honor them in ALL UI / design"), "it instructs the agent to honor the invariants");

  console.log("\n[2] it rides in the user-turn preamble as STANDING guidance (every turn, not the frozen prefix)");
  const t1 = buildUserTurnPreamble({ persona: null, skill: null, profile: "", designInvariants: block, memoryRecall: null, memoryRecallDelivered: false });
  const t2 = buildUserTurnPreamble({ persona: null, skill: null, profile: "", designInvariants: block, memoryRecall: null, memoryRecallDelivered: true });
  assert(t1.preamble.includes("Brand blue #1e6bff"), "turn 1 carries the invariants");
  assert(t2.preamble.includes("Brand blue #1e6bff"), "turn 2 carries them too (re-delivered, never fades)");

  console.log("\n[3] no DESIGN.md → no block (the agent just proceeds normally)");
  assert(designInvariantsBlock(null) === "", "absent DESIGN.md → empty block");
  const none = buildUserTurnPreamble({ persona: null, skill: null, profile: "", designInvariants: "", memoryRecall: null, memoryRecallDelivered: false });
  assert(!none.preamble.includes("design-invariants"), "no design-invariants block in the preamble when there's no DESIGN.md");

  console.log("\n✓ P-DESIGN.1 demo passed — DESIGN.md is honored as standing, per-turn design guidance.");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
