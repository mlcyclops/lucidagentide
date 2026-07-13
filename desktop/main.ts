// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/main.ts - Electron main process for LucidAgentIDE.
//
// Thin shell: it spawns the Bun dev server (desktop/dev.ts) - which serves the
// renderer, the read-only dashboards, AND a real omp-ACP chat backend
// (desktop/acp_backend.ts, with the security gate loaded) - then loads it in a
// frameless window. Chat/config/data all flow over HTTP from that server, so the
// browser build and the desktop app share one real backend. The preload only
// adds native window controls + crisp zoom.

import { app, BrowserWindow, dialog, ipcMain, Menu, safeStorage, shell } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { initAutoUpdate } from "./updater.ts";
import { ensureRuntimes, findBun, needsBootstrap } from "./runtime.ts";
import { createSplash, setSplashStatus } from "./splash.ts";
import { deleteCredential, listCredentials, readCredential, rotateCredential, storeCredential, type SafeStorageLike, type VaultIo } from "./cred_vault.ts";
import { materializeLocalProviders, registerLocalProviderEgress } from "./local_providers_runtime.ts";
import { listLocalProviders } from "./settings_store.ts";
import type { AuthKind } from "./network_whitelist.ts";

const PORT = Number(process.env.LUCID_PORT ?? 5319);
let REPO = "";
const preloadPath = () => join(app.getAppPath(), "dist", "preload.js");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let win: BrowserWindow | null = null;
let dev: ChildProcess | null = null;
let runtimeEnv: Record<string, string> = {};

// ── P-KGMARKET.4 (ADR-0206): lucid://auth deep link for hosted marketplace sign-in ──────────────────
// After the user signs in on the hosted page, the browser redirects to lucid://auth?token=...; the OS hands
// that URL to this app, which forwards it to the renderer (market_boot.handleAuthCallback). On Windows/Linux a
// cold or second launch delivers it as an argv entry (caught by the single-instance handler); on macOS it
// arrives via "open-url". A URL that lands before the window is ready is queued and flushed on did-finish-load.
const AUTH_PROTOCOL = "lucid";
let pendingAuthUrl: string | null = null;
const firstAuthUrl = (argv: string[]): string | null => argv.find((a) => a.startsWith(`${AUTH_PROTOCOL}://`)) ?? null;
function forwardAuthUrl(url: string | null): void {
  if (!url) return;
  if (win && !win.webContents.isLoading()) win.webContents.send("lucid:authCallback", url);
  else pendingAuthUrl = url; // deliver once the renderer has loaded
}

// ADR-0177: the engine's startup output is TEED to a log file, so a boot failure diagnoses itself.
// The v1.10.2 brick (a packaging filter stripped a runtime-imported file) was only debuggable by
// relaunching from a terminal - now the crash text is sitting in engine.log for the error dialog to
// point at. Best-effort: a failed tee never blocks the engine.
const engineLogPath = (): string => join(app.getPath("userData"), "engine.log");
function openEngineLog(): ((d: unknown) => void) {
  try {
    const s = createWriteStream(engineLogPath(), { flags: "a" });
    s.write(`\n--- engine start ${new Date().toISOString()} · v${app.getVersion()}${app.isPackaged ? " (packaged)" : " (dev)"} ---\n`);
    return (d) => { try { s.write(d as Buffer); } catch { /* never block the engine */ } };
  } catch { return () => { }; }
}

