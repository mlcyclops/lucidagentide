// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Increment P-FIGMA.2 — the guided review + DESIGN.md flow (ADR-0154). After /figma import, the modal offers a
// next step: have the agent REVIEW the design (preview_screenshot + preview_inspect + DESIGN.md), and — depending
// on whether the project already has a DESIGN.md — either OPEN it in the IDE or BUILD one from the design. When
// the agent writes DESIGN.md, the backend emits a `design-available` event so the UI can pop it out in the Monaco
// IDE for the user to review/edit. This demo proves the pure detection that drives that event, headlessly.

import { isDesignDocPath, designDocPath, designInvariantsBlock, DESIGN_DOC_NAME } from "../design_doc.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) { console.error("  ✗ " + msg); process.exit(1); }
  console.log("  ✓ " + msg);
}

console.log("== #ADR-0154 P-FIGMA.2: guided review + DESIGN.md build/pop-out ==\n");

console.log("[1] the backend recognizes an agent write to DESIGN.md → drives the `design-available` event");
assert(isDesignDocPath("DESIGN.md"), "a bare DESIGN.md write is recognized");
assert(isDesignDocPath("/work/proj/DESIGN.md"), "a POSIX-path DESIGN.md write is recognized");
assert(isDesignDocPath("C:\\work\\proj\\DESIGN.md"), "a Windows-path DESIGN.md write is recognized");
assert(isDesignDocPath("/work/design.md"), "case-insensitive (design.md) still counts");

console.log("\n[2] no false positives — a look-alike write must NOT pop the IDE");
assert(!isDesignDocPath("/work/DESIGN.md.bak"), "DESIGN.md.bak is not DESIGN.md");
assert(!isDesignDocPath("/work/MY_DESIGN.md"), "MY_DESIGN.md is not DESIGN.md");
assert(!isDesignDocPath("/work/src/App.tsx"), "an ordinary source write is ignored");
assert(!isDesignDocPath(""), "an empty path is ignored");

console.log("\n[3] the popped-out doc resolves under the workspace, and once written it becomes standing guidance");
assert(designDocPath("/work/proj").replace(/\\/g, "/") === "/work/proj/DESIGN.md", "openDesignInIde() targets <workspace>/DESIGN.md");
const built = designInvariantsBlock("# Design\n- 4px grid\n- Ink #0b1020\n- Type: Inter 14/20");
assert(built.includes("<design-invariants>") && built.includes("4px grid"), "a freshly-built DESIGN.md is honored as a <design-invariants> block");
assert(DESIGN_DOC_NAME === "DESIGN.md", "the doc name is DESIGN.md");

console.log("\n✓ P-FIGMA.2 demo passed — DESIGN.md writes are detected (no false positives) and honored once built.");
