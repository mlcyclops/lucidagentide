// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/compliance_report.ts
//
// P-COMPLY.1 (ADR-0479): the NIST SP 800-171 Rev 3 evidence report (Contract D). One module serves both
// the CLI (tools/compliance/evidence.ts) and GET /api/compliance/report (compliance_routes.ts).
//
// Two halves, kept apart so the status logic is testable without a real host:
//   - gatherProbes(): READ-ONLY host and LUCID facts (crypto module, vault custody, CUI lockdown, managed
//     policy, egress posture, audit sink, sandbox policy, installer signature, OS FIPS policy, disk
//     encryption). Every OS probe degrades to "unknown" with a reason; nothing here writes a file, creates
//     a vault key or migrates a setting.
//   - buildReport(probes): PURE. Turns the facts into per-requirement checks with a status.
//
// NO SECRET VALUES, EVER: the report carries custody names, states, counts, paths and dates only. The vault
// is read for its entry COUNT; no value is copied out of the decrypted map.

import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { defaultAuditPath } from "./audit_export.ts";
import { clampPosture } from "./egress_policy.ts";
import { cryptoInfo, type CryptoProviderInfo } from "../harness/crypto/fips_crypto.ts";
import { engineVaultDir, readVault, vaultStatus } from "./engine_vault.ts";
import { managedAsksageOnly, managedConfig, managedRequireIsolation, managedSandboxFoldersLocked, managedSandboxLocksOn, type ManagedConfig } from "./managed_config.ts";
import { loadWhitelist } from "./network_whitelist.ts";
import { APP_VERSION } from "./version.ts";

// ── Contract D types (Contract A's CryptoProviderInfo is imported from fips_crypto.ts) ──────────────

export type CheckStatus = "pass" | "fail" | "partial" | "customer" | "n/a";

export interface ComplianceCheck {
  /** SP 800-171 Rev 3 requirement id, e.g. "03.13.11". */
  id: string;
  /** Rev 2 cross-reference ids (control-matrix-r3.csv), e.g. ["3.13.11"]. */
  r2: string[];
  title: string;
  status: CheckStatus;
  /** What was observed on this host. Metadata only. */
  evidence: string;
  /** Where an assessor re-checks it (file, registry key, command). */
  where: string;
}

export interface VaultFacts { custody: string; state: string; entries: number | null; detail?: string }
export interface CuiFacts { asksageOnly: boolean; managed: boolean }
export interface PolicyFacts { present: boolean; path: string | null; orgName: string | null }
export interface EgressFacts {
  /** Effective "allow all websites" posture after the managed clamp. */
  allowAll: boolean;
  allowWebSearch: boolean;
  whitelistEntries: number;
  managedAllowedHosts: number;
  managedDeniedHosts: number;
  dangerModeDisabled: boolean;
  locked: boolean;
}
export interface AuditFacts {
  enabled: boolean;
  /** Managed sink type ("file" when unmanaged). Non-file sinks are delivered by the private add-on. */
  sink: string;
  path: string;
  exists: boolean;
  bytes: number;
  lastWrite: string | null;
  /** POSIX: true when no group/other permission bits are set. null on Windows (NTFS ACLs) or no file. */
  ownerOnly: boolean | null;
}
export interface SandboxFacts { platform: string; requireIsolation: boolean; locksOn: boolean; foldersLocked: boolean }
export type SigningStatus = "valid" | "unsigned" | "invalid" | "not-found" | "unknown";
export interface SigningFacts { target: string | null; status: SigningStatus; signer: string | null; detail: string }
export type DiskStatus = "on" | "off" | "unknown";
export interface HostFacts { os: string; arch: string; user: string; diskEncryption: { status: DiskStatus; detail: string } }

export interface ComplianceProbes {
  generatedAt: string;
  lucidVersion: string;
  host: HostFacts;
  crypto: CryptoProviderInfo;
  vault: VaultFacts;
  cui: CuiFacts;
  policy: PolicyFacts;
  egress: EgressFacts;
  audit: AuditFacts;
  sandbox: SandboxFacts;
  signing: SigningFacts;
}

/** Contract D. `policy` and `host.diskEncryption` extend the contract's field list; nothing is removed. */
export interface ComplianceReport extends ComplianceProbes { checks: ComplianceCheck[] }

