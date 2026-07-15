// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/build/fetch-runtimes.ts — fetch + VERIFY the static `bun` + `uv` binaries the
// packaged app bundles into Resources/runtimes (see desktop/runtime.ts `bundled()`).
//
// Supply-chain posture (this repo is a provenance/security harness): runtimes are
//   1. PINNED to an exact version (no `latest` -> reproducible builds), and
//   2. VERIFIED against a committed SHA-256 before they're bundled — FAIL-CLOSED:
//      a mismatch, or a missing/placeholder hash, aborts the build.
//
// The trust anchor is the cross-check: the committed hashes below were confirmed
// equal to the vendors' OWN published checksums (bun: SHASUMS256.txt in the
// release · uv: <asset>.tar.gz.sha256) — not merely "whatever downloaded".
//
// Refresh after a version bump:
//   REFRESH=1 bun run build/fetch-runtimes.ts
//   -> downloads each archive and PRINTS its SHA-256 (writes nothing). Paste the values
//      into SPECS, AND cross-check them against the vendor's published checksums before
//      committing (so the committed hash actually means something).

import { $ } from "bun";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Locate the extracted member by basename, recursively. Cross-platform ON PURPOSE: it replaces a
// `find … -name` shell call that on the Windows CI runner resolves to System32\find.exe (a text-search
// tool with incompatible syntax → "FIND: Parameter format not correct"), not the Unix find.
function findMember(root: string, member: string): string | null {
	for (const rel of readdirSync(root, { recursive: true }) as string[]) {
		if (rel.split(/[\\/]/).pop() === member) return join(root, rel);
	}
	return null;
}

// Pinned upstream versions — bump deliberately, then REFRESH the hashes below.
const BUN_VERSION = "1.3.14"; // github.com/oven-sh/bun -> release tag bun-v<ver>
const UV_VERSION = "0.11.23"; // github.com/astral-sh/uv -> release tag <ver>
// python-build-standalone (astral-sh): a RELOCATABLE CPython we bundle so the scanner
// interpreter is provisioned OFFLINE (air-gap, ADR-0225 / add-on ADR-A009). Without it,
// `desktop/runtime.ts` falls back to `uv venv --python 3.12`, which DOWNLOADS a managed
// Python on first run — impossible on an air-gapped host. The scanner has zero pip deps
// (scanner-sidecar/pyproject.toml `dependencies = []`), so a bare interpreter suffices.
// `install_only` archives extract to a single top-level `python/` directory.
const PY_TAG = "20260623"; // github.com/astral-sh/python-build-standalone -> release tag
const PY_VERSION = "3.12.13"; // CPython inside that tag (scanner requires >=3.11)

interface RuntimeSpec {
	readonly platform: "darwin" | "win32" | "linux"; // the process.platform this runtime targets
	readonly name: string; // output name under runtimes/ — must match runtime.ts bundled()/bundledPython()
	readonly url: string; // exact, versioned release archive URL (never `latest`)
	readonly kind: "zip" | "tgz";
	// Exactly one of `member` (copy a single executable) or `tree` (copy an extracted directory,
	// e.g. the whole relocatable Python) is set.
	readonly member?: string; // executable basename inside the archive
	readonly tree?: string; // directory inside the archive to copy wholesale to runtimes/<name>
	readonly sha256: string; // expected SHA-256 of the archive (committed + vendor-cross-checked)
}

const bunUrl = (slug: string): string =>
	`https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-${slug}.zip`;
const uvUrl = (triple: string, ext: "tar.gz" | "zip" = "tar.gz"): string =>
	`https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${triple}.${ext}`;
// %2B keeps the literal `+` in the asset filename (cpython-<ver>+<tag>-…) intact through the URL.
const pyUrl = (triple: string): string =>
	`https://github.com/astral-sh/python-build-standalone/releases/download/${PY_TAG}/cpython-${PY_VERSION}%2B${PY_TAG}-${triple}-install_only.tar.gz`;

