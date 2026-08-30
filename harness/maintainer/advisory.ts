// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/maintainer/advisory.ts
//
// P-MAINT.1: the OFFICIAL advisory feed for a Maintainer Agent. Source is OSV (osv.dev), the open
// advisory database Google runs that aggregates GHSA, CVE, PYSEC, RUSTSEC, GO and friends. It needs
// no API key and no account, which is what keeps the EDGE-FIRST mandate intact: an on-premise box
// with plain outbound https is fully served, with nothing to provision in a vendor cloud.
//
// TWO CALLS, because the API really is shaped that way:
//   [1] POST /v1/querybatch answers "is this (ecosystem, name, version) affected" for MANY packages
//       in one request, but it returns vulnerability IDs and a `modified` stamp ONLY.
//   [2] GET /v1/vulns/{id} is therefore required to learn the summary, the CVE/GHSA aliases, the
//       severity, and the FIXED version. Ids are deduped first, so N affected packages sharing one
//       advisory cost one hydrate, and the hydrate count is capped.
//
// FAIL-CLOSED / NEVER FAIL-OPEN. A network error, a non-2xx, malformed JSON, or a partial batch all
// return `unavailable: true` with a note naming the reason. An empty `findings` array with
// `unavailable: false` means "OSV was reached and it knows of nothing" - it is a real clean bill of
// health, and nothing else in this module is allowed to produce that state by accident.
//
// SEVERITY IS NEVER GUESSED. It comes from OSV's own qualitative rating when present, otherwise
// from a real CVSS v3.x base-score computation over the published vector, otherwise it stays
// undefined. There is no default and no heuristic.
//
// ALL NETWORK GOES THROUGH THE INJECTED `fetchImpl`. There is no import of fetch here, so the unit
// tests run entirely offline, and a caller that wants a timeout wraps it in its own fetch (see
// harness/scripts/demo_maintainer.ts, which uses AbortSignal.timeout).

import type { DepEntry, Ecosystem, Finding, Severity } from "./contracts.ts";

/** Structurally compatible with the global `fetch`, so a caller can pass it directly. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Stable prefix a renderer can detect to warn that the sweep had incomplete advisory coverage. */
export const ADVISORY_UNAVAILABLE = "advisory feed unavailable";

const OSV_BASE = "https://api.osv.dev/v1";
/** Queries per querybatch request. OSV accepts far more; a modest batch keeps bodies small. */
const BATCH = 64;
/** Hard cap on how many packages one sweep will ask about. */
const MAX_QUERIES = 2048;
/** Hard cap on paging rounds per batch, so a pathological page_token loop cannot spin forever. */
const MAX_PAGES = 5;
/** Hard cap on hydrate requests per sweep. */
const MAX_HYDRATE = 96;

/** Our ecosystem names -> OSV's exact ecosystem names (case-sensitive on the wire). */
export const OSV_ECOSYSTEM: Record<Ecosystem, string> = {
  npm: "npm",
  pypi: "PyPI",
  cargo: "crates.io",
  go: "Go",
  maven: "Maven",
  nuget: "NuGet",
};

/** Only official identifier namespaces reach a Finding. */
const OFFICIAL_ID = /^(CVE|GHSA|OSV|GO|PYSEC|RUSTSEC|MAL|DSA|DLA|RHSA|USN|UBUNTU|ALSA|CURL|PSF|OSV-MAL)-/i;

// --- CVSS v3.x base score ----------------------------------------------------------------------

const AV: Record<string, number> = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 };
const AC: Record<string, number> = { L: 0.77, H: 0.44 };
const PR_U: Record<string, number> = { N: 0.85, L: 0.62, H: 0.27 };
const PR_C: Record<string, number> = { N: 0.85, L: 0.68, H: 0.5 };
const UI: Record<string, number> = { N: 0.85, R: 0.62 };
// Confidentiality / Integrity / Availability take High, Low, None (there is no Medium in CVSS v3).
const CIA: Record<string, number> = { H: 0.56, L: 0.22, N: 0 };

/** CVSS spec Roundup: round up to one decimal place, exactly as Appendix A defines it. */
function roundUp1(x: number): number {
  const i = Math.round(x * 100000);
  return i % 10000 === 0 ? i / 100000 : (Math.floor(i / 10000) + 1) / 10;
}

/**
 * The CVSS v3.0/v3.1 base score for a vector string, or null when the vector is not a v3 base
 * vector or is missing a required metric. This is the published formula, not an approximation.
 */