function startDevServer(): void {
  // findBun() prefers the bundled runtime in packaged builds, falling back to the
  // user's bun. runtimeEnv carries LUCID_OMP_BIN / SCANNER_PYTHON / PATH down to
  // the dev server and its omp + scanner children.
  // P-LOCAL.2 (ADR-0135): the omp acp runs in this dev child, but the OS-encrypted vault (safeStorage) is
  // main-only. So MAIN materializes the Local Providers here — writes omp's ~/.omp/agent/models.yml and
  // resolves each provider's secret from the vault — and injects the keys into the dev child's env (models.yml
  // holds only the env-var NAME; omp resolves it from this env). Best-effort: never blocks the server start.
  const lpEnv = prepareLocalProviders();
  // P-FIGMA.1 (ADR-0154): the Figma PAT lives in the OS-encrypted vault (main-only). Inject it into the dev
  // child as LUCID_FIGMA_TOKEN so /api/figma/import can call api.figma.com server-side — the key never reaches
  // the renderer or the agent. (A freshly-entered token is passed in the first import request; this covers
  // subsequent sessions.) Best-effort — never blocks the server start.
  const figmaEnv = prepareFigmaToken();
  dev = spawn(findBun(), ["run", "desktop/dev.ts"], {
    cwd: REPO,
    env: { ...process.env, ...runtimeEnv, ...lpEnv, ...figmaEnv, PORT: String(PORT) },
    // NOT "inherit": in a packaged GUI app the Electron main has no console, so inheriting
    // makes the console-subsystem Bun allocate its OWN console window (the black pop-up).
    // Pipe instead + windowsHide so no window ever appears; forward output for dev runs.
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const tee = openEngineLog();
  dev.stdout?.on("data", (d) => { process.stdout.write(d); tee(d); });
  dev.stderr?.on("data", (d) => { process.stderr.write(d); tee(d); });
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
  // Spell-check suggestions: Electron's spellchecker underlines misspellings but the app must build the
  // correction menu itself. Only intercept when there's a misspelled word (so we don't fight Monaco's own
  // context menu elsewhere); offer the dictionary suggestions + "Add to dictionary".
  win.webContents.on("context-menu", (_e, params) => {
    if (!params.misspelledWord) return;
    const suggestions = params.dictionarySuggestions.slice(0, 6);
    const template: Electron.MenuItemConstructorOptions[] = suggestions.length
      ? suggestions.map((s) => ({ label: s, click: () => win?.webContents.replaceMisspelling(s) }))
      : [{ label: "No suggestions", enabled: false }];
    template.push(
      { type: "separator" },
      { label: "Add to dictionary", click: () => win?.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord) },
    );
    Menu.buildFromTemplate(template).popup({ window: win ?? undefined });
  });
  // external links (e.g. duckdb.org) open in the OS browser, not a new Electron window
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: "deny" }; });
  // If the dev server isn't answering yet (slow first launch), the load fails — retry a bounded number
  // of times so a late-ready server self-heals into a rendered window instead of a permanent black one.
  let reloadTries = 0;
  win.webContents.on("did-fail-load", () => {
    if (reloadTries++ < 30) setTimeout(() => win?.loadURL(`http://localhost:${PORT}`), 1000);
  });
  // P-KGMARKET.4: once the renderer is up, flush any lucid://auth URL that arrived during a cold launch.
  win.webContents.on("did-finish-load", () => {
    if (pendingAuthUrl) { win?.webContents.send("lucid:authCallback", pendingAuthUrl); pendingAuthUrl = null; }
  });
  win.loadURL(`http://localhost:${PORT}`);
  win.on("closed", () => (win = null));
}

ipcMain.handle("lucid:pickFolder", async (e) => {
  const w = BrowserWindow.fromWebContents(e.sender) ?? undefined;
  // Native OS folder dialog: browse anywhere on the machine and CREATE a new folder from within the dialog.
  // `createDirectory` enables the New Folder button on macOS (Windows always offers it); the whole tree is
  // reachable (no home confinement).
  const r = await dialog.showOpenDialog(w!, { properties: ["openDirectory", "createDirectory"], title: "Choose or create a workspace folder" });
  return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
});

