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

export function initAutoUpdate(getWindow: () => BrowserWindow | null): void {
  if (!app.isPackaged) return; // dev: no feed, would throw on missing config

  // ADR-A009 (#74): the managed-config update channel. "managed" disables the in-app check entirely so
  // a policy-managed / air-gapped fleet never makes an outbound update call or hangs waiting on one.
  const policy = updatePolicy();
  if (policy.channel === "managed") {
    console.log("[updater] channel=managed — in-app update check disabled (IT owns the version)");
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = { info: console.log, warn: console.warn, error: console.error, debug: () => {} } as never;

  autoUpdater.on("error", (err) => console.warn("[updater] ", err?.message ?? err));

  autoUpdater.on("update-downloaded", async (info) => {
    const win = getWindow();
    const { response } = await dialog.showMessageBox(win ?? undefined!, {
      type: "info",
      buttons: ["Restart now", "Later"],
      defaultId: 0,
      cancelId: 1,
      title: "Update ready",
      message: `LucidAgentIDE ${info.version} is ready to install.`,
      detail: "Restart to apply the update. Your session and credentials are kept.",
    });
    if (response === 0) {
      setImmediate(() => autoUpdater.quitAndInstall());
    }
  });

  // ADR-A009 (#74): "feed" points electron-updater's GENERIC provider at the customer-hosted mirror;
  // "github" leaves the package.json publish provider untouched (today's behavior).
  if (policy.channel === "feed" && policy.feedUrl) {
    try {
      autoUpdater.setFeedURL({ provider: "generic", url: policy.feedUrl });
      console.log(`[updater] channel=feed — internal mirror ${policy.feedUrl}`);
    } catch (e) {
      console.warn("[updater] feed URL rejected, falling back to default provider:", (e as Error)?.message ?? e);
    }
  }

  // Best-effort: a failed check (offline, no release yet) must never block launch.
  autoUpdater.checkForUpdates().catch((e) => console.warn("[updater] check failed:", e?.message ?? e));
}
