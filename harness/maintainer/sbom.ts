// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/maintainer/sbom.ts
//
// P-MAINT.1: the SBOM a Maintainer Agent refreshes on every sweep, and the DRIFT diff that turns
// "the dependency set changed" into something a human can be notified about. PURE - no clock, no
// filesystem, no randomness, so two runs over the same deps produce byte-identical output and a diff
// is real signal rather than noise.
//
// FORMAT: CycloneDX 1.5 JSON, the OASIS standard. Minimal but VALID: bomFormat, specVersion,
// version, metadata.timestamp, metadata.component, and one component per dependency carrying
// type/name/version/purl. `serialNumber` is deliberately absent - it must be a fresh urn:uuid, and
// minting randomness would make every refresh differ from the last for no informational gain.
//
// DRIFT WITH NO BASELINE IS NOT DRIFT. diffSbom(null, next) returns three empty lists: a first sweep
// has nothing to have drifted from, and reporting an entire dependency tree as "added" would train
// the reader to ignore the section. The caller writes the baseline and says so.

import type { DepEntry, Ecosystem } from "./contracts.ts";

export interface SbomComponent {
  type: "library";
  name: string;
  version: string;
  purl: string;
}

export interface Sbom {
  bomFormat: "CycloneDX";
  specVersion: "1.5";
  version: number;
  metadata: {
    timestamp: string;
    component: { type: "application"; name: string };
  };
  components: SbomComponent[];
}

export interface SbomDiff { added: string[]; removed: string[]; changed: string[] }

/** purl type per ecosystem, from the package-url specification. */
const PURL_TYPE: Record<Ecosystem, string> = {
  npm: "npm",
  pypi: "pypi",
  cargo: "cargo",
  go: "golang",
  maven: "maven",
  nuget: "nuget",
};

/**
 * Build the purl name portion under that ecosystem's normalization rules from the package-url spec:
 * npm scopes become a percent-encoded namespace, pypi lowercases and hyphenates, golang lowercases
 * the whole module path, maven splits `group:artifact` into namespace/name.
 */
function purlName(ecosystem: Ecosystem, name: string): string {
  const trimmed = name.trim();
  if (ecosystem === "npm") {
    if (trimmed.startsWith("@")) {
      const cut = trimmed.indexOf("/");
      if (cut > 1) return `%40${trimmed.slice(1, cut)}/${trimmed.slice(cut + 1)}`;
    }
    return trimmed;
  }
  if (ecosystem === "pypi") return trimmed.toLowerCase().replace(/_/g, "-");
  if (ecosystem === "go") return trimmed.toLowerCase();
  if (ecosystem === "maven") {
    const cut = trimmed.indexOf(":");
    return cut > 0 ? `${trimmed.slice(0, cut)}/${trimmed.slice(cut + 1)}` : trimmed;
  }
  return trimmed;
}

/** A package-url for one dependency, e.g. `pkg:npm/%40scope/pkg@1.2.3`. */
export function purl(ecosystem: Ecosystem, name: string, version: string): string {
  const v = version.trim().replace(/[?#]/g, "");
  return `pkg:${PURL_TYPE[ecosystem]}/${purlName(ecosystem, name)}@${v}`;
}

/**
 * A CycloneDX 1.5 document for this dependency set. Components are deduped by purl and sorted, so
 * the SBOM is a stable function of its input and a diff against it means something.
 */
export function buildSbom(deps: DepEntry[], meta: { name: string; at: number }): Sbom {
  const byPurl = new Map<string, SbomComponent>();
  for (const dep of deps) {
    const id = purl(dep.ecosystem, dep.name, dep.version);
    if (byPurl.has(id)) continue;
    byPurl.set(id, { type: "library", name: dep.name, version: dep.version, purl: id });
  }
  const components = [...byPurl.values()].sort((a, b) => (a.purl < b.purl ? -1 : a.purl > b.purl ? 1 : 0));
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    version: 1,
    metadata: {
      timestamp: new Date(meta.at).toISOString(),
      component: { type: "application", name: meta.name },
    },
    components,
  };
}

/**
 * Compare two SBOMs by purl.
 *   added   - purls present only in `next`, where the package itself is new
 *   removed - purls present only in `prev`, where the package is gone entirely
 *   changed - the same package at a different version, rendered `<old purl> -> <new purl>`
 * A version change is reported ONLY as `changed`, never also as an added/removed pair.
 */
export function diffSbom(prev: Sbom | null, next: Sbom): SbomDiff {
  if (prev === null) return { added: [], removed: [], changed: [] };
  const prevByBase = new Map<string, string>(); // purl without version -> full purl
  const nextByBase = new Map<string, string>();
  const base = (p: string): string => {
    const cut = p.lastIndexOf("@");
    return cut > 4 ? p.slice(0, cut) : p;
  };
  for (const c of prev.components) prevByBase.set(base(c.purl), c.purl);
  for (const c of next.components) nextByBase.set(base(c.purl), c.purl);

  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const [key, nextPurl] of nextByBase) {
    const prevPurl = prevByBase.get(key);
    if (prevPurl === undefined) added.push(nextPurl);
    else if (prevPurl !== nextPurl) changed.push(`${prevPurl} -> ${nextPurl}`);
  }
  for (const [key, prevPurl] of prevByBase) {
    if (!nextByBase.has(key)) removed.push(prevPurl);
  }
  added.sort();
  removed.sort();
  changed.sort();
  return { added, removed, changed };
}

/** Narrow an SBOM read back off disk. Anything malformed is `null` - a bad baseline is no baseline. */
export function parseSbom(text: string): Sbom | null {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return null;
  const rec = doc as Record<string, unknown>;
  if (rec["bomFormat"] !== "CycloneDX" || rec["specVersion"] !== "1.5") return null;
  const rawComponents = rec["components"];
  if (!Array.isArray(rawComponents)) return null;
  const components: SbomComponent[] = [];
  for (const raw of rawComponents) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
    const c = raw as Record<string, unknown>;
    const name = c["name"];
    const version = c["version"];
    const id = c["purl"];
    if (typeof name !== "string" || typeof version !== "string" || typeof id !== "string") return null;
    components.push({ type: "library", name, version, purl: id });
  }
  const metadata = rec["metadata"];
  const meta = metadata !== null && typeof metadata === "object" && !Array.isArray(metadata) ? (metadata as Record<string, unknown>) : null;
  const timestamp = typeof meta?.["timestamp"] === "string" ? meta["timestamp"] : new Date(0).toISOString();
  const metaComponent = meta?.["component"];
  const mc = metaComponent !== null && typeof metaComponent === "object" && !Array.isArray(metaComponent) ? (metaComponent as Record<string, unknown>) : null;
  const appName = typeof mc?.["name"] === "string" ? mc["name"] : "unknown";
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    version: typeof rec["version"] === "number" ? rec["version"] : 1,
    metadata: { timestamp, component: { type: "application", name: appName } },
    components,
  };
}