// P-NETWL.1 (ADR-0106): native FILE picker for uploading an auth config / token / PEM / API-key file. Like
// pickFolder, it uses the real OS dialog (reach anywhere), and returns the chosen path or null on cancel.
// Optional filters/title come from the renderer; unknown shapes fall back to "all files".
ipcMain.handle("lucid:pickFile", async (e, opts: unknown) => {
  const w = BrowserWindow.fromWebContents(e.sender) ?? undefined;
  const o = (opts ?? {}) as { title?: unknown; filters?: unknown };
  const filters = Array.isArray(o.filters) ? (o.filters as { name: string; extensions: string[] }[]) : undefined;
  const r = await dialog.showOpenDialog(w!, {
    properties: ["openFile"],
    title: typeof o.title === "string" ? o.title : "Choose a file",
    ...(filters ? { filters } : {}),
  });
  return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
});

// P-NETWL.1 (ADR-0106): the OS-encrypted credential vault (cred_vault.ts) lives in the main process because
// Electron's safeStorage is main-only. The renderer can STORE, LIST, and DELETE secrets; it can never READ a
// plaintext back (decrypt stays here, for future request injection). storeCredential FAIL-CLOSES if OS
// encryption is unavailable - the handler surfaces { error } rather than ever writing plaintext.
const CRED_DIR = () => join(homedir(), ".omp", "lucid-cred-vault");
const ELECTRON_SAFE_STORAGE: SafeStorageLike = {
  isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
  encryptString: (s) => safeStorage.encryptString(s),
  decryptString: (b) => safeStorage.decryptString(b),
};
const VAULT_IO: VaultIo = {
  ensureDir: (dir) => mkdirSync(dir, { recursive: true }),
  writeFile: (p, data) => writeFileSync(p, data, { mode: 0o600 }),
  readFile: (p) => readFileSync(p),
  exists: (p) => existsSync(p),
  remove: (p) => rmSync(p, { force: true }),
  list: (dir) => (existsSync(dir) ? readdirSync(dir) : []),
};
// P-LOCAL.2 (ADR-0135): materialize the Local Providers for the omp child. Reads each declared provider's
// secret from the OS-encrypted vault (main-only), writes omp's models.yml (env-var references, never the
// secret), registers each endpoint in the network whitelist, and returns { ENV_VAR: secret } to inject into
// the dev-server child env so the omp grandchild can resolve them. Fail-soft: any error yields {} and the
// server still starts (authed local providers simply won't be available until fixed).
function prepareLocalProviders(): Record<string, string> {
  try {
    const defs = listLocalProviders();
    if (defs.length === 0) return {};
    const r = materializeLocalProviders({
      defs,
      readSecret: (ref) => { try { return readCredential(ELECTRON_SAFE_STORAGE, VAULT_IO, CRED_DIR(), ref); } catch { return null; } },
    });
    try { registerLocalProviderEgress(defs, Date.now()); } catch { /* egress registration is best-effort */ }
    if (r.wrote) console.error(`[LOCAL_PROVIDERS] ${r.included.length} provider(s) → ~/.omp/agent/models.yml${r.skipped.length ? `; skipped ${r.skipped.map((s) => s.id).join(", ")}` : ""}`);
    else if (r.writeReason) console.error(`[LOCAL_PROVIDERS] models.yml not written: ${r.writeReason}`);
    return r.childEnv;
  } catch (err) { console.error("[LOCAL_PROVIDERS] prepare failed:", err); return {}; }
}
// P-FIGMA.1 (ADR-0154): read the Figma PAT from the vault (ref "figma_pat") and expose it to the dev child as
// LUCID_FIGMA_TOKEN, so the Figma REST calls happen server-side without the secret ever reaching the renderer.
const FIGMA_PAT_REF = "figma_pat";
function prepareFigmaToken(): Record<string, string> {
  try {
    const tok = readCredential(ELECTRON_SAFE_STORAGE, VAULT_IO, CRED_DIR(), FIGMA_PAT_REF);
    return tok ? { LUCID_FIGMA_TOKEN: tok } : {};
  } catch { return {}; }
}
ipcMain.handle("lucid:credStore", (_e, input: { ref?: string; kind: AuthKind; secret: string; label?: string; expiresAt?: number; rotationIntervalDays?: number }) => {
  try { return storeCredential(ELECTRON_SAFE_STORAGE, VAULT_IO, CRED_DIR(), { ...input, createdAt: Date.now() }); }
  catch (err) { return { error: (err as Error)?.message ?? String(err) }; }
});
// P-KEYS.2 (ADR-0107): rotate a stored secret IN PLACE (same ref), by paste or by file. Fail-closed: throws
// (surfaced as {error}) if OS encryption is unavailable, leaving the old secret intact; the secret bytes for
// the file path are read + re-encrypted in main, never crossing to the renderer.
ipcMain.handle("lucid:credRotate", (_e, input: { ref: string; secret: string; expiresAt?: number }) => {
  try { return rotateCredential(ELECTRON_SAFE_STORAGE, VAULT_IO, CRED_DIR(), { ...input, rotatedAt: Date.now() }) ?? { error: "not-found" }; }
  catch (err) { return { error: (err as Error)?.message ?? String(err) }; }
});
ipcMain.handle("lucid:credRotateFile", async (e, input: { ref: string }) => {
  try {
    const w = BrowserWindow.fromWebContents(e.sender) ?? undefined;
    const r = await dialog.showOpenDialog(w!, {
      properties: ["openFile"],
      title: "Choose the new secret file (rotation)",
      filters: [{ name: "Keys & tokens", extensions: ["pem", "key", "crt", "cer", "jwt", "json", "txt", "token"] }, { name: "All files", extensions: ["*"] }],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const secret = readFileSync(r.filePaths[0], "utf8");
    return rotateCredential(ELECTRON_SAFE_STORAGE, VAULT_IO, CRED_DIR(), { ref: input.ref, secret, rotatedAt: Date.now() }) ?? { error: "not-found" };
  } catch (err) { return { error: (err as Error)?.message ?? String(err) }; }
});
ipcMain.handle("lucid:credList", () => { try { return listCredentials(VAULT_IO, CRED_DIR()); } catch { return []; } });
ipcMain.handle("lucid:credDelete", (_e, ref: unknown) => { try { return deleteCredential(VAULT_IO, CRED_DIR(), typeof ref === "string" ? ref : ""); } catch { return false; } });
ipcMain.handle("lucid:credEncryptionAvailable", () => { try { return safeStorage.isEncryptionAvailable(); } catch { return false; } });
// P-NETWL.2 (ADR-0106): upload an auth file (token / PEM / API-key / config) straight into the vault. The
// file is picked + read + encrypted ENTIRELY in main - the secret bytes never cross to the renderer (unlike a
// paste flow). Returns the credential metadata (+ the source filename as a default label) or { error }.
ipcMain.handle("lucid:credStoreFile", async (e, input: { kind: AuthKind; label?: string; expiresAt?: number; rotationIntervalDays?: number }) => {
  try {
    const w = BrowserWindow.fromWebContents(e.sender) ?? undefined;
    const r = await dialog.showOpenDialog(w!, {
      properties: ["openFile"],
      title: "Choose an auth file (token / PEM / API key / config)",
      filters: [{ name: "Keys & tokens", extensions: ["pem", "key", "crt", "cer", "jwt", "json", "txt", "token"] }, { name: "All files", extensions: ["*"] }],
    });
    if (r.canceled || !r.filePaths[0]) return null; // user cancelled
    const p = r.filePaths[0];
    const secret = readFileSync(p, "utf8");
    const label = input.label && input.label.trim() ? input.label : p.replace(/^.*[\\/]/, ""); // default label = filename
    return storeCredential(ELECTRON_SAFE_STORAGE, VAULT_IO, CRED_DIR(), { kind: input.kind, secret, label, createdAt: Date.now(), expiresAt: input.expiresAt, rotationIntervalDays: input.rotationIntervalDays });
  } catch (err) { return { error: (err as Error)?.message ?? String(err) }; }
});

// P-PREVIEW.1 (ADR-0096): capture the preview region of the window into a PNG data URL. Crops the live
// window capture to the iframe's rect (sent by the renderer), so the agent/user gets just the previewed
// page. Metadata-safe (shows only what is already on screen); returns null on any failure, never throws.
ipcMain.handle("lucid:capturePreview", async (e, rect: unknown) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w) return null;
  const r = (rect ?? {}) as { x?: unknown; y?: unknown; width?: unknown; height?: unknown };
  const n = (v: unknown) => (typeof v === "number" && isFinite(v) && v >= 0 ? Math.round(v) : 0);
  const crop = { x: n(r.x), y: n(r.y), width: n(r.width), height: n(r.height) };
  try {
    const img = crop.width > 0 && crop.height > 0 ? await w.webContents.capturePage(crop) : await w.webContents.capturePage();
    return img.isEmpty() ? null : img.toDataURL();
  } catch { return null; }
});