// ── Pure status logic ───────────────────────────────────────────────────────────────────────────────

/** Custodies where the vault master key is held by an OS key store (engine_vault.ts VaultBackendKind). */
const OS_CUSTODY: Record<string, true> = { dpapi: true, keychain: true, libsecret: true };

export function cryptoCheck(c: CryptoProviderInfo): ComplianceCheck {
  const policy = c.osFipsPolicy === null ? "OS FIPS policy unknown" : `OS FIPS policy ${c.osFipsPolicy ? "enabled" : "disabled"}`;
  const base = { id: "03.13.11", r2: ["3.13.11"], title: "Cryptographic Protection", where: "harness/crypto/fips_crypto.ts cryptoInfo(); docs/compliance/poam.md" };
  if (c.fips) return { ...base, status: "pass", evidence: `FIPS 140-validated module in use: ${c.module} (${c.detail}); ${policy}.` };
  const why = c.required ? "FIPS is REQUIRED by policy but no validated module is usable (operations fail closed)" : "at-rest crypto runs in a module that is not FIPS 140-validated";
  return { ...base, status: "fail", evidence: `${why}: ${c.module} (${c.detail}); ${policy}.` };
}

export function transmissionStorageCheck(v: VaultFacts, disk: HostFacts["diskEncryption"]): ComplianceCheck {
  const vaultOk = v.state === "ok" && OS_CUSTODY[v.custody] === true;
  const diskOn = disk.status === "on";
  const parts = [
    `credential vault ${vaultOk ? `sealed under OS custody (${v.custody})` : `NOT under OS custody (${v.custody}, ${v.state})`}`,
    `system disk encryption ${disk.status} (${disk.detail})`,
    "outbound TLS is performed by Bun/omp and is not a FIPS-validated module (POA&M P-1)",
  ];
  return {
    id: "03.13.08", r2: ["3.13.8", "3.13.16", "3.1.13", "3.8.6"], title: "Transmission and Storage Confidentiality",
    status: !vaultOk && !diskOn ? "fail" : "partial",
    evidence: parts.join("; ") + ".",
    where: "desktop/engine_vault.ts vaultStatus(); manage-bde -status / fdesetup status; docs/compliance/poam.md",
  };
}

export function keyManagementCheck(v: VaultFacts): ComplianceCheck {
  const base = { id: "03.13.10", r2: ["3.13.10"], title: "Cryptographic Key Establishment and Management", where: "desktop/engine_vault.ts (master key per vault directory, OS key store)" };
  if (v.state === "ok" && OS_CUSTODY[v.custody] === true) return { ...base, status: "pass", evidence: `Vault master key held by the OS key store (${v.custody}); ${v.entries ?? "unknown"} sealed entries.` };
  return { ...base, status: "fail", evidence: `Vault master key not under OS custody: custody ${v.custody}, state ${v.state}${v.detail ? ` (${v.detail})` : ""}.` };
}

export function informationFlowCheck(cui: CuiFacts): ComplianceCheck {
  const base = { id: "03.01.03", r2: ["3.1.3"], title: "Information Flow Enforcement", where: "desktop/lockdown_route.ts; desktop/cui_policy.ts; managed policy asksageOnly / models.asksageOnly" };
  if (cui.managed) return { ...base, status: "pass", evidence: "CUI lockdown (AskSage-only routing) is enforced by managed policy; users cannot turn it off." };
  if (cui.asksageOnly) return { ...base, status: "partial", evidence: "CUI lockdown is on by the user's own setting; it is not locked by managed policy." };
  return { ...base, status: "fail", evidence: "CUI lockdown is off: prompts and files may reach any configured model provider." };
}

export function configurationSettingsCheck(p: PolicyFacts): ComplianceCheck {
  const base = { id: "03.04.02", r2: ["3.4.2"], title: "Configuration Settings", where: "desktop/managed_config.ts (managed-config.json or HKLM\\Software\\Policies\\LucidAgentIDE)" };
  if (p.present) return { ...base, status: "pass", evidence: `Managed policy present${p.orgName ? ` for ${p.orgName}` : ""} (${p.path ?? "unknown source"}).` };
  return { ...base, status: "customer", evidence: "No managed policy found; the organization must deploy one to establish and lock the security settings." };
}

