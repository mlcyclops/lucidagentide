// desktop/updater.ts — in-app auto-update via electron-updater.
//
// Packaged builds check the GitHub Releases feed (publish provider in
// package.json) on launch. A new version downloads in the background; when it's
// ready we ask the user to restart. No-op in dev (no update feed) and safe when
// offline or when no newer release exists.
//
// macOS auto-update requires a SIGNED build (Squirrel.Mac refuses unsigned);
// Windows (NSIS) updates unsigned but SmartScreen may warn. See desktop/README.

import { app, BrowserWindow, dialog } from "electron";
import { autoUpdater } from "electron-updater";

export function initAutoUpdate(getWindow: () => BrowserWindow | null): void {
  if (!app.isPackaged) return; // dev: no feed, would throw on missing config

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

  // Best-effort: a failed check (offline, no release yet) must never block launch.
  autoUpdater.checkForUpdates().catch((e) => console.warn("[updater] check failed:", e?.message ?? e));
}
