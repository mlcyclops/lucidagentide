// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/skills_registry.ts — P-SKILLREG.1 (ADR-0098): the enterprise Agent Skills registry READER.
//
// PUBLIC-SEAM ONLY. This source-available repo ships the reader half of the registry: given a skill
// artifact (the private add-on's connector fetches the OCI artifact + its signature), the reader
//   (1) VERIFIES the Ed25519 signature against the workstation's trusted registry keys,
//   (2) runs the SKILL.md + every bundled resource through the EXISTING fail-closed scan gate, and
//   (3) only then INSTALLS it into the local project skill dir with a provenance marker, so the P-SKILL.4
//       directory discovers it (omp-native) and re-classifies it to the `registry` source root.
// The registry SERVER, the Cosign/SLSA pipeline, and the per-provider Terraform runbooks are PRIVATE
// add-on IP (mlcyclops/lucidagentIDEaddon, ADR-A012/A013) — same public-seam / private-IP split as the
// managed-config (ADR-0068) and SIEM Sink (ADR-0069) seams.
//
// SECURITY (CLAUDE.md invariants #1/#3/#5/#7, keystone #2). FAIL-CLOSED throughout: an UNSIGNED artifact,
// a signature that matches NO trusted key, NO trusted keys configured at all, a scan-flagged body/resource,
// or a DEAD scanner ⇒ the install is BLOCKED (recordBlock) and NOTHING is written. Extend-don't-fork (#1):
// the install lands in omp's own `.omp/skills` so its native discovery is untouched. Keystone #2: a freshly
// installed registry skill is NEVER auto-promoted to trusted — it is shown `untrusted` until a human re-scan
// certifies it. Resource paths are pathWithin-confined so a hostile artifact can't traverse out of its dir.

import { createHash, createPublicKey, type KeyObject, verify } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { TrustLabel } from "../harness/contracts.ts";
import { DEFAULT_POLICY, type GateDecision, scanAndDecide } from "../harness/security/gate.ts";
import { ScannerClient } from "../harness/security/scanner_client.ts";
import { currentWorkspace } from "./workspace.ts";
import { pathWithin } from "./path_guard.ts";
import { recordBlock } from "./security_log.ts";
import { REGISTRY_MARKER } from "./skills_gov.ts";

/** The unit the reader installs: a signed SKILL.md + optional bundled resources + provenance. The private
 *  connector produces this from the OCI artifact it fetched; the public reader only ever verifies + installs. */
export interface RegistrySkillArtifact {
  name: string;
  version?: string;
  content: string; // the SKILL.md body — the signed payload
  signature: string; // base64 Ed25519 signature over `content` (utf8 bytes)
  keyId?: string; // hint: which trusted key signed it (verification still tries all)
  registryRef?: string; // provenance: the OCI ref the artifact came from
  resources?: { path: string; content: string }[]; // optional scripts/references/assets
}

/** A trusted registry signing key: an id + the imported Ed25519 public key. */
export interface TrustedRegistryKey {
  id: string;
  key: KeyObject;
}

export interface RegistryInstallResult {
  ok: boolean;
  name: string;
  installed: boolean;
  /** Where the pipeline stopped: which fail-closed stage rejected, or "done" on success. */
  stage: "validate" | "signature" | "scan" | "write" | "done";
  path?: string;
  trust?: TrustLabel;
  keyId?: string;
  findings?: number;
  reason?: string;
}

// Trusted registry keys come from managed config: the LUCID_SKILL_REGISTRY_KEYS env (a JSON array) or a
// per-user JSON file. Each entry is { id, spki } where spki is base64 DER SubjectPublicKeyInfo (an Ed25519
// public key). NO trusted keys ⇒ nothing verifies ⇒ every install is blocked (fail-closed by absence).
const KEYS_ENV = "LUCID_SKILL_REGISTRY_KEYS";
const DEFAULT_KEYS_PATH = join(homedir(), ".omp", "lucid-registry-keys.json");

