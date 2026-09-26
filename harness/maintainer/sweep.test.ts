// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-MAINT.1: a full sweep with every piece of I/O injected. No filesystem, no network, no clock.
// This is where the four steps are proven to compose: discover + parse, OSV, SBOM drift, ordering.
//
// The behaviours that matter most:
//   [1] a real multi-ecosystem repository produces a correctly ordered, correctly counted report,
//   [2] an unavailable advisory feed is PINNED to the front of the findings, never buried and never
//       silently absent (a sweep that cannot check must not look like a sweep that found nothing),
//   [3] dependency-update findings exist only where an advisory names a fixed version,
//   [4] a first sweep reports no drift, and the sweep NEVER writes anything (SweepIo has no writer).

import { expect, test } from "bun:test";
import { ADVISORY_UNAVAILABLE, type FetchLike } from "./advisory.ts";
import type { MaintainerTarget } from "./contracts.ts";
import { buildSbom, type Sbom } from "./sbom.ts";
import { sweepTarget, type SweepIo } from "./sweep.ts";

const AT = Date.UTC(2026, 7, 30, 2, 30, 0);

const target: MaintainerTarget = {
  id: "lucid-core",
  repoUrl: "https://github.com/techlead187/LucidAgentIDE.git",
  provider: "github",
  localPath: "C:/Apps AI Vibe/LucidAgentIDE",
  cadence: { kind: "daily", hhmm: "02:30" },
  openPr: false,
  openTracker: false,
};

const FILES: Record<string, string> = {
  "C:/Apps AI Vibe/LucidAgentIDE/package.json": JSON.stringify({
    dependencies: { "loud-dep": "^1.0.0", "quiet-dep": "2.3.1", "clean-dep": "9.9.9" },
    devDependencies: { typescript: "5.9.2" },
  }),
  "C:/Apps AI Vibe/LucidAgentIDE/go.mod": "module x\n\ngo 1.22\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.10.0\n)\n",
  "C:/Apps AI Vibe/LucidAgentIDE/scanner-sidecar/requirements.txt": "flask==3.0.2\n-r base.txt\n",
};

const DIRS: Record<string, string[]> = {
  "C:/Apps AI Vibe/LucidAgentIDE": ["package.json", "go.mod", "README.md", "harness"],
  "C:/Apps AI Vibe/LucidAgentIDE/scanner-sidecar": ["requirements.txt"],
  "C:/Apps AI Vibe/LucidAgentIDE/harness": ["maintainer"],
};

/** OSV stand-in: loud-dep is critical with a fix, quiet-dep is low with no fix, everything else clean. */
const osv: FetchLike = async (url, init) => {
  if (url.endsWith("/querybatch")) {
    const raw = typeof init?.body === "string" ? init.body : "{}";
    const parsed: unknown = JSON.parse(raw);
    const q = parsed !== null && typeof parsed === "object" && "queries" in parsed ? parsed.queries : null;
    const queries = Array.isArray(q) ? q : [];
    const results = queries.map((entry) => {
      const pkg = entry !== null && typeof entry === "object" && "package" in entry ? entry.package : null;
      const name = pkg !== null && typeof pkg === "object" && "name" in pkg && typeof pkg.name === "string" ? pkg.name : "";
      if (name === "loud-dep") return { vulns: [{ id: "GHSA-loud" }, { id: "GHSA-loud-two" }] };
      if (name === "quiet-dep") return { vulns: [{ id: "PYSEC-2026-7" }] };
      return {};
    });
    return new Response(JSON.stringify({ results }), { status: 200 });
  }
  const id = url.slice(url.lastIndexOf("/") + 1);
  const entries: Record<string, unknown> = {
    "GHSA-loud": {
      id: "GHSA-loud",
      summary: "Remote code execution in the request parser.",
      aliases: ["CVE-2026-1111"],
      database_specific: { severity: "CRITICAL" },
      affected: [{ package: { ecosystem: "npm", name: "loud-dep" }, ranges: [{ events: [{ introduced: "0" }, { fixed: "1.0.4" }] }] }],
    },
    "GHSA-loud-two": {
      id: "GHSA-loud-two",
      summary: "Second advisory against the same package, same fix.",
      database_specific: { severity: "HIGH" },
      affected: [{ package: { ecosystem: "npm", name: "loud-dep" }, ranges: [{ events: [{ introduced: "0" }, { fixed: "1.0.4" }] }] }],
    },
    "PYSEC-2026-7": { id: "PYSEC-2026-7", summary: "Information disclosure in verbose logging.", database_specific: { severity: "LOW" } },
  };
  const entry = entries[id];
  if (entry === undefined) return new Response("not found", { status: 404 });
  return new Response(JSON.stringify(entry), { status: 200 });
};

