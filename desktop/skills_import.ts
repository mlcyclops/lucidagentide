// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/skills_import.ts
//
// P-SKILL.1 (ADR-0045): gated drag-and-drop import of project skills. A dropped `.md` is SCANNED
// fail-closed through the Python Unicode scanner BEFORE it can touch the workspace. Clean content is
// written to `<workspace>/.omp/skills/<slug>/SKILL.md` (where omp's discoverSkills() finds it natively);
// suspicious/quarantined content is NOT written — it's recorded as a Security-panel block for review
// (the "block + review" posture). This makes the security gate authoritative for IMPORTED project
// skills, which omp's native loader would otherwise bypass.
//
// Same scan seam as the AskSage persona scan (scanPersona): a lazy ScannerClient + scanAndDecide with
// the strict DEFAULT_POLICY, fail-closed (scanner dead/malformed/timeout ⇒ blocked, never written).

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ScannerClient } from "../harness/security/scanner_client.ts";
import { DEFAULT_POLICY, scanAndDecide } from "../harness/security/gate.ts";
import { currentWorkspace } from "./workspace.ts";
import { pathWithin } from "./path_guard.ts";
import { recordBlock } from "./security_log.ts";

let scanner: ScannerClient | null = null;
function getScanner(): ScannerClient {
  if (!scanner) { scanner = new ScannerClient(); scanner.start(); }
  return scanner;
}
/** Stop the import scanner sidecar (used by the demo/tests for clean teardown). */
export function stopSkillScanner(): void { try { scanner?.stop(); } catch { /* ignore */ } scanner = null; }

export interface SkillImportResult {
  ok: boolean;            // true ⇒ written to disk; false ⇒ blocked (held for review) or write error
  name: string;          // the slug it was (or would be) saved under
  written?: boolean;
  path?: string;         // workspace-relative path written, e.g. `.omp/skills/<slug>/SKILL.md`
  blocked?: boolean;     // scanned but flagged (suspicious/quarantined or scanner-unavailable) → review
  reason?: string;
  trustLabel?: string;
  findings?: number;
}

/** Slugify a dropped filename or a frontmatter `name:` into a safe skill-dir name (no separators, no
 *  `..`, so the write can never escape `.omp/skills/`). */
function slugify(raw: string): string {
  const base = raw.replace(/\.md$/i, "").replace(/[/\\]/g, " ");
  const s = base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return s || "skill";
}

/** Pull `name:` from YAML frontmatter when the dropped file has it (omp skills carry name/description). */
function frontmatterName(content: string): string | null {
  const m = /^---\s*\n([\s\S]*?)\n---/.exec(content);
  if (!m) return null;
  const n = /^\s*name\s*:\s*(.+?)\s*$/m.exec(m[1]!);
  return n ? n[1]!.replace(/^["']|["']$/g, "").trim() : null;
}

/**
 * Scan a dropped skill `.md` fail-closed, then write it to the workspace skills dir (clean) or hold it
 * for review (flagged). `filename` is the dropped file's name (the slug source when there's no
 * frontmatter `name:`). NEVER writes unscanned or flagged content.
 */
export async function importSkill(filename: string, content: string, workspace: string = currentWorkspace()): Promise<SkillImportResult> {
  const slug = slugify(frontmatterName(content) ?? filename);

  let decision: Awaited<ReturnType<typeof scanAndDecide>>;
  try {
    decision = await scanAndDecide(getScanner(), content, DEFAULT_POLICY);
  } catch (e) {
    // Fail-closed (invariant #3): no valid scan ⇒ block, record for review, never write.
    recordBlock({ tool: "skill_import", severity: "high", findings: "scanner-unavailable", reason: `skill "${slug}" import blocked — scanner unavailable` });
    return { ok: false, name: slug, blocked: true, reason: `scanner unavailable: ${String((e as Error)?.message ?? e)}`, findings: 0 };
  }

  if (decision.block) {
    recordBlock({
      tool: "skill_import",
      severity: decision.trustLabel === "quarantined" ? "high" : "medium",
      findings: String(decision.findings.length),
      reason: `skill "${slug}" import blocked — ${decision.reason}`,
    });
    return { ok: false, name: slug, blocked: true, reason: decision.reason, trustLabel: decision.trustLabel, findings: decision.findings.length };
  }

  // Clean → write to <workspace>/.omp/skills/<slug>/SKILL.md, confined under the skills root.
  const root = join(workspace, ".omp", "skills");
  const target = pathWithin(root, join(root, slug, "SKILL.md"));
  if (!target) return { ok: false, name: slug, reason: "unsafe skill path" };
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  } catch (e) {
    return { ok: false, name: slug, reason: `write failed: ${String((e as Error)?.message ?? e)}` };
  }
  return { ok: true, name: slug, written: true, path: join(".omp", "skills", slug, "SKILL.md"), trustLabel: decision.trustLabel, findings: decision.findings.length };
}
