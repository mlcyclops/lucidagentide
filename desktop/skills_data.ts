// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/skills_data.ts — P-SKILL.4 (ADR-0097): the Agent Skill directory's server side.
//
// Extends the read-only `listSkills()` (which just wrapped omp's discoverSkills) into a GOVERNANCE
// surface: every discovered skill is classified to a source ROOT, given a TRUST label (frozen for
// curated roots, the recorded scan verdict otherwise), an invocation id, and a removable flag. On top
// of that sit three additive, confinement-checked actions the directory's per-skill menu calls:
//   • inspectSkill — read the SKILL.md body + a shallow tree of bundled scripts/references/assets, as
//     DATA (the renderer wraps it in trust-boundary delimiters; it is never executed — invariant #5).
//   • rescanSkill  — run the EXISTING fail-closed gate over the skill and record the verdict; a dead
//     scanner ⇒ `quarantined`, never "safe" (invariant #3). Reuses skills_import's scan seam.
//   • removeSkill  — delete a project/user skill dir under a pathWithin confinement; bundled + `.agents`
//     are immutable and refused (mirrors the import write's own roots).
// Extend-don't-fork (#1): omp's discoverSkills stays authoritative for WHICH skills exist; we only add
// a governance layer around it. Bundled INSTALLED_SKILLS live in the renderer (they are inline, not on
// disk) and are composed into the directory client-side — they never flow through this discovery path.

import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { homedir } from "node:os";
import type { Skill as OmpSkill } from "@oh-my-pi/pi-coding-agent"; // type-only: the VALUE import is lazy (see discoverRaw)
import { DEFAULT_POLICY, type GateDecision, scanAndDecide } from "../harness/security/gate.ts";
import { ScannerClient } from "../harness/security/scanner_client.ts";
import type { TrustLabel } from "../harness/contracts.ts";
import { currentWorkspace } from "./workspace.ts";
import { pathWithin } from "./path_guard.ts";
import { recordBlock } from "./security_log.ts";
import { recordScanVerdict, type ScanVerdict, scanVerdicts } from "./skills_scan_log.ts";
import { REGISTRY_MARKER, rootRemovable, rootTrust, type SkillRoot, skillKey } from "./skills_gov.ts";

// The directory row for a DISCOVERED (on-disk) skill. Bundled skills are composed in the renderer and
// carry the same shape minus the disk fields. `source` keeps omp's raw "provider:level" for reference.
export interface SkillInfo {
  name: string;
  description: string;
  source: string;
  root: SkillRoot;
  trust: TrustLabel;
  invocation: string;
  removable: boolean;
  scanned?: ScanVerdict | null;
}

/** Classify a discovered skill's on-disk location to a source root. project = the workspace's
 *  `.omp/skills` (where imports land); user = the per-user skill dirs; agents = a `.agents/skills`
 *  tree; everything else (a third-party CLI provider) = plugin. PURE given the three anchor dirs. */
function classifyRoot(baseDir: string, workspace: string, home: string): SkillRoot {
  if (pathWithin(join(workspace, ".omp", "skills"), baseDir)) return "project";
  if (pathWithin(join(home, ".omp", "agent", "skills"), baseDir) || pathWithin(join(home, ".omp", "skills"), baseDir)) return "user";
  if (resolve(baseDir).replace(/\\/g, "/").includes("/.agents/skills/")) return "agents";
  return "plugin";
}

/** True when a skill dir carries the P-SKILLREG.1 provenance marker (installed from the registry). A
 *  try-read (not existsSync-then-read) avoids the TOCTOU pattern; a registry install lands in the project
 *  skills dir, so this marker is what distinguishes it from a hand-authored project skill. */
function isRegistryInstall(baseDir: string): boolean {
  try { readFileSync(join(baseDir, REGISTRY_MARKER), "utf8"); return true; } catch { return false; }
}

/** classifyRoot, then re-classify a marked project install to the `registry` root (P-SKILLREG.1). */
function classifySkillRoot(baseDir: string, workspace: string, home: string): SkillRoot {
  const root = classifyRoot(baseDir, workspace, home);
  return root === "project" && isRegistryInstall(baseDir) ? "registry" : root;
}

/** The confinement root a removable skill MUST sit under, so remove can never rmSync outside it. */
function removableRootDir(root: SkillRoot, workspace: string, home: string): string | null {
  // registry installs live in the project skills dir (P-SKILLREG.1) — uninstall = remove that folder.
  if (root === "project" || root === "registry") return join(workspace, ".omp", "skills");
  if (root === "user") return join(home, ".omp");
  return null;
}

/** Raw omp discovery (fail-soft): the visible, named skills omp would load for this workspace. Returns
 *  [] on any discovery error so the directory degrades to bundled-only rather than throwing.
 *  The @oh-my-pi/pi-coding-agent import is LAZY + fail-soft ON PURPOSE (ADR-0177): a static import
 *  bricked v1.10.2 - the packaging filter stripped the .md prompt files that package imports at
 *  module load, so dev.ts died at BOOT and the engine never bound its port. An optional feature
 *  dependency must degrade the feature, never kill the engine. */
