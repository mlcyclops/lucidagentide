// desktop/main.ts — Electron main process for LucidAgentIDE.
//
// Two children:
//   1. a Bun server (desktop/dev.ts) — renderer + read-only /api dashboards.
//   2. `omp acp -e harness/omp/security_extension.ts` — the agent loop, WITH the
//      in-process security gate (invariant #4 preserved on the GUI path).
//
// ACP wire format was captured from a live omp 16.0.8 turn (see DECISIONS ADR-0006):
//   session/new → { sessionId, configOptions:[model|mode|thinking] }
//   notifications: agent_message_chunk{content:{type:"text",text}}, tool_call,
//     usage_update{size,used,cost:{amount}}, available_commands_update, config_option_update
//   set option: session/set_config_option { sessionId, configId, value }

import { app, BrowserWindow, ipcMain, type IpcMainEvent } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ACPClient } from "./acp.ts";

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
let acp: ACPClient | null = null;
let sessionId: string | null = null;
let configOptions: any[] = [];
let commands: any[] = [];
let active: { id: string; wc: Electron.WebContents } | null = null;

function send(a: { id: string; wc: Electron.WebContents } | null, e: unknown): void {
  if (a && !a.wc.isDestroyed()) a.wc.send(`lucid:chat:${a.id}`, e);
}

// ── content server ───────────────────────────────────────────────────────────
function startDevServer(): void {
  dev = spawn(bin("bun"), ["run", "desktop/dev.ts"], { cwd: REPO, env: { ...process.env, PORT: String(PORT) }, stdio: "inherit" });
}
async function waitForServer(timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://localhost:${PORT}/api/health`)).ok) return; } catch { /* retry */ }
    await sleep(180);
  }
}

// ── agent loop over ACP ───────────────────────────────────────────────────────
function startAcp(): void {
  acp = new ACPClient(bin("omp"), ["acp", "-e", "harness/omp/security_extension.ts"], REPO);

  acp.onNotify = (method, params) => {
    if (method !== "session/update") return;
    const u = params?.update ?? params;
    switch (u?.sessionUpdate) {
      case "agent_message_chunk":
        if (u.content?.type === "text") send(active, { type: "token", text: u.content.text });
        break;
      case "tool_call":
        send(active, { type: "tool", name: String(u.kind ?? u.title ?? "tool"), detail: String(u.title ?? u.rawInput?.command ?? "") });
        break;
      case "tool_call_update":
        if (u.status === "failed" || u.status === "rejected") send(active, { type: "block", tool: String(u.kind ?? "tool"), reason: "blocked by the security gate", severity: "high", findings: "" });
        break;
      case "usage_update":
        send(active, { type: "usage", used: Number(u.used ?? 0), size: Number(u.size ?? 0), cost: Number(u.cost?.amount ?? 0) });
        break;
      case "available_commands_update":
        commands = u.availableCommands ?? [];
        break;
      case "config_option_update":
        if (u.configOptions) configOptions = u.configOptions;
        break;
    }
  };

  // Auto-answer tool-permission prompts (the gate already blocked quarantined ones).
  acp.onRequest = async (m, params) => {
    if (m === "session/request_permission") {
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
      if (m) send(active, { type: "block", tool: m[1]!, reason: "hidden-Unicode content quarantined", severity: m[2]!, findings: m[3]! });
    }
  };

  acp.start();
  acp.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } }).catch(() => {});
}

/** Create the session (once) and capture its config options; commands arrive by notification. */
async function ensureSession(): Promise<void> {
  if (sessionId) return;
  const s: any = await acp!.request("session/new", { cwd: REPO, mcpServers: [] });
  sessionId = s?.sessionId ?? s?.id ?? null;
  if (Array.isArray(s?.configOptions)) configOptions = s.configOptions;
  await sleep(350); // let available_commands_update arrive
}

// ── window ────────────────────────────────────────────────────────────────────
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

// ── IPC ───────────────────────────────────────────────────────────────────────
ipcMain.on("lucid:prompt", async (e: IpcMainEvent, { id, text }: { id: string; text: string }) => {
  active = { id, wc: e.sender };
  try {
    await ensureSession();
    await acp!.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
  } catch (err) {
    send(active, { type: "token", text: `\n[agent error: ${String(err)}]` });
  }
  send(active, { type: "done" });
  active = null;
});

ipcMain.handle("lucid:config", async () => { await ensureSession(); return configOptions; });
ipcMain.handle("lucid:commands", async () => { await ensureSession(); return commands.map((c) => ({ name: c.name, description: c.description, hint: c.input?.hint })); });
ipcMain.handle("lucid:setConfig", async (_e, { configId, value }: { configId: string; value: string }) => {
  await ensureSession();
  const r: any = await acp!.request("session/set_config_option", { sessionId, configId, value }).catch(() => null);
  if (Array.isArray(r?.configOptions)) configOptions = r.configOptions;
  return configOptions;
});
ipcMain.handle("lucid:newSession", async () => {
  if (sessionId) await acp!.request("session/close", { sessionId }).catch(() => {});
  sessionId = null;
  await ensureSession();
});

ipcMain.on("lucid:win", (e, action: string) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w) return;
  if (action === "minimize") w.minimize();
  else if (action === "toggleMaximize") w.isMaximized() ? w.unmaximize() : w.maximize();
  else if (action === "close") w.close();
});

// ── lifecycle ──────────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  REPO = join(app.getAppPath(), "..");
  startDevServer();
  startAcp();
  ensureSession().catch(() => {}); // warm the session so config/commands are ready
  await waitForServer();
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("quit", () => { dev?.kill(); acp?.stop(); });
