// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-MAINT.1: the OSV advisory client. Runs entirely OFFLINE: every test injects its own fetch, so
// what is proven here is the wire contract and the failure behaviour, not the network.
//
// The load-bearing assertions:
//   [1] ecosystem names go out in OSV's exact spelling (PyPI, crates.io, Go, Maven, NuGet, npm),
//   [2] queries are BATCHED and PAGED, and querybatch's id-only response is hydrated per unique id,
//   [3] severity comes from OSV's rating or a real CVSS v3.1 computation, and is otherwise undefined,
//   [4] `latest` carries the FIXED version OSV publishes, matched to the right package,
//   [5] a network or parse failure returns unavailable:true - NEVER an empty list that reads clean.

import { expect, test } from "bun:test";
import { ADVISORY_UNAVAILABLE, cvss3BaseScore, OSV_ECOSYSTEM, queryAdvisories, severityFromScore, sortFindings, type FetchLike } from "./advisory.ts";
import type { DepEntry, Finding, Severity } from "./contracts.ts";

interface Call { url: string; body: unknown }

/** A fetch stand-in driven by two callbacks, recording every call for assertion. */
function stubFetch(
  calls: Call[],
  handlers: { batch: (queries: unknown[], round: number) => unknown; vuln?: (id: string) => unknown },
): FetchLike {
  let round = 0;
  return async (url, init) => {
    const raw = typeof init?.body === "string" ? init.body : "";
    const body: unknown = raw.length > 0 ? JSON.parse(raw) : null;
    calls.push({ url, body });
    if (url.endsWith("/querybatch")) {
      const parsed = body !== null && typeof body === "object" && "queries" in body ? body.queries : null;
      const queries = Array.isArray(parsed) ? parsed : [];
      const payload = handlers.batch(queries, round);
      round++;
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    }
    const id = url.slice(url.lastIndexOf("/") + 1);
    if (handlers.vuln === undefined) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(handlers.vuln(decodeURIComponent(id))), { status: 200 });
  };
}

const dep = (ecosystem: DepEntry["ecosystem"], name: string, version: string): DepEntry => ({ ecosystem, name, version, manifest: `m/${ecosystem}` });

test("ecosystem mapping uses OSV's exact names", () => {
  expect(OSV_ECOSYSTEM).toEqual({ npm: "npm", pypi: "PyPI", cargo: "crates.io", go: "Go", maven: "Maven", nuget: "NuGet" });
});

test("queries carry the mapped ecosystem, and a go.mod v-prefix is normalized for OSV", () => {
  const calls: Call[] = [];
  const fetchImpl = stubFetch(calls, { batch: (queries) => ({ results: queries.map(() => ({})) }) });
  const deps = [
    dep("npm", "left-pad", "1.3.0"),
    dep("pypi", "flask", "3.0.2"),
    dep("cargo", "serde", "1.0.203"),
    dep("go", "github.com/gin-gonic/gin", "v1.10.0"),
    dep("maven", "org.apache.commons:commons-text", "1.9"),
    dep("nuget", "Newtonsoft.Json", "12.0.1"),
  ];
  return queryAdvisories(deps, fetchImpl).then((result) => {
    expect(result.unavailable).toBe(false);
    expect(result.findings).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.osv.dev/v1/querybatch");
    const sent = calls[0]?.body;
    const queries = sent !== null && typeof sent === "object" && sent !== undefined && "queries" in sent ? sent.queries : null;
    expect(queries).toEqual([
      { package: { name: "left-pad", ecosystem: "npm" }, version: "1.3.0" },
      { package: { name: "flask", ecosystem: "PyPI" }, version: "3.0.2" },
      { package: { name: "serde", ecosystem: "crates.io" }, version: "1.0.203" },
      // the declared "v" is stripped: OSV indexes Go versions without it
      { package: { name: "github.com/gin-gonic/gin", ecosystem: "Go" }, version: "1.10.0" },
      { package: { name: "org.apache.commons:commons-text", ecosystem: "Maven" }, version: "1.9" },
      { package: { name: "Newtonsoft.Json", ecosystem: "NuGet" }, version: "12.0.1" },
    ]);
  });
});

