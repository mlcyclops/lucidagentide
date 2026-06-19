// desktop/main.ts — Electron main process for LucidAgentIDE.
//
// Thin shell: it spawns the Bun dev server (desktop/dev.ts) — which serves the
// renderer, the read-only dashboards, AND a real omp-ACP chat backend
// (desktop/acp_backend.ts, with the security gate loaded) — then loads it in a
// frameless window. Chat/config/data all flow over HTTP from that server, so the
// browser build and the desktop app share one real backend. The preload only
// adds native window controls + crisp zoom.

import { app, BrowserWindow, ipcMain } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.LUCID_PORT ?? 5319);
let REPO = "";
const preloadPath = () => join(app.getAppPath(), "dist", "preload.js");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function bin(name: string): string {
  for (const c of [join(homedir(), ".bun", "bin", `${name}.exe`), join(homedir(), ".bun", "bin", name)]) if (existsSync(c)) return c;
  return name;
}

let win: BrowserWindow | null = null;
let dev: ChildProcess | null = null;

function startDevServer(): void {
  dev = spawn(bin("bun"), ["run", "desktop/dev.ts"], { cwd: REPO, env: { ...process.env, PORT: String(PORT) }, stdio: "inherit" });
}
async function waitForServer(timeoutMs = 12000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://localhost:${PORT}/api/health`)).ok) return; } catch { /* retry */ }
    await sleep(180);
  }
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1320, height: 860, minWidth: 940, minHeight: 600,
    frame: false, backgroundColor: "#0a0b0f", show: false, title: "LucidAgentIDE",
    webPreferences: { preload: preloadPath(), contextIsolation: true, nodeIntegration: false },
  });
  win.once("ready-to-show", () => win!.show());
  win.loadURL(`http://localhost:${PORT}`);
  win.on("closed", () => (win = null));
}

ipcMain.on("lucid:win", (e, action: string) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w) return;
  if (action === "minimize") w.minimize();
  else if (action === "toggleMaximize") w.isMaximized() ? w.unmaximize() : w.maximize();
  else if (action === "close") w.close();
});

app.whenReady().then(async () => {
  REPO = join(app.getAppPath(), "..");
  startDevServer();
  await waitForServer();
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("quit", () => { dev?.kill(); });
