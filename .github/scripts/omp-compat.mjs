// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const PACKAGES = ["pi-agent-core", "pi-ai", "pi-coding-agent", "pi-utils"].map(name => `@oh-my-pi/${name}`);
const REGRESSION = "harness/prompt/prefix_compaction.test.ts";
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SUPPORTED = /^const SUPPORTED_OMP = "([^"]+)";\r?$/gm;
const LEGACY = 'session.settings.set("compaction.strategy", "context-full");';
const ORDERED = 'session.settings.set("compaction.methodOrder", ["soft"]);';

export function exactVersion(value) {
	if (typeof value !== "string" || !VERSION.test(value)) {
		throw new Error("omp probe requires one exact stable x.y.z version, not a range or prerelease");
	}
	return value;
}

function packagePin(manifest) {
	const pin = exactVersion(manifest.dependencies?.[PACKAGES[0]]);
	for (const name of PACKAGES) {
		if (manifest.dependencies?.[name] !== pin) throw new Error(`All four omp pins must agree: ${name}`);
	}
	return pin;
}

function supportedPin(source) {
	const matches = [...source.matchAll(SUPPORTED)];
	if (matches.length !== 1) throw new Error("Expected exactly one SUPPORTED_OMP literal; review regression changes");
	return exactVersion(matches[0][1]);
}

export function currentPin(manifest, source) {
	const pin = packagePin(manifest);
	if (supportedPin(source) !== pin) throw new Error("SUPPORTED_OMP must match all four current exact pins before probing");
	return pin;
}

function orderedCompaction(version) {
	const [major, minor, patch] = exactVersion(version).split(".").map(Number);
	// v17.4.1 replaced strategy with methodOrder; soft maps to context-full with remote disabled.
	// https://github.com/can1357/oh-my-pi/releases/tag/v17.4.1
	// https://github.com/can1357/oh-my-pi/blob/v17.4.1/packages/coding-agent/src/session/compaction-methods.ts
	return major > 17 || (major === 17 && (minor > 4 || (minor === 4 && patch >= 1)));
}

export function migrateCandidateSource(source, current, target) {
	exactVersion(current);
	exactVersion(target);
	if (supportedPin(source) !== current) throw new Error("Candidate regression no longer matches the pre-install pin");
	const before = orderedCompaction(current) ? ORDERED : LEGACY;
	const after = orderedCompaction(target) ? ORDERED : LEGACY;
	const settings = source.match(/session\.settings\.set\("compaction\.(?:strategy|methodOrder)"[^\r\n]*/g) ?? [];
	if (settings.length !== 1 || settings[0] !== before) {
		throw new Error("Unexpected compaction configuration; review upstream changes instead of weakening the regression");
	}
	return source
		.replace(`const SUPPORTED_OMP = "${current}";`, `const SUPPORTED_OMP = "${target}";`)
		.replace(before, after)
		.replace("context-full strategy", "portable text summarization");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const [mode, current, target] = process.argv.slice(2);
	if (mode === "version") {
		console.log(exactVersion(current));
	} else if (mode === "current" || mode === "migrate") {
		const manifest = JSON.parse(readFileSync("package.json", "utf8"));
		const source = readFileSync(REGRESSION, "utf8");
		if (mode === "current") {
			console.log(currentPin(manifest, source));
		} else {
			if (packagePin(manifest) !== exactVersion(target)) throw new Error("Installed candidate manifest pins do not match target");
			const migrated = migrateCandidateSource(source, current, target);
			currentPin(manifest, migrated);
			writeFileSync(REGRESSION, migrated);
			console.log(`Candidate regression migrated from ${current} to ${target}; all assertions retained`);
		}
	} else {
		throw new Error("Usage: node .github/scripts/omp-compat.mjs current | version VERSION | migrate CURRENT TARGET");
	}
}
