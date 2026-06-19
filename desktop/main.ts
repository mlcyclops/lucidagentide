// desktop/main.ts — Electron main process for LucidAgentIDE.
//
// Two children, mirroring the proven spike pieces:
//   1. a Bun server (desktop/dev.ts) that serves the renderer + live /api data
//      (read-only dashboards) — the window loads it over http://localhost.
//   2. `omp acp -e harness/omp/security_extension.ts` — the agent loop, WITH the
//      in-process security gate loaded (invariant #4 preserved on the GUI path).
//
// The renderer is unchanged from the browser build; window.lucid (preload) gives
// it the real ACP chat + native window controls.

import { app, BrowserWindow, ipcMain, type IpcMainEvent } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ACPClient } from "./acp.ts";

const PORT = Number(process.env.LUCID_PORT ?? 4318);
// app.getAppPath() == the desktop/ folder (holds package.json); repo root is its parent.
let REPO = "";
const preloadPath = () => join(app.getAppPath(), "dist", "preload.js");

function bin(name: string): string {
  for (const c of [join(homedir(), ".bun", "bin", `${name}.exe`), join(homedir(), ".bun", "bin", name)]) {
    if (existsSync(c)) return c;
  }
  return name; // fall back to PATH
}

let win: BrowserWindow | null = null;
let dev: ChildProcess | null = null;
let acp: ACPClient | null = null;
let sessionId: string | null = null;
let active: { id: string; wc: Electron.WebContents } | null = null;

// ── content server (renderer + dashboards) ──────────────────────────────────
function startDevServer(): void {
  dev = spawn(bin("bun"), ["run", "desktop/dev.ts"], { cwd: REPO, env: { ...process.env, PORT: String(PORT) }, stdio: "inherit" });
}
async function waitForServer(timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const r = await fetch(`http://localhost:${PORT}/api/health`); if (r.ok) return; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 180));
  }
}

// ── agent loop over ACP, with the gate loaded ───────────────────────────────
function startAcp(): void {
  acp = new ACPClient(bin("omp"), ["acp", "-e", "harness/omp/security_extension.ts"], REPO);

  acp.onNotify = (method, params) => {
    if (method !== "session/update" || !active) return;
    const u = params?.update ?? params;
    const kind = u?.sessionUpdate;
    if (kind === "agent_message_chunk" && u.content?.type === "text") {
      send(active, { type: "token", text: u.content.text });
    } else if (kind === "tool_call") {
      send(active, { type: "tool", name: String(u.kind ?? u.title ?? "tool"), detail: String(u.title ?? "") });
    } else if (kind === "tool_call_update" && (u.status === "failed" || u.status === "rejected")) {
      send(active, { type: "block", tool: String(u.kind ?? "tool"), reason: "blocked by the security gate", severity: "high", findings: "" });
    }
  };

  // Auto-answer tool-permission prompts (the gate has already blocked anything
  // quarantined before this point). A production UI would surface these.
  acp.onRequest = async (method, params) => {
    if (method === "session/request_permission") {
      const opts: any[] = params?.options ?? [];
      const allow = opts.find((o) => /allow/i.test(o.kind ?? o.optionId ?? "")) ?? opts[0];
      return allow ? { outcome: { outcome: "selected", optionId: allow.optionId } } : { outcome: { outcome: "cancelled" } };
    }
    return {};
  };

  // The gate prints "🛡️ [LucidAgentIDE] [BLOCKED tool_call:bash] … severity=… findings=…"
  acp.onStderr = (chunk) => {
    for (const line of chunk.split("\n")) {
      const m = /\[BLOCKED tool_call:(\w+)\].*?severity=(\w+).*?findings=([^\s]+)/.exec(line);
      if (m && active) send(active, { type: "block", tool: m[1]!, reason: "hidden-Unicode content quarantined", severity: m[2]!, findings: m[3]! });
    }
  };

  acp.start();
  acp.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } }).catch(() => {});
}

function send(a: { id: string; wc: Electron.WebContents }, e: unknown): void {
  if (!a.wc.isDestroyed()) a.wc.send(`lucid:chat:${a.id}`, e);
}

// ── window ──────────────────────────────────────────────────────────────────
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

// ── IPC ──────────────────────────────────────────────────────────────────────
ipcMain.on("lucid:prompt", async (e: IpcMainEvent, { id, text }: { id: string; text: string }) => {
  active = { id, wc: e.sender };
  try {
    if (!sessionId) {
      const s: any = await acp!.request("session/new", { cwd: REPO, mcpServers: [] });
      sessionId = s?.sessionId ?? s?.id ?? null;
    }
    await acp!.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
  } catch (err) {
    send(active, { type: "token", text: `\n[agent error: ${String(err)}]` });
  }
  send(active, { type: "done" });
  active = null;
});

ipcMain.on("lucid:win", (e, action: string) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w) return;
  if (action === "minimize") w.minimize();
  else if (action === "toggleMaximize") w.isMaximized() ? w.unmaximize() : w.maximize();
  else if (action === "close") w.close();
});
ipcMain.on("lucid:setModel", (_e, _m: string) => { /* ACP model switching is per-session; reserved */ });

// ── lifecycle ────────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  REPO = join(app.getAppPath(), "..");
  startDevServer();
  startAcp();
  await waitForServer();
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("quit", () => { dev?.kill(); acp?.stop(); });
