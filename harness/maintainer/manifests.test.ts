// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-MAINT.1: manifest discovery + parsing. Every supported format is exercised with the awkward
// shapes that actually appear in real repositories (scoped npm names, range prefixes, inline TOML
// tables, dotted Cargo sub-tables, go.mod require blocks with an // indirect comment), and every
// corrupt or non-registry input is asserted to become an ERROR STRING rather than a throw or a
// silent skip. A parser that quietly drops what it cannot read would report a vulnerable repository
// as clean.

import { expect, test } from "bun:test";
import { discoverManifests, parseManifest } from "./manifests.ts";

test("package.json: dependencies + devDependencies, range prefixes stripped, scope preserved", () => {
  const text = JSON.stringify({
    name: "demo",
    dependencies: { "left-pad": "^1.3.0", "@scope/pkg": "~2.1.0", exact: "3.0.0", gt: ">=4.5.6", pinned: "=6.0.0", withV: "v7.1.0" },
    devDependencies: { typescript: "5.9.2" },
  });
  const { deps, errors } = parseManifest("repo/package.json", text);
  expect(errors).toEqual([]);
  expect(deps.map((d) => `${d.name}@${d.version}`)).toEqual([
    "left-pad@1.3.0",
    "@scope/pkg@2.1.0",
    "exact@3.0.0",
    "gt@4.5.6",
    "pinned@6.0.0",
    "withV@7.1.0",
    "typescript@5.9.2",
  ]);
  expect(deps.every((d) => d.ecosystem === "npm" && d.manifest === "repo/package.json")).toBe(true);
});

test("package.json: a non-registry spec is recorded verbatim, never invented into a version", () => {
  const text = JSON.stringify({ dependencies: { wsp: "workspace:*", loc: "file:../local", git: "git+https://x/y.git", any: "*" } });
  const { deps, errors } = parseManifest("repo/package.json", text);
  expect(errors).toEqual([]);
  expect(deps.map((d) => d.version)).toEqual(["workspace:*", "file:../local", "git+https://x/y.git", "*"]);
});

test("package.json: corrupt JSON and wrong-shaped blocks become errors, never a throw", () => {
  const corrupt = parseManifest("repo/package.json", "{ not json");
  expect(corrupt.deps).toEqual([]);
  expect(corrupt.errors[0]).toStartWith("repo/package.json: not valid JSON (");

  expect(parseManifest("repo/package.json", "[]").errors).toEqual(["repo/package.json: top level must be a JSON object"]);
  expect(parseManifest("repo/package.json", "{}").errors).toEqual(["repo/package.json: no dependencies or devDependencies block"]);
  expect(parseManifest("repo/package.json", '{"dependencies":["a"]}').errors[0]).toContain('"dependencies" must be an object');
  expect(parseManifest("repo/package.json", '{"dependencies":{"a":1}}').errors[0]).toContain('"dependencies.a" must be a string, got number');
  expect(parseManifest("repo/package.json", "   ").errors).toEqual(["repo/package.json: empty file"]);
});

test("requirements.txt: pins parsed; comments/blanks skipped; includes and editables reported", () => {
  const text = [
    "# a comment",
    "",
    "flask==3.0.2",
    "requests>=2.31.0  # inline comment",
    "django[argon2]==5.0.1 ; python_version >= '3.10'",
    "unpinned",
    "-r base.txt",
    "--requirement other.txt",
    "-e .",
    "pkg @ git+https://github.com/x/y.git",
    "--index-url https://example.invalid/simple",
  ].join("\n");
  const { deps, errors } = parseManifest("repo/requirements.txt", text);
  expect(deps.map((d) => `${d.name}@${d.version}`)).toEqual([
    "flask@3.0.2",
    "requests@2.31.0",
    "django@5.0.1", // extras stripped, marker stripped
    "unpinned@*",
  ]);
  expect(deps.every((d) => d.ecosystem === "pypi")).toBe(true);
  expect(errors).toEqual([
    "repo/requirements.txt:7: include not followed (-r base.txt); the referenced file must be discovered and parsed on its own",
    "repo/requirements.txt:8: include not followed (--requirement other.txt); the referenced file must be discovered and parsed on its own",
    "repo/requirements.txt:9: editable install not auditable (-e .)",
    "repo/requirements.txt:10: not a registry requirement (pkg @ git+https://github.com/x/y.git)",
    "repo/requirements.txt:11: pip option not a dependency (--index-url https://example.invalid/simple)",
  ]);
});