async function discoverRaw(workspace: string): Promise<OmpSkill[]> {
  try {
    const { discoverSkills } = await import("@oh-my-pi/pi-coding-agent");
    const r = await discoverSkills(workspace);
    return (r?.skills ?? []).filter((s) => s && !s.hide && s.name);
  } catch {
    return [];
  }
}

/**
 * The skill directory (discovered skills only). Each row is classified to a root, labeled with its trust
 * (frozen `trusted` for `.agents`; the recorded scan verdict, else `untrusted`, for the rest), and marked
 * removable iff it lives in a dir we own. The renderer composes the bundled corpus in ahead of these.
 */
export async function listSkills(workspace: string = currentWorkspace()): Promise<SkillInfo[]> {
  const home = homedir();
  const verdicts = scanVerdicts();
  return (await discoverRaw(workspace)).map((s) => {
    const root = classifySkillRoot(s.baseDir, workspace, home);
    const scanned = verdicts[skillKey(root, s.name)] ?? null;
    return {
      name: String(s.name),
      description: String(s.description ?? ""),
      source: String(s.source ?? ""),
      root,
      trust: rootTrust(root, scanned?.trust),
      invocation: `/skill:${s.name}`,
      removable: rootRemovable(root),
      scanned,
    };
  });
}

/** Locate one discovered skill by name (omp dedupes by name, so a name is unique across roots). */
async function resolveSkill(name: string, workspace: string): Promise<{ skill: OmpSkill; root: SkillRoot } | null> {
  const raw = await discoverRaw(workspace);
  const skill = raw.find((s) => s.name === name);
  if (!skill) return null;
  return { skill, root: classifySkillRoot(skill.baseDir, workspace, homedir()) };
}

export interface SkillResource {
  dir: string;
  files: string[];
}
export interface SkillInspect {
  ok: boolean;
  name: string;
  root?: SkillRoot;
  trust?: TrustLabel;
  body?: string;
  resources?: SkillResource[];
  provenance?: string;
  reason?: string;
}

const BODY_CAP = 20_000; // inspect is a display; a huge SKILL.md is clipped, not streamed.
const RES_DIRS = ["scripts", "references", "assets"] as const;

/** Read a skill's SKILL.md body + a shallow listing of its bundled resource dirs, all confined to the
 *  skill's own baseDir. Content is returned as DATA for the renderer to delimit — never executed. */
export async function inspectSkill(name: string, workspace: string = currentWorkspace()): Promise<SkillInspect> {
  const found = await resolveSkill(name, workspace);
  if (!found) return { ok: false, name, reason: "skill not found" };
  const { skill, root } = found;
  const filePath = pathWithin(skill.baseDir, skill.filePath);
  if (!filePath) return { ok: false, name, reason: "unsafe skill path" };

  let body = "";
  try { body = readFileSync(filePath, "utf8").slice(0, BODY_CAP); } catch { body = ""; }

  const resources: SkillResource[] = [];
  for (const d of RES_DIRS) {
    const dir = pathWithin(skill.baseDir, join(skill.baseDir, d));
    if (!dir) continue;
    try {
      const files = readdirSync(dir).filter((f) => { try { return statSync(join(dir, f)).isFile(); } catch { return false; } }).slice(0, 40);
      if (files.length) resources.push({ dir: d, files });
    } catch { /* no such resource dir — skip */ }
  }

  const verdict = scanVerdicts()[skillKey(root, name)] ?? null;
  return { ok: true, name, root, trust: rootTrust(root, verdict?.trust), body, resources, provenance: provenanceFor(root, name, skill.baseDir) };
}

/** Provenance line for a curated `.agents` skill (its SOURCES.md row) or a registry install (its marker). */
function provenanceFor(root: SkillRoot, name: string, baseDir: string): string | undefined {
  if (root === "registry") {
    try {
      const m = JSON.parse(readFileSync(join(baseDir, REGISTRY_MARKER), "utf8")) as { registryRef?: unknown; keyId?: unknown; version?: unknown; installedAt?: unknown };
      const ref = typeof m.registryRef === "string" && m.registryRef ? m.registryRef : "registry";
      const ver = typeof m.version === "string" && m.version ? `@${m.version}` : "";
      const key = typeof m.keyId === "string" && m.keyId ? ` · signed by ${m.keyId}` : "";
      const at = typeof m.installedAt === "string" && m.installedAt ? ` · installed ${m.installedAt}` : "";
      return `from registry ${ref}${ver}${key}${at}`;
    } catch { return "from the enterprise skills registry"; }
  }
  if (root !== "agents") return undefined;
  const sources = pathWithin(resolve(baseDir, ".."), join(resolve(baseDir, ".."), "SOURCES.md"));
  if (!sources) return undefined;
  try {
    const row = readFileSync(sources, "utf8").split("\n").find((l) => l.includes(`\`${name}\``));
    return row?.trim();
  } catch { return undefined; }
}