export function denyByDefaultCheck(e: EgressFacts): ComplianceCheck {
  const base = { id: "03.13.06", r2: ["3.13.6"], title: "Network Communications \u2013 Deny by Default \u2013 Allow by Exception", where: "desktop/network_whitelist.ts (~/.omp/lucid-whitelist.json); desktop/egress_policy.ts clampPosture()" };
  const facts = `${e.whitelistEntries} whitelist entries, managed allowedHosts ${e.managedAllowedHosts}, deniedHosts ${e.managedDeniedHosts}`;
  if (e.allowAll) return { ...base, status: "fail", evidence: `Egress posture is "allow all websites"; agent egress is not denied by default (${facts}).` };
  if (e.dangerModeDisabled || e.locked || e.managedAllowedHosts > 0) {
    return { ...base, status: "pass", evidence: `Allow-all is off and held off by managed policy; hosts outside the whitelist need an explicit per-host approval (${facts}).` };
  }
  return { ...base, status: "partial", evidence: `Allow-all is off by user choice only; a user can turn it back on (${facts}).` };
}

export function eventLoggingCheck(a: AuditFacts): ComplianceCheck {
  const base = { id: "03.03.01", r2: ["3.3.1"], title: "Event Logging", where: `desktop/audit_export.ts FileSink -> ${a.path}` };
  if (!a.enabled) return { ...base, status: "fail", evidence: "Security event logging is disabled by managed policy (logging.enabled = false)." };
  if (!a.exists) return { ...base, status: "partial", evidence: `Logging is enabled (sink ${a.sink}) but no security event has been written on this host yet.` };
  return { ...base, status: "pass", evidence: `OCSF audit file present: ${a.bytes} bytes, last write ${a.lastWrite ?? "unknown"}; sink ${a.sink}.` };
}

export function auditProtectionCheck(a: AuditFacts): ComplianceCheck {
  const base = { id: "03.03.08", r2: ["3.3.8", "3.3.9"], title: "Protection of Audit Information", where: `${a.path} permissions; managed logging sink` };
  if (a.ownerOnly === false) return { ...base, status: "fail", evidence: "The audit file is readable or writable by group/other." };
  const forward = a.sink !== "file" ? `forwarded to a ${a.sink} sink (private connector)` : "not forwarded off the host";
  return { ...base, status: "partial", evidence: `Audit file is owned by the user account (${a.ownerOnly === null ? "NTFS ACL not evaluated" : "owner-only mode bits"}), is not hash-chained, and is ${forward}; the user can delete it.` };
}

export function leastPrivilegeCheck(s: SandboxFacts): ComplianceCheck {
  const base = { id: "03.01.05", r2: ["3.1.5", "3.4.9"], title: "Least Privilege", where: "harness/runs/sandbox_exec.ts; managed policy security.exec.requireIsolation / security.sandbox" };
  if (s.requireIsolation) return { ...base, status: "pass", evidence: "Managed policy requires runtime isolation for agent exec (fails closed when isolation is unavailable)." };
  if (s.locksOn) return { ...base, status: "pass", evidence: "Managed policy keeps the sandbox switch on (users cannot turn it off)." };
  return { ...base, status: "partial", evidence: `Agent sandbox is user-controlled on ${s.platform}; no managed requirement${s.foldersLocked ? " (folder grants are locked)" : ""}.` };
}

export function signingCheck(s: SigningFacts, platform: string): ComplianceCheck {
  const base = { id: "03.17.03", r2: [], title: "Supply Chain Requirements and Processes", where: s.target ?? "installed application binary (pass --installer <path>)" };
  if (s.status === "valid") return { ...base, status: "pass", evidence: `Signature valid${s.signer ? `, signer ${s.signer}` : ""}.` };
  if (s.status === "unsigned" || s.status === "invalid") return { ...base, status: "fail", evidence: `Signature ${s.status}: ${s.detail}` };
  if (platform === "linux") return { ...base, status: "customer", evidence: s.detail };
  return { ...base, status: "n/a", evidence: s.detail };
}