test("pyproject.toml: [project] dependencies array and both poetry dependency tables", () => {
  const text = `
[project]
name = "demo"
dependencies = [
  "httpx>=0.27.0",
  "pydantic==2.7.1",
]

[project.urls]
home = "https://example.invalid"

[tool.poetry.dependencies]
python = "^3.11"
rich = "^13.7.1"
uvicorn = { version = "0.30.1", extras = ["standard"] }
localthing = { path = "../local" }

[tool.poetry.group.dev.dependencies]
pytest = "8.2.0"
`;
  const { deps, errors } = parseManifest("repo/pyproject.toml", text);
  expect(deps.map((d) => `${d.name}@${d.version}`)).toEqual([
    "httpx@0.27.0",
    "pydantic@2.7.1",
    "rich@13.7.1",
    "uvicorn@0.30.1", // inline table version read
    "pytest@8.2.0", // poetry dev group
  ]);
  // "python" is the interpreter constraint, not a package, and must never be queried as one.
  expect(deps.some((d) => d.name === "python")).toBe(false);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toContain('poetry dependency "localthing" declares no version');
});

test("pyproject.toml: a single-line dependencies array works, and a manifest with neither table errors", () => {
  const inline = parseManifest("repo/pyproject.toml", '[project]\ndependencies = ["boto3==1.34.0", "click>=8.1"]\n');
  expect(inline.errors).toEqual([]);
  expect(inline.deps.map((d) => `${d.name}@${d.version}`)).toEqual(["boto3@1.34.0", "click@8.1"]);

  const empty = parseManifest("repo/pyproject.toml", '[build-system]\nrequires = ["hatchling"]\n');
  expect(empty.deps).toEqual([]);
  expect(empty.errors).toEqual(["repo/pyproject.toml: no [project] dependencies and no [tool.poetry.dependencies]"]);
});

test("Cargo.toml: plain table, inline table, dotted sub-table, dev-dependencies", () => {
  const text = `
[package]
name = "demo"
version = "0.1.0"

[dependencies]
serde = "1.0.203"
tokio = { version = "1.38.0", features = ["full"] }
localcrate = { path = "../x" }

[dependencies.regex]
version = "1.10.5"
features = ["std"]

[dev-dependencies]
criterion = "0.5.1"
`;
  const { deps, errors } = parseManifest("repo/Cargo.toml", text);
  expect(deps.map((d) => `${d.name}@${d.version}`)).toEqual([
    "serde@1.0.203",
    "tokio@1.38.0",
    "regex@1.10.5",
    "criterion@0.5.1",
  ]);
  expect(deps.every((d) => d.ecosystem === "cargo")).toBe(true);
  // The [package] version="0.1.0" is the crate's own version and must not be read as a dependency.
  expect(deps.some((d) => d.name === "version")).toBe(false);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toContain('cargo dependency "localcrate" declares no version');
});

test("go.mod: require blocks, single-line requires, // indirect, and replace blocks skipped", () => {
  const text = `
module example.com/demo

go 1.22

require (
	github.com/gin-gonic/gin v1.10.0
	golang.org/x/crypto v0.24.0 // indirect
)

require github.com/stretchr/testify v1.9.0

replace (
	github.com/old/x => github.com/new/x v1.0.0
)

exclude example.com/bad v0.0.1
`;
  const { deps, errors } = parseManifest("repo/go.mod", text);
  expect(errors).toEqual([]);
  // Versions keep the declared "v" prefix: manifest fidelity. Normalization for OSV happens later.
  expect(deps.map((d) => `${d.name}@${d.version}`)).toEqual([
    "github.com/gin-gonic/gin@v1.10.0",
    "golang.org/x/crypto@v0.24.0",
    "github.com/stretchr/testify@v1.9.0",
  ]);
  expect(deps.every((d) => d.ecosystem === "go")).toBe(true);
  expect(deps.some((d) => d.name === "github.com/old/x")).toBe(false);
});