export function cvss3BaseScore(vector: string): number | null {
  if (!/^CVSS:3\.[01]\//i.test(vector)) return null;
  const metrics = new Map<string, string>();
  for (const part of vector.split("/").slice(1)) {
    const [k, v] = part.split(":");
    if (k && v) metrics.set(k.toUpperCase(), v.toUpperCase());
  }
  const scope = metrics.get("S");
  const scopeChanged = scope === "C";
  const av = AV[metrics.get("AV") ?? ""];
  const ac = AC[metrics.get("AC") ?? ""];
  const pr = (scopeChanged ? PR_C : PR_U)[metrics.get("PR") ?? ""];
  const ui = UI[metrics.get("UI") ?? ""];
  const c = CIA[metrics.get("C") ?? ""];
  const i = CIA[metrics.get("I") ?? ""];
  const a = CIA[metrics.get("A") ?? ""];
  if (av === undefined || ac === undefined || pr === undefined || ui === undefined) return null;
  if (c === undefined || i === undefined || a === undefined || scope === undefined) return null;
  const iss = 1 - (1 - c) * (1 - i) * (1 - a);
  const impact = scopeChanged ? 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15 : 6.42 * iss;
  if (impact <= 0) return 0;
  const exploitability = 8.22 * av * ac * pr * ui;
  const raw = scopeChanged ? 1.08 * (impact + exploitability) : impact + exploitability;
  return roundUp1(Math.min(raw, 10));
}

/** CVSS qualitative severity bands (spec section 5). */
export function severityFromScore(score: number): Severity | undefined {
  if (score >= 9) return "critical";
  if (score >= 7) return "high";
  if (score >= 4) return "medium";
  if (score > 0) return "low";
  return undefined; // a 0.0 base score is "None", which is not one of our four bands
}

const RATING: Record<string, Severity> = {
  LOW: "low",
  MODERATE: "medium",
  MEDIUM: "medium",
  HIGH: "high",
  CRITICAL: "critical",
};

// --- OSV response narrowing ---------------------------------------------------------------------

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

interface VulnDetail {
  id: string;
  summary: string;
  ids: string[];
  severity?: Severity;
  /** Fixed version per affected package, keyed `<osvEcosystem>|<name>` (built at runtime). */
  fixed: Map<string, string>;
}

/** Pull the qualitative severity out of a vuln entry without ever guessing one. */
function detailSeverity(entry: Record<string, unknown>): Severity | undefined {
  const dbSpecific = asRecord(entry["database_specific"]);
  const rating = asString(dbSpecific?.["severity"]);
  if (rating) {
    const mapped = RATING[rating.toUpperCase()];
    if (mapped) return mapped;
  }
  for (const raw of asArray(entry["severity"])) {
    const sev = asRecord(raw);
    const type = asString(sev?.["type"]) ?? "";
    const score = asString(sev?.["score"]) ?? "";
    if (!/^CVSS_V3/i.test(type)) continue; // v2 and v4 vectors use different formulas: not guessed
    const computed = cvss3BaseScore(score);
    if (computed !== null) return severityFromScore(computed);
  }
  return undefined;
}

/** Collect every `fixed` event OSV publishes, keyed by the package it applies to. */
function detailFixed(entry: Record<string, unknown>): Map<string, string> {
  const fixed = new Map<string, string>();
  for (const rawAffected of asArray(entry["affected"])) {
    const affected = asRecord(rawAffected);
    const pkg = asRecord(affected?.["package"]);
    const eco = asString(pkg?.["ecosystem"]);
    const name = asString(pkg?.["name"]);
    if (!eco || !name) continue;
    // OSV ecosystem strings can carry a release suffix such as "Debian:11"; the base is what we key on.
    const key = `${eco.split(":")[0] ?? eco}|${name}`;
    for (const rawRange of asArray(affected?.["ranges"])) {
      const range = asRecord(rawRange);
      for (const rawEvent of asArray(range?.["events"])) {
        const event = asRecord(rawEvent);
        const f = asString(event?.["fixed"]);
        if (f && !fixed.has(key)) fixed.set(key, f);
      }
    }
  }
  return fixed;
}

function officialIds(primary: string, aliases: unknown): string[] {
  const out: string[] = [primary];
  const extra: string[] = [];
  for (const raw of asArray(aliases)) {
    const id = asString(raw);
    if (id && id !== primary && OFFICIAL_ID.test(id)) extra.push(id);
  }
  extra.sort();
  for (const id of extra) if (!out.includes(id)) out.push(id);
  return out;
}

function parseDetail(id: string, body: unknown): VulnDetail {
  const entry = asRecord(body);
  if (!entry) return { id, summary: "", ids: [id], fixed: new Map() };
  const summary = asString(entry["summary"]) ?? asString(entry["details"]) ?? "";
  return {
    id,
    summary: summary.replace(/\s+/g, " ").trim().slice(0, 400),
    ids: officialIds(id, entry["aliases"]),
    severity: detailSeverity(entry),
    fixed: detailFixed(entry),
  };
}

// --- the query ---------------------------------------------------------------------------------

interface OsvQuery { package: { name: string; ecosystem: string }; version: string; page_token?: string }

/** A dep OSV can actually answer for: mapped ecosystem plus a concrete version. */
function queryable(dep: DepEntry): OsvQuery | null {
  const eco = OSV_ECOSYSTEM[dep.ecosystem];
  if (eco === undefined) return null;
  // Go module versions are declared `v1.2.3` but OSV indexes them without the `v`.
  const version = dep.ecosystem === "go" ? dep.version.replace(/^v/, "") : dep.version;
  if (!/^\d/.test(version)) return null; // "*", "workspace:*", "file:../x": no version to check
  return { package: { name: dep.name, ecosystem: eco }, version };
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function postBatch(fetchImpl: FetchLike, queries: OsvQuery[]): Promise<unknown> {
  const res = await fetchImpl(`${OSV_BASE}/querybatch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ queries }),
  });
  if (!res.ok) throw new Error(`querybatch HTTP ${res.status}`);
  return await res.json();
}

/**
 * Ask OSV which of these dependencies are known-vulnerable.
 *
 * Returns one Finding per (dependency, advisory) pair, carrying the official identifiers, the
 * severity when OSV publishes one, and `latest` set to the FIXED version when OSV names one - that
 * is where an evidence-backed dependency-update recommendation comes from, as opposed to a registry
 * "newest version" guess.
 */
export async function queryAdvisories(
  deps: DepEntry[],
  fetchImpl: FetchLike,
): Promise<{ findings: Finding[]; unavailable: boolean; note: string }> {
  const asked: { dep: DepEntry; query: OsvQuery }[] = [];
  let skipped = 0;
  for (const dep of deps) {
    const query = queryable(dep);
    if (!query) {
      skipped++;
      continue;
    }
    if (asked.length >= MAX_QUERIES) {
      skipped++;
      continue;
    }
    asked.push({ dep, query });
  }
  const skipNote = skipped > 0 ? ` ${skipped} dependency declaration(s) had no concrete version or no OSV ecosystem and were not queried.` : "";

  if (asked.length === 0) {
    return { findings: [], unavailable: false, note: `No dependency had a concrete version to check.${skipNote}` };
  }

  // [1] detection: batched querybatch, with per-query paging for the rare huge result.
  const hits: { dep: DepEntry; ids: string[] }[] = [];
  const failures: string[] = [];
  for (const batch of chunk(asked, BATCH)) {
    let pending = batch.map((b, i) => ({ index: i, query: { ...b.query } }));
    const collected: string[][] = batch.map(() => []);
    for (let page = 0; page < MAX_PAGES && pending.length > 0; page++) {
      let body: unknown;
      try {
        body = await postBatch(fetchImpl, pending.map((p) => p.query));
      } catch (e) {
        failures.push(e instanceof Error ? e.message : String(e));
        pending = [];
        break;
      }
      const results = asArray(asRecord(body)?.["results"]);
      if (results.length !== pending.length) {
        failures.push(`querybatch returned ${results.length} result(s) for ${pending.length} query(ies)`);
        pending = [];
        break;
      }
      const next: typeof pending = [];
      for (let i = 0; i < pending.length; i++) {
        const slot = pending[i];
        if (!slot) continue;
        const result = asRecord(results[i]);
        for (const rawVuln of asArray(result?.["vulns"])) {
          const id = asString(asRecord(rawVuln)?.["id"]);
          if (id) collected[slot.index]?.push(id);
        }
        const token = asString(result?.["next_page_token"]);
        if (token) next.push({ index: slot.index, query: { ...slot.query, page_token: token } });
      }
      pending = next;
    }
    if (pending.length > 0) failures.push(`paging stopped after ${MAX_PAGES} rounds with ${pending.length} query(ies) incomplete`);
    for (let i = 0; i < batch.length; i++) {
      const entry = batch[i];
      const ids = collected[i];
      if (entry && ids && ids.length > 0) hits.push({ dep: entry.dep, ids: [...new Set(ids)] });
    }
  }

  // [2] hydration: one GET per unique advisory id, capped.
  const unique: string[] = [];
  for (const hit of hits) for (const id of hit.ids) if (!unique.includes(id)) unique.push(id);
  const details = new Map<string, VulnDetail>();
  let hydrateFailures = 0;
  let hydrateSkipped = 0;
  for (const id of unique) {
    if (details.size >= MAX_HYDRATE) {
      hydrateSkipped++;
      continue;
    }
    try {
      const res = await fetchImpl(`${OSV_BASE}/vulns/${encodeURIComponent(id)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      details.set(id, parseDetail(id, await res.json()));
    } catch {
      hydrateFailures++;
      details.set(id, { id, summary: "", ids: [id], fixed: new Map() });
    }
  }

  const findings: Finding[] = [];
  for (const hit of hits) {
    const osvEco = OSV_ECOSYSTEM[hit.dep.ecosystem];
    for (const id of hit.ids) {
      const detail = details.get(id) ?? { id, summary: "", ids: [id], fixed: new Map<string, string>() };
      const fixed = detail.fixed.get(`${osvEco}|${hit.dep.name}`);
      const summary = detail.summary.length > 0
        ? detail.summary
        : `${id} affects ${hit.dep.name} ${hit.dep.version}; OSV entry details were not retrieved`;
      const finding: Finding = {
        kind: "advisory",
        ecosystem: hit.dep.ecosystem,
        name: hit.dep.name,
        current: hit.dep.version,
        severity: detail.severity,
        advisoryIds: detail.ids,
        summary,
      };
      if (fixed !== undefined) finding.latest = fixed;
      findings.push(finding);
    }
  }

  if (failures.length > 0) {
    // Partial coverage is reported as unavailable WITH whatever was found. Returning only the
    // partial list would read as a clean bill of health for everything the failed batch covered.
    return {
      findings,
      unavailable: true,
      note: `${ADVISORY_UNAVAILABLE}: ${failures[0]}. ${findings.length} finding(s) were confirmed before the failure, so this sweep's advisory coverage is INCOMPLETE.${skipNote}`,
    };
  }

  const notes: string[] = [`Checked ${asked.length} dependency version(s) against OSV; ${findings.length} advisory match(es).`];
  if (skipNote) notes.push(skipNote.trim());
  if (hydrateFailures > 0) notes.push(`${hydrateFailures} advisory detail fetch(es) failed, so those findings carry their id without a severity.`);
  if (hydrateSkipped > 0) notes.push(`${hydrateSkipped} advisory detail fetch(es) were skipped at the ${MAX_HYDRATE} hydrate cap.`);
  return { findings, unavailable: false, note: notes.join(" ") };
}

// --- ordering ----------------------------------------------------------------------------------

/** CVSS qualitative order. Ungraded findings sort after every graded one (rank 4). */
export const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

const KIND_RANK: Record<Finding["kind"], number> = {
  advisory: 0,
  "dependency-update": 1,
  "manifest-error": 2,
  "sbom-drift": 3,
};

/**
 * Worst-first ordering for a sweep's findings, with ONE deliberate exception: a finding that reports
 * the advisory feed as unavailable is pinned to the front regardless of severity. Not knowing
 * whether a repository is vulnerable outranks any single thing we do know about it, and it must never
 * be buried under graded rows where a reader could take the rest of the list as complete.
 *
 * Ties break by severity, then kind, then name, then first advisory id, so the order is total and a
 * re-render of the same report is byte-identical.
 */
export function sortFindings(findings: Finding[]): Finding[] {
  const keyed = findings.map((f) => ({
    f,
    gap: f.summary.startsWith(ADVISORY_UNAVAILABLE) ? 0 : 1,
    sev: f.severity === undefined ? 4 : SEVERITY_RANK[f.severity],
    kind: KIND_RANK[f.kind],
    id: f.advisoryIds?.[0] ?? "",
  }));
  keyed.sort((a, b) => a.gap - b.gap || a.sev - b.sev || a.kind - b.kind || a.f.name.localeCompare(b.f.name) || a.id.localeCompare(b.id));
  return keyed.map((k) => k.f);
}
