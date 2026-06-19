// desktop/preload.ts — the only bridge exposed to the renderer (contextIsolated).
// Implements the LucidBridge shape (renderer/bridge.ts): dashboards over the local
// HTTP API (read-only), chat + live session config over real omp ACP via IPC,
// native text zoom via webFrame, and window controls. When present the renderer
// uses it; in a plain browser it falls back to fetch + a simulated chat.

import { contextBridge, ipcRenderer, webFrame } from "electron";
import { randomUUID } from "node:crypto";

type ChatEvent =
  | { type: "token"; text: string }
  | { type: "tool"; name: string; detail: string }
  | { type: "block"; tool: string; reason: string; severity: string; findings: string }
  | { type: "usage"; used: number; size: number; cost: number }
  | { type: "done" };

const getData = (path: string) =>
  fetch(path, { cache: "no-store" }).then((r) => r.json()).then((j) => j?.data ?? null).catch(() => null);

contextBridge.exposeInMainWorld("lucid", {
  isElectron: true,
  security: () => getData("/api/security"),
  memory: () => getData("/api/memory"),
  config: () => ipcRenderer.invoke("lucid:config"),
  setConfig: (configId: string, value: string) => ipcRenderer.invoke("lucid:setConfig", { configId, value }),
  commands: () => ipcRenderer.invoke("lucid:commands"),
  newSession: () => ipcRenderer.invoke("lucid:newSession"),
  setZoom: (factor: number) => { try { webFrame.setZoomFactor(factor); } catch { /* ignore */ } },
  win: {
    minimize: () => ipcRenderer.send("lucid:win", "minimize"),
    toggleMaximize: () => ipcRenderer.send("lucid:win", "toggleMaximize"),
    close: () => ipcRenderer.send("lucid:win", "close"),
  },
  sendPrompt: (text: string, onEvent: (e: ChatEvent) => void): Promise<void> =>
    new Promise((resolve) => {
      const id = randomUUID();
      const ch = `lucid:chat:${id}`;
      const handler = (_e: unknown, evt: ChatEvent) => {
        onEvent(evt);
        if (evt.type === "done") { ipcRenderer.removeListener(ch, handler); resolve(); }
      };
      ipcRenderer.on(ch, handler);
      ipcRenderer.send("lucid:prompt", { id, text });
    }),
});
