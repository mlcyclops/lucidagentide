// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/plugins_flyout.test.ts - P-PLUGINS.1 (ADR-0461): where the drawer lands. It must open from the
// Preview panel's left edge at min(1180px, 88vw), and never slide under the left rail.

import { describe, expect, test } from "bun:test";
import { resolvePreview } from "../preview_resolve.ts";
import type { InstalledPluginView, PluginFileInspectView } from "./bridge.ts";
import { drawerGeometry, drawerShellHtml, installedBodyHtml, privateInstallSheetHtml, removeSheetHtml } from "./plugins_flyout.ts";

// P-PLUGINS.7 (ADR-0505): what the INSTALLED tab shows and what its sheets let a user do.
const row = (over: Partial<InstalledPluginView>): InstalledPluginView => ({
  id: "remote-spokes", name: "Remote Spokes", version: "0.1.0", kind: "server", tier: "free", section: "civilian",
  state: "installed", license: "Proprietary", hasMcp: false, source: "private", signed: false, ...over,
});
const inspected = (over: Partial<Extract<PluginFileInspectView, { ok: true }>> = {}): Extract<PluginFileInspectView, { ok: true }> => ({
  ok: true, id: "remote-spokes", name: "Remote Spokes", version: "0.1.0", publisher: "TECHLEAD 187 LLC", kind: "server",
  permissions: ["network:loopback", "network:internet", "fs:plugin-data"], hasMcp: false, signed: false, sha256: "a".repeat(64), replaces: null, ...over,
});
const count = (html: string, needle: string): number => html.split(needle).length - 1;

describe("the INSTALLED tab", () => {
  test("the drawer has Premium, Free and Installed tabs", () => {
    const shell = drawerShellHtml("installed", "");
    expect(count(shell, 'role="tab"')).toBe(3);
    expect(shell).toContain('id="plgTab-installed" aria-controls="plgBody" aria-selected="true"');
  });

  test("a private unsigned plugin is marked unsigned and removable; a store plugin opens but is managed from its card", () => {
    const html = installedBodyHtml([
      row({}),
      row({ id: "my-signed", name: "Signed Tool", signed: true }),
      row({ id: "pathfinder", name: "Pathfinder", source: "catalog", signed: true, tier: "premium" }),
    ], "", new Map(), true);
    expect(count(html, 'data-status="unsigned"')).toBe(1);
    expect(html).toContain("Private, unsigned");
    expect(html).toContain("Private, signed by TECHLEAD 187 LLC");
    expect(html).toContain("LUCID store");
    expect(count(html, "data-plg-iopen=")).toBe(3);
    expect(count(html, "data-plg-iremove=")).toBe(2);
    expect(html).not.toContain('data-plg-iremove="pathfinder"');
    expect(html).toContain("data-plg-file");
  });

  test("installing from a file is offered only where a native picker exists; search narrows the rows", () => {
    expect(installedBodyHtml([], "", new Map(), false)).not.toContain("data-plg-file");
    expect(installedBodyHtml([], "", new Map(), true)).toContain("No plugins are installed yet.");
    const html = installedBodyHtml([row({}), row({ id: "other", name: "Other" })], "unsigned", new Map(), true);
    expect(count(html, "data-plg-iopen=")).toBe(2);
    expect(count(installedBodyHtml([row({}), row({ id: "other", name: "Other" })], "remote", new Map(), true), "data-plg-iopen=")).toBe(1);
  });

  test("the review sheet warns about an unsigned package and keeps Install disabled until the box is ticked", () => {
    const unsigned = privateInstallSheetHtml(inspected());
    expect(unsigned).toContain("This plugin is not signed.");
    expect(unsigned).toContain("(not verified)");
    expect(unsigned).toContain("data-plg-unsigned-ok");
    expect(unsigned).toMatch(/data-plg-fileinstall disabled/);
    const signed = privateInstallSheetHtml(inspected({ signed: true, keyId: "k" }));
    expect(signed).not.toContain("not signed");
    expect(signed).not.toContain("data-plg-unsigned-ok");
    expect(signed).not.toMatch(/data-plg-fileinstall disabled/);
    expect(signed).toContain("(signature verified)");
    expect(privateInstallSheetHtml(inspected({ replaces: "0.0.9" }))).toContain("Replaces the installed version 0.0.9");
  });

  test("names in a package are escaped, never markup", () => {
    const html = privateInstallSheetHtml(inspected({ name: "<img src=x onerror=alert(1)>", publisher: "\"><script>" }));
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>");
    expect(removeSheetHtml(row({ name: "<b>x</b>" }))).not.toContain("<b>x</b>");
  });

  test("a plugin's loopback URL typed into the Preview path is still refused: plugins open only through their tab", () => {
    for (const url of ["http://localhost:47123/", "http://127.0.0.1:47123/", "https://example.com/"]) {
      const t = resolvePreview(url);
      expect(t.kind).toBe("remote");
      expect(t.src).toBe("");
    }
  });
});

describe("drawerGeometry", () => {
  test("a wide window: 1180 px, right edge on the Preview panel's left edge", () => {
    expect(drawerGeometry(2560, 1800, 56)).toEqual({ left: 620, width: 1180 });
  });

  test("a common window: 88vw wins, and when the chat column is narrower the drawer overlaps the panel instead of shrinking", () => {
    const g = drawerGeometry(1280, 640, 56);
    expect(g.width).toBe(1126);
    expect(g.left).toBe(56);
    expect(g.left + g.width).toBeGreaterThan(640);
  });

  test("never under the rail, never wider than the space right of it", () => {
    const g = drawerGeometry(900, 450, 56);
    expect(g.left).toBe(56);
    expect(g.left + g.width).toBeLessThanOrEqual(900);
  });
});
