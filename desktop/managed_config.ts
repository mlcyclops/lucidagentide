// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/managed_config.ts
//
// Enterprise-managed configuration. Admins place a read-only policy file in a machine-wide,
// admin-controlled location (pushed by GPO / Intune / JAMF / other MDM); LucidAgentIDE consumes it
// at startup to ENFORCE org policy — e.g. "attribution requires a corporate email, no skip" and
// "restrict to @company.com". The capability lives here (public repo); the org's actual policy file
// is a tested template kept in the private add-on repo as IP.
//
// SECURITY MODEL (this is policy, not a security-gate decision):
//   - The file must live in an admin-only-writable path so a non-admin user cannot forge policy.
//     Canonical machine paths below; an MDM may instead set LUCID_MANAGED_CONFIG to an explicit path.
//   - On POSIX we ignore a group/world-writable file (tamper guard). On Windows the directory ACL is
//     the control (admins lock %ProgramData%\LucidAgentIDE — documented in the deployment runbook).
//   - We NEVER write this file. Absent/malformed ⇒ run unmanaged (the safe default); a present file
//     only ever ADDS constraints, never relaxes the security gate (invariants #3/#4 are untouched).

import { existsSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

export interface ManagedAttribution {
  /** Require a corporate email (no workstation-only attribution; implies skip is disabled). */
  requireEmail?: boolean;
  /** Allow the user to skip the email prompt (workstation fallback). Default true unless requireEmail. */
  allowSkip?: boolean;
  /** If set, the email must end in one of these domains (e.g. ["company.com","contractor.company.com"]). */
  allowedEmailDomains?: string[];
}
export type UpdateChannel = "github" | "feed" | "managed";

// ── Enterprise security-knob governance (ADR-0068, P-ENT.1) ──────────────────────────────────────
// Managed policy may centrally SET + LOCK the security knobs (exec approval ADR-0066, the loop
// Speed↔Risk dial ADR-0067, egress ADR-0062, and model routing). Cardinal rule, mirroring the existing
// attribution policy: a managed value is a CEILING — the user may always pick something SAFER, never
// riskier — and a `lock` disables the matching UI control ("Managed by <org>"). Absent ⇒ unmanaged for
// that knob (fail-safe). The scanner / fail-closed gate is NEVER touched by policy (invariants #3/#4);
// this module owns the SCHEMA + the pure clamp helpers each decision point calls.

/** The graded exec risk ladder (ADR-0067): T0 read-only · T1 local-mutate · T2 reach-out ·
 *  T3 destructive · T4 catastrophic. Ordered; higher = riskier. */
export type RiskTier = "T0" | "T1" | "T2" | "T3" | "T4";
export const TIER_ORDER: Record<RiskTier, number> = { T0: 0, T1: 1, T2: 2, T3: 3, T4: 4 };
/** Type guard: a value is a known tier. Unknown/garbage ⇒ false (callers fail closed). */
export function isRiskTier(v: unknown): v is RiskTier {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(TIER_ORDER, v);
}

export interface ManagedExecPolicy {
  /** CEILING for the per-command auto-run tier (ADR-0066/0067). The user may auto-run at a LOWER tier,
   *  never higher. Absent ⇒ no exec ceiling. */
  maxAutoTier?: RiskTier;
  /** Forbid the exec "allow-all shell" danger mode entirely. */
  disableDangerMode?: boolean;
  /** Programs (argv0) the org forbids from any standing allow — they ALWAYS prompt/block. */
  denylist?: string[];
  /** ADR-0157 (P-SANDBOX.1): REQUIRE runtime isolation for exec. When true and no isolating sandbox
   *  backend is available on this machine, exec fail-closes to BLOCKED — never the disclosed
   *  passthrough. Tighten-only, like every managed knob. */
  requireIsolation?: boolean;
  /** Lock the exec controls in the UI ("Managed by <org>"). */
  lock?: boolean;
}

export interface ManagedEgressPolicy {
  /** Restrictive allow-list: when present, ONLY these hosts may be auto-allowed (a host outside the
   *  list always prompts, even if the user allowed it). A ceiling, not an additive pre-approval. */
  allowedHosts?: string[];
  /** Hosts that may NEVER be auto-allowed (always prompt; overrides user allow + danger mode). */
  deniedHosts?: string[];
  /** Forbid the egress "allow-all" danger mode entirely. */
  disableDangerMode?: boolean;
  /** Lock the egress controls in the UI ("Managed by <org>"). */
  lock?: boolean;
}

export interface ManagedLoopPolicy {
  /** CEILING for every unattended /goal dial row (ADR-0067). Clamps each per-command-type dial. */
  maxAutoTier?: RiskTier;
  /** Lock the loop dial in the UI ("Managed by <org>"). */
  lock?: boolean;
}

export interface ManagedSecurity {
  exec?: ManagedExecPolicy;
  egress?: ManagedEgressPolicy;
  loop?: ManagedLoopPolicy;
}

/** SIEM/audit sink configuration, consumed by ADR-0069 (P-ENT.2). Schema only here; the dispatcher +
 *  connectors live in the export seam. */
export interface ManagedLogging {
  enabled?: boolean;
  sink?: "file" | "splunk" | "syslog" | "elastic" | "aws" | "azure" | "gcp" | "tenable";
  endpoint?: string;
  format?: "ocsf" | "cef" | "json";
}

/** Central model-routing governance — generalizes the legacy top-level `asksageOnly` lock. */
export interface ManagedModels {
  /** Force gov-gateway-only (AskSage) routing — generalizes top-level `asksageOnly`. */
  asksageOnly?: boolean;
  /** Restrictive allow-list of provider/model id substrings; when present, only matching models route. */
  allowed?: string[];
  /** Provider/model id substrings that are always forbidden (overrides `allowed`). */
  denied?: string[];
  /** Lock the model picker / routing controls in the UI ("Managed by <org>"). */
  lock?: boolean;
}

export interface ManagedConfig {
  /** Shown as "Managed by <orgName>" in the UI. */
  orgName?: string;
  attribution?: ManagedAttribution;
  /** Force AskSage-only (gov gateway) routing. */
  asksageOnly?: boolean;
  /** ADR-A009: which in-app update channel this fleet uses. Default "github" (today's public feed).
   *  "feed" = electron-updater generic provider against a customer-hosted mirror (needs updateFeedUrl);
   *  "managed" = IT owns the version (MSI/MSIX/rpm/deb/pkg), so the in-app update check is DISABLED. */
  updateChannel?: UpdateChannel;
  /** The customer-hosted feed URL for updateChannel:"feed" (mirrors latest*.yml + installers). */
  updateFeedUrl?: string;
  /** ADR-0068 (P-ENT.1): centrally set + lock the exec/egress/loop security knobs. */
  security?: ManagedSecurity;
  /** ADR-0068: SIEM/audit sink config (consumed by ADR-0069, P-ENT.2). */
  logging?: ManagedLogging;
  /** ADR-0068: central model-routing governance (generalizes `asksageOnly`). */
  models?: ManagedModels;
  /** ADR-0103 (P-FS.1): restrict the in-app folder browser + workspace selection to these roots.
   *  Unset/empty = the full filesystem (the individual-user default). When set, the browser is confined
   *  to these subtrees and never offers a parent above them. Only TIGHTENS (mirrors ADR-0068). */
  workspaceRoots?: string[];
  /** Reserved/extensible: pinned mcpServers, BI endpoint, etc. */
  [k: string]: unknown;
}

export interface UpdatePolicy {
  channel: UpdateChannel;
  /** Present only when channel === "feed". */
  feedUrl?: string;
}

function candidatePaths(): string[] {
  const list: string[] = [];
  const envPath = process.env.LUCID_MANAGED_CONFIG; // MDM may point us at an explicit path
  if (envPath) list.push(envPath);
  if (process.platform === "win32") {
    list.push(join(process.env.ProgramData || "C:\\ProgramData", "LucidAgentIDE", "managed-config.json"));
  } else if (process.platform === "darwin") {
    list.push("/Library/Application Support/LucidAgentIDE/managed-config.json");
  } else {
    list.push("/etc/lucidagentide/managed-config.json");
  }
  return list;
}

/** POSIX tamper guard: a policy file a non-admin could write (group/world-writable) is not trusted. */
function trustworthy(path: string): boolean {
  if (process.platform === "win32") return true; // directory ACL is the control (deployment runbook)
  try { return (statSync(path).mode & 0o022) === 0; } catch { return false; }
}

let cached: { config: ManagedConfig | null; path: string | null } | undefined;

/** First trustworthy policy FILE candidate (the canonical MDM channel). Null ⇒ no file policy. */
function fileConfig(): { config: ManagedConfig | null; path: string | null } {
  for (const p of candidatePaths()) {
    if (!existsSync(p) || !trustworthy(p)) continue;
    try {
      const c = JSON.parse(readFileSync(p, "utf8"));
      if (c && typeof c === "object") return { config: c as ManagedConfig, path: p };
    } catch { /* malformed admin file → run unmanaged rather than lock users out */ }
  }
  return { config: null, path: null };
}

/** Load + cache the effective managed config: the Windows Group-Policy registry (admin-only HKLM)
 *  merged UNDER the policy file (the file wins per leaf), per ADR-0068. Null config ⇒ unmanaged. */
export function managedConfig(): { config: ManagedConfig | null; path: string | null } {
  if (cached) return cached;
  const file = fileConfig();
  const reg = registryConfig(); // win32-only; null elsewhere
  const config = mergeManaged(reg.config, file.config); // file overlays registry
  return (cached = { config, path: file.path ?? reg.path });
}

/** Test-only: drop the cache so a freshly-written policy file is re-read. */
export function __resetManagedCache(): void { cached = undefined; }

/** Does `email` satisfy the managed allowed-domains policy? (true when no policy / no email check.) */
export function emailDomainAllowed(email: string): boolean {
  const domains = managedConfig().config?.attribution?.allowedEmailDomains;
  if (!domains || domains.length === 0) return true;
  const e = email.trim().toLowerCase();
  return domains.some((d) => e.endsWith("@" + d.toLowerCase().replace(/^@/, "")));
}

/** Whether the user is allowed to skip the email prompt under managed policy. */
export function skipAllowed(): boolean {
  const a = managedConfig().config?.attribution;
  if (!a) return true;
  if (a.requireEmail) return false;
  return a.allowSkip !== false;
}

/** ADR-A009 (#74): resolve the effective update policy from a (possibly null) managed config. PURE so it
 *  is unit-testable without files. Fail-safe defaults:
 *   - unmanaged / unset / unknown value ⇒ "github" (today's behavior — never silently disable updates),
 *   - "feed" with a non-blank URL ⇒ feed against that URL,
 *   - "feed" with NO usable URL ⇒ "managed" (disable the check rather than hit a wrong/empty feed),
 *   - "managed" ⇒ disable the in-app check (IT owns the version). */
export function resolveUpdatePolicy(mc: ManagedConfig | null): UpdatePolicy {
  const channel = mc?.updateChannel;
  if (channel === "managed") return { channel: "managed" };
  if (channel === "feed") {
    const feedUrl = typeof mc?.updateFeedUrl === "string" ? mc.updateFeedUrl.trim() : "";
    return feedUrl ? { channel: "feed", feedUrl } : { channel: "managed" };
  }
  return { channel: "github" }; // default + unknown value
}

/** Read-side: the effective update policy from the live managed config. */
export function updatePolicy(): UpdatePolicy { return resolveUpdatePolicy(managedConfig().config); }

// ── Windows Group-Policy channel (ADR-0068) ──────────────────────────────────────────────────────
// ADMX/Intune push to HKLM\Software\Policies\LucidAgentIDE; that hive is admin-only by ACL, the same
// tamper model as the file. The READER (spawns reg.exe) is thin; the pure PARSER + MERGE are tested.

const GPO_KEY = "HKLM\\Software\\Policies\\LucidAgentIDE";

/** A REG_DWORD prints as hex ("0x1"); treat any nonzero as true. */
function dwordTrue(v?: string): boolean {
  const n = v ? parseInt(v.trim(), 16) : 0;
  return Number.isFinite(n) && n !== 0;
}
/** Split a list value: REG_MULTI_SZ (reg.exe prints `\0` between entries) or a CSV REG_SZ. */
function regList(v?: string): string[] | undefined {
  if (v == null) return undefined;
  const parts = (v.includes("\\0") ? v.split("\\0") : v.split(/[,;]/)).map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts : undefined;
}

/** Parse `reg query <key> /s` output into the ManagedConfig shape. Recognizes a `Json` value (a full
 *  JSON policy blob) as the base, then overlays known flat values. Unknown values are ignored; malformed
 *  input ⇒ null (fail-safe to unmanaged). Pure + total — the test surface for the GPO channel. */
export function parseRegistryPolicy(regOutput: string): ManagedConfig | null {
  const vals = new Map<string, string>();
  for (const line of regOutput.split(/\r?\n/)) {
    const m = /^\s+(.+?)\s{4,}REG_\w+\s{4,}(.*)$/.exec(line);
    if (m) vals.set(m[1]!.trim(), m[2]!);
  }
  if (vals.size === 0) return null;
  const str = (k: string) => { const v = vals.get(k); return v != null && v.trim() ? v.trim() : undefined; };
  const bool = (k: string) => (vals.has(k) ? dwordTrue(vals.get(k)) : undefined);
  const list = (k: string) => regList(vals.get(k));

  let cfg: ManagedConfig = {};
  const json = str("Json");
  if (json) { try { const o = JSON.parse(json); if (o && typeof o === "object") cfg = o as ManagedConfig; } catch { /* ignore malformed blob */ } }

  const orgName = str("OrgName"); if (orgName) cfg.orgName = orgName;
  const asksageOnly = bool("AsksageOnly"); if (asksageOnly !== undefined) cfg.asksageOnly = asksageOnly;
  const updateChannel = str("UpdateChannel");
  if (updateChannel === "github" || updateChannel === "feed" || updateChannel === "managed") cfg.updateChannel = updateChannel;
  const updateFeedUrl = str("UpdateFeedUrl"); if (updateFeedUrl) cfg.updateFeedUrl = updateFeedUrl;

  const exec: ManagedExecPolicy = { ...(cfg.security?.exec ?? {}) };
  const execTier = str("ExecMaxAutoTier"); if (isRiskTier(execTier)) exec.maxAutoTier = execTier;
  const execDanger = bool("ExecDisableDangerMode"); if (execDanger !== undefined) exec.disableDangerMode = execDanger;
  const execLock = bool("ExecLock"); if (execLock !== undefined) exec.lock = execLock;
  const execDeny = list("ExecDenylist"); if (execDeny) exec.denylist = execDeny;
  const execIso = bool("ExecRequireIsolation"); if (execIso !== undefined) exec.requireIsolation = execIso; // ADR-0157

  const egress: ManagedEgressPolicy = { ...(cfg.security?.egress ?? {}) };
  const egAllowed = list("EgressAllowedHosts"); if (egAllowed) egress.allowedHosts = egAllowed;
  const egDenied = list("EgressDeniedHosts"); if (egDenied) egress.deniedHosts = egDenied;
  const egDanger = bool("EgressDisableDangerMode"); if (egDanger !== undefined) egress.disableDangerMode = egDanger;
  const egLock = bool("EgressLock"); if (egLock !== undefined) egress.lock = egLock;

  const loop: ManagedLoopPolicy = { ...(cfg.security?.loop ?? {}) };
  const loopTier = str("LoopMaxAutoTier"); if (isRiskTier(loopTier)) loop.maxAutoTier = loopTier;
  const loopLock = bool("LoopLock"); if (loopLock !== undefined) loop.lock = loopLock;

  const security: ManagedSecurity = { ...(cfg.security ?? {}) };
  if (Object.keys(exec).length) security.exec = exec;
  if (Object.keys(egress).length) security.egress = egress;
  if (Object.keys(loop).length) security.loop = loop;
  if (Object.keys(security).length) cfg.security = security;

  const models: ManagedModels = { ...(cfg.models ?? {}) };
  const mAsk = bool("ModelsAsksageOnly"); if (mAsk !== undefined) models.asksageOnly = mAsk;
  const mAllowed = list("ModelsAllowed"); if (mAllowed) models.allowed = mAllowed;
  const mDenied = list("ModelsDenied"); if (mDenied) models.denied = mDenied;
  const mLock = bool("ModelsLock"); if (mLock !== undefined) models.lock = mLock;
  if (Object.keys(models).length) cfg.models = models;

  const wsRoots = list("WorkspaceRoots"); if (wsRoots) cfg.workspaceRoots = wsRoots; // ADR-0103 (P-FS.1)

  const logging: ManagedLogging = { ...(cfg.logging ?? {}) };
  const lEnabled = bool("LoggingEnabled"); if (lEnabled !== undefined) logging.enabled = lEnabled;
  const lSink = str("LoggingSink");
  if (lSink && ["file", "splunk", "syslog", "elastic", "aws", "azure", "gcp", "tenable"].includes(lSink)) logging.sink = lSink as ManagedLogging["sink"];
  const lEndpoint = str("LoggingEndpoint"); if (lEndpoint) logging.endpoint = lEndpoint;
  const lFormat = str("LoggingFormat"); if (lFormat === "ocsf" || lFormat === "cef" || lFormat === "json") logging.format = lFormat;
  if (Object.keys(logging).length) cfg.logging = logging;

  return Object.keys(cfg).length ? cfg : null;
}

/** Read the Windows Group-Policy registry. Non-Windows ⇒ null; any failure ⇒ null (fail-safe). */
function registryConfig(): { config: ManagedConfig | null; path: string | null } {
  if (process.platform !== "win32") return { config: null, path: null };
  try {
    const out = execFileSync("reg", ["query", GPO_KEY, "/s"], { encoding: "utf8", windowsHide: true, timeout: 4000 });
    const cfg = parseRegistryPolicy(out);
    return cfg ? { config: cfg, path: GPO_KEY } : { config: null, path: null };
  } catch { return { config: null, path: null }; }
}

/** Overlay `over` onto `base` (over wins per leaf), deep for the `security` sub-objects so a file can
 *  override ONE sub-knob without wiping the registry's other sub-policies. Pure. */
export function mergeManaged(base: ManagedConfig | null, over: ManagedConfig | null): ManagedConfig | null {
  if (!base) return over;
  if (!over) return base;
  const merged: ManagedConfig = { ...base, ...over };
  if (base.security || over.security) {
    const sec: ManagedSecurity = { ...(base.security ?? {}), ...(over.security ?? {}) };
    for (const k of ["exec", "egress", "loop"] as const) {
      const b = base.security?.[k]; const o = over.security?.[k];
      if (b || o) (sec as Record<string, unknown>)[k] = { ...(b ?? {}), ...(o ?? {}) };
    }
    merged.security = sec;
  }
  if (base.models || over.models) merged.models = { ...(base.models ?? {}), ...(over.models ?? {}) };
  if (base.logging || over.logging) merged.logging = { ...(base.logging ?? {}), ...(over.logging ?? {}) };
  return merged;
}

// ── Pure clamp / lock helpers (ADR-0068) ─────────────────────────────────────────────────────────

/** The cardinal clamp: the effective auto-run tier is never RISKIER than the managed CEILING — the
 *  user may go safer, never higher. Pure + total, ALWAYS returns a concrete tier. An unset/garbage user
 *  choice fails closed to the safest tier (T0); an unset/garbage ceiling means no limit (user stands). */
export function clampToManaged(userTier: RiskTier | undefined, ceiling: RiskTier | undefined): RiskTier {
  const user: RiskTier = isRiskTier(userTier) ? userTier : "T0";
  if (!isRiskTier(ceiling)) return user;
  return TIER_ORDER[user] <= TIER_ORDER[ceiling] ? user : ceiling;
}

/** Whether the "allow-all" danger mode is permitted for a knob (a managed `disableDangerMode` forbids
 *  it — tighten only). */
export function dangerModeAllowed(kind: "exec" | "egress", mc: ManagedConfig | null = managedConfig().config): boolean {
  const s = mc?.security;
  return kind === "exec" ? !s?.exec?.disableDangerMode : !s?.egress?.disableDangerMode;
}

/** Whether a model id may route under managed policy: a denied substring always blocks (overrides
 *  allow); a non-empty allow-list restricts routing to matching ids. asksageOnly is enforced
 *  separately (it forces the gateway). Pure when given `models`. */
export function modelAllowed(modelId: string, models: ManagedModels | undefined = managedConfig().config?.models): boolean {
  if (!models) return true;
  const id = (modelId ?? "").trim().toLowerCase();
  if (!id) return true;
  const denied = (models.denied ?? []).map((d) => d.toLowerCase()).filter(Boolean);
  if (denied.some((d) => id.includes(d))) return false;
  const allowed = (models.allowed ?? []).map((a) => a.toLowerCase()).filter(Boolean);
  if (allowed.length && !allowed.some((a) => id.includes(a))) return false;
  return true;
}

/** The effective gov-gateway-only lock, OR-ing the legacy top-level flag and the new models block. */
export function managedAsksageOnly(mc: ManagedConfig | null = managedConfig().config): boolean {
  return !!mc?.asksageOnly || !!mc?.models?.asksageOnly;
}

/** ADR-0157 (P-SANDBOX.1): whether managed policy REQUIRES runtime isolation for exec (the tighten-only
 *  "require-isolation" knob). Absent/unmanaged/false = no requirement (personal default = the disclosed
 *  passthrough). Pure when given `mc`. */
export function managedRequireIsolation(mc: ManagedConfig | null = managedConfig().config): boolean {
  return !!mc?.security?.exec?.requireIsolation;
}

/** ADR-0103 (P-FS.1): the managed folder-browser/workspace root allowlist, or null when unmanaged
 *  (full-filesystem browsing). Pure when given `mc`. */
export function managedWorkspaceRoots(mc: ManagedConfig | null = managedConfig().config): string[] | null {
  const r = mc?.workspaceRoots;
  return Array.isArray(r) && r.length ? r.map(String).filter(Boolean) : null;
}

export interface ManagedLocks { exec: boolean; egress: boolean; loop: boolean; models: boolean; }
/** Which UI controls a managed policy locks (the renderer disables them + shows "Managed by <org>").
 *  Forcing AskSage-only implies a models lock (the picker is constrained). */
export function managedLocks(mc: ManagedConfig | null = managedConfig().config): ManagedLocks {
  const s = mc?.security;
  return {
    exec: !!s?.exec?.lock,
    egress: !!s?.egress?.lock,
    loop: !!s?.loop?.lock,
    models: !!mc?.models?.lock || managedAsksageOnly(mc),
  };
}
