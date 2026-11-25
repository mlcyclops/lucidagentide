// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/whats_new.test.ts - P-WHATSNEW.1 (ADR-0686): the launch decision and the popup markup.

import { describe, expect, test } from "bun:test";
import { latestNotes, type ReleaseNotes } from "./release_notes.ts";
import { APP_VERSION } from "../version.ts";
import { shouldShowWhatsNew, WHATS_NEW_HINT, whatsNewHtml, type WhatsNewInput } from "./whats_new.ts";

const manifest: ReleaseNotes[] = [
  { version: "3.1.0", date: "2027-01-03", title: "Three one", highlights: [
    { id: "feat", kind: "feature", title: "A feature", body: "Does a thing.", image: "assets/a.webp", alt: "A", learnMore: "https://docs.lucid-agents.com/agents/" },
    { id: "world", kind: "world", title: "A world", body: "A place.", image: "assets/b.webp", alt: "B" },
  ] },
  { version: "3.0.1", date: "2027-01-02", title: "hotfix", highlights: [], quiet: true },
  { version: "3.0.0", date: "2027-01-01", title: "Three", highlights: [
    { id: "old", kind: "feature", title: "Older", body: "Older thing.", image: "assets/c.webp", alt: "C" },
  ] },
];

const input = (over: Partial<WhatsNewInput> = {}): WhatsNewInput =>
  ({ seen: "3.0.0", current: "3.1.0", firstRun: false, onboardingActive: false, ...over });

describe("shouldShowWhatsNew", () => {
  test("an upgrade with notes shows the popup", () => {
    expect(shouldShowWhatsNew(input(), manifest)).toBe("show");
  });

  test("a fresh install records the version silently, even with onboarding up", () => {
    expect(shouldShowWhatsNew(input({ seen: null, firstRun: true }), manifest)).toBe("record");
    expect(shouldShowWhatsNew(input({ seen: null, firstRun: true, onboardingActive: true }), manifest)).toBe("record");
  });

  test("once seen it never shows again, and a downgrade shows nothing", () => {
    expect(shouldShowWhatsNew(input({ seen: "3.1.0" }), manifest)).toBe("none");
    expect(shouldShowWhatsNew(input({ seen: "3.2.0" }), manifest)).toBe("none");
  });

  test("never over onboarding, the tour or another modal: wait", () => {
    expect(shouldShowWhatsNew(input({ onboardingActive: true }), manifest)).toBe("wait");
  });

  test("never stacked with Lucid's suggestion toast: the notes keep for the next launch", () => {
    expect(shouldShowWhatsNew(input({ noticeShownThisLaunch: true }), manifest)).toBe("none");
  });

  test("a quiet release moves the seen version on without a popup", () => {
    expect(shouldShowWhatsNew(input({ seen: "3.0.0", current: "3.0.1" }), manifest)).toBe("record");
  });

  test("an install from before the popup (no seen version, not a first run) sees the current notes", () => {
    expect(shouldShowWhatsNew(input({ seen: null }), manifest)).toBe("show");
  });
});

describe("whatsNewHtml", () => {
  const html = whatsNewHtml(manifest.filter((n) => !n.quiet));

  test("is a labeled modal with Dismiss as its primary button and a close X", () => {
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby="whatsNewTitle"');
    expect(html).toMatch(/<button class="btn-mini ok" data-wn-dismiss>Dismiss<\/button>/);
    expect(html).toContain("data-wn-close");
  });

  test("groups the cards New features first, then Agent Worlds", () => {
    const feat = html.indexOf('data-wn-group="feature"'), world = html.indexOf('data-wn-group="world"');
    expect(feat).toBeGreaterThan(-1);
    expect(world).toBeGreaterThan(feat);
    expect(html).toContain("New features");
    expect(html).toContain("Agent Worlds");
  });

  test("each card carries its picture, title, body and version tag", () => {
    expect(html).toContain('src="assets/a.webp"');
    expect(html).toContain('alt="A"');
    expect(html).toContain("A feature");
    expect(html).toContain("New in v3.1.0");
    expect(html).toContain("New in v3.0.0");
  });

  test("Learn more opens in the OS browser with no opener or referrer, only for our sites", () => {
    expect(html).toContain('href="https://docs.lucid-agents.com/agents/" target="_blank" rel="noopener noreferrer"');
    expect((html.match(/class="wn-more"/g) ?? []).length).toBe(1);
    const foreign = whatsNewHtml([{ ...manifest[0]!, highlights: [{ ...manifest[0]!.highlights[0]!, learnMore: "https://evil.example/" }] }]);
    expect(foreign).not.toContain("evil.example");
  });

  test("an empty group is left out", () => {
    const onlyWorld = whatsNewHtml([{ ...manifest[0]!, highlights: [manifest[0]!.highlights[1]!] }]);
    expect(onlyWorld).not.toContain('data-wn-group="feature"');
    expect(onlyWorld).toContain('data-wn-group="world"');
  });

  test("escapes manifest text", () => {
    const evil = whatsNewHtml([{ ...manifest[0]!, title: "<script>", highlights: [{ ...manifest[0]!.highlights[0]!, title: '"><img>' }] }]);
    expect(evil).not.toContain("<script>");
    expect(evil).not.toContain('"><img>');
  });

  test("the real manifest renders for the running version", () => {
    const real = whatsNewHtml(latestNotes(APP_VERSION));
    expect(real).toContain(`v${APP_VERSION}`);
    expect(real).toContain("wn-card");
  });

  test("the dismiss hint points at About > What's new", () => {
    expect(WHATS_NEW_HINT.desc).toContain("About > What's new");
  });
});
