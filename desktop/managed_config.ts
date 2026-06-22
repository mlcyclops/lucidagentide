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
export interface ManagedConfig {
  /** Shown as "Managed by <orgName>" in the UI. */
  orgName?: string;
  attribution?: ManagedAttribution;
  /** Force AskSage-only (gov gateway) routing. */
  asksageOnly?: boolean;
  /** Reserved/extensible: pinned mcpServers, BI endpoint, locked workspace roots, etc. */
  [k: string]: unknown;
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