function makeIo(overrides: Partial<SweepIo> = {}): SweepIo {
  return {
    readFile: (path) => FILES[path] ?? null,
    listDir: (dir) => {
      const entries = DIRS[dir];
      if (entries === undefined) throw new Error(`ENOENT: ${dir}`);
      return entries;
    },
    fetchImpl: osv,
    loadPrevSbom: () => null,
    now: () => AT,
    ...overrides,
  };
}

test("a full multi-ecosystem sweep counts deps, finds advisories, and orders them worst-first", async () => {
  const outcome = await sweepTarget(target, makeIo());
  const { report } = outcome;
  expect(report.targetId).toBe("lucid-core");
  expect(report.at).toBe(AT);
  expect(outcome.manifests).toEqual([
    "C:/Apps AI Vibe/LucidAgentIDE/package.json",
    "C:/Apps AI Vibe/LucidAgentIDE/go.mod",
    "C:/Apps AI Vibe/LucidAgentIDE/scanner-sidecar/requirements.txt",
  ]);
  // 4 npm + 1 go + 1 pypi = 6 declarations read across three manifests.
  expect(report.deps).toBe(6);

  const advisories = report.findings.filter((f) => f.kind === "advisory");
  expect(advisories.map((f) => f.advisoryIds?.[0])).toEqual(["GHSA-loud", "GHSA-loud-two", "PYSEC-2026-7"]);
  expect(advisories[0]?.severity).toBe("critical");
  expect(advisories[0]?.advisoryIds).toEqual(["GHSA-loud", "CVE-2026-1111"]);
  expect(advisories[0]?.latest).toBe("1.0.4");
  expect(advisories[2]?.severity).toBe("low");
  expect(advisories[2]?.latest).toBeUndefined();

  // Worst-first across the whole list. SEVERITY dominates kind, so the critical bump sits above the
  // high advisory: a reader scanning from the top sees the most dangerous thing first regardless of
  // whether it is a report or an action.
  expect(report.findings.map((f) => `${f.kind}:${f.severity ?? "none"}`)).toEqual([
    "advisory:critical",
    "dependency-update:critical",
    "advisory:high",
    "advisory:low",
    "manifest-error:none",
  ]);
  expect(outcome.advisoryNote).toContain("advisory match(es)");
  expect(outcome.advisoryNote).not.toContain(ADVISORY_UNAVAILABLE);
});

test("two advisories against one package collapse into ONE bump keeping the worst severity", async () => {
  const outcome = await sweepTarget(target, makeIo());
  const bumps = outcome.report.findings.filter((f) => f.kind === "dependency-update");
  expect(bumps).toHaveLength(1);
  expect(bumps[0]?.name).toBe("loud-dep");
  expect(bumps[0]?.current).toBe("1.0.0");
  expect(bumps[0]?.latest).toBe("1.0.4");
  expect(bumps[0]?.severity).toBe("critical"); // not the "high" of the second advisory
  expect(bumps[0]?.advisoryIds).toEqual(["GHSA-loud", "CVE-2026-1111", "GHSA-loud-two"]);
  // quiet-dep has an advisory but no published fix, so there is NO bump invented for it.
  expect(bumps.some((f) => f.name === "quiet-dep")).toBe(false);
});