const DEVICE_LOCK: ComplianceCheck = {
  id: "03.01.10", r2: ["3.1.10"], title: "Device Lock", status: "customer",
  evidence: "LUCID has no in-app session lock; the operating system screen lock is the control (POA&M P-2).",
  where: "OS lock policy (GPO / MDM)",
};
const MFA: ComplianceCheck = {
  id: "03.05.03", r2: ["3.5.3"], title: "Multi-Factor Authentication", status: "customer",
  evidence: "LUCID has no in-app MFA; MFA is enforced at OS sign-in and by the identity provider (POA&M P-3).",
  where: "OS / IdP configuration",
};

/** Pure: probes in, Contract D report out. Checks are ordered by requirement id. */
export function buildReport(p: ComplianceProbes): ComplianceReport {
  const checks = [
    cryptoCheck(p.crypto),
    transmissionStorageCheck(p.vault, p.host.diskEncryption),
    keyManagementCheck(p.vault),
    informationFlowCheck(p.cui),
    configurationSettingsCheck(p.policy),
    denyByDefaultCheck(p.egress),
    eventLoggingCheck(p.audit),
    auditProtectionCheck(p.audit),
    leastPrivilegeCheck(p.sandbox),
    signingCheck(p.signing, p.host.os),
    DEVICE_LOCK,
    MFA,
  ].sort((a, b) => a.id.localeCompare(b.id));
  return { ...p, checks };
}

// Markdown table cell: backslash FIRST (else a trailing "\" escapes the cell's closing pipe), then pipe,
// then flatten newlines. Same rule as loop_preflight.esc (CodeQL #119: incomplete escaping).
const cell = (s: string): string => s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

/** Pure: the human-readable companion of evidence.json. */
export function renderMarkdown(r: ComplianceReport): string {
  const counts = new Map<CheckStatus, number>();
  for (const c of r.checks) counts.set(c.status, (counts.get(c.status) ?? 0) + 1);
  const summary = (["pass", "partial", "fail", "customer", "n/a"] as const).map((s) => `${s} ${counts.get(s) ?? 0}`).join(", ");
  const lines = [
    "# LUCID Agent IDE: NIST SP 800-171 Rev 3 evidence",
    "",
    `Generated ${r.generatedAt} by tools/compliance/evidence.ts. LUCID ${r.lucidVersion}. Host ${r.host.os}/${r.host.arch}, user ${r.host.user}.`,
    "",
    `Summary: ${summary}. Locally computable checks only; the full requirement set is in docs/compliance/control-matrix-r3.md.`,
    "",
    "| R3 id | R2 | Requirement | Status | Evidence | Where |",
    "| --- | --- | --- | --- | --- | --- |",
    ...r.checks.map((c) => `| ${c.id} | ${c.r2.join(", ") || "none"} | ${cell(c.title)} | ${c.status} | ${cell(c.evidence)} | ${cell(c.where)} |`),
    "",
    "## Facts",
    "",
    `- Crypto: module ${r.crypto.module}, FIPS ${r.crypto.fips}, OS FIPS policy ${r.crypto.osFipsPolicy ?? "unknown"}, required ${r.crypto.required}. ${r.crypto.detail}`,
    `- Vault: custody ${r.vault.custody}, state ${r.vault.state}, entries ${r.vault.entries ?? "unknown"}${r.vault.detail ? ` (${r.vault.detail})` : ""}.`,
    `- CUI lockdown: user ${r.cui.asksageOnly}, managed ${r.cui.managed}.`,
    `- Managed policy: ${r.policy.present ? `present (${r.policy.path ?? "unknown"})` : "absent"}${r.policy.orgName ? `, org ${r.policy.orgName}` : ""}.`,
    `- Egress: allowAll ${r.egress.allowAll}, allowWebSearch ${r.egress.allowWebSearch}, whitelist ${r.egress.whitelistEntries}, managed allowed ${r.egress.managedAllowedHosts}, denied ${r.egress.managedDeniedHosts}, danger mode disabled ${r.egress.dangerModeDisabled}, locked ${r.egress.locked}.`,
    `- Audit: enabled ${r.audit.enabled}, sink ${r.audit.sink}, file ${r.audit.path} (${r.audit.exists ? `${r.audit.bytes} bytes, last write ${r.audit.lastWrite ?? "unknown"}` : "absent"}).`,
    `- Sandbox: requireIsolation ${r.sandbox.requireIsolation}, locked on ${r.sandbox.locksOn}, folders locked ${r.sandbox.foldersLocked}.`,
    `- Signing: ${r.signing.status}${r.signing.signer ? `, ${r.signing.signer}` : ""} (${r.signing.target ?? "no target"}). ${r.signing.detail}`,
    `- Disk encryption: ${r.host.diskEncryption.status} (${r.host.diskEncryption.detail}).`,
    "",
  ];
  return lines.join("\n");
}

