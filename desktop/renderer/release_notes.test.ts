// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/release_notes.test.ts - P-WHATSNEW.1 (ADR-0686): the bundled What's new manifest.

import { describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { APP_VERSION } from "../version.ts";
import { latestNotes, notesSince, RELEASE_NOTES, type ReleaseNotes } from "./release_notes.ts";
import { isNewerVersion } from "./plugin_catalog.ts";

const highlight = (id: string, kind: "feature" | "world" = "feature") =>
  ({ id, kind, title: id, body: id, image: "assets/x.webp", alt: id });

describe("RELEASE_NOTES", () => {
  test("the current APP_VERSION has an entry or an explicit quiet marker", () => {
    const entry = RELEASE_NOTES.find((n) => n.version === APP_VERSION);
    expect(entry, `add a RELEASE_NOTES entry (or { quiet: true }) for ${APP_VERSION}`).toBeDefined();
  });

  test("each entry has highlights XOR the quiet marker, a real date and a semver version", () => {
    for (const n of RELEASE_NOTES) {
      expect(n.version).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
      expect(n.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(n.title.trim().length).toBeGreaterThan(0);
      expect(n.quiet ? n.highlights.length === 0 : n.highlights.length > 0).toBe(true);
    }
  });

  test("entries are unique and newest first", () => {
    const versions = RELEASE_NOTES.map((n) => n.version);
    expect(new Set(versions).size).toBe(versions.length);
    for (let i = 1; i < versions.length; i++) expect(isNewerVersion(versions[i - 1], versions[i])).toBe(true);
  });

  test("every highlight's image is bundled in the renderer and modest in size", () => {
    const root = import.meta.dir;
    for (const n of RELEASE_NOTES) for (const h of n.highlights) {
      expect(h.image).toMatch(/^assets\/[\w/.-]+\.webp$/);
      const file = join(root, h.image);
      expect(existsSync(file), `${n.version}/${h.id}: ${h.image} is not in desktop/renderer/`).toBe(true);
      expect(statSync(file).size).toBeLessThan(600 * 1024);
    }
  });

  test("highlights are complete, unique per release, and link only to lucid-agents.com or its docs", () => {
    for (const n of RELEASE_NOTES) {
      const ids = n.highlights.map((h) => h.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const h of n.highlights) {
        expect(["feature", "world"]).toContain(h.kind);
        for (const s of [h.id, h.title, h.body, h.alt]) expect(s.trim().length).toBeGreaterThan(0);
        if (h.learnMore) expect(h.learnMore).toMatch(/^https:\/\/(docs\.)?lucid-agents\.com\//);
      }
    }
  });

  test("no em dash in any shipped copy (AGENTS.md)", () => {
    expect(JSON.stringify(RELEASE_NOTES)).not.toContain("\u2014");
  });
});

describe("notesSince / latestNotes", () => {
  const manifest: ReleaseNotes[] = [
    { version: "3.1.0", date: "2027-01-03", title: "c", highlights: [highlight("c")] },
    { version: "3.0.1", date: "2027-01-02", title: "hotfix", highlights: [], quiet: true },
    { version: "3.0.0", date: "2027-01-01", title: "b", highlights: [highlight("b", "world")] },
    { version: "2.9.0", date: "2026-12-01", title: "a", highlights: [highlight("a")] },
  ];

  test("everything after the seen version up to the current one, newest first, quiet entries skipped", () => {
    expect(notesSince("2.9.0", "3.1.0", manifest).map((n) => n.version)).toEqual(["3.1.0", "3.0.0"]);
    expect(notesSince("2.8.0", "3.0.1", manifest).map((n) => n.version)).toEqual(["3.0.0", "2.9.0"]);
  });

  test("nothing newer than the running version, nothing already seen", () => {
    expect(notesSince("3.1.0", "3.1.0", manifest)).toEqual([]);
    expect(notesSince("3.0.0", "3.0.1", manifest)).toEqual([]);
  });

  test("with no seen version only the current release shows, never the whole history", () => {
    expect(notesSince(null, "3.0.0", manifest).map((n) => n.version)).toEqual(["3.0.0"]);
  });

  test("a prerelease sorts below its release", () => {
    expect(notesSince("3.1.0-beta.1", "3.1.0", manifest).map((n) => n.version)).toEqual(["3.1.0"]);
  });

  test("About replays the newest release with highlights; a quiet hotfix replays the release it fixed", () => {
    expect(latestNotes("3.1.0", manifest).map((n) => n.version)).toEqual(["3.1.0"]);
    expect(latestNotes("3.0.1", manifest).map((n) => n.version)).toEqual(["3.0.0"]);
    expect(latestNotes(APP_VERSION).length).toBe(1);
  });
});