test("manifest errors ride into the report attributed to their file", async () => {
  const outcome = await sweepTarget(target, makeIo());
  const errors = outcome.report.findings.filter((f) => f.kind === "manifest-error");
  expect(errors).toHaveLength(1);
  expect(errors[0]?.name).toBe("C:/Apps AI Vibe/LucidAgentIDE/scanner-sidecar/requirements.txt");
  expect(errors[0]?.summary).toContain("include not followed (-r base.txt)");
  expect(errors[0]?.ecosystem).toBe("n/a");
});

test("a discovered but unreadable manifest is reported, not skipped", async () => {
  const outcome = await sweepTarget(target, makeIo({ readFile: () => null }));
  const errors = outcome.report.findings.filter((f) => f.kind === "manifest-error");
  expect(errors).toHaveLength(3);
  for (const e of errors) expect(e.summary).toBe("Manifest was discovered but could not be read.");
  expect(outcome.report.deps).toBe(0);
});

test("no manifest at all is a finding, never a silent clean report", async () => {
  const outcome = await sweepTarget(target, makeIo({ listDir: () => [] }));
  expect(outcome.manifests).toEqual([]);
  expect(outcome.report.findings).toHaveLength(1);
  expect(outcome.report.findings[0]?.kind).toBe("manifest-error");
  expect(outcome.report.findings[0]?.summary).toContain("No supported dependency manifest was found");
  expect(outcome.report.deps).toBe(0);
});

test("an unavailable advisory feed is pinned FIRST and named, so the report never reads clean", async () => {
  const offline: FetchLike = async () => {
    throw new Error("getaddrinfo ENOTFOUND api.osv.dev");
  };
  const outcome = await sweepTarget(target, makeIo({ fetchImpl: offline }));
  const first = outcome.report.findings[0];
  expect(first?.name).toBe("osv.dev");
  expect(first?.summary).toStartWith(ADVISORY_UNAVAILABLE);
  expect(first?.summary).toContain("ENOTFOUND");
  expect(first?.severity).toBeUndefined(); // a coverage gap has no CVSS score to claim
  // It outranks the graded findings even though it has no severity of its own.
  expect(outcome.report.findings.filter((f) => f.kind === "advisory")).toHaveLength(1);
  expect(outcome.advisoryNote).toStartWith(ADVISORY_UNAVAILABLE);
  // The dependency count is still honest: the manifests were read even though OSV was not reached.
  expect(outcome.report.deps).toBe(6);
});

test("a first sweep reports no drift and says it was the first", async () => {
  const outcome = await sweepTarget(target, makeIo());
  expect(outcome.firstSweep).toBe(true);
  expect(outcome.report.sbomDrift).toEqual({ added: [], removed: [], changed: [] });
  expect(outcome.report.findings.some((f) => f.kind === "sbom-drift")).toBe(false);
  // The freshly built SBOM is still returned, so the caller can persist the baseline.
  expect(outcome.sbom.bomFormat).toBe("CycloneDX");
  expect(outcome.sbom.components.map((c) => c.purl)).toEqual([
    "pkg:golang/github.com/gin-gonic/gin@v1.10.0",
    "pkg:npm/clean-dep@9.9.9",
    "pkg:npm/loud-dep@1.0.0",
    "pkg:npm/quiet-dep@2.3.1",
    "pkg:npm/typescript@5.9.2",
    "pkg:pypi/flask@3.0.2",
  ]);
});