test("a dependency with no concrete version is never queried, and that is stated in the note", async () => {
  const calls: Call[] = [];
  const fetchImpl = stubFetch(calls, { batch: (queries) => ({ results: queries.map(() => ({})) }) });
  const result = await queryAdvisories(
    [dep("npm", "wsp", "workspace:*"), dep("npm", "any", "*"), dep("npm", "real", "1.0.0")],
    fetchImpl,
  );
  expect(result.unavailable).toBe(false);
  expect(result.note).toContain("2 dependency declaration(s) had no concrete version");
  const sent = calls[0]?.body;
  const queries = sent !== null && typeof sent === "object" && sent !== undefined && "queries" in sent ? sent.queries : null;
  expect(Array.isArray(queries) ? queries.length : -1).toBe(1);
});

test("nothing to query at all reaches no network and is honestly not a clean bill of health claim", async () => {
  const calls: Call[] = [];
  const result = await queryAdvisories([dep("npm", "wsp", "workspace:*")], stubFetch(calls, { batch: () => ({ results: [] }) }));
  expect(calls).toEqual([]);
  expect(result.unavailable).toBe(false);
  expect(result.note).toContain("No dependency had a concrete version to check");
});

test("queries are batched at 64 per request", async () => {
  const calls: Call[] = [];
  const deps: DepEntry[] = [];
  for (let i = 0; i < 150; i++) deps.push(dep("npm", `pkg-${i}`, "1.0.0"));
  const fetchImpl = stubFetch(calls, { batch: (queries) => ({ results: queries.map(() => ({})) }) });
  await queryAdvisories(deps, fetchImpl);
  const sizes = calls.map((c) => {
    const b = c.body;
    const q = b !== null && typeof b === "object" && b !== undefined && "queries" in b ? b.queries : null;
    return Array.isArray(q) ? q.length : -1;
  });
  expect(sizes).toEqual([64, 64, 22]);
});

test("a next_page_token is followed for exactly the query that returned it", async () => {
  const calls: Call[] = [];
  const fetchImpl = stubFetch(calls, {
    batch: (queries, round) => {
      if (round === 0) {
        return { results: [{ vulns: [{ id: "GHSA-page-1" }], next_page_token: "tok-a" }, { vulns: [{ id: "GHSA-other" }] }] };
      }
      expect(queries).toHaveLength(1);
      return { results: [{ vulns: [{ id: "GHSA-page-2" }] }] };
    },
    vuln: (id) => ({ id, summary: `summary for ${id}` }),
  });
  const result = await queryAdvisories([dep("npm", "paged", "1.0.0"), dep("npm", "plain", "2.0.0")], fetchImpl);
  expect(result.unavailable).toBe(false);
  const paged = result.findings.filter((f) => f.name === "paged").map((f) => f.advisoryIds?.[0]);
  expect(paged.sort()).toEqual(["GHSA-page-1", "GHSA-page-2"]);
  expect(result.findings.filter((f) => f.name === "plain")).toHaveLength(1);
  // Page 2 asked only about the query that had a token.
  const secondBatch = calls[1]?.body;
  const q = secondBatch !== null && typeof secondBatch === "object" && secondBatch !== undefined && "queries" in secondBatch ? secondBatch.queries : null;
  expect(Array.isArray(q) ? q.length : -1).toBe(1);
});

test("one hydrate per UNIQUE advisory id, no matter how many packages it hits", async () => {
  const calls: Call[] = [];
  const fetchImpl = stubFetch(calls, {
    batch: (queries) => ({ results: queries.map(() => ({ vulns: [{ id: "GHSA-shared" }] })) }),
    vuln: (id) => ({ id, summary: "one shared advisory" }),
  });
  const result = await queryAdvisories([dep("npm", "a", "1.0.0"), dep("npm", "b", "2.0.0"), dep("npm", "c", "3.0.0")], fetchImpl);
  expect(result.findings).toHaveLength(3);
  expect(calls.filter((c) => c.url.includes("/vulns/"))).toHaveLength(1);
  expect(calls.filter((c) => c.url.includes("/vulns/"))[0]?.url).toBe("https://api.osv.dev/v1/vulns/GHSA-shared");
});