const SPECS: readonly RuntimeSpec[] = [
	// macOS (both arches; runtime.ts picks by process.arch)
	{
		platform: "darwin",
		name: "bun-darwin-arm64",
		kind: "zip",
		member: "bun",
		url: bunUrl("darwin-aarch64"),
		sha256: "d8b96221828ad6f97ac7ac0ab7e95872341af763001e8803e8267652c2652620",
	},
	{
		platform: "darwin",
		name: "bun-darwin-x64",
		kind: "zip",
		member: "bun",
		url: bunUrl("darwin-x64"),
		sha256: "4183df3374623e5bab315c547cfa0974533cd457d86b73b639f7a87974cd6633",
	},
	{
		platform: "darwin",
		name: "uv-darwin-arm64",
		kind: "tgz",
		member: "uv",
		url: uvUrl("aarch64-apple-darwin"),
		sha256: "71ef9de85db820749b3b12b7585624ee279e9c5afcbc6f8236bc3d628c4305b0",
	},
	{
		platform: "darwin",
		name: "uv-darwin-x64",
		kind: "tgz",
		member: "uv",
		url: uvUrl("x86_64-apple-darwin"),
		sha256: "7a88155033cc469bba5bd5a24212e355eb92e3e2a276320b669ec576296c1e25",
	},
	// Windows x64 — output names carry the `.exe` so they match runtime.ts bundled() (EXE = ".exe").
	{
		platform: "win32",
		name: "bun-win32-x64.exe",
		kind: "zip",
		member: "bun.exe",
		url: bunUrl("windows-x64"),
		sha256: "0a0620930b6675d7ba440e81f4e0e00d3cfbe096c4b140d3fff02205e9e18922",
	},
	{
		platform: "win32",
		name: "uv-win32-x64.exe",
		kind: "zip",
		member: "uv.exe",
		url: uvUrl("x86_64-pc-windows-msvc", "zip"),
		sha256: "02ad29f07e674d68726ba3bb1ff25b335d83515756e2b1a194bb56c3cc30e07c",
	},
	// Linux x64
	{
		platform: "linux",
		name: "bun-linux-x64",
		kind: "zip",
		member: "bun",
		url: bunUrl("linux-x64"),
		sha256: "951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f",
	},
	{
		platform: "linux",
		name: "uv-linux-x64",
		kind: "tgz",
		member: "uv",
		url: uvUrl("x86_64-unknown-linux-gnu"),
		sha256: "e12c4cda2fe8c305510a78380a88f2c32a27e90cdcd123cefd2873388f0ebb5f",
	},
	// Relocatable CPython for the scanner (air-gap) — copy the whole extracted `python/` tree.
	// Hashes below were cross-checked against python-build-standalone's published SHA256SUMS
	// for release 20260623 (…/releases/download/20260623/SHA256SUMS).
	{
		platform: "win32",
		name: "python-win32-x64",
		kind: "tgz",
		tree: "python",
		url: pyUrl("x86_64-pc-windows-msvc"),
		sha256: "c6af85bb83d5158c9ff71f50dfad467853d1cd236f932b144e87e26e2ea2a83e",
	},
	{
		platform: "linux",
		name: "python-linux-x64",
		kind: "tgz",
		tree: "python",
		url: pyUrl("x86_64-unknown-linux-gnu"),
		sha256: "9fa869d69be54f6b8eeae64272fbd9bb0646e0e1a8da9d80e51ba5a3bee48930",
	},
	{
		platform: "darwin",
		name: "python-darwin-arm64",
		kind: "tgz",
		tree: "python",
		url: pyUrl("aarch64-apple-darwin"),
		sha256: "3724aa4dafb5f7b6c2cf98e89914e4248dc6bd2fe40407df4a2d73de99615f16",
	},
	{
		platform: "darwin",
		name: "python-darwin-x64",
		kind: "tgz",
		tree: "python",
		url: pyUrl("x86_64-apple-darwin"),
		sha256: "7c57fdd1fa675190093700eb0d8e7117e1f9eae7c30a46dea5f8d5266bcfc791",
	},
];

const REFRESH = process.env.REFRESH === "1";
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "runtimes");
const hashOf = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");

mkdirSync(OUT, { recursive: true });

