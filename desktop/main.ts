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
import { randomBytes } from "node:crypto";
import { appendFileSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { initAutoUpdate } from "./updater.ts";
import { ensureRuntimes, findBun, needsBootstrap } from "./runtime.ts";
import { createSplash, setSplashStatus } from "./splash.ts";
import { deleteCredential, listCredentials, readCredential, rotateCredential, storeCredential, type SafeStorageLike, type VaultIo } from "./cred_vault.ts";
import { bestEngineLine, classifyEngineFailure, isProtectedInstallRoot, probeDirWritable, type WriteProbe } from "./engine_boot.ts";
import { resolveEngineSpawn } from "./engine_launch.ts"; // P-WINBOOT.2 (ADR-0260): prefer the compiled engine binary
import { materializeLocalProviders, registerLocalProviderEgress } from "./local_providers_runtime.ts";
import { GPU_SANDBOX_FLAG_FILE, GPU_SANDBOX_SWITCH, decideGpuAction, gpuDeathLogLine, relaunchArgs } from "./gpu_watchdog.ts";
import { backfillCanonicalFromInstance, seedInstanceFromCanonical } from "./oscrypt_seed.ts"; // one safeStorage key across port-keyed instances
import { listLocalProviders, embeddingsConfig } from "./settings_store.ts";
import type { AuthKind } from "./network_whitelist.ts";
import { gitEnvNameFromRef } from "./git_url.ts"; // P-FLEET.L2: host-scoped git creds, vault ref -> env name
import { parseKeyCombo } from "./browser_keys.ts"; // P-BROWSER.2: agent key combos, parsed by one shared rule
import { flavorInfo, resolveBuildFlavor } from "./build_flavor.ts"; // CREATOR-0 (ADR-0279): the product-line identity

// CREATOR-0 (ADR-0279): resolve the BUILD FLAVOR before anything reads an identity-derived path.
// Order: an explicit env var (launcher / dev run), then the packaged package.json's `lucidBuildFlavor`
// (electron-builder extraMetadata), then the standard Agent build. Renaming the app is what actually
// separates the two products on disk (userData, the single-instance lock, and the Windows os_crypt key
// all key on the app name), so it happens FIRST and only for the Creator flavor - the standard build's
// paths must not move by a single byte.
const packagedBuildFlavor = ((): string => {
  try {
    const meta = JSON.parse(readFileSync(join(app.getAppPath(), "package.json"), "utf8")) as { lucidBuildFlavor?: unknown };
    return typeof meta.lucidBuildFlavor === "string" ? meta.lucidBuildFlavor : "";
  } catch { return ""; }
})();
const BUILD = flavorInfo(resolveBuildFlavor(process.env, packagedBuildFlavor));
if (BUILD.creatorBuild) {
  app.setName(BUILD.productName);
  if (process.platform === "win32") { try { app.setAppUserModelId(BUILD.appId); } catch { /* taskbar grouping only */ } }
}

const DEFAULT_PORT = BUILD.defaultPort;
const PORT = Number(process.env.LUCID_PORT ?? DEFAULT_PORT);
// A LUCID on a NON-DEFAULT port is a deliberately separate instance: LucidAgentIDE.bat rolls a free port
// when 5319 is taken, precisely so a dev build can run beside an installed one. Electron's single-instance
// lock (below, ADR-0206) is keyed on the userData directory and knows nothing about the port, so without
// this the second launch hit the guard, quit, and merely FOCUSED the first window - making the control
// panel's port-picking dead effort. Two instances can never share a port, so keying identity on the port
// makes them never share a lock. The default-port instance keeps the canonical identity, so the lucid://
// OAuth deep-link still re-focuses the primary app rather than spawning an engine.
// Must run before requestSingleInstanceLock() and before anything resolves a userData path.
const CANONICAL_USER_DATA = app.getPath("userData"); // the unsuffixed install identity - owns the one true safeStorage key
if (PORT !== DEFAULT_PORT) app.setPath("userData", `${app.getPath("userData")}-${PORT}`);
// safeStorage on Windows is Chromium os_crypt: its AES key lives in `<userData>/Local State`, so the
// per-port userData above silently gave EVERY instance its own encryption key while the credential vault
// (~/.omp/lucid-cred-vault) is global. A key stored on port A was undecryptable on port B: readCredential
// failed closed, the Local Provider was skipped at engine spawn, and the model vanished from the picker
// with the UI still saying "key in vault". Seed this instance's Local State from the canonical dir NOW -
// before Chromium reads it at app-ready - so every instance shares the canonical key. macOS (Keychain)
// and Linux (libsecret) key by app NAME and already share; this is win32-only. Best-effort: a failed
// seed just means this instance mints its own key (the pre-fix behavior).
const localStatePath = (dir: string): string => join(dir, "Local State");
function readTextBestEffort(p: string): string { try { return readFileSync(p, "utf8"); } catch { return ""; } }
if (process.platform === "win32" && PORT !== DEFAULT_PORT) {
  try {
    const instPath = localStatePath(app.getPath("userData"));
    const seed = seedInstanceFromCanonical(readTextBestEffort(localStatePath(CANONICAL_USER_DATA)), readTextBestEffort(instPath));
    if (seed.changed && seed.content !== undefined) {
      mkdirSync(app.getPath("userData"), { recursive: true });
      writeFileSync(instPath, seed.content);
    }
  } catch (err) { console.error("[main] os_crypt seed failed (instance will mint its own key):", err); }
}
let REPO = "";
const preloadPath = () => join(app.getAppPath(), "dist", "preload.js");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let win: BrowserWindow | null = null;
let dev: ChildProcess | null = null;
let runtimeEnv: Record<string, string> = {};
// P-WINBOOT.1 (ADR-0259): the engine child's exit + a bounded tail of its output, so a boot failure is
// diagnosed the instant it dies (see classifyEngineFailure) rather than after the full 30s health timeout.
let engineExit: { code: number | null } | null = null;
let engineTail = "";

// ── P-KGMARKET.4 (ADR-0206): lucid://auth deep link for hosted marketplace sign-in ──────────────────
// After the user signs in on the hosted page, the browser redirects to lucid://auth?token=...; the OS hands
// that URL to this app, which forwards it to the renderer (market_boot.handleAuthCallback). On Windows/Linux a
// cold or second launch delivers it as an argv entry (caught by the single-instance handler); on macOS it
// arrives via "open-url". A URL that lands before the window is ready is queued and flushed on did-finish-load.
// CREATOR-0: Creator claims `lucid-creator://`, NEVER `lucid://` - stealing the standard build's scheme
// would hand it the OAuth callback for a sign-in the user started in the other app.
const AUTH_PROTOCOL = BUILD.authProtocol;
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
const appendEngineLog = (line: string): void => { try { appendFileSync(engineLogPath(), line); } catch { /* best-effort */ } };

// ADR-0246 (P-GPUFIX.1): zombie-SID GPU-sandbox self-heal (electron/electron#51761). On machines
// where an unresolvable AppContainer SID in the install dir's DACL kills every sandboxed GPU child
// with 0xC0000022, the app used to die (FATAL after 9 retries) before the window showed. The
// watchdog (pure core: gpu_watchdog.ts) relaunches with --disable-gpu-sandbox on the 2nd
// pre-render fatal GPU death and persists a flag file in userData (which survives the NSIS
// reinstall that re-inherits the zombie SID). ONLY the GPU sandbox is dropped; the renderer
// sandbox is untouched. The switch must be appended at module load, before Chromium spawns the
// GPU process at the first window.
const gpuFlagPath = (): string => join(app.getPath("userData"), GPU_SANDBOX_FLAG_FILE);
let gpuSandboxOff = app.commandLine.hasSwitch(GPU_SANDBOX_SWITCH); // the relaunch carries it in argv
try {
  if (!gpuSandboxOff && existsSync(gpuFlagPath())) { app.commandLine.appendSwitch(GPU_SANDBOX_SWITCH); gpuSandboxOff = true; }
} catch { /* unreadable flag: sandbox stays on; the watchdog below re-heals if it bricks */ }
let gpuDeaths = 0;
let firstWindowRendered = false; // set in createWindow's ready-to-show
app.on("child-process-gone", (_e, details) => {
  const r = decideGpuAction(details, { deathsBefore: gpuDeaths, windowRendered: firstWindowRendered, sandboxOff: gpuSandboxOff });
  gpuDeaths = r.deaths;
  if (r.action === "ignore") return;
  appendEngineLog(gpuDeathLogLine(details, r.deaths, r.action, new Date().toISOString()));
  if (r.action !== "relaunch") return;
  try { writeFileSync(gpuFlagPath(), `GPU sandbox disabled ${new Date().toISOString()} after ${r.deaths} GPU child deaths (zombie-SID mitigation, electron/electron#51761). Delete this file to re-enable the GPU sandbox.\n`); }
  catch { /* the relaunch argv still carries the switch for this recovery */ }
  try { dev?.kill(); } catch { /* best-effort */ }
  app.relaunch({ args: relaunchArgs(process.argv.slice(1)) });
  app.exit(0);
});

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
  // ADR-0216: the vault-backed git PAT (ref "git_pat"), injected as LUCID_GIT_PAT so cloneRepo can authenticate
  // a PRIVATE clone from the Settings button - the same vault→env-into-dev-child path as Figma/Local Providers.
  const gitEnv = prepareGitToken();
  const embeddingsEnv = prepareEmbeddingsToken(); // ADR-0221: vault→env for the embeddings endpoint key
  // CREATOR-0 (ADR-0279): the engine child learns its own identity and its own data roots. The standard
  // build gets ONLY the descriptive vars (no path relocation), so its on-disk layout is untouched; the
  // Creator build additionally isolates GUI settings, Personal Knowledge, the creator data root, and the
  // auxiliary ports (relay + managed whisper both bind, so two flavors cannot share them).
  const flavorEnv: Record<string, string> = {
    LUCID_BUILD_FLAVOR: BUILD.flavor,
    LUCID_APP_ID: BUILD.appId,
    LUCID_PRODUCT_NAME: BUILD.productName,
    LUCID_DISPLAY_NAME: BUILD.displayName,
    LUCID_AUTH_PROTOCOL: BUILD.authProtocol,
    LUCID_DATA_ROOT: app.getPath("userData"),
    LUCID_CRED_VAULT_DIR: CRED_DIR(),
    ...(BUILD.creatorBuild ? {
      LUCID_GUI_SETTINGS_FILE: process.env.LUCID_GUI_SETTINGS_FILE || join(app.getPath("userData"), "lucid-gui.json"),
      LUCID_PERSONAL_DIR: process.env.LUCID_PERSONAL_DIR || join(app.getPath("userData"), "personal"),
      LUCID_CREATOR_DIR: process.env.LUCID_CREATOR_DIR || join(app.getPath("userData"), "creator"),
      LUCID_RELAY_PORT: process.env.LUCID_RELAY_PORT || String(BUILD.defaultRelayPort),
      LUCID_WHISPER_PORT: process.env.LUCID_WHISPER_PORT || String(BUILD.defaultWhisperPort),
    } : {}),
  };
  // P-WINBOOT.2 (ADR-0260): packaged builds spawn the COMPILED engine (bin/lucid-engine) - it embeds
  // dev.ts so Bun never module-loads a .ts from a protected install dir (the P-WINBOOT.1 EPERM brick).
  // Dev runs, and any package cut before compile-engine existed, fall back to `bun run desktop/dev.ts`.
  const engineSpec = resolveEngineSpawn({ packaged: app.isPackaged, repoRoot: REPO, bun: findBun(), exists: existsSync, platform: process.platform });
  console.log(`[main] engine: ${engineSpec.compiled ? "compiled bin/lucid-engine" : "bun run desktop/dev.ts"}`);
  dev = spawn(engineSpec.cmd, engineSpec.args, {
    cwd: REPO,
    // LUCID_RESOURCES lets the dev child resolve the bundled whisper.cpp binary under <resources>/whisper
    // (P-STT.2c); process.resourcesPath is an Electron property, not an env var, so it must be threaded here.
    // P-BROWSER.1 (wave 2): LUCID_MAIN_TOKEN is the per-launch capability token, minted HERE (below)
    // and adopted by dev.ts as THE token - the only channel that lets this parent process authenticate
    // its agent-browser poll loop against the child's /api/browser routes.
    env: { ...process.env, ...runtimeEnv, ...lpEnv, ...figmaEnv, ...gitEnv, ...embeddingsEnv, ...flavorEnv, LUCID_RESOURCES: app.isPackaged ? process.resourcesPath : "", PORT: String(PORT), LUCID_MAIN_TOKEN: MAIN_TOKEN },
    // NOT "inherit": in a packaged GUI app the Electron main has no console, so inheriting
    // makes the console-subsystem Bun allocate its OWN console window (the black pop-up).
    // Pipe instead + windowsHide so no window ever appears; forward output for dev runs.
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const tee = openEngineLog();
  engineExit = null;
  engineTail = "";
  // P-WINBOOT.1 (ADR-0259): keep a bounded tail of engine output + watch for an early exit, so a boot
  // failure (e.g. Bun's EPERM loading dev.ts from a Program Files install) is diagnosed the instant it
  // dies rather than after the full 30s health timeout.
  dev.stdout?.on("data", (d) => { process.stdout.write(d); tee(d); engineTail = (engineTail + d.toString()).slice(-4000); });
  dev.stderr?.on("data", (d) => { process.stderr.write(d); tee(d); engineTail = (engineTail + d.toString()).slice(-4000); });
  dev.on("exit", (code) => { engineExit = { code: code ?? null }; });
  // ADR-0246: a spawn failure (missing/blocked bun exe) used to vanish - no "error" listener, so
  // engine.log showed only the banner and the app just waited out the 30s health timeout. Tee it (and
  // feed the ADR-0259 tail + exit flag, so waitForServer bails at once and the dialog names the cause).
  dev.on("error", (err) => {
    const line = `[engine] dev-server spawn failed: ${(err as Error)?.message ?? String(err)}\n`;
    process.stderr.write(line);
    tee(line);
    engineTail = (engineTail + line).slice(-4000);
    engineExit = { code: null };
  });
}
// Returns true once the dev server answers /api/health, false if it never does within the window.
// 30s headroom: the server's own init (DuckDB open + omp acp spawn) can outlast a slow first launch;
// the splash already covered the longer omp/scanner provisioning before we got here.
async function waitForServer(timeoutMs = 30000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://localhost:${PORT}/api/health`)).ok) return true; } catch { /* retry */ }
    // P-WINBOOT.1 (ADR-0259): a dead engine will never answer - stop waiting the moment it exits.
    if (engineExit) return false;
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
    frame: false, backgroundColor: "#0a0b0f", show: false, title: "Lucid Agent",
    ...(existsSync(iconPath) ? { icon: iconPath } : {}),
    webPreferences: { preload: preloadPath(), contextIsolation: true, nodeIntegration: false },
  });
  win.once("ready-to-show", () => { firstWindowRendered = true; win!.show(); }); // ADR-0246: past here a GPU death is not the boot brick
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

ipcMain.handle("lucid:pickFolder", async (e, opts: unknown) => {
  const w = BrowserWindow.fromWebContents(e.sender) ?? undefined;
  // Native OS folder dialog: browse anywhere on the machine and CREATE a new folder from within the dialog.
  // `createDirectory` enables the New Folder button on macOS (Windows always offers it); the whole tree is
  // reachable (no home confinement).
  // P-KG-INGEST.5 (ADR-0252): title/defaultPath/buttonLabel come from the renderer so EVERY folder picker
  // (workspace, chat-history import, pack export) is this real Explorer dialog, not the in-app browser.
  const o = (opts ?? {}) as { title?: unknown; defaultPath?: unknown; buttonLabel?: unknown };
  const r = await dialog.showOpenDialog(w!, {
    properties: ["openDirectory", "createDirectory"],
    title: typeof o.title === "string" ? o.title : "Choose or create a workspace folder",
    ...(typeof o.defaultPath === "string" && o.defaultPath ? { defaultPath: o.defaultPath } : {}),
    ...(typeof o.buttonLabel === "string" && o.buttonLabel ? { buttonLabel: o.buttonLabel } : {}),
  });
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
// CREATOR-0 (ADR-0279): the Creator flavor gets its OWN vault root inside its userData. Two reasons:
// a standard-build provider key must not silently become creative-media egress credit, and on Windows
// the safeStorage key lives per profile directory, so a shared vault path across two app identities
// would fail closed on every read anyway (the ADR-0278 lesson).
const CRED_DIR = () => process.env.LUCID_CRED_VAULT_DIR
  || (BUILD.creatorBuild ? join(app.getPath("userData"), "lucid-cred-vault") : join(homedir(), ".omp", "lucid-cred-vault"));
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
    // Tee the outcome into engine.log too: main's console is invisible in a packaged GUI app, and a
    // silently-skipped provider (vault miss) is exactly the failure that needs a trail to diagnose.
    const skippedNote = r.skipped.length ? `; skipped ${r.skipped.map((s) => `${s.id} (${s.reason})`).join(", ")}` : "";
    const line = r.wrote
      ? `[LOCAL_PROVIDERS] ${r.included.length} provider(s) → ~/.omp/agent/models.yml${skippedNote}`
      : `[LOCAL_PROVIDERS] models.yml not written: ${r.writeReason ?? "unknown"}${skippedNote}`;
    console.error(line);
    appendEngineLog(line + "\n");
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
// ADR-0216: read the git personal access token from the vault (ref "git_pat") and expose it to the dev child as
// LUCID_GIT_PAT, so cloneRepo can clone a PRIVATE repo from the Settings "Clone" button without an interactive
// credential prompt. The secret never reaches the renderer or the agent. (A freshly-entered PAT is also passed
// inline on the first clone request; this covers subsequent sessions.) Best-effort — never blocks server start.
//
// P-FLEET.L2: the fleet's repo field saves a token PER HOST (vault ref `git_pat_<host_slug>`, minted by
// git_url.gitCredRef). Every such ref is injected under its own name - `LUCID_GIT_PAT_GITHUB_COM`,
// `LUCID_GIT_PAT_DEV_AZURE_COM`, `LUCID_GIT_PAT_GITLAB_MYCORP_COM` - which is what lets workspace.ts hand a
// token ONLY to the host it was saved for, self-hosted GitLab/Azure DevOps Server included. Enumerating the
// vault costs one directory read at launch; a ref we cannot decrypt is simply skipped.
const GIT_PAT_REF = "git_pat";
function prepareGitToken(): Record<string, string> {
  const env: Record<string, string> = {};
  try {
    const legacy = readCredential(ELECTRON_SAFE_STORAGE, VAULT_IO, CRED_DIR(), GIT_PAT_REF);
    if (legacy) env.LUCID_GIT_PAT = legacy;
  } catch { /* best-effort */ }
  try {
    for (const meta of listCredentials(VAULT_IO, CRED_DIR())) {
      const name = gitEnvNameFromRef(meta.ref);
      if (!name) continue;
      const tok = readCredential(ELECTRON_SAFE_STORAGE, VAULT_IO, CRED_DIR(), meta.ref);
      if (tok) env[name] = tok;
    }
  } catch { /* best-effort */ }
  return env;
}
// ADR-0221: read the embeddings endpoint's API key from the vault (ref = settings.embeddings.vaultRef) and expose
// it to the dev child as LUCID_EMBEDDINGS_KEY, so the ApiEmbedder can authenticate a cloud endpoint (OpenAI/Azure)
// without the secret reaching the renderer. A local no-auth Ollama needs no key. Best-effort — never blocks start.
function prepareEmbeddingsToken(): Record<string, string> {
  try {
    const cfg = embeddingsConfig();
    if (!cfg?.enabled || !cfg.vaultRef || (cfg.authKind !== "bearer" && cfg.authKind !== "apikey")) return {};
    const tok = readCredential(ELECTRON_SAFE_STORAGE, VAULT_IO, CRED_DIR(), cfg.vaultRef);
    return tok ? { LUCID_EMBEDDINGS_KEY: tok } : {};
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

// ── P-BROWSER.1 (wave 2): the agent-controlled VISIBLE browser window ────────────────────────────────
// A real Chromium BrowserWindow the AGENT drives through the dev server's command mailbox
// (desktop/browser_control.ts): agent tools enqueue on /api/browser/*, this loop drains
// GET /api/browser/commands every 500ms, executes on the window, and POSTs /api/browser/result.
// Deliberately VISIBLE: the user watches every step, can log in on real pages, and closing the window
// is a hard kill switch. capturePage reads compositor pixels, so DOM-locking/anti-agent pages cannot
// blind the agent (and a prior ADR rejects puppeteering the user's OWN browser - this sanctioned window
// is the alternative). Everything here is fail-quiet: the poll loop must never throw.
// AUTH: this parent cannot read the child's token, so it MINTS the per-launch token itself and hands it
// down via the spawn env (LUCID_MAIN_TOKEN, adopted by dev.ts as TOKEN); every call sends x-lucid-token.
const MAIN_TOKEN = randomBytes(32).toString("hex");
let agentWin: BrowserWindow | null = null;
let agentCloseByCommand = false; // distinguishes the agent's own close from the user's X (kill switch)
let agentPollBusy = false;
// Width (px) of the newest snapshot handed to the agent. Click coordinates are expressed in THAT image's
// space, so this is the only number needed to map them back onto the live window. Null until a capture.
let agentLastShotWidth: number | null = null;
// Injected into every page the agent visits: a breathing accent glow on the html element (the user can
// tell at a glance which window the agent is driving) + the .lucid-snap-flash pulse replayed per shot.
const AGENT_FX_CSS = `
@keyframes lucidAgentBreathe {
  0%, 100% { box-shadow: inset 0 0 0 3px rgba(198, 75, 214, .55), inset 0 0 44px rgba(198, 75, 214, .16); }
  50% { box-shadow: inset 0 0 0 3px rgba(70, 200, 220, .70), inset 0 0 72px rgba(70, 200, 220, .28); }
}
@keyframes lucidSnapFlash {
  0% { filter: brightness(1.85) saturate(1.25); }
  100% { filter: none; }
}
html { animation: lucidAgentBreathe 3.2s ease-in-out infinite; }
html.lucid-snap-flash { animation: lucidAgentBreathe 3.2s ease-in-out infinite, lucidSnapFlash .45s ease-out 1; }
`;
async function browserApiPost(path: string, body: unknown): Promise<void> {
  try {
    await fetch(`http://localhost:${PORT}${path}`, {
      method: "POST",
      headers: { "x-lucid-token": MAIN_TOKEN, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch { /* fail-quiet: the dev server may be restarting */ }
}
/** The live agent window's contents, or null once destroyed/never opened. */
function agentPage(): Electron.WebContents | null {
  return agentWin && !agentWin.isDestroyed() ? agentWin.webContents : null;
}
async function agentBrowserOpen(id: string, url: string): Promise<void> {
  if (!/^https?:\/\//i.test(url)) { await browserApiPost("/api/browser/result", { id, ok: false, error: "only http(s) URLs can be opened" }); return; }
  try {
    if (!agentWin || agentWin.isDestroyed()) {
      agentCloseByCommand = false;
      agentWin = new BrowserWindow({
        width: 1180, height: 800, show: true, autoHideMenuBar: true, title: "LUCID agent browser",
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
      });
      // target=_blank / window.open stays in THIS window - the agent never fans out into new windows.
      agentWin.webContents.setWindowOpenHandler(({ url: u }) => {
        if (/^https?:\/\//i.test(u)) void agentWin?.loadURL(u).catch(() => {});
        return { action: "deny" };
      });
      agentWin.webContents.on("did-finish-load", () => { void agentPage()?.insertCSS(AGENT_FX_CSS).catch(() => {}); });
      agentWin.webContents.on("page-title-updated", () => {
        const wc = agentPage();
        if (wc) void browserApiPost("/api/browser/status", { active: true, title: wc.getTitle(), url: wc.getURL() });
      });
      agentWin.webContents.on("did-navigate", () => {
        const wc = agentPage();
        if (wc) void browserApiPost("/api/browser/status", { active: true, title: wc.getTitle(), url: wc.getURL() });
      });
      agentWin.on("closed", () => {
        agentWin = null;
        const byUser = !agentCloseByCommand;
        agentCloseByCommand = false;
        // User-X = KILL SWITCH: the server fails every queued/pending command with "browser closed by
        // user" and keeps failing browser calls until a fresh browser_open. Agent closes just go inactive.
        void browserApiPost("/api/browser/status", { active: false, closedByUser: byUser });
      });
    }
    await agentWin.loadURL(url);
    const wc = agentPage();
    await browserApiPost("/api/browser/result", { id, ok: true, title: wc?.getTitle() ?? "", url: wc?.getURL() ?? url });
  } catch (e) {
    await browserApiPost("/api/browser/result", { id, ok: false, error: `could not load ${url}: ${e instanceof Error ? e.message : String(e)}` });
  }
}
async function agentBrowserCapture(id: string): Promise<void> {
  const wc = agentPage();
  if (!wc) { await browserApiPost("/api/browser/result", { id, ok: false, error: "browser closed by user" }); return; }
  try {
    const img = await wc.capturePage();
    const scaled = img.getSize().width > 1100 ? img.resize({ width: 1100 }) : img;
    // Remember what the AGENT saw: click coordinates arrive in this image's pixel space, and mapping
    // them back needs the width that actually went out (never the raw capture, never the display ratio).
    agentLastShotWidth = scaled.getSize().width || null;
    // Pulse AFTER the pixels are read, so the flash marks the shot without contaminating it.
    void wc.executeJavaScript(
      `(() => { const h = document.documentElement; h.classList.remove("lucid-snap-flash"); void h.offsetWidth; h.classList.add("lucid-snap-flash"); setTimeout(() => h.classList.remove("lucid-snap-flash"), 500); })();`,
      true,
    ).catch(() => {});
    await browserApiPost("/api/browser/result", { id, ok: true, png: scaled.toDataURL(), title: wc.getTitle(), url: wc.getURL() });
  } catch (e) {
    await browserApiPost("/api/browser/result", { id, ok: false, error: `capture failed: ${e instanceof Error ? e.message : String(e)}` });
  }
}
/** Snapshot pixels -> window content coordinates. The agent aims at the downscaled image it was shown;
 *  contentBounds is in DIP, which is also what sendInputEvent expects, so one ratio covers both the
 *  downscale and the display's pixel ratio. No shot yet = treat the coordinates as already-live. */
function agentMapPoint(x: number, y: number): { x: number; y: number } | null {
  if (!agentWin || agentWin.isDestroyed()) return null;
  const b = agentWin.getContentBounds();
  const ratio = agentLastShotWidth && agentLastShotWidth > 0 ? b.width / agentLastShotWidth : 1;
  const clamp = (v: number, hi: number) => Math.max(0, Math.min(Math.max(hi - 1, 0), Math.round(v)));
  return { x: clamp(x * ratio, b.width), y: clamp(y * ratio, b.height) };
}
async function agentBrowserClick(id: string, x: number, y: number, button: "left" | "right"): Promise<void> {
  const wc = agentPage();
  if (!wc) { await browserApiPost("/api/browser/result", { id, ok: false, error: "browser closed by user" }); return; }
  try {
    const pt = agentMapPoint(x, y);
    if (!pt) { await browserApiPost("/api/browser/result", { id, ok: false, error: "browser closed by user" }); return; }
    // Move first: hover-gated controls (menus, custom dropdowns) need the pointer to arrive before the
    // press, exactly as it would for the user's own mouse.
    wc.sendInputEvent({ type: "mouseMove", x: pt.x, y: pt.y });
    wc.sendInputEvent({ type: "mouseDown", x: pt.x, y: pt.y, button, clickCount: 1 });
    wc.sendInputEvent({ type: "mouseUp", x: pt.x, y: pt.y, button, clickCount: 1 });
    await browserApiPost("/api/browser/result", { id, ok: true, title: wc.getTitle(), url: wc.getURL() });
  } catch (e) {
    await browserApiPost("/api/browser/result", { id, ok: false, error: `click failed: ${e instanceof Error ? e.message : String(e)}` });
  }
}
/** Press at one point, travel, release at another. The intermediate moves are the point: HTML5
 *  drag-and-drop, range sliders and canvas handles all read the move stream, and a bare down-then-up
 *  is indistinguishable from a click. Ten steps is enough for every such listener to see motion. */
async function agentBrowserDrag(id: string, x: number, y: number, toX: number, toY: number): Promise<void> {
  const wc = agentPage();
  if (!wc) { await browserApiPost("/api/browser/result", { id, ok: false, error: "browser closed by user" }); return; }
  try {
    const from = agentMapPoint(x, y), to = agentMapPoint(toX, toY);
    if (!from || !to) { await browserApiPost("/api/browser/result", { id, ok: false, error: "browser closed by user" }); return; }
    const STEPS = 10;
    wc.sendInputEvent({ type: "mouseMove", x: from.x, y: from.y });
    wc.sendInputEvent({ type: "mouseDown", x: from.x, y: from.y, button: "left", clickCount: 1 });
    for (let i = 1; i <= STEPS; i++) {
      const px = Math.round(from.x + ((to.x - from.x) * i) / STEPS);
      const py = Math.round(from.y + ((to.y - from.y) * i) / STEPS);
      wc.sendInputEvent({ type: "mouseMove", x: px, y: py });
      await new Promise((r) => setTimeout(r, 16)); // ~one frame between moves, so listeners actually run
    }
    wc.sendInputEvent({ type: "mouseUp", x: to.x, y: to.y, button: "left", clickCount: 1 });
    await browserApiPost("/api/browser/result", { id, ok: true, title: wc.getTitle(), url: wc.getURL() });
  } catch (e) {
    await browserApiPost("/api/browser/result", { id, ok: false, error: `drag failed: ${e instanceof Error ? e.message : String(e)}` });
  }
}
/** One key combo, modifiers held for the press. Re-parsed here (not trusted from the queue) so main is
 *  the authority on what actually reaches Chromium. */
async function agentBrowserKeys(id: string, keys: string): Promise<void> {
  const wc = agentPage();
  if (!wc) { await browserApiPost("/api/browser/result", { id, ok: false, error: "browser closed by user" }); return; }
  const parsed = parseKeyCombo(keys);
  if ("error" in parsed) { await browserApiPost("/api/browser/result", { id, ok: false, error: parsed.error }); return; }
  try {
    const { keyCode, modifiers } = parsed;
    wc.sendInputEvent({ type: "keyDown", keyCode, modifiers });
    // A char event is what puts a printable key into a field; a named key (Escape, Tab) must NOT get one,
    // or Chromium inserts a stray control character alongside the keydown the page is listening for.
    if ([...keyCode].length === 1 && !modifiers.includes("control") && !modifiers.includes("meta")) {
      wc.sendInputEvent({ type: "char", keyCode, modifiers });
    }
    wc.sendInputEvent({ type: "keyUp", keyCode, modifiers });
    await browserApiPost("/api/browser/result", { id, ok: true, title: wc.getTitle(), url: wc.getURL() });
  } catch (e) {
    await browserApiPost("/api/browser/result", { id, ok: false, error: `key press failed: ${e instanceof Error ? e.message : String(e)}` });
  }
}
async function agentBrowserType(id: string, text: string, pressEnter: boolean): Promise<void> {
  const wc = agentPage();
  if (!wc) { await browserApiPost("/api/browser/result", { id, ok: false, error: "browser closed by user" }); return; }
  try {
    const enter = (): void => {
      wc.sendInputEvent({ type: "keyDown", keyCode: "Return" });
      wc.sendInputEvent({ type: "char", keyCode: "Return" });
      wc.sendInputEvent({ type: "keyUp", keyCode: "Return" });
    };
    for (const ch of text) {
      if (ch === "\n" || ch === "\r") { enter(); continue; }
      wc.sendInputEvent({ type: "char", keyCode: ch });
    }
    if (pressEnter) enter();
    await browserApiPost("/api/browser/result", { id, ok: true, title: wc.getTitle(), url: wc.getURL() });
  } catch (e) {
    await browserApiPost("/api/browser/result", { id, ok: false, error: `type failed: ${e instanceof Error ? e.message : String(e)}` });
  }
}
async function agentBrowserScroll(id: string, dy: number): Promise<void> {
  const wc = agentPage();
  if (!wc) { await browserApiPost("/api/browser/result", { id, ok: false, error: "browser closed by user" }); return; }
  try {
    const step = Number.isFinite(dy) ? Math.max(-20_000, Math.min(20_000, Math.round(dy))) : 800;
    await wc.executeJavaScript(`window.scrollBy(0, ${step});`, true);
    await browserApiPost("/api/browser/result", { id, ok: true, title: wc.getTitle(), url: wc.getURL() });
  } catch (e) {
    await browserApiPost("/api/browser/result", { id, ok: false, error: `scroll failed: ${e instanceof Error ? e.message : String(e)}` });
  }
}
async function agentBrowserClose(id: string): Promise<void> {
  if (agentWin && !agentWin.isDestroyed()) {
    agentCloseByCommand = true;
    try { agentWin.destroy(); } catch { /* already gone */ }
  }
  agentWin = null;
  await browserApiPost("/api/browser/result", { id, ok: true });
}
/** Drain + execute the agent's queued browser commands. Sequential: order matters (open -> capture). */
async function agentBrowserTick(): Promise<void> {
  if (agentPollBusy) return;
  agentPollBusy = true;
  try {
    const res = await fetch(`http://localhost:${PORT}/api/browser/commands`, { headers: { "x-lucid-token": MAIN_TOKEN } });
    if (!res.ok) return;
    const parsed: unknown = await res.json().catch(() => null);
    const data = parsed && typeof parsed === "object" && "data" in parsed ? parsed.data : null;
    const cmds = data && typeof data === "object" && "commands" in data && Array.isArray(data.commands) ? data.commands : [];
    for (const raw of cmds) {
      if (!raw || typeof raw !== "object") continue;
      const id = "id" in raw && typeof raw.id === "string" ? raw.id : "";
      if (!id) continue;
      const op = "op" in raw && typeof raw.op === "string" ? raw.op : "";
      if (op === "open") await agentBrowserOpen(id, "url" in raw && typeof raw.url === "string" ? raw.url : "");
      else if (op === "capture") await agentBrowserCapture(id);
      else if (op === "scroll") await agentBrowserScroll(id, "dy" in raw && typeof raw.dy === "number" ? raw.dy : 800);
      else if (op === "click") await agentBrowserClick(id, "x" in raw && typeof raw.x === "number" ? raw.x : 0, "y" in raw && typeof raw.y === "number" ? raw.y : 0, "button" in raw && raw.button === "right" ? "right" : "left");
      else if (op === "drag") await agentBrowserDrag(id, "x" in raw && typeof raw.x === "number" ? raw.x : 0, "y" in raw && typeof raw.y === "number" ? raw.y : 0, "toX" in raw && typeof raw.toX === "number" ? raw.toX : 0, "toY" in raw && typeof raw.toY === "number" ? raw.toY : 0);
      else if (op === "keys") await agentBrowserKeys(id, "keys" in raw && typeof raw.keys === "string" ? raw.keys : "");
      else if (op === "type") await agentBrowserType(id, "text" in raw && typeof raw.text === "string" ? raw.text : "", "pressEnter" in raw && raw.pressEnter === true);
      else if (op === "close") await agentBrowserClose(id);
      else await browserApiPost("/api/browser/result", { id, ok: false, error: "unknown browser command" });
    }
  } catch { /* fail-quiet: never let the poll loop throw */
  } finally { agentPollBusy = false; }
}
function startAgentBrowserLoop(): void {
  setInterval(() => { void agentBrowserTick(); }, 500);
}

// Open an EXTERNAL http(s) URL in the user's default browser via the OS — a reliable path for the OAuth
// sign-in page that doesn't depend on the renderer's window.open reaching setWindowOpenHandler (which can
// silently no-op in some contexts, leaving "Connect via OAuth" with a toast but no browser). Strictly
// http/https only, so a forged request can't launch file:// or a custom-scheme handler. Returns success.
ipcMain.handle("lucid:openExternal", async (_e, u: unknown) => {
  const url = typeof u === "string" ? u : "";
  if (!/^https?:\/\//i.test(url)) return false;
  try { await shell.openExternal(url); return true; } catch { return false; }
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
// Only the DEFAULT-port instance claims the lucid:// scheme. A side-by-side test instance registering it
// would silently steal the OAuth callback from the app the user actually signed in from.
if (PORT === DEFAULT_PORT) {
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(AUTH_PROTOCOL, process.execPath, [resolve(process.argv[1]!)]); // dev
  } else {
    app.setAsDefaultProtocolClient(AUTH_PROTOCOL); // packaged
  }
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

  // os_crypt convergence, backfill direction: on a machine that only ever ran port-suffixed instances
  // the canonical dir has no key, so adopt the key Chromium just minted for THIS instance as the
  // canonical one - every later instance then seeds from it (module-load seed above). Never overwrites
  // an existing canonical key. Best-effort: a miss self-heals on a later launch.
  if (process.platform === "win32" && PORT !== DEFAULT_PORT) {
    try {
      const canonPath = localStatePath(CANONICAL_USER_DATA);
      const fill = backfillCanonicalFromInstance(readTextBestEffort(canonPath), readTextBestEffort(localStatePath(app.getPath("userData"))));
      if (fill.changed && fill.content !== undefined) {
        mkdirSync(CANONICAL_USER_DATA, { recursive: true });
        writeFileSync(canonPath, fill.content);
      }
    } catch (err) { console.error("[main] os_crypt canonical backfill failed:", err); }
  }
  startDevServer();
  const serverUp = await waitForServer();
  createWindow();
  // P-BROWSER.1 (wave 2): start the agent-browser command poll once the server answered /api/health.
  // Started even on a timeout - the loop is fail-quiet and a late-starting server self-heals into it.
  startAgentBrowserLoop();
  splash?.close();
  // Don't leave the user staring at a black window with no explanation: if the local engine never
  // came up (e.g. no usable bun runtime), say so. The window keeps retrying via did-fail-load, so a
  // late start still recovers; this only fires when it genuinely failed to answer in time.
  if (!serverUp) {
    // P-WINBOOT.1 (ADR-0259): classify the failure into an ACTIONABLE dialog. The dominant field case is
    // a Program Files install where Bun's loader EPERMs on dev.ts; waitForServer already returned early on
    // the child's exit, so this fires immediately (not 30s later) and tells the user how to recover.
    const probe: WriteProbe = { write: (p, data) => writeFileSync(p, data), remove: (p) => rmSync(p, { force: true }) };
    const report = classifyEngineFailure({
      packaged: app.isPackaged,
      repoRoot: REPO,
      repoWritable: probeDirWritable(REPO, probe),
      protectedRoot: isProtectedInstallRoot(REPO),
      exited: !!engineExit,
      exitCode: engineExit?.code ?? null,
      lastLogLine: bestEngineLine(engineTail),
      port: PORT,
      logPath: engineLogPath(),
      platform: process.platform,
    });
    dialog.showErrorBox(report.title, report.detail);
  }
  initAutoUpdate(() => win); // packaged-only; checks GitHub Releases, prompts on download
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
} // end single-instance guard (P-KGMARKET.4)
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("quit", () => { dev?.kill(); });