// ── Read-only probes ────────────────────────────────────────────────────────────────────────────────

interface Run { ok: boolean; code: number | null; out: string; err: string }
const PROBE_TIMEOUT_MS = 20_000;

/** Run one OS probe without blocking the engine's event loop (the HTTP route shares it). Never rejects. */
function run(cmd: string, args: string[], env?: Record<string, string>): Promise<Run> {
  const { promise, resolve } = Promise.withResolvers<Run>();
  try {
    execFile(cmd, args, { encoding: "utf8", timeout: PROBE_TIMEOUT_MS, windowsHide: true, maxBuffer: 1 << 20, env: env ? { ...process.env, ...env } : process.env }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : null) : 0;
      const err = String(stderr ?? "") || (error && code === null ? String(error.message) : "");
      resolve({ ok: !error, code, out: String(stdout ?? ""), err });
    });
  } catch (e) {
    resolve({ ok: false, code: null, out: "", err: String((e as Error)?.message ?? e) });
  }
  return promise;
}

const firstLine = (s: string): string => s.trim().split(/\r?\n/)[0]?.slice(0, 200) ?? "";

/** Parse `manage-bde -status <drive>` output. */
export function parseManageBde(out: string): DiskStatus {
  const state = /Protection Status:\s*Protection (On|Off)/i.exec(out)?.[1]?.toLowerCase();
  return state === "on" ? "on" : state === "off" ? "off" : "unknown";
}

/** Parse `fdesetup status` output. */
export function parseFdesetup(out: string): DiskStatus {
  if (/FileVault is On/i.test(out)) return "on";
  if (/FileVault is Off/i.test(out)) return "off";
  return "unknown";
}

export async function diskEncryption(): Promise<HostFacts["diskEncryption"]> {
  if (process.platform === "win32") {
    const drive = process.env.SystemDrive || "C:";
    const bde = await run("manage-bde", ["-status", drive]);
    const s = parseManageBde(bde.out);
    if (s !== "unknown") return { status: s, detail: `manage-bde -status ${drive}` };
    // Non-admin fallback: the Shell's BitLocker property (1 = protection on, 2 = off; other values reported raw).
    const ps = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `(New-Object -ComObject Shell.Application).NameSpace('${drive}\\').Self.ExtendedProperty('System.Volume.BitLockerProtection')`]);
    const v = ps.out.trim();
    if (v === "1") return { status: "on", detail: `Shell System.Volume.BitLockerProtection=1 on ${drive} (manage-bde -status needs elevation)` };
    if (v === "2") return { status: "off", detail: `Shell System.Volume.BitLockerProtection=2 on ${drive}` };
    const bdeWhy = /denied|administrator|elevat/i.test(bde.out + bde.err) || bde.code !== 0 ? "it needs an elevated prompt" : "its output had no Protection Status line";
    return {
      status: "unknown",
      detail: `inconclusive: manage-bde -status ${drive} reported no protection status (${bdeWhy}); the Shell property System.Volume.BitLockerProtection read ${v ? `${v}, which is neither 1 (on) nor 2 (off)` : "nothing"}. Rerun elevated or run Get-BitLockerVolume as administrator`,
    };
  }
  if (process.platform === "darwin") {
    const r = await run("fdesetup", ["status"]);
    const s = parseFdesetup(r.out);
    return { status: s, detail: s === "unknown" ? `fdesetup status: ${firstLine(r.out || r.err) || "unavailable"}` : firstLine(r.out) };
  }
  const r = await run("lsblk", ["-rno", "TYPE"]);
  if (r.ok && /\bcrypt\b/.test(r.out)) return { status: "on", detail: "lsblk reports a dm-crypt device" };
  return { status: "unknown", detail: r.ok ? "lsblk reports no dm-crypt device; verify the root volume manually" : `lsblk unavailable: ${firstLine(r.err)}` };
}

