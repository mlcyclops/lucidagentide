// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/preload.ts - the native shell exposed to the renderer (contextIsolated).
//
// Chat, dashboards, and session config all flow over the dev server's HTTP API
// (which is backed by a real omp ACP session - see desktop/acp_backend.ts), so
// the only things the renderer needs from Electron are crisp text zoom
// (webFrame) and native window controls. In a plain browser, window.lucid is
// absent and the renderer falls back to CSS zoom.

import { contextBridge, ipcRenderer, webFrame } from "electron";
import { marketBootConfig } from "./market_config.ts";

// ADR-0223 (completes P-KGMARKET, ADR-0206): expose the marketplace boot config to the renderer's main world so
// market_boot.ts (readMarketBootConfig → globalThis.__LUCID_MARKET__) can register the real Stripe/Firebase
// entitlement provider. Without this the storefront's "Get pack" only opens the product page. A plain browser
// build has no preload → __LUCID_MARKET__ stays unset → fail-closed "off" (storefront hint), unchanged.
contextBridge.exposeInMainWorld("__LUCID_MARKET__", marketBootConfig());

contextBridge.exposeInMainWorld("lucid", {
  isElectron: true,
  setZoom: (factor: number) => { try { webFrame.setZoomFactor(factor); } catch { /* ignore */ } },
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke("lucid:pickFolder"),
  // P-NETWL.1 (ADR-0106): native FILE picker (auth config / token / PEM / API-key upload).
  pickFile: (opts?: { title?: string; filters?: { name: string; extensions: string[] }[] }): Promise<string | null> => ipcRenderer.invoke("lucid:pickFile", opts ?? {}),
  // P-NETWL.1 (ADR-0106): OS-encrypted credential vault (safeStorage). Store/list/delete only; a plaintext
  // secret never comes back to the renderer (decrypt is main-process-only).
  credStore: (input: { ref?: string; kind: string; secret: string; label?: string }) => ipcRenderer.invoke("lucid:credStore", input),
  credStoreFile: (input: { kind: string; label?: string; expiresAt?: number; rotationIntervalDays?: number }) => ipcRenderer.invoke("lucid:credStoreFile", input),
  credRotate: (input: { ref: string; secret: string; expiresAt?: number }) => ipcRenderer.invoke("lucid:credRotate", input),
  credRotateFile: (input: { ref: string }) => ipcRenderer.invoke("lucid:credRotateFile", input),
  credList: () => ipcRenderer.invoke("lucid:credList"),
  credDelete: (ref: string) => ipcRenderer.invoke("lucid:credDelete", ref),
  credEncryptionAvailable: (): Promise<boolean> => ipcRenderer.invoke("lucid:credEncryptionAvailable"),
  // P-PREVIEW.1 (ADR-0096): capture the preview region of the window → PNG data URL (main uses capturePage).
  capturePreview: (rect: { x: number; y: number; width: number; height: number }): Promise<string | null> => ipcRenderer.invoke("lucid:capturePreview", rect),
  // Open an external http(s) URL in the OS default browser (OAuth sign-in) — reliable path that doesn't
  // depend on the renderer's window.open reaching setWindowOpenHandler.
  openExternal: (url: string): Promise<boolean> => ipcRenderer.invoke("lucid:openExternal", url),
  revealPath: (path: string): Promise<boolean> => ipcRenderer.invoke("lucid:revealPath", path),
  // P-FSREVEAL.1 (ADR-0212): reveal a file highlighted in its parent folder (native file manager).
  showInFolder: (path: string): Promise<boolean> => ipcRenderer.invoke("lucid:showInFolder", path),
  // P-LOCAL.3 polish: restart the app so a freshly-spawned omp picks up new/changed local providers.
  relaunch: (): Promise<void> => ipcRenderer.invoke("lucid:relaunch"),
  // P-KGMARKET.4 (ADR-0206): the OS forwards the lucid://auth?token=... deep link (after hosted marketplace
  // sign-in) to the main process, which relays it here for market_boot.handleAuthCallback.
  onAuthCallback: (cb: (url: string) => void): void => { ipcRenderer.on("lucid:authCallback", (_e, url: string) => cb(url)); },
  win: {
    minimize: () => ipcRenderer.send("lucid:win", "minimize"),
    toggleMaximize: () => ipcRenderer.send("lucid:win", "toggleMaximize"),
    close: () => ipcRenderer.send("lucid:win", "close"),
  },
});
