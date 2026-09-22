// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/sandbox_grants.ts — P-SANDBOX.8: user-approved standing directory grants for the AppContainer.
//
// P-SANDBOX.7 (ADR-0173) contains the agent's exec inside a Windows AppContainer whose container SID can
// read/write ONLY the dirs it was explicitly ACL-granted (workspace + tool dirs). That is correct and
// fail-closed — but absolute: the agent cannot reach a directory the USER wants it to use (a data folder,
// a second repo). This module is the desktop-owned half of the grant flow:
//
//   - the agent calls `sandbox_grant_dir` (harness/omp/sandbox_grant_extension.ts); omp PROMPTS
//     (acp_config.yml) and acp_backend shows the approval dialog;
//   - on the user's "Grant until revoked", acp_backend records the approved {path,mode} in this store's
//     ONE-SHOT `pending` slot BEFORE replying allow (defense in depth: the loopback endpoint refuses a
//     POST that no fresh user approval matches — a forged/replayed request applies nothing);
//   - the /api/sandbox/grant endpoint (dev.ts) consumes the pending slot, applies the DACL ACE via the
//     bundled helper (`lucid-appcontainer --apply-acl`), and records the grant here;
//   - the Security panel lists `grants` with a Revoke button → /api/security/sandbox-grant/revoke →
//     `--revoke-acl` + removeGrant.
//
// Every persistent host mutation is therefore user-approved, logged, listed, and reversible.
// Store shape mirrors egress_policy (pure updaters over a small JSON file); persistence mirrors
// settings_store (one fd for write + fchmod 0600 best-effort).