/** Installed app binaries the evidence run looks for when --installer is not given (electron-builder NSIS
 *  per-user and MSI per-machine defaults for productName LucidAgentIDE, desktop/package.json). */
export function defaultSigningTargets(): string[] {
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
    const pf = process.env.ProgramFiles || "C:\\Program Files";
    return [
      join(local, "Programs", "LucidAgentIDE", "LucidAgentIDE.exe"),
      join(pf, "LucidAgentIDE", "LucidAgentIDE.exe"),
    ];
  }
  if (process.platform === "darwin") return ["/Applications/LucidAgentIDE.app"];
  return [];
}

/** Map Get-AuthenticodeSignature's Status to ours. */
export function authenticodeStatus(status: string): SigningStatus {
  if (status === "Valid") return "valid";
  if (status === "NotSigned") return "unsigned";
  return status ? "invalid" : "unknown";
}

export async function signingFacts(installer?: string): Promise<SigningFacts> {
  const target = installer ?? defaultSigningTargets().find((p) => existsSync(p)) ?? null;
  if (process.platform === "linux") return { target, status: "unknown", signer: null, detail: "Linux AppImage/deb/rpm packages are not code-signed; verify the release SHA-256 instead." };
  if (!target || !existsSync(target)) {
    return { target, status: "not-found", signer: null, detail: `No installed LucidAgentIDE binary found${installer ? ` at ${installer}` : ""}; pass --installer <path>.` };
  }
  if (process.platform === "win32") {
    // The path travels in an environment variable, never spliced into the command text.
    const r = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "$s = Get-AuthenticodeSignature -LiteralPath $env:LUCID_SIG_TARGET; " +
      "[pscustomobject]@{ status = $s.Status.ToString(); signer = $(if ($s.SignerCertificate) { $s.SignerCertificate.Subject } else { $null }); message = $s.StatusMessage } | ConvertTo-Json -Compress"],
      { LUCID_SIG_TARGET: target });
    try {
      const j = JSON.parse(r.out.trim()) as { status?: unknown; signer?: unknown; message?: unknown };
      const status = authenticodeStatus(typeof j.status === "string" ? j.status : "");
      return { target, status, signer: typeof j.signer === "string" ? j.signer : null, detail: typeof j.message === "string" ? j.message : String(j.status ?? "") };
    } catch {
      return { target, status: "unknown", signer: null, detail: `Get-AuthenticodeSignature failed: ${firstLine(r.err || r.out) || "no output"}` };
    }
  }
  if (process.platform === "darwin") {
    const v = await run("codesign", ["--verify", "--deep", "--strict", target]);
    if (v.ok) {
      const d = await run("codesign", ["-dv", "--verbose=2", target]);
      const authority = /Authority=(.+)/.exec(d.err)?.[1]?.trim() ?? null;
      return { target, status: "valid", signer: authority, detail: "codesign --verify passed" };
    }
    const text = firstLine(v.err || v.out);
    return { target, status: /not signed/i.test(text) ? "unsigned" : "invalid", signer: null, detail: `codesign: ${text || "verify failed"}` };
  }
  return { target, status: "unknown", signer: null, detail: `no signature probe for ${process.platform}` };
}

/** The user's own AskSage-only flag, read straight from the settings JSON. settings_store.load() is NOT
 *  used: it can migrate plaintext keys into the vault, and this report never writes. */
function userAsksageOnly(settingsFile: string): boolean {
  try {
    const j = JSON.parse(readFileSync(settingsFile, "utf8")) as { asksageOnly?: unknown };
    return j.asksageOnly === true;
  } catch { return false; }
}

/** ── INTEGRATION ADAPTER (the only place Contracts A and B are read) ─────────────────────────────────
 *  Contract A: `cryptoInfo()` from harness/crypto/fips_crypto.ts (P-FIPS.1, ADR-0473); it reads the managed
 *  `security.crypto.requireFips` knob itself. The vault is read for the settings file being assessed (the
 *  CLI can point at any profile), with the v2 entry count (P-VAULT-V2.1, ADR-0474). */
