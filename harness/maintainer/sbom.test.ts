// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-MAINT.1: the CycloneDX SBOM and its drift diff. Two things are load-bearing here and both are
// over-tested: PURL CORRECTNESS per ecosystem (a wrong purl silently breaks every downstream
// correlation, including OSV's own purl queries) and the THREE DIFF CLASSES, in particular that a
// version change is reported once as `changed` and never also as an added/removed pair.

import { expect, test } from "bun:test";
import type { DepEntry } from "./contracts.ts";
import { buildSbom, diffSbom, parseSbom, purl, type Sbom } from "./sbom.ts";

const dep = (ecosystem: DepEntry["ecosystem"], name: string, version: string): DepEntry => ({ ecosystem, name, version, manifest: "m" });
const AT = Date.UTC(2026, 7, 30, 12, 0, 0);

test("purls follow the package-url spec for every ecosystem", () => {
  expect(purl("npm", "left-pad", "1.3.0")).toBe("pkg:npm/left-pad@1.3.0");
  // An npm scope is a NAMESPACE, and the "@" is percent-encoded.
  expect(purl("npm", "@scope/pkg", "2.1.0")).toBe("pkg:npm/%40scope/pkg@2.1.0");
  // pypi names normalize to lowercase with underscores as hyphens.
  expect(purl("pypi", "Flask_Login", "0.6.3")).toBe("pkg:pypi/flask-login@0.6.3");
  expect(purl("cargo", "serde", "1.0.203")).toBe("pkg:cargo/serde@1.0.203");
  // golang keeps the module path and lowercases it, and keeps the declared "v".
  expect(purl("go", "github.com/Gin-Gonic/gin", "v1.10.0")).toBe("pkg:golang/github.com/gin-gonic/gin@v1.10.0");
  // maven splits group:artifact into namespace/name.
  expect(purl("maven", "org.apache.commons:commons-text", "1.9")).toBe("pkg:maven/org.apache.commons/commons-text@1.9");
  expect(purl("nuget", "Newtonsoft.Json", "12.0.1")).toBe("pkg:nuget/Newtonsoft.Json@12.0.1");
});

test("buildSbom produces a valid, minimal CycloneDX 1.5 document", () => {
  const sbom = buildSbom([dep("npm", "left-pad", "1.3.0"), dep("pypi", "flask", "3.0.2")], { name: "core", at: AT });
  expect(sbom.bomFormat).toBe("CycloneDX");
  expect(sbom.specVersion).toBe("1.5");
  expect(sbom.version).toBe(1);
  expect(sbom.metadata.timestamp).toBe("2026-08-30T12:00:00.000Z");
  expect(sbom.metadata.component).toEqual({ type: "application", name: "core" });
  expect(sbom.components).toEqual([
    { type: "library", name: "left-pad", version: "1.3.0", purl: "pkg:npm/left-pad@1.3.0" },
    { type: "library", name: "flask", version: "3.0.2", purl: "pkg:pypi/flask@3.0.2" },
  ]);
  // The document round-trips through JSON, which is what a consumer will actually receive.
  expect(JSON.parse(JSON.stringify(sbom))).toEqual(sbom);
});

test("buildSbom is deterministic: sorted by purl and deduped, so a diff is real signal", () => {
  const a = buildSbom([dep("npm", "zeta", "1.0.0"), dep("npm", "alpha", "2.0.0"), dep("npm", "alpha", "2.0.0")], { name: "core", at: AT });
  const b = buildSbom([dep("npm", "alpha", "2.0.0"), dep("npm", "zeta", "1.0.0")], { name: "core", at: AT });
  expect(a.components.map((c) => c.purl)).toEqual(["pkg:npm/alpha@2.0.0", "pkg:npm/zeta@1.0.0"]);
  expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  // A dependency declared in two manifests is ONE component, not two.
  const dupes = buildSbom(
    [
      { ecosystem: "npm", name: "shared", version: "1.0.0", manifest: "a/package.json" },
      { ecosystem: "npm", name: "shared", version: "1.0.0", manifest: "b/package.json" },
    ],
    { name: "core", at: AT },
  );
  expect(dupes.components).toHaveLength(1);
});

test("diffSbom classifies added, removed, and changed, and never double-reports a version change", () => {
  const prev = buildSbom(
    [dep("npm", "stays", "1.0.0"), dep("npm", "bumps", "1.0.0"), dep("npm", "leaves", "1.0.0")],
    { name: "core", at: AT },
  );
  const next = buildSbom(
    [dep("npm", "stays", "1.0.0"), dep("npm", "bumps", "2.0.0"), dep("npm", "arrives", "3.0.0")],
    { name: "core", at: AT + 1000 },
  );
  const diff = diffSbom(prev, next);
  expect(diff.added).toEqual(["pkg:npm/arrives@3.0.0"]);
  expect(diff.removed).toEqual(["pkg:npm/leaves@1.0.0"]);
  expect(diff.changed).toEqual(["pkg:npm/bumps@1.0.0 -> pkg:npm/bumps@2.0.0"]);
  // The bumped package appears in exactly one class.
  expect(diff.added.join()).not.toContain("bumps");
  expect(diff.removed.join()).not.toContain("bumps");
  // An unchanged component appears in no class at all.
  expect([...diff.added, ...diff.removed, ...diff.changed].join()).not.toContain("stays");
});

