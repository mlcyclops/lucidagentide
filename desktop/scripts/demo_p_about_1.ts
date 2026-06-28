// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_about_1.ts
//
// Increment P-ABOUT.1 (ADR-0087) — the About panel + a dynamically-sourced app version.
// Proves: (1) the version is single-sourced (version.ts === desktop/package.json) and starts at the
// launch baseline v1.8.7; (2) the About panel renders the LUCID Agent IDE identity, the TechLead 187
// company + BUSL-1.1 licensing, and the live version; (3) the animated rail glyph matches the icon family.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { aboutHtml, readmeMark } from "../renderer/about.ts";
import { APP_VERSION } from "../version.ts";

const fail = (msg: string): never => { console.error(`FAIL: ${msg}`); process.exit(1); };
const ok = (msg: string): void => console.log(`   ${msg} ✓`);

console.log("== P-ABOUT.1 — About panel + dynamic version ==");

// 1. Single-sourced version, launch baseline v1.8.7.
const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as { version: string };
if (pkg.version !== APP_VERSION) fail(`desktop/package.json (${pkg.version}) and version.ts (${APP_VERSION}) drifted`);
ok(`version single-sourced: version.ts === desktop/package.json === ${APP_VERSION}`);
if (APP_VERSION !== "1.8.9") fail(`app version must be 1.8.9, got ${APP_VERSION}`);
ok("app version is v1.8.9");

// 2. The panel surfaces identity, company, license, and the live version (no hardcoded duplicate).
const html = aboutHtml(APP_VERSION);
const must = [
  ["product wordmark", "LUCID"],
  ["product subtitle", "AGENT&nbsp;IDE"],
  ["dynamic version", `v${APP_VERSION}`],
  ["company", "TechLead&nbsp;187&nbsp;LLC"],
  ["license", "Business Source License 1.1"],
  ["change date → MPL", "2030-06-27 → MPL-2.0"],
  ["not OSI open-source", "source-available, not OSI open-source"],
  ["dialog semantics", 'role="dialog"'],
] as const;
for (const [label, needle] of must) {
  if (!html.includes(needle)) fail(`About panel missing ${label} (${needle})`);
  ok(`panel shows ${label}`);
}

// The version is interpolated, never hardcoded in the markup — bumping version.ts moves the UI.
if (aboutHtml("9.9.9").includes("v1.8.9")) fail("version is hardcoded in the markup");
ok("version is interpolated (dynamic), not hardcoded");

// 3. The animated rail glyph matches the 24×24 / 1.6-stroke icon family and has the twinkle hook.
const mark = readmeMark();
if (!mark.includes('viewBox="0 0 24 24"') || !mark.includes('stroke-width="1.6"')) fail("rail glyph off-family");
if (!mark.includes("about-spark")) fail("rail glyph missing the animated sparkle the CSS twinkles");
ok("animated rail glyph matches the icon family (book + twinkling sparkle)");

console.log("demo-P-ABOUT.1 OK");
process.exit(0);