export async function platformProbes(settingsFile: string): Promise<{ crypto: CryptoProviderInfo; vault: VaultFacts }> {
  const dir = engineVaultDir(settingsFile);
  const st = vaultStatus(dir);
  let entries: number | null = null;
  try {
    const v = readVault(dir);
    if (!v.problem) entries = Object.keys(v.entries).length;
  } catch { entries = null; }
  return { crypto: cryptoInfo(), vault: { custody: st.custody, state: st.state, entries, ...(st.detail ? { detail: st.detail } : {}) } };
}

function auditFacts(mc: ManagedConfig | null): AuditFacts {
  const path = defaultAuditPath();
  const logging = mc?.logging;
  const base: AuditFacts = { enabled: logging?.enabled !== false, sink: logging?.sink ?? "file", path, exists: false, bytes: 0, lastWrite: null, ownerOnly: null };
  try {
    const st = statSync(path);
    return { ...base, exists: true, bytes: st.size, lastWrite: st.mtime.toISOString(), ownerOnly: process.platform === "win32" ? null : (st.mode & 0o077) === 0 };
  } catch { return base; }
}

function egressFacts(mc: ManagedConfig | null): EgressFacts {
  const managed = mc?.security?.egress;
  const store = loadWhitelist();
  const posture = clampPosture(store.posture, managed);
  return {
    allowAll: posture.allowAll,
    allowWebSearch: posture.allowWebSearch,
    whitelistEntries: store.entries.length,
    managedAllowedHosts: managed?.allowedHosts?.length ?? 0,
    managedDeniedHosts: managed?.deniedHosts?.length ?? 0,
    dangerModeDisabled: !!managed?.disableDangerMode,
    locked: !!managed?.lock,
  };
}

export interface GatherOptions {
  /** Binary whose signature is checked (default: the installed app, see defaultSigningTargets()). */
  installer?: string;
  /** Skip the slow OS subprocess probes (signature, disk encryption); they report "unknown". */
  skipOsProbes?: boolean;
  now?: () => Date;
}

/** Collect every fact. Read-only; never throws for a missing or unreadable source. */
export async function gatherProbes(opts: GatherOptions = {}): Promise<ComplianceProbes> {
  const { config: mc, path: policyPath } = managedConfig();
  // The file settings_store.ts reads, through the same LUCID_GUI_SETTINGS_FILE seam.
  const settingsFile = process.env.LUCID_GUI_SETTINGS_FILE || join(homedir(), ".omp", "lucid-gui.json");
  const [{ crypto, vault }, disk, signing] = await Promise.all([
    platformProbes(settingsFile),
    opts.skipOsProbes ? { status: "unknown" as const, detail: "OS probes skipped" } : diskEncryption(),
    opts.skipOsProbes ? { target: opts.installer ?? null, status: "unknown" as const, signer: null, detail: "OS probes skipped" } : signingFacts(opts.installer),
  ]);
  let user = "unknown";
  try { user = userInfo().username; } catch { /* no passwd entry */ }
  return {
    generatedAt: (opts.now?.() ?? new Date()).toISOString(),
    lucidVersion: APP_VERSION,
    host: {
      os: process.platform,
      arch: process.arch,
      user,
      diskEncryption: disk,
    },
    crypto,
    vault,
    cui: { asksageOnly: userAsksageOnly(settingsFile), managed: managedAsksageOnly(mc) },
    policy: { present: mc !== null, path: mc ? policyPath : null, orgName: typeof mc?.orgName === "string" ? mc.orgName : null },
    egress: egressFacts(mc),
    audit: auditFacts(mc),
    sandbox: { platform: process.platform, requireIsolation: managedRequireIsolation(mc), locksOn: managedSandboxLocksOn(mc), foldersLocked: managedSandboxFoldersLocked(mc) },
    signing,
  };
}

/** gatherProbes + buildReport. */
export async function complianceReport(opts: GatherOptions = {}): Promise<ComplianceReport> {
  return buildReport(await gatherProbes(opts));
}