test("diffSbom compares by purl, so the same name in two ecosystems is two components", () => {
  const prev = buildSbom([dep("npm", "requests", "1.0.0")], { name: "core", at: AT });
  const next = buildSbom([dep("npm", "requests", "1.0.0"), dep("pypi", "requests", "2.31.0")], { name: "core", at: AT });
  const diff = diffSbom(prev, next);
  expect(diff.added).toEqual(["pkg:pypi/requests@2.31.0"]);
  expect(diff.changed).toEqual([]);
  expect(diff.removed).toEqual([]);
});

test("a scoped npm package and a maven coordinate still split version from name correctly", () => {
  const prev = buildSbom([dep("npm", "@scope/pkg", "1.0.0"), dep("maven", "org.apache.commons:commons-text", "1.9")], { name: "core", at: AT });
  const next = buildSbom([dep("npm", "@scope/pkg", "1.1.0"), dep("maven", "org.apache.commons:commons-text", "1.10.0")], { name: "core", at: AT });
  expect(diffSbom(prev, next).changed).toEqual([
    "pkg:maven/org.apache.commons/commons-text@1.9 -> pkg:maven/org.apache.commons/commons-text@1.10.0",
    "pkg:npm/%40scope/pkg@1.0.0 -> pkg:npm/%40scope/pkg@1.1.0",
  ]);
});

test("no baseline is NOT drift: a first sweep reports nothing rather than the whole tree as added", () => {
  const next = buildSbom([dep("npm", "a", "1.0.0"), dep("npm", "b", "2.0.0")], { name: "core", at: AT });
  expect(diffSbom(null, next)).toEqual({ added: [], removed: [], changed: [] });
  // An empty-to-empty comparison is likewise silent.
  expect(diffSbom(buildSbom([], { name: "core", at: AT }), buildSbom([], { name: "core", at: AT }))).toEqual({ added: [], removed: [], changed: [] });
  // A real emptying-out IS reported.
  expect(diffSbom(next, buildSbom([], { name: "core", at: AT })).removed).toEqual(["pkg:npm/a@1.0.0", "pkg:npm/b@2.0.0"]);
});

test("diffSbom output is sorted, so a re-render of the same drift is byte-identical", () => {
  const prev = buildSbom([dep("npm", "z", "1.0.0"), dep("npm", "a", "1.0.0")], { name: "core", at: AT });
  const next = buildSbom([dep("npm", "m", "1.0.0"), dep("npm", "b", "1.0.0")], { name: "core", at: AT });
  const diff = diffSbom(prev, next);
  expect(diff.added).toEqual(["pkg:npm/b@1.0.0", "pkg:npm/m@1.0.0"]);
  expect(diff.removed).toEqual(["pkg:npm/a@1.0.0", "pkg:npm/z@1.0.0"]);
  expect(JSON.stringify(diff)).toBe(JSON.stringify(diffSbom(prev, next)));
});

test("parseSbom round-trips a built SBOM and rejects anything malformed", () => {
  const sbom = buildSbom([dep("npm", "left-pad", "1.3.0")], { name: "core", at: AT });
  const back = parseSbom(JSON.stringify(sbom));
  expect(back).toEqual(sbom);
  expect(diffSbom(back, sbom)).toEqual({ added: [], removed: [], changed: [] });

  // A bad baseline is NO baseline: null, so the caller treats it as a first sweep rather than
  // diffing against garbage and inventing drift.
  expect(parseSbom("not json")).toBeNull();
  expect(parseSbom("[]")).toBeNull();
  expect(parseSbom(JSON.stringify({ bomFormat: "SPDX", specVersion: "1.5", components: [] }))).toBeNull();
  expect(parseSbom(JSON.stringify({ bomFormat: "CycloneDX", specVersion: "1.4", components: [] }))).toBeNull();
  expect(parseSbom(JSON.stringify({ bomFormat: "CycloneDX", specVersion: "1.5" }))).toBeNull();
  expect(parseSbom(JSON.stringify({ bomFormat: "CycloneDX", specVersion: "1.5", components: [{ name: "x" }] }))).toBeNull();

  // A valid document missing only optional metadata still parses.
  const bare = parseSbom(JSON.stringify({ bomFormat: "CycloneDX", specVersion: "1.5", components: [{ name: "x", version: "1", purl: "pkg:npm/x@1" }] }));
  expect(bare?.components).toHaveLength(1);
  expect(bare?.metadata.component.name).toBe("unknown");
});

test("no SBOM or diff output contains an em dash", () => {
  const prev = buildSbom([dep("npm", "gone", "1.0.0"), dep("npm", "bump", "1.0.0")], { name: "core", at: AT });
  const next = buildSbom([dep("npm", "bump", "2.0.0"), dep("npm", "new", "1.0.0")], { name: "core", at: AT });
  const diff = diffSbom(prev, next);
  const text = [JSON.stringify(next), ...diff.added, ...diff.removed, ...diff.changed].join("\n");
  expect(text).not.toContain("\u2014");
  // The changed marker is an ASCII arrow, which is what makes that guarantee hold.
  expect(diff.changed[0]).toContain(" -> ");
});

test("an SBOM never carries a secret-shaped field and is safe to log", () => {
  const sbom: Sbom = buildSbom([dep("npm", "left-pad", "1.3.0")], { name: "core", at: AT });
  const serialized = JSON.stringify(sbom);
  for (const forbidden of ["token", "Authorization", "password", "secret", "PAT", "Bearer"]) {
    expect(serialized).not.toContain(forbidden);
  }
  expect(Object.keys(sbom).sort()).toEqual(["bomFormat", "components", "metadata", "specVersion", "version"]);
});