test("official ids: the OSV id first, then CVE/GHSA aliases, with junk aliases dropped", async () => {
  const calls: Call[] = [];
  const fetchImpl = stubFetch(calls, {
    batch: (queries) => ({ results: queries.map(() => ({ vulns: [{ id: "GHSA-xxxx-yyyy-zzzz" }] })) }),
    vuln: (id) => ({
      id,
      summary: "Prototype pollution in the parser",
      aliases: ["CVE-2024-12345", "SNYK-JS-THING-1234", "PYSEC-2024-9", "GHSA-xxxx-yyyy-zzzz"],
    }),
  });
  const result = await queryAdvisories([dep("npm", "pollute", "1.0.0")], fetchImpl);
  expect(result.findings[0]?.advisoryIds).toEqual(["GHSA-xxxx-yyyy-zzzz", "CVE-2024-12345", "PYSEC-2024-9"]);
  expect(result.findings[0]?.advisoryIds).not.toContain("SNYK-JS-THING-1234");
  expect(result.findings[0]?.summary).toBe("Prototype pollution in the parser");
  expect(result.findings[0]?.kind).toBe("advisory");
});

test("severity comes from OSV's own rating when it publishes one", async () => {
  const ratings: readonly [string, Severity | undefined][] = [
    ["CRITICAL", "critical"],
    ["HIGH", "high"],
    ["MODERATE", "medium"],
    ["MEDIUM", "medium"],
    ["LOW", "low"],
    ["WEIRD", undefined],
  ];
  for (const [published, expected] of ratings) {
    const fetchImpl = stubFetch([], {
      batch: (queries) => ({ results: queries.map(() => ({ vulns: [{ id: "GHSA-rate" }] })) }),
      vuln: (id) => ({ id, summary: "x", database_specific: { severity: published } }),
    });
    const result = await queryAdvisories([dep("npm", "x", "1.0.0")], fetchImpl);
    expect(result.findings[0]?.severity).toBe(expected);
  }
});

test("severity falls back to a real CVSS v3.1 base-score computation, and never to a guess", async () => {
  // AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H is the canonical 9.8 critical vector.
  const critical = stubFetch([], {
    batch: (queries) => ({ results: queries.map(() => ({ vulns: [{ id: "GHSA-cvss" }] })) }),
    vuln: (id) => ({ id, summary: "x", severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" }] }),
  });
  expect((await queryAdvisories([dep("npm", "x", "1.0.0")], critical)).findings[0]?.severity).toBe("critical");

  // A CVSS v4 vector uses a different formula, so it is NOT approximated: severity stays undefined.
  const v4 = stubFetch([], {
    batch: (queries) => ({ results: queries.map(() => ({ vulns: [{ id: "GHSA-v4" }] })) }),
    vuln: (id) => ({ id, summary: "x", severity: [{ type: "CVSS_V4", score: "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N" }] }),
  });
  expect((await queryAdvisories([dep("npm", "x", "1.0.0")], v4)).findings[0]?.severity).toBeUndefined();

  // No severity information at all: still undefined, still a reported finding.
  const none = stubFetch([], {
    batch: (queries) => ({ results: queries.map(() => ({ vulns: [{ id: "GHSA-none" }] })) }),
    vuln: (id) => ({ id, summary: "x" }),
  });
  const bare = await queryAdvisories([dep("npm", "x", "1.0.0")], none);
  expect(bare.findings).toHaveLength(1);
  expect(bare.findings[0]?.severity).toBeUndefined();
});

test("cvss3BaseScore matches the published examples and refuses a non-v3 vector", () => {
  expect(cvss3BaseScore("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H")).toBe(9.8);
  expect(cvss3BaseScore("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H")).toBe(7.5);
  expect(cvss3BaseScore("CVSS:3.1/AV:L/AC:H/PR:H/UI:R/S:U/C:L/I:N/A:N")).toBe(1.8);
  expect(cvss3BaseScore("CVSS:3.0/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N")).toBe(6.1);
  // No impact at all is a 0.0 base score, which is CVSS "None": not one of our four bands.
  expect(cvss3BaseScore("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N")).toBe(0);
  expect(severityFromScore(0)).toBeUndefined();
  expect(cvss3BaseScore("CVSS:2.0/AV:N/AC:L/Au:N/C:P/I:P/A:P")).toBeNull();
  expect(cvss3BaseScore("CVSS:3.1/AV:N/AC:L")).toBeNull(); // missing required metrics
  expect(cvss3BaseScore("not a vector")).toBeNull();
});

test("latest carries the FIXED version, matched to the right package and ecosystem", async () => {
  const fetchImpl = stubFetch([], {
    batch: (queries) => ({ results: queries.map(() => ({ vulns: [{ id: "GHSA-fix" }] })) }),
    vuln: (id) => ({
      id,
      summary: "fixed upstream",
      affected: [
        { package: { ecosystem: "npm", name: "other-package" }, ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "9.9.9" }] }] },
        { package: { ecosystem: "npm", name: "vulnerable" }, ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "1.4.2" }] }] },
      ],
    }),
  });
  const result = await queryAdvisories([dep("npm", "vulnerable", "1.2.0")], fetchImpl);
  expect(result.findings[0]?.latest).toBe("1.4.2");
  expect(result.findings[0]?.current).toBe("1.2.0");

  // An advisory that names no fixed version must leave `latest` absent, not fabricate one.
  const unfixed = stubFetch([], {
    batch: (queries) => ({ results: queries.map(() => ({ vulns: [{ id: "GHSA-unfixed" }] })) }),
    vuln: (id) => ({ id, summary: "no fix published", affected: [{ package: { ecosystem: "npm", name: "vulnerable" }, ranges: [{ events: [{ introduced: "0" }] }] }] }),
  });
  expect((await queryAdvisories([dep("npm", "vulnerable", "1.2.0")], unfixed)).findings[0]?.latest).toBeUndefined();
});

