// desktop/build/fetch-runtimes.ts — fetch the static `bun` + `uv` binaries the
// packaged app bundles into Resources/runtimes (see desktop/runtime.ts `bundled()`),
// so a LOCAL `dist:mac` build is as self-contained as the CI one. Without these,
// a Finder-launched app falls back to `spawn("bun")` and dies with ENOENT on a
// machine whose bun isn't on the GUI PATH.
//
// Idempotent: anything already present is left alone (delete a file to refresh).
// Binary names match `bundled()`'s `<tool>-<platform>-<arch>` lookup exactly.

import { $ } from "bun";
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

interface RuntimeSpec {
	/** Output name under runtimes/, e.g. "bun-darwin-arm64" — must match bundled(). */
	readonly name: string;
	/** Release archive URL. */
	readonly url: string;
	/** Archive kind. */
	readonly kind: "zip" | "tgz";
	/** Basename of the executable inside the extracted archive. */
	readonly member: string;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "runtimes");

// Both mac arches: runtime.ts picks by process.arch, and electron-builder bundles
// the whole dir into every arch's app, so an x64 (Rosetta) launch also resolves.
const SPECS: readonly RuntimeSpec[] = [
	{
		name: "bun-darwin-arm64",
		kind: "zip",
		member: "bun",
		url: "https://github.com/oven-sh/bun/releases/latest/download/bun-darwin-aarch64.zip",
	},
	{
		name: "bun-darwin-x64",
		kind: "zip",
		member: "bun",
		url: "https://github.com/oven-sh/bun/releases/latest/download/bun-darwin-x64.zip",
	},
	{
		name: "uv-darwin-arm64",
		kind: "tgz",
		member: "uv",
		url: "https://github.com/astral-sh/uv/releases/latest/download/uv-aarch64-apple-darwin.tar.gz",
	},
	{
		name: "uv-darwin-x64",
		kind: "tgz",
		member: "uv",
		url: "https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-apple-darwin.tar.gz",
	},
];

mkdirSync(OUT, { recursive: true });

for (const spec of SPECS) {
	const dest = join(OUT, spec.name);
	if (existsSync(dest)) {
		console.log(`runtimes: ${spec.name} (cached)`);
		continue;
	}

	const tmp = join(OUT, `.tmp-${spec.name}`);
	rmSync(tmp, { recursive: true, force: true });
	mkdirSync(tmp, { recursive: true });

	const archive = join(tmp, spec.kind === "zip" ? "archive.zip" : "archive.tgz");
	await $`curl -fL --retry 3 -o ${archive} ${spec.url}`;
	if (spec.kind === "zip") {
		await $`unzip -oq ${archive} -d ${tmp}`;
	} else {
		await $`tar xzf ${archive} -C ${tmp}`;
	}

	const found = (await $`find ${tmp} -type f -name ${spec.member}`.text()).trim().split("\n")[0];
	if (!found) {
		throw new Error(`fetch-runtimes: "${spec.member}" not found in ${spec.url}`);
	}
	await $`cp ${found} ${dest}`;
	chmodSync(dest, 0o755);
	rmSync(tmp, { recursive: true, force: true });
	console.log(`runtimes: ${spec.name} ok`);
}

console.log(`runtimes: bundled into ${OUT}`);
