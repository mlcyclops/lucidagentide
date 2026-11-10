// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, test } from "bun:test";
import { ADMIN_TAB_NAME, adminLauncherHtml, launchRemoteAdmin, type PanelUrlResult } from "./remote_admin_launch.ts";

// P-RS-WINDOW.1 (ADR-0537): the admin panel opens in its own window, never in a frame in the view.
const URL_OK = "http://127.0.0.1:47555/#bootstrap=abc";

function harness(mint: PanelUrlResult | Error, answer: boolean | null | Error, tab: unknown = {}) {
  const windows: string[] = [];
  const tabs: { url: string; name: string }[] = [];
  const deps = {
    panelUrl: () => (mint instanceof Error ? Promise.reject(mint) : Promise.resolve(mint)),
    openWindow: (url: string) => { windows.push(url); return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer); },
    openTab: (url: string, name: string) => { tabs.push({ url, name }); return tab; },
  };
  return { deps, windows, tabs };
}

describe("launchRemoteAdmin", () => {
  test("in Electron the minted URL goes to the window and never to a browser tab", async () => {
    const h = harness({ ok: true, url: URL_OK }, true);
    expect(await launchRemoteAdmin(h.deps)).toBeNull();
    expect(h.windows).toEqual([URL_OK]);
    expect(h.tabs).toEqual([]);
  });

  test("a window main refuses is reported and never falls back to a tab", async () => {
    for (const answer of [false, new Error("ipc gone")]) {
      const h = harness({ ok: true, url: URL_OK }, answer);
      expect(await launchRemoteAdmin(h.deps)).toBe("LUCID could not open the admin window.");
      expect(h.tabs).toEqual([]);
    }
  });

  test("outside Electron the URL opens in one named tab", async () => {
    const h = harness({ ok: true, url: URL_OK }, null);
    expect(await launchRemoteAdmin(h.deps)).toBeNull();
    expect(h.tabs).toEqual([{ url: URL_OK, name: ADMIN_TAB_NAME }]);
  });

  test("a blocked tab is reported", async () => {
    expect(await launchRemoteAdmin(harness({ ok: true, url: URL_OK }, null, null).deps)).toBe("The browser blocked the new tab.");
  });

  test("a plugin that does not start opens nothing and says why", async () => {
    const stopped = harness({ ok: false, error: "The Remote Spokes plugin is not installed." }, true);
    expect(await launchRemoteAdmin(stopped.deps)).toBe("The Remote Spokes plugin is not installed.");
    const silent = harness(new Error("network"), true);
    expect(await launchRemoteAdmin(silent.deps)).toBe("The engine did not answer.");
    expect([...stopped.windows, ...silent.windows, ...stopped.tabs, ...silent.tabs]).toEqual([]);
  });
});

describe("adminLauncherHtml", () => {
  test("the Admin tab says what the panel holds and offers one button, with no frame", () => {
    const html = adminLauncherHtml();
    expect(html).toContain("relays and licenses");
    expect(html).toContain("Open the admin panel");
    expect(html.split("data-rsv-admin-open").length - 1).toBe(1);
    expect(html).not.toContain("<iframe");
  });
});