test("a second sweep against a real baseline produces one aggregate drift finding plus full lists", async () => {
  const prev: Sbom = buildSbom(
    [
      { ecosystem: "npm", name: "loud-dep", version: "0.9.0", manifest: "m" }, // version change
      { ecosystem: "npm", name: "departed", version: "1.0.0", manifest: "m" }, // removed
      { ecosystem: "npm", name: "clean-dep", version: "9.9.9", manifest: "m" }, // unchanged
    ],
    { name: "lucid-core", at: AT - 864e5 },
  );
  const outcome = await sweepTarget(target, makeIo({ loadPrevSbom: () => prev }));
  expect(outcome.firstSweep).toBe(false);
  expect(outcome.report.sbomDrift.changed).toEqual(["pkg:npm/loud-dep@0.9.0 -> pkg:npm/loud-dep@1.0.0"]);
  expect(outcome.report.sbomDrift.removed).toEqual(["pkg:npm/departed@1.0.0"]);
  expect(outcome.report.sbomDrift.added).toEqual([
    "pkg:golang/github.com/gin-gonic/gin@v1.10.0",
    "pkg:npm/quiet-dep@2.3.1",
    "pkg:npm/typescript@5.9.2",
    "pkg:pypi/flask@3.0.2",
  ]);
  const drift = outcome.report.findings.filter((f) => f.kind === "sbom-drift");
  expect(drift).toHaveLength(1); // ONE aggregate row, so a large diff cannot flood the findings
  expect(drift[0]?.summary).toContain("4 added, 1 removed, 1 version change(s)");
  expect(drift[0]?.current).toBe("6 components");
  // The drift row sorts last: it is ungraded and the least urgent kind.
  expect(outcome.report.findings.at(-1)?.kind).toBe("sbom-drift");
});

test("the sweep is read-only: it reads exactly the manifests it discovered and nothing else", async () => {
  const read: string[] = [];
  const listed: string[] = [];
  const io = makeIo({
    readFile: (path) => {
      read.push(path);
      return FILES[path] ?? null;
    },
    listDir: (dir) => {
      listed.push(dir);
      const entries = DIRS[dir];
      if (entries === undefined) throw new Error(`ENOENT: ${dir}`);
      return entries;
    },
  });
  const outcome = await sweepTarget(target, io);
  expect(read).toEqual(outcome.manifests);
  // Listing is confined to the target root plus one level of known source directories.
  expect(listed[0]).toBe("C:/Apps AI Vibe/LucidAgentIDE");
  expect(listed.every((d) => d.startsWith("C:/Apps AI Vibe/LucidAgentIDE"))).toBe(true);
  // There is no writer to call: the contract itself makes a mutating sweep impossible.
  const keys = Object.keys(io).sort();
  expect(keys).toEqual(["fetchImpl", "listDir", "loadPrevSbom", "now", "readFile"]);
  expect(keys.some((k) => /write|delete|remove|commit|push/i.test(k))).toBe(false);
});

test("the report is pure data, safe to log, with no secret-shaped content", async () => {
  const outcome = await sweepTarget(target, makeIo());
  const serialized = JSON.stringify(outcome.report);
  for (const forbidden of ["token", "Authorization", "Bearer", "password", "LUCID_GIT_PAT"]) {
    expect(serialized).not.toContain(forbidden);
  }
  expect(Object.keys(outcome.report).sort()).toEqual(["at", "deps", "findings", "sbomDrift", "targetId"]);
});

test("the clock is injected, so two sweeps over identical input are identical", async () => {
  const a = await sweepTarget(target, makeIo());
  const b = await sweepTarget(target, makeIo());
  expect(JSON.stringify(a.report)).toBe(JSON.stringify(b.report));
  expect(JSON.stringify(a.sbom)).toBe(JSON.stringify(b.sbom));
});

test("no sweep output contains an em dash", async () => {
  const outcomes = [
    await sweepTarget(target, makeIo()),
    await sweepTarget(target, makeIo({ listDir: () => [] })),
    await sweepTarget(target, makeIo({
      fetchImpl: async () => {
        throw new Error("offline");
      },
    })),
  ];
  for (const outcome of outcomes) {
    const text = [JSON.stringify(outcome.report), outcome.advisoryNote, JSON.stringify(outcome.sbom)].join("\n");
    expect(text).not.toContain("\u2014");
  }
});