// Lazy scanner for on-demand re-scans (mirrors skills_import.ts). Fail-closed by construction: a scan
// that throws is caught by rescanSkill and recorded as `quarantined`, never treated as clean.
let scanner: ScannerClient | null = null;
function getScanner(): ScannerClient {
  if (!scanner) { scanner = new ScannerClient(); scanner.start(); }
  return scanner;
}
/** Stop the directory's re-scan sidecar (demo/test teardown). */
export function stopSkillDirScanner(): void { try { scanner?.stop(); } catch { /* ignore */ } scanner = null; }

export interface SkillRescanResult {
  ok: boolean;
  name: string;
  found: boolean;
  trust?: TrustLabel;
  findings?: number;
  blocked?: boolean;
  reason?: string;
}

/**
 * Re-scan a discovered skill through the EXISTING fail-closed gate and record the verdict. `decide` is
 * injectable (tests/demo) but defaults to the real scanner: a clean scan records `trusted`, sub-threshold
 * findings `suspicious`, a blocking hit `quarantined` (+ recordBlock for the Security panel), and a scan
 * that FAILS (dead sidecar) records `quarantined` — never "safe" (invariant #3, keystone #2).
 */
export async function rescanSkill(
  name: string,
  workspace: string = currentWorkspace(),
  decide: (content: string) => Promise<GateDecision> = (content) => scanAndDecide(getScanner(), content, DEFAULT_POLICY),
  // injectable (typed to just the CALL — rescan ignores the return) so unit tests never touch the real
  // block log / OCSF sink; the demo + production use the default recordBlock.
  record: (b: { tool: string; severity?: string; findings?: string; reason: string; sessionId?: string }) => void = recordBlock,
): Promise<SkillRescanResult> {
  const found = await resolveSkill(name, workspace);
  if (!found) return { ok: false, name, found: false, reason: "skill not found" };
  const { skill, root } = found;
  const key = skillKey(root, name);

  const filePath = pathWithin(skill.baseDir, skill.filePath);
  let content = "";
  try { if (filePath) content = readFileSync(filePath, "utf8"); } catch { content = ""; }

  let decision: GateDecision;
  try {
    decision = await decide(content);
  } catch (e) {
    // Fail-closed: no valid scan ⇒ quarantine + record for review, never a clean label.
    recordScanVerdict(key, "quarantined", 0);
    record({ tool: "skill_rescan", severity: "high", findings: "scanner-unavailable", reason: `skill "${name}" re-scan blocked — scanner unavailable` });
    return { ok: true, name, found: true, trust: "quarantined", findings: 0, blocked: true, reason: `scanner unavailable: ${String((e as Error)?.message ?? e)}` };
  }

  recordScanVerdict(key, decision.trustLabel, decision.findings.length);
  if (decision.block) {
    record({
      tool: "skill_rescan",
      severity: decision.trustLabel === "quarantined" ? "high" : "medium",
      findings: String(decision.findings.length),
      reason: `skill "${name}" re-scan flagged — ${decision.reason}`,
    });
  }
  return { ok: true, name, found: true, trust: decision.trustLabel, findings: decision.findings.length, blocked: decision.block, reason: decision.reason };
}

export interface SkillRemoveResult {
  ok: boolean;
  name: string;
  removed?: boolean;
  root?: SkillRoot;
  reason?: string;
}

/**
 * Delete a project/user skill's directory. Bundled/agents/plugin roots are IMMUTABLE and refused; the
 * target dir must sit under its removable confinement root (pathWithin), so remove can never escape the
 * import write's own tree even if discovery ever returned a surprising path.
 */
export async function removeSkill(name: string, workspace: string = currentWorkspace()): Promise<SkillRemoveResult> {
  const found = await resolveSkill(name, workspace);
  if (!found) return { ok: false, name, reason: "skill not found" };
  const { skill, root } = found;
  if (!rootRemovable(root)) return { ok: false, name, root, reason: `${root} skills are immutable` };

  const confineRoot = removableRootDir(root, workspace, homedir());
  const target = confineRoot ? pathWithin(confineRoot, skill.baseDir) : null;
  // Never delete the root itself, and never a path that resolves outside the confinement root.
  if (!target || basename(target) === "skills" || target === resolve(confineRoot!)) return { ok: false, name, root, reason: "unsafe skill path" };
  try {
    rmSync(target, { recursive: true, force: true });
  } catch (e) {
    return { ok: false, name, root, reason: `remove failed: ${String((e as Error)?.message ?? e)}` };
  }
  return { ok: true, name, removed: true, root };
}
