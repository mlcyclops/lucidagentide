// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/updater.ts - in-app auto-update via electron-updater.
//
// Packaged builds check an update feed on launch, selected by managed-config
// (ADR-A009, #74) so ONE binary behaves correctly in any environment:
//   - "github"  (default): the public GitHub Releases feed (publish provider in
//                package.json) - today's behavior.
//   - "feed":   electron-updater's GENERIC provider against a customer-hosted
//                mirror (updateFeedUrl) - intranet / no-internet, in-app update
//                still works.
//   - "managed": IT owns the version (MSI/MSIX/rpm/deb/pkg via SCCM/Intune/YUM/
//                Jamf), so the in-app check is DISABLED - never nag or hang offline.
// A new version downloads in the background; when it's ready we ask the user to
// restart. No-op in dev and safe when offline or when no newer release exists.
//
// macOS auto-update requires a SIGNED build (Squirrel.Mac refuses unsigned);
// Windows (NSIS) updates unsigned but SmartScreen may warn. See desktop/README.

import { app, BrowserWindow, dialog } from "electron";
import { autoUpdater } from "electron-updater";
import { updatePolicy } from "./managed_config.ts";
import { laneNames, updatePrompt, type UpdateCheck } from "./update_lanes.ts";

/** P-HOLDER.2 (ADR-0573): the engine's view of the lanes an update meets, and its stop of the ones the person chose
 *  (only those still idle or stuck). Null when the engine did not answer (the prompt then says nothing of lanes). */
export interface UpdateLaneDeps {
  check(): Promise<UpdateCheck | null>;
  stop(laneIds: string[]): Promise<{ stopped: string[] } | null>;
}

export function initAutoUpdate(getWindow: () => BrowserWindow | null, lanes?: UpdateLaneDeps): void {
  if (!app.isPackaged) return; // dev: no feed, would throw on missing config

  // ADR-A009 (#74): the managed-config update channel. "managed" disables the in-app check entirely so
  // a policy-managed / air-gapped fleet never makes an outbound update call or hangs waiting on one.
  const policy = updatePolicy();
  if (policy.channel === "managed") {
    console.log("[updater] channel=managed: in-app update check disabled (IT owns the version)");
    return;
  }

  autoUpdater.autoDownload = true;
  // P-HOLDER.2 (ADR-0573): never a silent install on quit. It ran with no look at the lanes, and a silent install
  // over files a running process holds can fail halfway (a local install on 2026-11-10 removed the old version and
  // left none). The update installs from the prompt below; "Later" leaves it for the prompt at a later launch.
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.logger = { info: console.log, warn: console.warn, error: console.error, debug: () => {} } as never;

  autoUpdater.on("error", (err) => console.warn("[updater] ", err?.message ?? err));

  autoUpdater.on("update-downloaded", async (info) => {
    const win = getWindow();
    const p = updatePrompt(info.version, lanes ? await lanes.check().catch(() => null) : null);
    const { response } = await dialog.showMessageBox(win ?? undefined!, {
      type: "info",
      buttons: p.choices.map((c) => c.label),
      defaultId: 0,
      cancelId: p.choices.length - 1,
      title: "Update ready",
      message: `LucidAgentIDE ${info.version} is ready to install.`,
      detail: p.detail,
    });
    const choice = p.choices[response];
    if (!choice?.install) return;
    if (choice.stop && lanes) {
      await lanes.stop(p.stop).catch(() => null);
      // Look again: a lane that started working meanwhile was kept, and one from the install folder blocks the install.
      const again = await lanes.check().catch(() => null);
      if (again?.lanes.some((l) => l.blocksInstall)) {
        await dialog.showMessageBox(win ?? undefined!, { type: "warning", buttons: ["OK"], title: "Update waits", message: "The update did not install.", detail: `${laneNames(again.lanes.filter((l) => l.blocksInstall))} still ${again.blocking === 1 ? "runs" : "run"} from the install folder. It is offered again at the next launch.` });
        return;
      }
    }
    setImmediate(() => autoUpdater.quitAndInstall());
  });

  // ADR-A009 (#74): "feed" points electron-updater's GENERIC provider at the customer-hosted mirror;
  // "github" leaves the package.json publish provider untouched (today's behavior).
  if (policy.channel === "feed" && policy.feedUrl) {
    try {
      autoUpdater.setFeedURL({ provider: "generic", url: policy.feedUrl });
      console.log(`[updater] channel=feed: internal mirror ${policy.feedUrl}`);
    } catch (e) {
      console.warn("[updater] feed URL rejected, falling back to default provider:", (e as Error)?.message ?? e);
    }
  }

  // Best-effort: a failed check (offline, no release yet) must never block launch.
  autoUpdater.checkForUpdates().catch((e) => console.warn("[updater] check failed:", e?.message ?? e));
}