import { closeSync, existsSync, fchmodSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** "rx" = read-only (GENERIC_READ|GENERIC_EXECUTE); "rw" = read-write (GENERIC_ALL). Helper vocabulary. */
export type GrantMode = "rx" | "rw";

export interface SandboxGrant {
  path: string;
  mode: GrantMode;
  grantedAt: string; // ISO
  reason: string;
}

/** The one-shot approved-pending slot acp_backend fills on the user's allow, consumed by the endpoint. */
export interface PendingGrant {
  path: string;
  mode: GrantMode;
  reason: string;
  at: string; // ISO — a stale approval no longer matches (see PENDING_MAX_AGE_MS)
}

export interface SandboxGrantsStore {
  grants: SandboxGrant[];
  pending?: PendingGrant;
}

/** An approval older than this can no longer be consumed — the tool executes right after the user's
 *  click, so minutes of slack is plenty; a forgotten slot must not stay claimable forever. */
export const PENDING_MAX_AGE_MS = 5 * 60_000;

/** PURE: the case/separator-normalized key two Windows paths are compared under (mirrors the
 *  aclTargets dedupe key in tools/appcontainer/lucid_appcontainer.ts). */
export function normalizeGrantPath(p: string): string {
  return p.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

/** PURE: fold a granted directory into the store (newest first). Re-granting the same dir replaces the
 *  old record — the helper's SetEntriesInAclW merge makes the ACE side idempotent, so one row per dir. */
export function addGrant(store: SandboxGrantsStore, grant: SandboxGrant): SandboxGrantsStore {
  const key = normalizeGrantPath(grant.path);
  return { ...store, grants: [grant, ...store.grants.filter((g) => normalizeGrantPath(g.path) !== key)] };
}

/** PURE: drop a grant record by path (normalized compare). */
export function removeGrant(store: SandboxGrantsStore, path: string): SandboxGrantsStore {
  const key = normalizeGrantPath(path);
  return { ...store, grants: store.grants.filter((g) => normalizeGrantPath(g.path) !== key) };
}

/** PURE: park the user-approved {path,mode} for the endpoint to consume. Overwrites any prior slot —
 *  only the LATEST approval is claimable (one dialog, one claim). */
export function setPending(store: SandboxGrantsStore, pending: PendingGrant): SandboxGrantsStore {
  return { ...store, pending };
}

/**
 * PURE: claim the pending approval for {path,mode}. ONE-SHOT and fail-closed: ANY claim attempt clears
 * the slot (matched or not — a mismatched probe must not leave a still-claimable approval behind), and
 * `ok` is true only when a FRESH pending slot names the same normalized path and the same mode.
 */
export function consumePending(store: SandboxGrantsStore, path: string, mode: GrantMode, nowMs: number): { store: SandboxGrantsStore; ok: boolean; reason?: string } {
  const { pending, ...rest } = store;
  const cleared: SandboxGrantsStore = { ...rest, grants: store.grants };
  if (!pending) return { store: cleared, ok: false, reason: "no pending approval" };
  const age = nowMs - Date.parse(pending.at);
  if (!(age >= 0 && age <= PENDING_MAX_AGE_MS)) return { store: cleared, ok: false, reason: "the approval expired" };
  if (normalizeGrantPath(pending.path) !== normalizeGrantPath(path)) return { store: cleared, ok: false, reason: "path does not match the approval" };
  if (pending.mode !== mode) return { store: cleared, ok: false, reason: "mode does not match the approval" };
  return { store: cleared, ok: true };
}

// ── thin persistence (env seam for tests, like LUCID_GUI_SETTINGS_FILE) ───────────────────────────────
function grantsFile(): string {
  return process.env.LUCID_SANDBOX_GRANTS_FILE || join(homedir(), ".omp", "lucid-sandbox-grants.json");
}

export function loadGrants(): SandboxGrantsStore {
  try {
    const fd = openSync(grantsFile(), "r"); // throws when missing → empty store
    try {
      const s = JSON.parse(readFileSync(fd, "utf8")) as SandboxGrantsStore;
      return { grants: Array.isArray(s.grants) ? s.grants : [], ...(s.pending ? { pending: s.pending } : {}) };
    } finally { closeSync(fd); }
  } catch { return { grants: [] }; }
}

export function saveGrants(s: SandboxGrantsStore): void {
  const file = grantsFile();
  try { mkdirSync(dirname(file), { recursive: true }); } catch { /* exists */ }
  const fd = openSync(file, "w");
  try {
    writeFileSync(fd, JSON.stringify(s, null, 2), "utf8");
    try { fchmodSync(fd, 0o600); } catch { /* best-effort on Windows */ }
  } finally { closeSync(fd); }
}

/** The Security panel's list (already newest-first — addGrant unshifts). */
export function sandboxGrantsView(): SandboxGrant[] {
  return loadGrants().grants;
}

// ── the helper edge (NOT pure): apply / check / revoke one DACL ACE via lucid-appcontainer ────────────

/** Single-quote a token for a PowerShell -ArgumentList element ('' escapes an embedded quote). */
function psQuote(a: string): string {
  return `'${a.replace(/'/g, "''")}'`;
}

function runHelper(helper: string, args: string[]): { code: number; stderr: string } {
  const r = Bun.spawnSync([helper, ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode ?? 3, stderr: new TextDecoder().decode(r.stderr).trim() };
}

/** Re-run a failed helper subcommand ELEVATED (UAC) — used only when the un-elevated attempt failed with
 *  Win32 err=5 (ERROR_ACCESS_DENIED: the user lacks WRITE_DAC on the dir). Start-Process -Verb RunAs
 *  cannot pipe the child's stderr back, so the caller MUST re-check the outcome via `--check-acl`. */
function runHelperElevated(helper: string, args: string[]): boolean {
  const list = args.map(psQuote).join(",");
  const cmd = `$p = Start-Process -FilePath ${psQuote(helper)} -ArgumentList ${list} -Verb RunAs -Wait -PassThru; exit $p.ExitCode`;
  const r = Bun.spawnSync(["powershell", "-NoProfile", "-Command", cmd], { stdout: "pipe", stderr: "pipe" });
  return (r.exitCode ?? 1) === 0;
}

/** Does the container SID currently hold an ACE on `path`? (helper `--check-acl`: 0 yes, 1 no). */
export function checkGrantAce(helper: string, path: string): boolean {
  return runHelper(helper, ["--check-acl", path]).code === 0;
}

/**
 * Apply the inheritable container-SID ACE for `mode` on `path` via `--apply-acl`. When the un-elevated
 * attempt fails with err=5 (no WRITE_DAC), retry ONCE elevated (UAC prompt) and trust only a `--check-acl`
 * re-probe — never the elevated exit path alone. Returns a human-readable verdict for the agent.
 */
export function applyGrantAce(helper: string, mode: GrantMode, path: string): { ok: boolean; detail: string } {
  const r = runHelper(helper, ["--apply-acl", mode, path]);
  if (r.code === 0) return { ok: true, detail: `acl grant ${mode} applied` };
  if (r.stderr.includes("err=5")) {
    const launched = runHelperElevated(helper, ["--apply-acl", mode, path]);
    if (launched && checkGrantAce(helper, path)) return { ok: true, detail: `acl grant ${mode} applied (elevated)` };
    return { ok: false, detail: `elevated retry ${launched ? "did not take effect" : "was refused"} · ${r.stderr || `exit ${r.code}`}` };
  }
  return { ok: false, detail: r.stderr || `helper exit ${r.code}` };
}

/** Strip every container-SID ACE on `path` via `--revoke-acl` — same shape (and err=5 elevated retry,
 *  re-checked: revoked means `--check-acl` now says ABSENT) as applyGrantAce. */
export function revokeGrantAce(helper: string, path: string): { ok: boolean; detail: string } {
  const r = runHelper(helper, ["--revoke-acl", path]);
  if (r.code === 0) return { ok: true, detail: "acl revoked" };
  if (r.stderr.includes("err=5")) {
    const launched = runHelperElevated(helper, ["--revoke-acl", path]);
    if (launched && !checkGrantAce(helper, path)) return { ok: true, detail: "acl revoked (elevated)" };
    return { ok: false, detail: `elevated retry ${launched ? "did not take effect" : "was refused"} · ${r.stderr || `exit ${r.code}`}` };
  }
  return { ok: false, detail: r.stderr || `helper exit ${r.code}` };
}