// Reveal an export location in the OS file manager (#115). Only opens a path that actually exists, so a
// stray/forged request can't probe the filesystem. shell.openPath returns "" on success, else an error.
ipcMain.handle("lucid:revealPath", async (_e, p: unknown) => {
  const target = typeof p === "string" ? p : "";
  if (!target || !existsSync(target)) return false;
  return (await shell.openPath(target)) === "";
});

// P-FSREVEAL.1 (ADR-0212): reveal a FILE (or folder) in the OS file manager, HIGHLIGHTED in its parent
// folder — so a file the agent just wrote/edited is one click from the chat feed to Finder/Explorer/Files,
// no digging through the tree. `showItemInFolder` opens the containing folder with the item selected. Only
// an existing path is honored (a stray/forged request can't probe the filesystem).
ipcMain.handle("lucid:showInFolder", async (_e, p: unknown) => {
  const target = typeof p === "string" ? p : "";
  if (!target || !existsSync(target)) return false;
  shell.showItemInFolder(target);
  return true;
});

// P-LOCAL.3 polish: restart the app so the freshly-spawned dev server + omp pick up the current Local
// Providers (their secrets are injected into the dev child env at spawn — a restart is the clean apply).
ipcMain.handle("lucid:relaunch", () => {
  try { dev?.kill(); } catch { /* best-effort */ }
  app.relaunch();
  app.quit();
});