test("a network throw returns unavailable:true with a reason, never a clean empty list", async () => {
  const boom: FetchLike = async () => {
    throw new Error("getaddrinfo ENOTFOUND api.osv.dev.invalid");
  };
  const result = await queryAdvisories([dep("npm", "x", "1.0.0")], boom);
  expect(result.unavailable).toBe(true);
  expect(result.findings).toEqual([]);
  expect(result.note).toStartWith(ADVISORY_UNAVAILABLE);
  expect(result.note).toContain("ENOTFOUND");
  expect(result.note).toContain("INCOMPLETE");
});

test("a non-2xx and a malformed body both fail closed", async () => {
  const http500: FetchLike = async () => new Response("upstream error", { status: 500 });
  const bad500 = await queryAdvisories([dep("npm", "x", "1.0.0")], http500);
  expect(bad500.unavailable).toBe(true);
  expect(bad500.note).toContain("querybatch HTTP 500");

  const html: FetchLike = async () => new Response("<html>captive portal</html>", { status: 200 });
  const badHtml = await queryAdvisories([dep("npm", "x", "1.0.0")], html);
  expect(badHtml.unavailable).toBe(true);
  expect(badHtml.note).toStartWith(ADVISORY_UNAVAILABLE);

  // Right JSON, wrong arity: OSV guarantees result order matches input, so a mismatch is a failure.
  const shortResults: FetchLike = async () => new Response(JSON.stringify({ results: [] }), { status: 200 });
  const mismatch = await queryAdvisories([dep("npm", "x", "1.0.0")], shortResults);
  expect(mismatch.unavailable).toBe(true);
  expect(mismatch.note).toContain("returned 0 result(s) for 1 query(ies)");
});

