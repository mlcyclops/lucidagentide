// desktop/main.ts - Electron main process for LucidAgentIDE.
//
// Thin shell: it spawns the Bun dev server (desktop/dev.ts) - which serves the
// renderer, the read-only dashboards, AND a real omp-ACP chat backend
// (desktop/acp_backend.ts, with the security gate loaded) - then loads it in a
// frameless window. Chat/config/data all flow over HTTP from that server, so the
// browser build and the desktop app share one real backend. The preload only
// adds native window controls + crisp zoom.

import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { initAutoUpdate } from "./updater.ts";
import { ensureRuntimes, findBun, needsBootstrap } from "./runtime.ts";
import { createSplash, setSplashStatus } from "./splash.ts";

const PORT = Number(process.env.LUCID_PORT ?? 5319);
let REPO = "";
const preloadPath = () => join(app.getAppPath(), "dist", "preload.js");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let win: BrowserWindow | null = null;
let dev: ChildProcess | null = null;
let runtimeEnv: Record<string, string> = {};

function startDevServer(): void {
  // findBun() prefers the bundled runtime in packaged builds, falling back to the
  // user's bun. runtimeEnv carries LUCID_OMP_BIN / SCANNER_PYTHON / PATH down to
  // the dev server and its omp + scanner children.
  dev = spawn(findBun(), ["run", "desktop/dev.ts"], {
    cwd: REPO,
    env: { ...process.env, ...runtimeEnv, PORT: String(PORT) },
    // NOT "inherit": in a packaged GUI app the Electron main has no console, so inheriting
    // makes the console-subsystem Bun allocate its OWN console window (the black pop-up).
    // Pipe instead + windowsHide so no window ever appears; forward output for dev runs.
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  dev.stdout?.on("data", (d) => process.stdout.write(d));
  dev.stderr?.on("data", (d) => process.stderr.write(d));
}
// Returns true once the dev server answers /api/health, false if it never does within the window.
// 30s headroom: the server's own init (DuckDB open + omp acp spawn) can outlast a slow first launch;
// the splash already covered the longer omp/scanner provisioning before we got here.
async function waitForServer(timeoutMs = 30000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://localhost:${PORT}/api/health`)).ok) return true; } catch { /* retry */ }
    await sleep(180);
  }
  return false;
}

function createWindow(): void {
  // Runtime window icon (taskbar/dev). Packaged Win/mac use the exe/app icon
  // baked in by electron-builder; this covers the dev run and Linux.
  const iconPath = join(app.getAppPath(), "build", "icon.png");
  win = new BrowserWindow({
    width: 1320, height: 860, minWidth: 940, minHeight: 600,
    frame: false, backgroundColor: "#0a0b0f", show: false, title: "LucidAgentIDE",
    ...(existsSync(iconPath) ? { icon: iconPath } : {}),
    webPreferences: { preload: preloadPath(), contextIsolation: true, nodeIntegration: false },
  });
  win.once("ready-to-show", () => win!.show());
  // external links (e.g. duckdb.org) open in the OS browser, not a new Electron window
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: "deny" }; });
  // If the dev server isn't answering yet (slow first launch), the load fails — retry a bounded number
  // of times so a late-ready server self-heals into a rendered window instead of a permanent black one.
  let reloadTries = 0;
  win.webContents.on("did-fail-load", () => {
    if (reloadTries++ < 30) setTimeout(() => win?.loadURL(`http://localhost:${PORT}`), 1000);
  });
  win.loadURL(`http://localhost:${PORT}`);
  win.on("closed", () => (win = null));
}

ipcMain.handle("lucid:pickFolder", async (e) => {
  const w = BrowserWindow.fromWebContents(e.sender) ?? undefined;
  const r = await dialog.showOpenDialog(w!, { properties: ["openDirectory"], title: "Choose a workspace folder" });
  return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
});

// Reveal an export location in the OS file manager (#115). Only opens a path that actually exists, so a
// stray/forged request can't probe the filesystem. shell.openPath returns "" on success, else an error.
ipcMain.handle("lucid:revealPath", async (_e, p: unknown) => {
  const target = typeof p === "string" ? p : "";
  if (!target || !existsSync(target)) return false;
  return (await shell.openPath(target)) === "";
});

ipcMain.on("lucid:win", (e, action: string) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w) return;
  if (action === "minimize") w.minimize();
  else if (action === "toggleMaximize") w.isMaximized() ? w.unmaximize() : w.maximize();
  else if (action === "close") w.close();
});

app.whenReady().then(async () => {
  // Dev: repo is the parent of desktop/. Packaged: the repo is bundled into
  // Resources/repo (electron-builder extraResources) so bun/omp can run it.
  REPO = app.isPackaged ? join(process.resourcesPath, "repo") : join(app.getAppPath(), "..");

  // First-run setup: install omp + provision the scanner interpreter using the
  // bundled bun/uv. Only shows a splash when there's actually work to do, so a
  // provisioned/dev machine launches straight through.
  const splash = needsBootstrap() ? createSplash() : null;
  try {
    runtimeEnv = await ensureRuntimes((s) => setSplashStatus(splash, s));
  } catch (e) {
    console.warn("[main] runtime bootstrap failed (continuing):", (e as Error).message);
  }

  startDevServer();
  const serverUp = await waitForServer();
  createWindow();
  splash?.close();
  // Don't leave the user staring at a black window with no explanation: if the local engine never
  // came up (e.g. no usable bun runtime), say so. The window keeps retrying via did-fail-load, so a
  // late start still recovers; this only fires when it genuinely failed to answer in time.
  if (!serverUp) {
    dialog.showErrorBox(
      "LucidAgentIDE could not start its local engine",
      `The bundled background service did not respond on port ${PORT} within 30 seconds, so the window ` +
        `may stay blank.\n\nThis usually means the bundled runtime is missing or was blocked. The app ` +
        `will keep retrying — if it stays blank, reinstall the latest release, or relaunch from a ` +
        `terminal to see the startup log.`,
    );
  }
  initAutoUpdate(() => win); // packaged-only; checks GitHub Releases, prompts on download
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("quit", () => { dev?.kill(); });
