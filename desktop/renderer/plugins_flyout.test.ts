// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/plugins_flyout.test.ts - P-PLUGINS.1 (ADR-0461): where the drawer lands. It must open from the
// Preview panel's left edge at min(1180px, 88vw), and never slide under the left rail.

import { describe, expect, test } from "bun:test";
import { resolvePreview } from "../preview_resolve.ts";
import type { InstalledPluginView, PluginFileInspectView } from "./bridge.ts";
import { FREE_PLUGINS, PATRON_PACK_ID, PREMIUM_PLUGINS, SPONSOR_PACK_ID, isWorldPlugin, type FreePlugin, type SoldPlugin } from "./plugin_catalog.ts";
import {
  addonFootHtml, addonOpenSheetHtml, buySheetHtml, drawerAnchor, drawerGeometry, drawerShellHtml, freeCardHtml, installedBodyHtml, pickCountLabel, premiumCardHtml,
  premiumFootHtml, privateInstallSheetHtml, removeSheetHtml, sponsorPickerSheetHtml,
} from "./plugins_flyout.ts";

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

// ADR-0541: the Herd card on the Free tab. One state button, Remove only once installed, nothing clickable
// when this build does not ship the package.
describe("the optional add-on card", () => {
  const herd: FreePlugin | undefined = FREE_PLUGINS.find((p) => p.id === "herd");
  if (!herd) throw new Error("the herd row is missing from FREE_PLUGINS");

  test("the card carries the Optional add-on chip and its live footer", () => {
    const html = freeCardHtml(herd, { action: { kind: "install", version: "0.1.0" }, note: null });
    expect(html).toContain('data-status="add-on"');
    expect(html).toContain("Optional add-on");
    expect(html).toContain('data-plg-afoot="herd"');
    expect(html).toContain('data-plg-addon="herd"');
    expect(html).not.toContain("data-plg-repo");
  });

  test("Install when offered; Not in this build is disabled; Open comes with Remove", () => {
    const install = addonFootHtml(herd, { kind: "install", version: "0.1.0" }, null);
    expect(install).toMatch(/data-kind="install" data-plg-addon="herd">Install</);
    expect(install).not.toContain("data-plg-iremove");

    const missing = addonFootHtml(herd, { kind: "not-offered" }, null);
    expect(missing).toMatch(/data-plg-addon="herd" disabled>Not in this build</);
    expect(missing).not.toContain("data-plg-iremove");

    const open = addonFootHtml(herd, { kind: "open" }, { tone: "ok", text: "Installed version 0.1.0." });
    expect(open).toContain('data-plg-iremove="herd"');
    expect(open).toMatch(/data-kind="open" data-plg-addon="herd">Open</);
    expect(open).toContain("Installed version 0.1.0.");

    expect(addonFootHtml(herd, { kind: "installing" }, null)).toMatch(/disabled aria-busy="true">Installing</);
    expect(addonFootHtml(herd, { kind: "checking" }, null)).toMatch(/disabled>Checking</);
  });

  test("a row that is not an add-on keeps its link footer", () => {
    const excalidraw = FREE_PLUGINS.find((p) => p.id === "excalidraw");
    if (!excalidraw) throw new Error("excalidraw row missing");
    const html = freeCardHtml(excalidraw);
    expect(html).toContain("data-plg-repo");
    expect(html).not.toContain("data-plg-addon");
  });

  test("the Open sheet lists how to run it, escaped", () => {
    const sheet = addonOpenSheetHtml(herd);
    expect(sheet).toContain("Herd is running");
    expect(sheet).toContain('<code class="plg-cmd">lucid herd</code>');
    expect(sheet).toContain("lucid herd server stop");
    const hostile = addonOpenSheetHtml({ ...herd, name: "<b>x</b>", howTo: [{ command: "<script>", what: "x" }] });
    expect(hostile).not.toContain("<b>x</b>");
    expect(hostile).not.toContain("<script>");
  });

  test("an add-on with a page says its live view is open, and still lists the commands", () => {
    expect(herd.page).toBe(true);
    const sheet = addonOpenSheetHtml(herd);
    expect(sheet).toContain("live view, read only, is open in the Herd Preview tab");
    expect(sheet).toContain('<code class="plg-cmd">lucid herd</code>');
    expect(addonOpenSheetHtml({ ...herd, page: false })).not.toContain("Preview tab");
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

// P-WORLDS.STORE1: the drawer never needs the Preview panel open to know where it goes.
describe("drawerAnchor", () => {
  const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width });
  const work = rect(0, 40, 1600, 932); // below a 40 px title bar, above a 28 px status bar

  test("an open Preview panel anchors the drawer on its left edge, as before", () => {
    expect(drawerAnchor(rect(900, 40, 700, 932), work)).toEqual({ right: 900, top: 40, height: 932 });
  });

  test("with Preview closed the drawer sits on the work area's right edge, between the title and status bars", () => {
    expect(drawerAnchor(null, work)).toEqual({ right: 1600, top: 40, height: 932 });
    expect(drawerAnchor(rect(1600, 40, 0, 932), work)).toEqual({ right: 1600, top: 40, height: 932 }); // collapsed panel
    const g = drawerGeometry(1600, 1600, 56);
    expect(g.left).toBeGreaterThanOrEqual(56);
    expect(g.left + g.width).toBe(1600);
  });

  test("no layout yet: the whole window", () => {
    expect(drawerAnchor(null, null)).toBeNull();
    expect(drawerAnchor(null, rect(0, 0, 0, 0))).toBeNull();
  });
});

describe("Lucid Agent World Packs on the drawer (P-WORLDS.STORE1)", () => {
  const sold = PREMIUM_PLUGINS.filter((p): p is SoldPlugin => p.sale === "buy");
  const sponsor = sold.find((p) => p.id === SPONSOR_PACK_ID)!;
  const patron = sold.find((p) => p.id === PATRON_PACK_ID)!;
  const worlds = sold.filter(isWorldPlugin);
  const picks = worlds.slice(0, 6).map((w) => w.id);

  test("every world and both packs play their own loop over their own poster", () => {
    for (const p of [...worlds, sponsor, patron]) {
      const html = premiumCardHtml(p, { kind: "buy", price: p.price }, false, null);
      expect(html).toContain('<video class="plg-loop"');
      expect(html).toContain(`data-src="assets/plugins/${p.id}-loop.mp4"`);
      expect(html).toContain(`poster="assets/plugins/${p.id}-poster.webp"`);
      expect(html).not.toContain("plg-gen");
    }
  });

  test("an owned pack is a disabled Owned button; Sponsor's foot says the credits left", () => {
    const s = premiumFootHtml(sponsor, { kind: "owned", credits: 4 }, false, null);
    expect(s).toContain("4 world credits left");
    expect(s).toMatch(/data-kind="owned"[^>]*disabled>Owned</);
    expect(premiumFootHtml(patron, { kind: "owned", credits: null }, false, null)).toContain("Every world unlocked");
    expect(premiumFootHtml(worlds[0]!, { kind: "redeem" }, false, null)).toMatch(/data-kind="redeem"[^>]*>Use a credit</);
  });

  test("the picker lists every world as a toggle, owned ones disabled as Owned, and Continue starts disabled", () => {
    const owned = new Set([worlds[1]!.id]);
    const sheet = sponsorPickerSheetHtml(worlds, owned);
    expect(sheet.split("data-plg-pick=").length - 1).toBe(29);
    for (const w of worlds) expect(sheet).toContain(`src="assets/plugins/${w.id}-poster.webp"`);
    expect(sheet).toMatch(new RegExp(`data-plg-pick="${worlds[1]!.id}" aria-pressed="false" disabled`));
    expect(sheet).toContain('<span class="plg-pick-tag">Owned</span>');
    expect(sheet).toContain(pickCountLabel(0));
    expect(sheet).toMatch(/data-plg-picks-go disabled>Continue</);
    expect(pickCountLabel(6)).toBe("6 of 6 picked");
    expect(sheet).not.toContain("are left"); // enough worlds left
    const most = new Set(worlds.slice(4).map((w) => w.id));
    expect(sponsorPickerSheetHtml(worlds, most)).toContain("only 4 are left");
  });

  test("the license sheet names Sponsor's picks and carries them to checkout; Patron carries none", () => {
    const s = buySheetHtml(sponsor, picks);
    expect(s).toContain(`data-plg-picks="${picks.join(",")}"`);
    for (const id of picks) expect(s).toContain(worlds.find((w) => w.id === id)!.name);
    expect(s).toContain("Buy Sponsor");
    const p = buySheetHtml(patron);
    expect(p).not.toContain("data-plg-picks");
    expect(p).toContain("Every Lucid Agent World unlocks right after checkout");
  });

  test("no em dash in any pack or picker string", () => {
    const all = [
      sponsorPickerSheetHtml(worlds, new Set()), sponsorPickerSheetHtml(worlds, new Set(worlds.slice(2).map((w) => w.id))), buySheetHtml(sponsor, picks), buySheetHtml(patron),
      premiumFootHtml(sponsor, { kind: "owned", credits: 0 }, false, null), premiumCardHtml(sponsor, { kind: "buy", price: sponsor.price }, false, null),
    ].join("");
    expect(all).not.toContain("\u2014");
  });
});
