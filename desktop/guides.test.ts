// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/guides.test.ts - P-GUIDE.1/.2: the bundled provider advisor guides.
// Every guide renders inside the sandboxed Preview frame (NO network, NO app stylesheet), so each
// asset must be fully self-contained; they ship as first-party docs, so the house writing rule
// (no em dashes, ever) is enforced here rather than trusted. The manifest is the single source of
// truth: every mapped file must exist, so a typo'd filename or a deleted asset fails HERE instead
// of as a dead Settings link.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GUIDE_FILES } from "./guides_manifest.ts";
import { probePreviewFile } from "./preview_file.ts";

const GUIDES_DIR = join(import.meta.dir, "renderer", "guides");
const uniqueFiles = [...new Set(Object.values(GUIDE_FILES))];

describe("guides manifest", () => {
  test("carries the onboarding entry and the provider cards the hub links", () => {
    expect(GUIDE_FILES["choosing"]).toBe("choosing_a_provider.html");
    expect(GUIDE_FILES["google"]).toBe("gemini_plans.html");
    for (const id of ["openai", "anthropic", "xai", "github-copilot", "azure", "perplexity"]) {
      expect(GUIDE_FILES[id]).toBeDefined();
    }
  });
});

describe.each(uniqueFiles)("guide asset %s", (file) => {
  const path = join(GUIDES_DIR, file);
  const html = readFileSync(path, "utf8");

  test("exists, is an html document, and the preview gate accepts it", () => {
    expect(html.startsWith("<!doctype html>")).toBe(true);
    const probe = probePreviewFile(path);
    expect(probe.ok).toBe(true);
    if (probe.ok) expect(probe.kind).toBe("html");
  });

  test("contains no em dash anywhere (house writing rule)", () => {
    expect(html.includes("\u2014")).toBe(false);
  });

  test("is self-contained: no external scripts, stylesheets, or images (the frame has no network)", () => {
    expect(/<script[^>]*\bsrc=/i.test(html)).toBe(false);
    expect(/<link[^>]*rel=["']?stylesheet/i.test(html)).toBe(false);
    expect(/<img[^>]*\bsrc=["']?https?:/i.test(html)).toBe(false);
  });

  test("carries the point-in-time price stamp", () => {
    expect(html).toContain("September 2026");
  });
});

describe("gemini guide covers the decisions its card links it for", () => {
  const html = readFileSync(join(GUIDES_DIR, "gemini_plans.html"), "utf8");
  test("names the LUCID fields and the cutoff facts", () => {
    for (const anchor of ["id=\"now\"", "id=\"map\"", "id=\"history\"", "id=\"models\"", "id=\"smallbiz\"", "id=\"enterprise\"", "id=\"sources\""]) {
      expect(html).toContain(anchor);
    }
    expect(html).toContain("GEMINI_API_KEY");           // the LUCID field it tells users to fill
    expect(html).toContain("GCP project ID");           // the OAuth prerequisite it explains
    expect(html).toContain("Code Assist Standard");     // the surviving cheap OAuth tier
    expect(html).toContain("Jun 18, 2026");             // the consumer cutoff that motivated the guide
    expect(html).toContain("Gemini Enterprise");        // the product the user asked when to switch to
  });
});

describe("choosing guide is the onboarding landing", () => {
  const html = readFileSync(join(GUIDES_DIR, "choosing_a_provider.html"), "utf8");
  test("points at the Creator edition download and the /providers command", () => {
    expect(html).toContain("github.com/mlcyclops/lucidagentide/releases");
    expect(html).toContain("/providers");
  });
});
