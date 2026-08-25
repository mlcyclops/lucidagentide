// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/engine_pf_smoke.ts - P-WINBOOT.2C (ADR-0261): the Program Files boot smoke's PURE decisions.
//
// v1.12.0 bricked because the engine was module-loaded as .ts out of an ACL-protected install tree
// (Program Files) - and no gate ever booted the app from such a tree: packaged_boot.test.ts boots from
// a WRITABLE temp dir, so the exact failure class shipped. This module holds the testable decisions for
// the gate that closes that hole: where to stage the install, how to deny ourselves write on it (the
// standard-user Program Files posture - CI runners are admins, so an explicit deny ACE is what
// reproduces the constraint), which files must exist before a boot attempt means anything, and how to
// undo the hardening so cleanup works. All IO lives in desktop/build/pf-boot-smoke.ts.

import { join } from "node:path";
import { engineExeName } from "./engine_launch.ts";

/** The staged install leaf. The SPACE is deliberate: "Program Files" has one, and spawn/path quoting
 *  bugs around it are a classic Windows failure class this smoke should also catch. */
export const SMOKE_LEAF = "Lucid PF Smoke";

export interface SmokeRootDecision {
  root: string;
  /** True when the decision landed on the real Program Files tree (required under strict). */
  programFiles: boolean;
}

/**
 * Where the hardened install is staged. Strict mode (CI) REQUIRES the real Program Files tree - a
 * runner that cannot write there must fail the build, never silently downgrade to a temp dir (that
 * downgrade is exactly how the v1.12.0 gap survived). Non-strict (a dev box without elevation) falls
 * back to a temp dir that gets the same deny-write hardening: the ACL posture is the load-bearing
 * part, the path is fidelity on top.
 */
export function pickSmokeRoot(o: {
  strict: boolean;
  programFilesDir: string; // e.g. C:\Program Files ("" when the platform has none)
  programFilesWritable: boolean;
  tmpDir: string;
  override?: string; // LUCID_PF_SMOKE_DIR - debugging escape hatch, never used in CI
}): SmokeRootDecision {
  if (o.override) return { root: join(o.override, SMOKE_LEAF), programFiles: false };
  if (o.programFilesDir && o.programFilesWritable) return { root: join(o.programFilesDir, SMOKE_LEAF), programFiles: true };
  if (o.strict) throw new Error(`strict mode requires staging under "${o.programFilesDir || "Program Files"}" and it is not writable from this process`);
  return { root: join(o.tmpDir, SMOKE_LEAF), programFiles: false };
}

/** The files that MUST exist in a staged repo root before booting proves anything. A stage that lost
 *  the engine binary or the prebuilt renderer bundle must fail the stage step, not surface as a
 *  confusing boot timeout. */
export function requiredLayout(platform: NodeJS.Platform): string[] {
  return [join("bin", engineExeName(platform)), join("desktop", "renderer", "app.bundle.js")];
}

/**
 * The hardening commands: make the staged tree read+execute-only for the CURRENT user.
 * win32: an explicit DENY ACE for write/delete rights, inheritable + applied to the existing tree
 * (/T). Deny beats allow even for Administrators - which is the point, because CI runners run as
 * admins and would otherwise sail through Program Files ACLs that block a real standard user.
 * SPECIFIC rights only (WD,AD,WEA,WA,DE,DC), never the generic W: generic write includes
 * SYNCHRONIZE, and denying that EPERMs CreateProcess itself (uv_spawn) - the engine could not even
 * START, which tests nothing. Real Program Files blocks a standard user by LACKING a write allow;
 * the specific-rights deny reproduces that constraint without also denying open-for-execute.
 * POSIX (a dev mac/linux running the demo): chmod -R a-w is the same semantic.
 */
export function hardenPlan(root: string, user: string, platform: NodeJS.Platform): string[][] {
  if (platform === "win32") return [["icacls", root, "/deny", `${user}:(OI)(CI)(WD,AD,WEA,WA,DE,DC)`, "/T", "/C", "/Q"]];
  return [["chmod", "-R", "a-w", root]];
}

/** Undo hardenPlan so the staged tree can be deleted. */
export function restorePlan(root: string, user: string, platform: NodeJS.Platform): string[][] {
  if (platform === "win32") return [["icacls", root, "/remove:d", user, "/T", "/C", "/Q"]];
  return [["chmod", "-R", "u+w", root]];
}

/** Classify the boot outcome into one legible verdict line. */
export function bootVerdict(o: { health: string | null; exitCode: number | null; stderrTail: string }): { ok: boolean; detail: string } {
  if (o.health !== null) {
    try {
      if (JSON.parse(o.health).ok === true) return { ok: true, detail: "engine answered /api/health from the protected tree" };
      return { ok: false, detail: `health answered but not ok: ${o.health.slice(0, 200)}` };
    } catch {
      return { ok: false, detail: `health answered unparseably: ${o.health.slice(0, 200)}` };
    }
  }
  if (o.exitCode !== null) return { ok: false, detail: `engine EXITED (code ${o.exitCode}) before answering /api/health - stderr tail:\n${o.stderrTail}` };
  return { ok: false, detail: `engine never answered /api/health (still running - likely bound elsewhere or wedged) - stderr tail:\n${o.stderrTail}` };
}
