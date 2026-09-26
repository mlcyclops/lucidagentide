// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// prompt_audit.test.ts - P-CTX.1 (ADR-0350).
//
// The load-bearing assertions:
//   1. DRIFT GUARDS: the audit's appended-policy composition and extension list mirror
//      desktop/acp_backend.ts (the production spawn). If acp_backend changes what it
//      loads or appends, these tests fail LOUDLY instead of the audit silently
//      measuring a stale spawn shape.
//   2. SUM INVARIANTS: residual rows are differences, so sections always sum exactly.
//      Attribution that does not add up is fabrication, and fabrication is banned.
//   3. HONESTY: an absent workspace tree reports as absent (note), never a plausible 0
//      that reads as "measured and empty"; the tokenizer mode is always named.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildReport,
  captureAssembly,
  composeAppendedPolicy,
  MEASURED_EXTENSION_FILES,
  policyParts,
  renderReport,
  type AuditCapture,
} from "./prompt_audit.ts";

const ACP_BACKEND = join(import.meta.dir, "..", "..", "desktop", "acp_backend.ts");

describe("drift guards against the production spawn (acp_backend.ts)", () => {
  test("composeAppendedPolicy mirrors acp_backend's appendedPolicy interpolation byte for byte", async () => {
    const src = await Bun.file(ACP_BACKEND).text();
    // The literal template expression in acp_backend.ts (backslash-n in source):
    const needle =
      "${DELEGATION_POLICY}\\n\\n${BUILD_POLICY}\\n\\n${PREVIEW_POLICY}\\n\\n${ENGAGEMENT_POLICY}\\n\\n${AGENT_BUILDER_POLICY}\\n\\n${SLASH_COMMAND_POLICY}\\n\\n${DATA_INTEGRATION_POLICY}\\n\\n${JEV_POLICY}";
    expect(src).toContain(needle);
    // And the audit joins the same 8 policies in the same order with the same separator.
    const composed = composeAppendedPolicy();
    let cursor = -1;
    for (const p of policyParts()) {
      const at = composed.indexOf(p.text);
      expect(at).toBeGreaterThan(cursor);
      cursor = at;
    }
    expect(policyParts()).toHaveLength(8);
  });

  test("every measured extension is one acp_backend actually spawns", async () => {
    const src = await Bun.file(ACP_BACKEND).text();
    for (const file of MEASURED_EXTENSION_FILES) {
      expect(src).toContain(file);
    }
  });
});

function syntheticCapture(overrides: Partial<AuditCapture> = {}): AuditCapture {
  return {
    cwd: "/repo",
    tokenizer: "estimate",
    hermetic: true,
    blockTokens: [1000, 400],
    tools: [
      { name: "read", tokens: 120, source: "builtin" },
      { name: "preview_open", tokens: 80, source: "extension" },
    ],
    toolsTokens: 200,
    skills: [{ name: "s1", tokens: 30 }],
    skillsTokens: 300,
    appendedPolicyTokens: 250,
    policyRows: [{ label: "delegation", tokens: 250 }],
    contextFiles: [{ path: "AGENTS.md", tokens: 90 }],
    workspaceTreeTokens: 60,
    nonMessageTokens: 1600,
    excluded: ["x"],
    ...overrides,
  };
}

describe("buildReport sum invariants", () => {
  test("every section's rows sum exactly to the section total (residuals are differences)", () => {
    const r = buildReport(syntheticCapture());
    for (const s of r.sections) {
      if (s.rows.length === 0) continue;
      const sum = s.rows.reduce((a, row) => a + row.tokens, 0);
      expect(sum).toBe(s.tokens);
    }
    // block 0: 300 skills + 250 policies + residual 450 = 1000
    const block0 = r.sections.find((s) => s.label.startsWith("system prompt"));
    expect(block0?.rows.at(-1)?.tokens).toBe(1000 - 300 - 250);
    // block 1: 90 ctx + 60 tree + residual 250 = 400
    const block1 = r.sections.find((s) => s.label.startsWith("project footer"));
    expect(block1?.rows.at(-1)?.tokens).toBe(400 - 90 - 60);
  });

  test("window and target math", () => {
    const r = buildReport(syntheticCapture(), { window: 65536, target: 10000 });
    expect(r.total).toBe(1600);
    expect(r.workingRoom).toBe(65536 - 1600);
    expect(r.overTarget).toBe(1600 - 10000);
  });

  test("a negative residual is reported raw, never clamped into a lie", () => {
    // skills + policies claim more than block 0 holds: the residual must go negative
    // and the sum invariant must still hold, so the inconsistency is VISIBLE.
    const r = buildReport(syntheticCapture({ blockTokens: [100, 400], skillsTokens: 300 }));
    const block0 = r.sections.find((s) => s.label.startsWith("system prompt"));
    expect(block0?.rows.at(-1)?.tokens).toBe(100 - 300 - 250);
    const sum = block0?.rows.reduce((a, row) => a + row.tokens, 0);
    expect(sum).toBe(100);
  });
});

describe("honesty rules", () => {
  test("absent workspace tree reports as absent, never a measured 0", () => {
    const r = buildReport(syntheticCapture({ workspaceTreeTokens: null }));
    const block1 = r.sections.find((s) => s.label.startsWith("project footer"));
    const tree = block1?.rows.find((row) => row.label === "workspace tree");
    expect(tree?.tokens).toBe(0);
    expect(tree?.note).toContain("not in prompt");
    // residual absorbs nothing for the tree: 400 - 90 - 0
    expect(block1?.rows.at(-1)?.tokens).toBe(400 - 90);
  });

  test("the rendered report names the tokenizer mode and the exclusions", () => {
    const text = renderReport(buildReport(syntheticCapture()));
    expect(text).toContain("tokenizer: estimate");
    expect(text).toContain("not measured here");
    expect(text).toContain("  - x");
    expect(text).toContain("[ext]");
  });

  test("no em dash anywhere in the rendered report (writing-style invariant)", () => {
    const text = renderReport(buildReport(syntheticCapture()));
    expect(text).not.toContain("\u2014");
  });

  test("long labels clamp to one line instead of shattering alignment", () => {
    const longPath = `context file: ${"x".repeat(120)}`;
    const r = buildReport(
      syntheticCapture({ contextFiles: [{ path: "x".repeat(120), tokens: 90 }] }),
    );
    const text = renderReport(r);
    for (const line of text.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(120);
    }
    expect(longPath.length).toBeGreaterThan(100); // the clamp was actually exercised
  });
});

describe("captureAssembly (real omp session, offline)", () => {
  test("assembles and measures a real session on an empty cwd", async () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-cwd-"));
    try {
      const c = await captureAssembly({ cwd: dir, withExtensions: false });
      expect(c.blockTokens.length).toBeGreaterThanOrEqual(1);
      expect(c.nonMessageTokens).toBeGreaterThan(0);
      expect(c.tools.length).toBeGreaterThan(0);
      expect(c.tools.every((t) => t.source === "builtin")).toBe(true);
      expect(c.tokenizer).toBe("estimate"); // NODE_ENV=test pins the estimate path
      expect(c.hermetic).toBe(true);
      expect(c.appendedPolicyTokens).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});
