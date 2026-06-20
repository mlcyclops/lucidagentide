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
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Pinned upstream versions — bump deliberately, then REFRESH the hashes below.
const BUN_VERSION = "1.3.14"; // github.com/oven-sh/bun -> release tag bun-v<ver>
const UV_VERSION = "0.11.23"; // github.com/astral-sh/uv -> release tag <ver>

interface RuntimeSpec {
	readonly name: string; // output name under runtimes/ — must match bundled()
	readonly url: string; // exact, versioned release archive URL (never `latest`)
	readonly kind: "zip" | "tgz";
	readonly member: string; // executable basename inside the archive
	readonly sha256: string; // expected SHA-256 of the archive (committed + vendor-cross-checked)
}

const bunUrl = (arch: string): string =>
	`https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-darwin-${arch}.zip`;
const uvUrl = (triple: string): string =>
	`https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${triple}.tar.gz`;

const SPECS: readonly RuntimeSpec[] = [
	{
		name: "bun-darwin-arm64",
		kind: "zip",
		member: "bun",
		url: bunUrl("aarch64"),
		sha256: "d8b96221828ad6f97ac7ac0ab7e95872341af763001e8803e8267652c2652620",
	},
	{
		name: "bun-darwin-x64",
		kind: "zip",
		member: "bun",
		url: bunUrl("x64"),
		sha256: "4183df3374623e5bab315c547cfa0974533cd457d86b73b639f7a87974cd6633",
	},
	{
		name: "uv-darwin-arm64",
		kind: "tgz",
		member: "uv",
		url: uvUrl("aarch64-apple-darwin"),
		sha256: "71ef9de85db820749b3b12b7585624ee279e9c5afcbc6f8236bc3d628c4305b0",
	},
	{
		name: "uv-darwin-x64",
		kind: "tgz",
		member: "uv",
		url: uvUrl("x86_64-apple-darwin"),
		sha256: "7a88155033cc469bba5bd5a24212e355eb92e3e2a276320b669ec576296c1e25",
	},
];

const REFRESH = process.env.REFRESH === "1";
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "runtimes");
const hashOf = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");

mkdirSync(OUT, { recursive: true });

for (const spec of SPECS) {
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
		await $`tar xzf ${archive} -C ${tmp}`;
	}
	const found = (await $`find ${tmp} -type f -name ${spec.member}`.text()).trim().split("\n")[0];
	if (!found) {
		rmSync(tmp, { recursive: true, force: true });
		throw new Error(`fetch-runtimes: "${spec.member}" not found in ${spec.url}`);
	}
	await $`cp ${found} ${dest}`;
	chmodSync(dest, 0o755);
	rmSync(tmp, { recursive: true, force: true });
	console.log(`runtimes: ${spec.name} ok (sha256 verified)`);
}

console.log(
	REFRESH
		? "runtimes: refresh done — paste the printed hashes into SPECS + cross-check vs vendor checksums."
		: `runtimes: verified + bundled into ${OUT}`,
);
