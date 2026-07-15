// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/about.test.ts — P-ABOUT.1 (ADR-0087): the About panel builders + the version single-source.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { aboutHtml, lucidLogo, readmeMark, techLeadLogo } from "./renderer/about.ts";
import { APP_VERSION } from "./version.ts";

describe("version is single-sourced", () => {
  test("APP_VERSION matches desktop/package.json (no drift)", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "package.json"), "utf8")) as { version: string };
    expect(pkg.version).toBe(APP_VERSION);
  });

  test("app version is v1.11.6", () => {
    expect(APP_VERSION).toBe("1.11.6");
  });
});

describe("aboutHtml", () => {
  const html = aboutHtml(APP_VERSION);

  test("shows the dynamic version with a v prefix", () => {
    expect(html).toContain(`v${APP_VERSION}`);
    expect(html).toContain("v1.11.6");
  });

  test("carries the product + company identity", () => {
    expect(html).toContain("LUCID");
    expect(html).toContain("AGENT&nbsp;IDE");
    expect(html).toContain("TechLead&nbsp;187&nbsp;LLC");
  });

  test("states the BUSL-1.1 license, the change date, and that it is not OSI open-source", () => {
    expect(html).toContain("Business Source License 1.1");
    expect(html).toContain("2030-06-27 → MPL-2.0");
    expect(html).toContain("source-available, not OSI open-source");
  });

  test("is a labelled, modal dialog with closable controls", () => {
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain("data-about-close");
  });

  test("offers a 'Take the tour' replay control (ADR-0089)", () => {
    expect(html).toContain("data-about-tour");
    expect(html).toContain("Take the tour");
  });

  test("links the product website, opening safely in the OS browser", () => {
    expect(html).toContain('href="https://lucid-agent.web.app/"');
    expect(html).toContain("lucid-agent.web.app");
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"'); // no window.opener / referrer leak
  });

  test("escapes the interpolated version (no raw injection)", () => {
    const evil = aboutHtml('1<script>"&');
    expect(evil).not.toContain("<script>");
    expect(evil).toContain("&lt;script&gt;");
  });
});

describe("logos + rail glyph match the icon family", () => {
  test("readmeMark is a 24×24 / 1.6-stroke svg with animated parts", () => {
    const m = readmeMark();
    expect(m).toContain('viewBox="0 0 24 24"');
    expect(m).toContain('stroke-width="1.6"');
    expect(m).toContain("about-mark");
    expect(m).toContain("about-spark"); // the twinkling sparkle the CSS animates
  });

  test("lucidLogo renders the wordmark + π", () => {
    const l = lucidLogo();
    expect(l).toContain("about-lucid");
    expect(l).toContain("about-pi");
  });

  test("techLeadLogo renders the brand avatar image in an animated ring", () => {
    const t = techLeadLogo();
    // The emblem is INLINED as a data URI (no out-of-band fetch), so it paints with the rest of the panel.
    expect(t).toContain("src=\"data:image/png;base64,");
    expect(t).not.toContain("assets/techlead187-avatar.png"); // no separate request left
    expect(t).toContain("about-tl-ring"); // the premium animated gradient ring
    expect(t).toContain('alt=""'); // decorative (the brand name is adjacent text)
  });
});