// electron-builder packages on the matching OS, so by default we fetch only the current platform's
// runtimes (RUNTIME_OS overrides — e.g. to pre-stage another OS's binaries). Filtering keeps a Windows
// build from downloading the mac/linux binaries it would never bundle.
const TARGET = (process.env.RUNTIME_OS ?? process.platform) as RuntimeSpec["platform"];
const specs = SPECS.filter((s) => s.platform === TARGET);
if (specs.length === 0) {
	console.warn(`fetch-runtimes: no runtime specs for platform "${TARGET}" — nothing to bundle.`);
}

for (const spec of specs) {
	const dest = join(OUT, spec.name);
	if (!REFRESH && existsSync(dest)) {
		console.log(`runtimes: ${spec.name} (cached)`);
		continue;
	}

	const tmp = join(OUT, `.tmp-${spec.name}`);
	rmSync(tmp, { recursive: true, force: true });
	mkdirSync(tmp, { recursive: true });
	const archive = join(tmp, spec.kind === "zip" ? "a.zip" : "a.tgz");

	// Hardened fetch: force HTTPS + a modern TLS floor.
	await $`curl -fsSL --retry 3 --proto =https --tlsv1.2 -o ${archive} ${spec.url}`;
	const got = hashOf(archive);

	if (REFRESH) {
		console.log(`${spec.name}\n  url:    ${spec.url}\n  sha256: ${got}`);
		rmSync(tmp, { recursive: true, force: true });
		continue;
	}

	// FAIL-CLOSED: never bundle an unpinned/unverified binary.
	if (!spec.sha256) {
		rmSync(tmp, { recursive: true, force: true });
		throw new Error(
			`fetch-runtimes: no committed sha256 for ${spec.name}. Run "REFRESH=1 bun run build/fetch-runtimes.ts", cross-check the vendor checksum, then paste it into SPECS.`,
		);
	}
	if (got !== spec.sha256) {
		rmSync(tmp, { recursive: true, force: true });
		throw new Error(
			`fetch-runtimes: SHA-256 MISMATCH for ${spec.name}\n  expected ${spec.sha256}\n  got      ${got}\nRefusing to bundle a binary that doesn't match the committed hash.`,
		);
	}

	// Verified — safe to extract.
	if (spec.kind === "zip") {
		await $`unzip -oq ${archive} -d ${tmp}`;
	} else {
		// Run from inside tmp with a RELATIVE archive name: a `C:\…` absolute path makes GNU tar
		// (Git Bash) read the drive letter as a remote `host:path` ("Cannot connect to C:"). A bare
		// `a.tgz` extracts locally under both GNU tar and Windows' bundled bsdtar.
		await $`tar xzf a.tgz`.cwd(tmp);
	}
	if (spec.tree) {
		// Copy a whole extracted directory (e.g. the relocatable Python) to runtimes/<name>.
		const srcDir = join(tmp, spec.tree);
		if (!existsSync(srcDir)) {
			rmSync(tmp, { recursive: true, force: true });
			throw new Error(`fetch-runtimes: directory "${spec.tree}/" not found in ${spec.url}`);
		}
		rmSync(dest, { recursive: true, force: true });
		cpSync(srcDir, dest, { recursive: true });
		// cpSync doesn't reliably carry the exec bit; restore it on the POSIX interpreters so the packaged
		// app can spawn them (Windows executability is by extension, so this loop is a no-op there).
		if (process.platform !== "win32") {
			const minor = PY_VERSION.split(".").slice(0, 2).join(".");
			for (const rel of ["bin/python3", `bin/python${minor}`]) {
				const exe = join(dest, rel);
				if (existsSync(exe)) chmodSync(exe, 0o755);
			}
		}
	} else {
		const found = findMember(tmp, spec.member!);
		if (!found) {
			rmSync(tmp, { recursive: true, force: true });
			throw new Error(`fetch-runtimes: "${spec.member}" not found in ${spec.url}`);
		}
		cpSync(found, dest);
		chmodSync(dest, 0o755);
	}
	rmSync(tmp, { recursive: true, force: true });
	console.log(`runtimes: ${spec.name} ok (sha256 verified)`);
}

console.log(
	REFRESH
		? "runtimes: refresh done — paste the printed hashes into SPECS + cross-check vs vendor checksums."
		: `runtimes: verified + bundled into ${OUT}`,
);
