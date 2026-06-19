// desktop/preload.ts — the native shell exposed to the renderer (contextIsolated).
//
// Chat, dashboards, and session config all flow over the dev server's HTTP API
// (which is backed by a real omp ACP session — see desktop/acp_backend.ts), so
// the only things the renderer needs from Electron are crisp text zoom
// (webFrame) and native window controls. In a plain browser, window.lucid is
// absent and the renderer falls back to CSS zoom.

import { contextBridge, ipcRenderer, webFrame } from "electron";

contextBridge.exposeInMainWorld("lucid", {
  isElectron: true,
  setZoom: (factor: number) => { try { webFrame.setZoomFactor(factor); } catch { /* ignore */ } },
  win: {
    minimize: () => ipcRenderer.send("lucid:win", "minimize"),
    toggleMaximize: () => ipcRenderer.send("lucid:win", "toggleMaximize"),
    close: () => ipcRenderer.send("lucid:win", "close"),
  },
});
