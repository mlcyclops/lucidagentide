// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/egress_policy.ts
//
// P-EGRESS.1 (ADR-0062): per-website approval for the agent's network-reaching tools (browser,
// web_search). In a security/provenance product, an agent autonomously browsing arbitrary internet
// sites is a real risk, so omp is configured to PROMPT for those tools (acp_config.yml `tools.approval`),
// and this module decides — per the user's standing choices — whether a given URL is auto-allowed or
// needs the approval dialog. Fail-closed: anything not explicitly allowed PROMPTS.
//
// The four "Yes" choices the dialog offers map to:
//   allow-once  → approve this call, remember nothing.
//   allow-site  → approve + auto-allow this host from now on.
//   ask-site    → approve, but ALWAYS ask for this host again (pins it to prompt, even under danger mode).
//   danger      → "danger is my middle name": auto-allow ALL egress from now on (except ask-site pins).
//   deny        → block this call (no persistence).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { managedConfig, type ManagedEgressPolicy } from "./managed_config.ts";
import { loadWhitelist, whitelistMatch, type WhitelistContext, type WhitelistEntry, type WhitelistStore } from "./network_whitelist.ts";

const FILE = join(homedir(), ".omp", "lucid-egress.json");

export type EgressChoice = "allow-once" | "allow-site" | "ask-site" | "danger" | "deny";
export type EgressVerdict = "allow" | "prompt";

export interface EgressStore {
  dangerMode?: boolean;       // global allow-all egress
  allowHosts?: string[];      // hosts auto-allowed
  alwaysAskHosts?: string[];  // hosts that ALWAYS prompt (override danger mode)
}

/** Lowercase host of a URL, or null if it isn't a parseable absolute URL. Used as the per-site key. */
export function extractHost(url: string): string | null {
  if (!url) return null;
  try { return new URL(url).hostname.toLowerCase() || null; }
  catch {
    // tolerate a bare host or scheme-less URL ("example.com/path")
    const m = /^(?:[a-z]+:\/\/)?([^/:\s]+)/i.exec(url.trim());
    return m ? m[1]!.toLowerCase() : null;
  }
}

/** P-EGRESS.2 (ADR-0094): a browser/open tool may be pointed at a LOCAL file (a filesystem path or a
 *  `file://` URL) rather than a website. That is not a network reach in the usual sense — but a rendered
 *  local HTML page CAN still load remote resources, so we keep PROMPTING; we just present it accurately
 *  (a local-file open, not a website visit) and never persist a host decision for it. Pure, conservative:
 *  only an explicit `file://` or a clearly-absolute local path counts; anything ambiguous (a bare host, a
 *  relative path, any other scheme) is NOT local, so it falls through to the normal egress prompt. */
