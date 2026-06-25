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

// ── thin persistence (machine-level, like settings) ─────────────────────────────────────────────────
export function loadEgress(): EgressStore {
  try { return existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : {}; } catch { return {}; }
}
function saveEgress(s: EgressStore): void {
  try { writeFileSync(FILE, JSON.stringify(s, null, 2), "utf8"); } catch { /* best-effort; never break a turn */ }
}

/** Read-side: is this URL allowed without asking? */
export function egressDecision(url: string): EgressVerdict { return egressVerdict(loadEgress(), url); }
/** Write-side: persist the user's choice (allow-once/deny are no-ops on disk). */
export function recordEgress(url: string, choice: EgressChoice): void { saveEgress(applyEgressChoice(loadEgress(), url, choice)); }
