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
  /** Reserved/extensible: pinned mcpServers, BI endpoint, locked workspace roots, etc. */
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
/** Load + cache the managed config (first trustworthy candidate). Null ⇒ unmanaged. */
export function managedConfig(): { config: ManagedConfig | null; path: string | null } {
  if (cached) return cached;
  for (const p of candidatePaths()) {
    if (!existsSync(p) || !trustworthy(p)) continue;
    try {
      const c = JSON.parse(readFileSync(p, "utf8"));
      if (c && typeof c === "object") return (cached = { config: c as ManagedConfig, path: p });
    } catch { /* malformed admin file → run unmanaged rather than lock users out */ }
  }
  return (cached = { config: null, path: null });
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
