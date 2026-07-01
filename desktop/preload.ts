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

contextBridge.exposeInMainWorld("lucid", {
  isElectron: true,
  setZoom: (factor: number) => { try { webFrame.setZoomFactor(factor); } catch { /* ignore */ } },
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke("lucid:pickFolder"),
  // P-NETWL.1 (ADR-0106): native FILE picker (auth config / token / PEM / API-key upload).
  pickFile: (opts?: { title?: string; filters?: { name: string; extensions: string[] }[] }): Promise<string | null> => ipcRenderer.invoke("lucid:pickFile", opts ?? {}),
  // P-NETWL.1 (ADR-0106): OS-encrypted credential vault (safeStorage). Store/list/delete only; a plaintext
  // secret never comes back to the renderer (decrypt is main-process-only).
  credStore: (input: { ref?: string; kind: string; secret: string; label?: string }) => ipcRenderer.invoke("lucid:credStore", input),
  credList: () => ipcRenderer.invoke("lucid:credList"),
  credDelete: (ref: string) => ipcRenderer.invoke("lucid:credDelete", ref),
  credEncryptionAvailable: (): Promise<boolean> => ipcRenderer.invoke("lucid:credEncryptionAvailable"),
  // P-PREVIEW.1 (ADR-0096): capture the preview region of the window → PNG data URL (main uses capturePage).
  capturePreview: (rect: { x: number; y: number; width: number; height: number }): Promise<string | null> => ipcRenderer.invoke("lucid:capturePreview", rect),
  revealPath: (path: string): Promise<boolean> => ipcRenderer.invoke("lucid:revealPath", path),
  win: {
    minimize: () => ipcRenderer.send("lucid:win", "minimize"),
    toggleMaximize: () => ipcRenderer.send("lucid:win", "toggleMaximize"),
    close: () => ipcRenderer.send("lucid:win", "close"),
  },
});
