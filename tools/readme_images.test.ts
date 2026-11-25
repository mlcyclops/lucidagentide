// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-DOCS.0 (ADR-0660): every image README.md shows from this repo exists, and README names the current
// release. A renamed or forgotten screenshot renders on GitHub as a broken icon and nothing else fails.

import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The release README must call current. Bump it with the release that updates README. */
const CURRENT_RELEASE = "2.7.1";

const root = join(import.meta.dir, "..");
const readme = readFileSync(join(root, "README.md"), "utf8");

/** Relative image paths from markdown `![alt](path "title")` and HTML `<img src="path">`, outside fenced code. */
function relativeImagePaths(markdown: string): string[] {
  const text = markdown.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, "");
  const sources: string[] = [];
  for (const m of text.matchAll(/!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g)) sources.push(m[1]!);
  for (const m of text.matchAll(/<img\b[^>]*?\bsrc\s*=\s*(["'])(.*?)\1/gi)) sources.push(m[2]!);
  const paths = new Set<string>();
  for (const src of sources) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith("//") || src.startsWith("#")) continue;
    const path = decodeURIComponent(src.replace(/[?#].*$/, "")).replace(/^\.?\//, "");
    if (path) paths.add(path);
  }
  return [...paths].sort();
}

test("every relative image in README.md exists in the repo", () => {
  const paths = relativeImagePaths(readme);
  // Guard against the patterns silently matching nothing, which would make this test vacuous and green.
  expect(paths.length).toBeGreaterThan(5);
  expect(paths).toContain("docs/images/worlds/worlds-hero.webp");
  expect(paths.filter((p) => !existsSync(join(root, p)))).toEqual([]);
});

test(`README.md names v${CURRENT_RELEASE} as the current release`, () => {
  const version = CURRENT_RELEASE.replaceAll(".", "\\.");
  expect(readme).toMatch(new RegExp(`\\bv${version} is the current stable release\\b`));
});
