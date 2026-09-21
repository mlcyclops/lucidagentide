// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

import type { WebContents } from "electron";

/** The OS opener accepts absolute HTTP(S) URLs, never local files or protocol handlers. */
export function externalHttpUrl(value: unknown): string | null {
  if (typeof value !== "string" || /[\u0000-\u0020\u007f\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (!/^https?:\/\//i.test(value) || (url.protocol !== "http:" && url.protocol !== "https:")
      || !url.hostname || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}

/** One fail-closed boundary for IPC, direct links and window.open. Never leaks an OS rejection. */
export async function openExternalHttp(value: unknown, open: (url: string) => Promise<unknown>): Promise<boolean> {
  const url = externalHttpUrl(value);
  if (!url) return false;
  try { await open(url); return true; } catch { return false; }
}

type AppContents = Pick<WebContents, "on" | "setWindowOpenHandler" | "mainFrame" | "isDestroyed" | "loadURL">;

/** Install on the app window only, not the intentionally navigable agent browser. */
export function installAppNavigation(
  contents: AppContents,
  appUrl: string,
  open: (url: string) => Promise<unknown>,
  schedule: (callback: () => void) => void = (callback) => { setTimeout(callback, 1000); },
): void {
  const app = new URL(appUrl);
  let loaded = false;
  let retryPending = false;
  let retries = 0;
  const openOutsideApp = (value: unknown): void => {
    const url = externalHttpUrl(value);
    if (url && new URL(url).origin !== app.origin) void openExternalHttp(url, open);
  };

  contents.setWindowOpenHandler(({ url }) => {
    openOutsideApp(url);
    return { action: "deny" };
  });
  // loadURL (our startup entry) does not emit will-navigate. No document, including a
  // same-origin preview/API route, may replace the privileged renderer. Hashes do not emit it.
  contents.on("will-navigate", (event, url) => {
    event.preventDefault();
    if (event.initiator === contents.mainFrame) openOutsideApp(url);
  });
  // Only the host may assign a frame's src. Preview scripts/forms must not turn navigation
  // into unapproved network egress. The opaque sandbox and frame CSP remain unchanged.
  contents.on("will-frame-navigate", (event) => {
    if (!event.isMainFrame && event.initiator !== contents.mainFrame) event.preventDefault();
  });
  contents.on("will-redirect", (event) => {
    if (event.isMainFrame || event.initiator !== contents.mainFrame) event.preventDefault();
  });

  // A failed preview used to reload the entire app. Retry only a genuine startup failure,
  // never an aborted navigation, subframe, or a document after the app has become usable.
  contents.on("dom-ready", () => { loaded = true; });
  contents.on("did-finish-load", () => { loaded = true; });
  contents.on("did-fail-load", (_event, code, _description, failedUrl, isMainFrame) => {
    if (loaded || !isMainFrame || code === -3 || retryPending || retries >= 30
      || externalHttpUrl(failedUrl) !== app.href) return;
    retryPending = true;
    retries++;
    schedule(() => {
      retryPending = false;
      if (!loaded && !contents.isDestroyed()) void contents.loadURL(app.href).catch(() => {});
    });
  });
}