/** Load + import the trusted registry signing keys. Fail-soft to [] (⇒ every install fail-closed-blocks). */
export function loadTrustedKeys(): TrustedRegistryKey[] {
  let raw = process.env[KEYS_ENV] ?? "";
  if (!raw) {
    try { raw = readFileSync(process.env.LUCID_SKILL_REGISTRY_KEYS_PATH || DEFAULT_KEYS_PATH, "utf8"); }
    catch { return []; }
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const out: TrustedRegistryKey[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const id = "id" in entry ? entry.id : undefined;
    const spki = "spki" in entry ? entry.spki : undefined;
    if (typeof id !== "string" || typeof spki !== "string") continue;
    try { out.push({ id, key: createPublicKey({ key: Buffer.from(spki, "base64"), type: "spki", format: "der" }) }); }
    catch { /* a malformed key entry is skipped — never a partial-trust bypass */ }
  }
  return out;
}

/**
 * Verify a base64 Ed25519 signature over `content` against the trusted keys. FAIL-CLOSED: an empty
 * signature, no configured trusted keys, or a signature matching none of them all return ok:false. Pure
 * (given the imported keys) — no I/O.
 */
export function verifyArtifactSignature(content: string, signatureB64: string, trusted: TrustedRegistryKey[]): { ok: boolean; keyId?: string; reason: string } {
  if (!signatureB64) return { ok: false, reason: "unsigned artifact" };
  if (!trusted.length) return { ok: false, reason: "no trusted registry keys configured" };
  let sig: Buffer;
  try { sig = Buffer.from(signatureB64, "base64"); } catch { return { ok: false, reason: "malformed signature" }; }
  const data = Buffer.from(content, "utf8");
  for (const k of trusted) {
    try { if (verify(null, data, k.key, sig)) return { ok: true, keyId: k.id, reason: "verified" }; }
    catch { /* wrong key type / bad sig for this key — try the next */ }
  }
  return { ok: false, reason: "signature does not match any trusted registry key" };
}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Lazy scanner for install-time gating (mirrors skills_import.ts / skills_data.ts). Fail-closed by
// construction: a scan that throws is caught below and blocks the install, never treated as clean.
let scanner: ScannerClient | null = null;
function getScanner(): ScannerClient {
  if (!scanner) { scanner = new ScannerClient(); scanner.start(); }
  return scanner;
}
/** Stop the registry install scanner (demo/test teardown). */
export function stopRegistryScanner(): void { try { scanner?.stop(); } catch { /* ignore */ } scanner = null; }

/**
 * Verify → scan-gate → install a registry skill. Every stage is fail-closed; a rejection records a block
 * (for the Security panel) and writes NOTHING. On success the skill lands in `.omp/skills/<name>/` with a
 * `.lucid-registry.json` provenance marker, and is returned as trust `untrusted` (keystone #2: never
 * auto-trusted — a human re-scan certifies it). `opts.trusted`/`decide`/`record` are injectable for tests.
 */
export async function installRegistrySkill(
  artifact: RegistrySkillArtifact,
  workspace: string = currentWorkspace(),
  opts: {
    trusted?: TrustedRegistryKey[];
    decide?: (content: string) => Promise<GateDecision>;
    record?: (b: { tool: string; severity?: string; findings?: string; reason: string; sessionId?: string }) => void;
  } = {},
): Promise<RegistryInstallResult> {
  const record = opts.record ?? recordBlock;
  const name = String(artifact?.name ?? "").trim();

  // (1) validate the name/slug + non-empty body BEFORE anything touches disk or the scanner.
  if (!SLUG_RE.test(name)) return { ok: false, name, installed: false, stage: "validate", reason: "invalid skill name (must be kebab-case)" };
  if (typeof artifact.content !== "string" || !artifact.content.trim()) return { ok: false, name, installed: false, stage: "validate", reason: "empty skill content" };

  // (2) signature — fail-closed. No signature / no trusted keys / no match ⇒ block, write nothing.
  const trusted = opts.trusted ?? loadTrustedKeys();
  const sig = verifyArtifactSignature(artifact.content, String(artifact.signature ?? ""), trusted);
  if (!sig.ok) {
    record({ tool: "skill_registry_install", severity: "high", findings: "signature", reason: `registry skill "${name}" rejected — ${sig.reason}` });
    return { ok: false, name, installed: false, stage: "signature", reason: sig.reason };
  }

  // (3) scan-gate the body + every resource through the EXISTING fail-closed gate. A block or a dead
  //     scanner (throw) stops the install; nothing is written (invariant #3, keystone #2).
  const decide = opts.decide ?? ((content) => scanAndDecide(getScanner(), content, DEFAULT_POLICY));
  const texts = [artifact.content, ...(artifact.resources ?? []).map((r) => String(r?.content ?? ""))];
  let findings = 0;
  for (const text of texts) {
    let decision: GateDecision;
    try {
      decision = await decide(text);
    } catch (e) {
      record({ tool: "skill_registry_install", severity: "high", findings: "scanner-unavailable", reason: `registry skill "${name}" blocked — scanner unavailable` });
      return { ok: false, name, installed: false, stage: "scan", trust: "quarantined", reason: `scanner unavailable: ${String((e as Error)?.message ?? e)}` };
    }
    findings += decision.findings.length;
    if (decision.block) {
      record({ tool: "skill_registry_install", severity: "high", findings: String(decision.findings.length), reason: `registry skill "${name}" blocked at the gate — ${decision.reason}` });
      return { ok: false, name, installed: false, stage: "scan", trust: decision.trustLabel, findings, reason: decision.reason };
    }
  }

  // (4) install into `.omp/skills/<name>/`, confined. Resource paths are re-confined so a hostile
  //     artifact can't traverse out of its own dir. Then drop the provenance marker.
  const root = join(workspace, ".omp", "skills");
  const skillDir = pathWithin(root, join(root, name));
  if (!skillDir) return { ok: false, name, installed: false, stage: "write", reason: "unsafe install path" };
  try {
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), artifact.content);
    for (const r of artifact.resources ?? []) {
      const rel = String(r?.path ?? "");
      const dest: string | null = rel ? pathWithin(skillDir, join(skillDir, rel)) : null;
      if (!dest || dest === skillDir) continue; // refuse traversal / empty / the dir itself
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, String(r?.content ?? ""));
    }
    const marker = {
      registryRef: String(artifact.registryRef ?? ""),
      version: String(artifact.version ?? ""),
      keyId: sig.keyId ?? "",
      digestSha256: createHash("sha256").update(artifact.content, "utf8").digest("hex"),
      installedAt: new Date().toISOString(),
    };
    writeFileSync(join(skillDir, REGISTRY_MARKER), JSON.stringify(marker, null, 2));
  } catch (e) {
    return { ok: false, name, installed: false, stage: "write", reason: `install failed: ${String((e as Error)?.message ?? e)}` };
  }

  // Gate-cleared + installed, but NOT auto-trusted (keystone #2): shown untrusted until a human re-scan.
  return { ok: true, name, installed: true, stage: "done", path: join(skillDir, "SKILL.md"), trust: "untrusted", keyId: sig.keyId, findings };
}
