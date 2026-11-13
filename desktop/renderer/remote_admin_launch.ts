// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/remote_admin_launch.ts - P-RS-WINDOW.1 (ADR-0543): the Remote Spokes admin panel opens in a window
// of its own. The view's Admin tab is a launcher, and every entry point (the Admin tab, the Spokes tab's setup
// buttons, the Hubs panel's Set up, the plugins drawer's Open) goes through launchRemoteAdmin: mint a fresh panel URL
// through the engine, then ask Electron main for the window, or open a named browser tab outside Electron.

import { icon } from "./icons.ts";

/** The browser tab's name outside Electron, so a second open reuses the same tab. */
export const ADMIN_TAB_NAME = "lucid-remote-spokes-admin";

export type PanelUrlResult = { ok: true; url: string } | { ok: false; error: string };

export interface RemoteAdminLaunchDeps {
  /** Start the plugin and mint its one-time panel URL (POST /api/plugins/start), or reuse one just minted. */
  panelUrl: () => Promise<PanelUrlResult>;
  /** bridge.openRemoteSpokesAdmin: true opened, false refused by main, null outside Electron. */
  openWindow: (url: string) => Promise<boolean | null>;
  /** window.open, outside Electron only. */
  openTab: (url: string, name: string) => unknown;
}

/** Open or bring forward the admin window. Resolves with the reason it did not open, or null when it did. */
export async function launchRemoteAdmin(d: RemoteAdminLaunchDeps): Promise<string | null> {
  const r = await d.panelUrl().catch((): PanelUrlResult => ({ ok: false, error: "The engine did not answer." }));
  if (!r.ok) return r.error;
  const opened = await d.openWindow(r.url).catch(() => false);
  if (opened === null) {
    // Not Electron (the browser demo): a named tab. Never in Electron, where window.open would hand the one-time
    // URL to the system browser.
    return d.openTab(r.url, ADMIN_TAB_NAME) ? null : "The browser blocked the new tab.";
  }
  return opened ? null : "LUCID could not open the admin window.";
}

/** The view's Admin tab: what the panel holds and the one button that opens it. */
export function adminLauncherHtml(): string {
  return `<div class="rsv-launch">
      <p class="rs-note">The hub's own admin panel: add, approve and remove spokes, presence, custody, models, relays and licenses. It opens in a window of its own.</p>
      <button class="btn-mini" data-rsv-admin-open>${icon("link", 12)} Open the admin panel</button>
    </div>`;
}