export function isLocalFileTarget(target: string): boolean {
  if (!target) return false;
  const t = target.trim();
  if (/^file:\/\//i.test(t)) return true;             // explicit file URL
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return false; // any other scheme (http(s), ftp, …) → not local
  if (/^[A-Za-z]:[\\/]/.test(t)) return true;          // Windows drive path: C:\… or C:/…
  if (/^\\\\/.test(t)) return true;                    // Windows UNC: \\server\share
  if (/^~[\\/]/.test(t)) return true;                  // home-relative: ~/…
  if (/^\//.test(t)) return true;                      // POSIX absolute: /…
  return false;
}

/** Pure decision: does this URL auto-allow, or must we PROMPT? Fail-closed to prompt on anything unknown
 *  (including an unparseable URL — we can't reason about a site we can't name). `ask-site` pins win over
 *  danger mode, honoring an explicit "always ask me for this one". */
export function egressVerdict(store: EgressStore, url: string): EgressVerdict {
  const host = extractHost(url);
  if (!host) return "prompt";
  if ((store.alwaysAskHosts ?? []).includes(host)) return "prompt";
  if ((store.allowHosts ?? []).includes(host)) return "allow";
  if (store.dangerMode) return "allow";
  return "prompt";
}

/** Pure update: fold a user's choice for `url` into the store. Returns a NEW store (never mutates). */
export function applyEgressChoice(store: EgressStore, url: string, choice: EgressChoice): EgressStore {
  const host = extractHost(url);
  const allow = new Set(store.allowHosts ?? []);
  const ask = new Set(store.alwaysAskHosts ?? []);
  let danger = store.dangerMode ?? false;
  switch (choice) {
    case "allow-site": if (host) { allow.add(host); ask.delete(host); } break;
    case "ask-site": if (host) { ask.add(host); allow.delete(host); } break; // pin to always-prompt
    case "danger": danger = true; break;
    case "allow-once": case "deny": break; // no persistence
  }
  return { dangerMode: danger, allowHosts: [...allow], alwaysAskHosts: [...ask] };
}

/** ADR-0068 (P-ENT.1): tighten a user's egress store by the managed CEILING, returning a NEW store that
 *  is never riskier than the user's. Pure. Tighten-only semantics:
 *   - `deniedHosts` can never be auto-allowed → dropped from allow + pinned to always-ask (they prompt
 *     even under danger mode).
 *   - `allowedHosts`, when present, is a RESTRICTIVE allow-list (a ceiling, not a pre-approval): the
 *     user's allow set is intersected with it, and danger mode is forced OFF (allow-all contradicts a
 *     whitelist), so a host outside the org list always prompts.
 *   - `disableDangerMode` forbids allow-all outright. */
export function clampEgress(store: EgressStore, managed?: ManagedEgressPolicy): EgressStore {
  if (!managed) return store;
  const norm = (h: string) => h.trim().toLowerCase();
  const denied = new Set((managed.deniedHosts ?? []).map(norm).filter(Boolean));
  const allowList = (managed.allowedHosts ?? []).map(norm).filter(Boolean);
  const allowWhitelist = allowList.length ? new Set(allowList) : null;

  let allow = (store.allowHosts ?? []).map(norm);
  if (allowWhitelist) allow = allow.filter((h) => allowWhitelist.has(h));
  allow = allow.filter((h) => !denied.has(h));

  const ask = new Set((store.alwaysAskHosts ?? []).map(norm));
  for (const d of denied) ask.add(d);

  // A restrictive allow-list or an explicit disable both kill allow-all (tighten only).
  const danger = managed.disableDangerMode || allowWhitelist ? false : store.dangerMode ?? false;
  return { dangerMode: danger, allowHosts: [...new Set(allow)], alwaysAskHosts: [...ask] };
}

// ── thin persistence (machine-level, like settings) ─────────────────────────────────────────────────
export function loadEgress(): EgressStore {
  try { return existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : {}; } catch { return {}; }
}
function saveEgress(s: EgressStore): void {
  try { writeFileSync(FILE, JSON.stringify(s, null, 2), "utf8"); } catch { /* best-effort; never break a turn */ }
}

/** Decision context (P-NETWL.3): the current project/workspace + whether we're inside a goal loop, so
 *  `project`- and `loop`-scoped whitelist entries can be honored. Omit for the plain "always"-only path. */
export type EgressContext = WhitelistContext;

/** P-NETWL.1/.3 (ADR-0106): PURE - the curated whitelist ENTRY that grants this URL under the managed ceiling,
 *  or null. The managed ceiling still wins: a managed-denied host, or one outside a restrictive managed
 *  allow-list, is never granted (tighten-only, same rule as clampEgress). Scope is honored via `ctx`
 *  (`project`/`loop`). Fail-closed: any error → null. Store-injected so it's testable without touching disk. */
export function egressWhitelistEntry(store: WhitelistStore | null | undefined, url: string, managed?: ManagedEgressPolicy, ctx?: EgressContext): WhitelistEntry | null {
  try {
    const e = whitelistMatch(store, url, ctx);
    if (!e) return null;
    const host = extractHost(url);
    if (!host) return null;
    const norm = (h: string) => h.trim().toLowerCase();
    if (new Set((managed?.deniedHosts ?? []).map(norm)).has(host)) return null; // managed deny beats user allow
    const allowList = (managed?.allowedHosts ?? []).map(norm).filter(Boolean);
    if (allowList.length && !allowList.includes(host)) return null;              // restrictive managed ceiling
    return e;
  } catch { return null; }
}

/** Boolean convenience over egressWhitelistEntry. */
export function egressWhitelistAllows(store: WhitelistStore | null | undefined, url: string, managed?: ManagedEgressPolicy, ctx?: EgressContext): boolean {
  return !!egressWhitelistEntry(store, url, managed, ctx);
}

export interface EgressDecision { verdict: EgressVerdict; via: "whitelist" | "host"; entry?: WhitelistEntry }

/** Read-side, detailed: how this URL is decided. A curated whitelist match auto-allows first (and returns the
 *  granting entry, so the caller can enforce its per-loop call budget); otherwise the standing egress store
 *  decides. Both honor the enterprise-managed egress ceiling. */
export function egressDecisionDetailed(url: string, ctx?: EgressContext): EgressDecision {
  const managed = managedConfig().config?.security?.egress;
  const entry = egressWhitelistEntry(loadWhitelist(), url, managed, ctx);
  if (entry) return { verdict: "allow", via: "whitelist", entry };
  return { verdict: egressVerdict(clampEgress(loadEgress(), managed), url), via: "host" };
}

/** Read-side: is this URL allowed without asking? (Verdict only - see egressDecisionDetailed for the entry.) */
export function egressDecision(url: string, ctx?: EgressContext): EgressVerdict {
  return egressDecisionDetailed(url, ctx).verdict;
}
/** Write-side: persist the user's choice (allow-once/deny are no-ops on disk). */
export function recordEgress(url: string, choice: EgressChoice): void { saveEgress(applyEgressChoice(loadEgress(), url, choice)); }