test("go.mod: a truncated require block and a versionless require both report errors", () => {
  const { deps, errors } = parseManifest("repo/go.mod", "require (\n\tbroken\n");
  expect(deps).toEqual([]);
  expect(errors).toEqual([
    "repo/go.mod:2: require line missing a version (broken)",
    "repo/go.mod: unterminated require block",
  ]);
  expect(parseManifest("repo/go.mod", "module x\ngo 1.22\n").errors).toEqual(["repo/go.mod: no require directives"]);
});

test("an unsupported manifest name is reported, not silently ignored", () => {
  const { deps, errors } = parseManifest("repo/pom.xml", "<project/>");
  expect(deps).toEqual([]);
  expect(errors[0]).toStartWith("repo/pom.xml: unsupported manifest (known: ");
});

test("binary-ish garbage in every supported format still returns errors rather than throwing", () => {
  const garbage = "\u0000\u0001\uFFFD}}}[[[ === not a manifest ===";
  for (const name of ["package.json", "requirements.txt", "pyproject.toml", "Cargo.toml", "go.mod"]) {
    const result = parseManifest(`repo/${name}`, garbage);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.deps.every((d) => typeof d.version === "string")).toBe(true);
  }
});

test("discoverManifests finds root plus one level in, with the lister injected", () => {
  const tree: Record<string, string[]> = {
    repo: ["package.json", "README.md", "src", "go.mod", "PACKAGE.JSON"],
    "repo/src": ["requirements.txt", "index.ts"],
    "repo/harness": ["Cargo.toml"],
    "repo/desktop": ["pyproject.toml"],
  };
  const asked: string[] = [];
  const found = discoverManifests("repo", (dir) => {
    asked.push(dir);
    const entries = tree[dir];
    if (entries === undefined) throw new Error(`ENOENT: ${dir}`);
    return entries;
  });
  expect(found).toEqual([
    "repo/package.json",
    "repo/go.mod",
    "repo/src/requirements.txt",
    "repo/harness/Cargo.toml",
    "repo/desktop/pyproject.toml",
  ]);
  // A case variant is a DIFFERENT file for every one of these ecosystems (npm requires lowercase
  // package.json), so it must not be picked up: matching it loosely would also double-count on a
  // case-insensitive filesystem.
  expect(found).not.toContain("repo/PACKAGE.JSON");
  // A missing directory throws from the lister and must be treated as absent, not fatal.
  expect(asked.length).toBeGreaterThan(5);
  // Paths use forward slashes on every platform, so discovery output is deterministic.
  expect(found.every((p) => !p.includes("\\"))).toBe(true);
});

test("discoverManifests tolerates a trailing separator and a lister that always throws", () => {
  expect(discoverManifests("repo/", (dir) => (dir === "repo" ? ["go.mod"] : []))).toEqual(["repo/go.mod"]);
  expect(discoverManifests("repo", () => {
    throw new Error("permission denied");
  })).toEqual([]);
});

test("no parser output contains an em dash", () => {
  const samples: readonly [string, string][] = [
    ["repo/package.json", "{ broken"],
    ["repo/requirements.txt", "-r base.txt\n-e .\n"],
    ["repo/pyproject.toml", "[tool.poetry.dependencies]\nx = { path = 'y' }\n"],
    ["repo/Cargo.toml", "[dependencies]\nx = { git = 'y' }\n"],
    ["repo/go.mod", "require (\n\tbroken\n"],
    ["repo/pom.xml", "<project/>"],
  ];
  for (const [path, text] of samples) {
    const result = parseManifest(path, text);
    expect(result.errors.join("\n")).not.toContain("\u2014");
  }
});

test("a deliberately EMPTY [project] dependencies array is zero deps, not an error", () => {
  // This repository's own scanner-sidecar/pyproject.toml is exactly this shape: zero runtime deps by
  // design. Reporting it as unreadable would put a false manifest-error in front of a maintainer.
  const result = parseManifest("scanner-sidecar/pyproject.toml", '[project]\nname = "x"\ndependencies = []\n\n[tool.uv]\npackage = false\n');
  expect(result.deps).toEqual([]);
  expect(result.errors).toEqual([]);
});