test("a partial failure reports the confirmed findings AND flags incomplete coverage", async () => {
  const deps: DepEntry[] = [];
  for (let i = 0; i < 70; i++) deps.push(dep("npm", `pkg-${i}`, "1.0.0"));
  let batches = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    if (url.endsWith("/querybatch")) {
      batches++;
      if (batches === 2) throw new Error("connection reset by peer");
      const raw = typeof init?.body === "string" ? init.body : "{}";
      const parsed: unknown = JSON.parse(raw);
      const q = parsed !== null && typeof parsed === "object" && "queries" in parsed ? parsed.queries : null;
      const count = Array.isArray(q) ? q.length : 0;
      const results: unknown[] = [];
      for (let i = 0; i < count; i++) results.push(i === 0 ? { vulns: [{ id: "GHSA-early" }] } : {});
      return new Response(JSON.stringify({ results }), { status: 200 });
    }
    return new Response(JSON.stringify({ id: "GHSA-early", summary: "found before the failure" }), { status: 200 });
  };
  const result = await queryAdvisories(deps, fetchImpl);
  expect(result.unavailable).toBe(true);
  expect(result.findings).toHaveLength(1);
  expect(result.note).toContain("connection reset by peer");
  expect(result.note).toContain("1 finding(s) were confirmed before the failure");
  expect(result.note).toContain("INCOMPLETE");
});

test("a hydrate failure keeps the finding, drops the severity, and says so", async () => {
  const fetchImpl: FetchLike = async (url) => {
    if (url.endsWith("/querybatch")) return new Response(JSON.stringify({ results: [{ vulns: [{ id: "GHSA-nodetail" }] }] }), { status: 200 });
    return new Response("gone", { status: 404 });
  };
  const result = await queryAdvisories([dep("npm", "x", "1.0.0")], fetchImpl);
  // Detection succeeded, so this is NOT unavailable; only the detail is missing.
  expect(result.unavailable).toBe(false);
  expect(result.findings).toHaveLength(1);
  expect(result.findings[0]?.severity).toBeUndefined();
  expect(result.findings[0]?.advisoryIds).toEqual(["GHSA-nodetail"]);
  expect(result.findings[0]?.summary).toContain("OSV entry details were not retrieved");
  expect(result.note).toContain("1 advisory detail fetch(es) failed");
});

test("sortFindings is worst-first, with a coverage gap pinned ahead of everything", () => {
  const findings: Finding[] = [
    { kind: "sbom-drift", ecosystem: "n/a", name: "sbom", current: "10 components", summary: "drift" },
    { kind: "advisory", ecosystem: "npm", name: "low-one", current: "1", severity: "low", summary: "low" },
    { kind: "advisory", ecosystem: "npm", name: "crit", current: "1", severity: "critical", summary: "crit" },
    { kind: "advisory", ecosystem: "n/a", name: "osv.dev", current: "n/a", summary: `${ADVISORY_UNAVAILABLE}: offline` },
    { kind: "advisory", ecosystem: "npm", name: "ungraded", current: "1", summary: "no severity published" },
    { kind: "advisory", ecosystem: "npm", name: "high", current: "1", severity: "high", summary: "high" },
    { kind: "dependency-update", ecosystem: "npm", name: "bump", current: "1", latest: "2", severity: "medium", summary: "bump" },
  ];
  expect(sortFindings(findings).map((f) => f.name)).toEqual(["osv.dev", "crit", "high", "bump", "low-one", "ungraded", "sbom"]);
  // Pure: the input array is not mutated.
  expect(findings[0]?.name).toBe("sbom");
  // Total order: a re-sort of the sorted list is identical.
  const once = sortFindings(findings);
  expect(sortFindings(once).map((f) => f.name)).toEqual(once.map((f) => f.name));
});

test("no advisory-client output contains an em dash", async () => {
  const fetchImpl = stubFetch([], {
    batch: (queries) => ({ results: queries.map(() => ({ vulns: [{ id: "GHSA-dash" }] })) }),
    vuln: (id) => ({ id, summary: "an advisory summary", database_specific: { severity: "HIGH" } }),
  });
  const ok = await queryAdvisories([dep("npm", "x", "1.0.0")], fetchImpl);
  const broken = await queryAdvisories([dep("npm", "x", "1.0.0")], async () => {
    throw new Error("offline");
  });
  const text = [ok.note, broken.note, ...ok.findings.map((f) => f.summary), ...broken.findings.map((f) => f.summary)].join("\n");
  expect(text).not.toContain("\u2014");
});