ipcMain.on("lucid:win", (e, action: string) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w) return;
  if (action === "minimize") w.minimize();
  else if (action === "toggleMaximize") w.isMaximized() ? w.unmaximize() : w.maximize();
  else if (action === "close") w.close();
});

// P-KGMARKET.4 (ADR-0206): claim the lucid:// scheme and enforce a single instance so a deep-link launch
// re-focuses the running app and hands it the URL (rather than spawning a second engine).
if (process.defaultApp && process.argv.length >= 2) {
  app.setAsDefaultProtocolClient(AUTH_PROTOCOL, process.execPath, [resolve(process.argv[1]!)]); // dev
} else {
  app.setAsDefaultProtocolClient(AUTH_PROTOCOL); // packaged
}
pendingAuthUrl = firstAuthUrl(process.argv); // a cold launch may already carry the URL
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", (_e, argv) => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
    forwardAuthUrl(firstAuthUrl(argv));
  });
  app.on("open-url", (_e, url) => forwardAuthUrl(url)); // macOS delivers the deep link here

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
        `may stay blank.\n\nThe engine's own startup output (including any crash message) is in:\n` +
        `${engineLogPath()}\n\nThe app will keep retrying — if it stays blank, send that log file to ` +
        `support or reinstall the latest release.`,
    );
  }
  initAutoUpdate(() => win); // packaged-only; checks GitHub Releases, prompts on download
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
} // end single-instance guard (P-KGMARKET.4)
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("quit", () => { dev?.kill(); });
