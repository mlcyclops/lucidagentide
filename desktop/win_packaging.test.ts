// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Windows enterprise packaging contract (issue #345, addon #75, PI-4 / ADR-A009).
//
// The MSI UpgradeCode is the identity Windows Installer uses to recognize "this is the
// same product, upgrade it in place". If it ever changes, every managed fleet gets a
// SECOND side-by-side install instead of an upgrade: duplicate shortcuts, orphaned old
// versions, SCCM/Intune supersedence broken. That is the data-loss failure mode for
// enterprise Windows deployment, so the value is pinned HERE and any drift fails CI.
// Same idea for perMachine (SCCM installs in SYSTEM context to Program Files) and the
// AppX identity fields (Intune LOB identity is identityName+publisher; changing either
// makes MSIX updates look like a different app).

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Pinned forever. Never regenerate (see header comment). New GUID = new product line.
const UPGRADE_CODE = "2568ebca-6784-4546-9463-9765440afaf3";

interface WinTargetEntry {
	target: string;
	arch?: string[];
}
interface BuildSection {
	win?: { target?: WinTargetEntry[] };
	msi?: {
		perMachine?: boolean;
		runAfterFinish?: boolean;
		upgradeCode?: string;
		artifactName?: string;
	};
	appx?: {
		identityName?: string;
		publisher?: string;
		publisherDisplayName?: string;
		applicationId?: string;
		artifactName?: string;
	};
}

// Narrow cast after JSON.parse: the assertions below are the runtime check; a missing
// section fails the test rather than passing silently (mirrors packaged_boot.test.ts).
const pkg = JSON.parse(readFileSync(join(import.meta.dir, "package.json"), "utf8")) as { build?: BuildSection };
const build = pkg.build ?? {};

test("win targets include the enterprise MSI and AppX alongside NSIS + portable", () => {
	const targets = (build.win?.target ?? []).map((t) => t.target);
	for (const required of ["nsis", "portable", "msi", "appx"]) {
		expect(targets).toContain(required);
	}
	// x64 only today (matches every other platform's published arch)
	for (const t of build.win?.target ?? []) {
		expect(t.arch).toEqual(["x64"]);
	}
});

test("MSI upgrade contract: UpgradeCode pinned, perMachine, no run-after-finish", () => {
	expect(build.msi?.upgradeCode).toBe(UPGRADE_CODE);
	// Belt and braces: the pin above is exact; this catches a malformed hand edit too.
	expect(build.msi?.upgradeCode).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
	// SCCM deploys in SYSTEM context to Program Files; a per-user MSI breaks that.
	expect(build.msi?.perMachine).toBe(true);
	// SCCM/Intune install silently in SYSTEM context; auto-launching the app there is wrong.
	expect(build.msi?.runAfterFinish).toBe(false);
});

test("AppX identity is stable and shaped for Intune LOB", () => {
	// identityName: 3-50 chars, alphanumeric + dots, no spaces (Package/Identity@Name rules).
	expect(build.appx?.identityName).toMatch(/^[A-Za-z0-9.]{3,50}$/);
	// publisher must be a distinguished name; it must match the signing cert subject at sign time.
	expect(build.appx?.publisher?.startsWith("CN=")).toBe(true);
	expect(build.appx?.publisherDisplayName).toBeTruthy();
	// applicationId: starts with a letter, alphanumeric (Application@Id rules).
	expect(build.appx?.applicationId).toMatch(/^[A-Za-z][A-Za-z0-9]*$/);
});

test("enterprise artifacts are versioned so SCCM/Intune content never collides", () => {
	expect(build.msi?.artifactName).toContain("${version}");
	expect(build.appx?.artifactName).toContain("${version}");
});
