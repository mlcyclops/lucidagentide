// extensions/vscode/src/extension.ts
//
// P-EXT.2 (ADR-0038) — the VS Code extension. A THIN ACP client of the fail-closed `lucid acp`
// launcher (P-EXT.1): it locates the Lucid launcher, spawns `lucid acp` with the opened workspace
// folder as cwd, and drives the session over stdio. It NEVER spawns a raw agent command — the gate
// always rides inside `lucid acp` (invariants #3/#4). The ACP transport is the proven desktop client;
// launcher resolution + the gate's block signal come from the shared, tested harness module.

import * as vscode from "vscode";
import { existsSync } from "node:fs";
import { delimiter } from "node:path";
import { ACPClient } from "../../../desktop/acp.ts";
import { buildLauncherCandidates, mapAcpUpdate, parseBlockLine, resolveLauncher } from "../../../harness/launcher/ide_client.ts";

const DOWNLOAD_URL = "https://github.com/mlcyclops/lucidagentide/releases";
const PERMISSION_TIMEOUT_MS = 300_000; // 5 min, then fail-closed (deny)

export function activate(context: vscode.ExtensionContext): void {
  const provider = new LucidChatProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("lucid.chat", provider, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand("lucid.newSession", () => provider.newSession()),
    vscode.commands.registerCommand("lucid.stop", () => provider.stop()),
  );
}

export function deactivate(): void {}

/** Resolve the `lucid` launcher securely: explicit setting → installed app → PATH. Returns null if not
 *  found — the caller prompts to install Lucid and does NOT fall back to anything ungated. */
function resolveLucid(): string | null {
  const configPath = vscode.workspace.getConfiguration("lucid").get<string>("launcherPath", "");
  const pathDirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const candidates = buildLauncherCandidates({ configPath, env: process.env, pathDirs });
  return resolveLauncher(candidates, existsSync);
}

class LucidChatProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private acp?: ACPClient;
  private sessionId?: string;
  private starting?: Promise<boolean>;
  private permPending = new Map<string, (optionId: string | null) => void>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")] };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((m) => this.onMessage(m));
    view.onDidDispose(() => this.teardown());
  }

  // ── webview → extension ────────────────────────────────────────────────────
  private async onMessage(m: any): Promise<void> {
    switch (m?.type) {
      case "prompt": await this.prompt(String(m.text ?? "")); break;
      case "setMode": await this.setMode(String(m.modeId ?? "")); break;
      case "permission": this.resolvePermission(String(m.id ?? ""), m.optionId ?? null); break;
      case "stop": this.stop(); break;
      case "newSession": await this.newSession(); break;
    }
  }

  private post(msg: unknown): void { this.view?.webview.postMessage(msg); }

  // ── session lifecycle ──────────────────────────────────────────────────────
  private async ensureSession(): Promise<boolean> {
    if (this.acp && this.sessionId) return true;
    if (this.starting) return this.starting;
    this.starting = this.start();
    const ok = await this.starting;
    this.starting = undefined;
    return ok;
  }

  private async start(): Promise<boolean> {
    const lucid = resolveLucid();
    if (!lucid) {
      this.post({ type: "unavailable", reason: "The Lucid launcher wasn't found. Install LucidAgentIDE or set `lucid.launcherPath`." });
      const pick = await vscode.window.showErrorMessage("LucidAgentIDE launcher not found.", "Download", "Open Settings");
      if (pick === "Download") vscode.env.openExternal(vscode.Uri.parse(DOWNLOAD_URL));
      else if (pick === "Open Settings") vscode.commands.executeCommand("workbench.action.openSettings", "lucid.launcherPath");
      return false;
    }
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    const isolate = vscode.workspace.getConfiguration("lucid").get<boolean>("isolate", false);
    const args = isolate ? ["acp", "--isolate"] : ["acp"];

    const acp = new ACPClient(lucid, args, cwd);
    this.acp = acp;
    acp.onNotify = (method, params) => this.onNotify(method, params);
    acp.onRequest = (method, params) => this.onRequest(method, params);
    acp.onStderr = (chunk) => this.onStderr(chunk);
    acp.onExit = (code) => { this.post({ type: "unavailable", reason: `The agent exited (code ${code}). The gate or scanner may be unavailable — fail-closed.` }); this.teardown(); };

    try {
      acp.start();
      await acp.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
      const s: any = await acp.request("session/new", { cwd, mcpServers: {} });
      this.sessionId = s?.sessionId ?? s?.id;
      if (!this.sessionId) throw new Error("no sessionId from session/new");
      this.post({ type: "ready", modes: s?.modes ?? null, cwd });
      return true;
    } catch (e) {
      this.post({ type: "unavailable", reason: `Could not start the gated agent: ${String((e as Error)?.message ?? e)}` });
      this.teardown();
      return false;
    }
  }

  async newSession(): Promise<void> {
    this.teardown();
    this.post({ type: "cleared" });
    await this.ensureSession();
  }

  private teardown(): void {
    for (const [, fn] of this.permPending) fn(null); // fail-closed: deny any parked permission
    this.permPending.clear();
    try { this.acp?.stop(); } catch { /* ignore */ }
    this.acp = undefined; this.sessionId = undefined;
  }

  // ── turn ───────────────────────────────────────────────────────────────────
  private async prompt(text: string): Promise<void> {
    if (!text.trim()) return;
    if (!(await this.ensureSession())) return;
    this.post({ type: "turnStart" });
    try {
      await this.acp!.request("session/prompt", { sessionId: this.sessionId, prompt: [{ type: "text", text }] });
    } catch (e) {
      this.post({ type: "error", text: String((e as Error)?.message ?? e) });
    } finally {
      this.post({ type: "turnEnd" });
    }
  }

  private async setMode(modeId: string): Promise<void> {
    if (!modeId || !(await this.ensureSession())) return;
    try { await this.acp!.request("session/set_mode", { sessionId: this.sessionId, modeId }); } catch { /* best-effort */ }
  }

  stop(): void {
    try { if (this.acp && this.sessionId) this.acp.notify("session/cancel", { sessionId: this.sessionId }); } catch { /* ignore */ }
  }

  // ── agent → extension ────────────────────────────────────────────────────────
  private onNotify(method: string, params: any): void {
    if (method !== "session/update") return;
    const ev = mapAcpUpdate(params);
    if (ev.kind === "ignored") return;
    this.post({ type: "update", event: ev });
  }

  /** Agent→client requests. Ask-mode permission is forwarded to the webview, FAIL-CLOSED on timeout/
   *  close (cancelled = deny). Anything else is answered with an empty result. */
  private onRequest(method: string, params: any): Promise<any> {
    if (method !== "session/request_permission") return Promise.resolve({});
    const id = String(params?.toolCall?.toolCallId ?? params?.id ?? Math.random());
    const options = (params?.options ?? []).map((o: any) => ({ optionId: String(o.optionId ?? o.id), name: String(o.name ?? o.label ?? "Allow") }));
    this.post({ type: "permission", id, tool: String(params?.toolCall?.title ?? params?.tool ?? "tool"), options });
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.permPending.delete(id); resolve({ outcome: { outcome: "cancelled" } }); }, PERMISSION_TIMEOUT_MS);
      this.permPending.set(id, (optionId) => {
        clearTimeout(timer);
        resolve(optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } });
      });
    });
  }

  private resolvePermission(id: string, optionId: string | null): void {
    const fn = this.permPending.get(id);
    if (fn) { this.permPending.delete(id); fn(optionId); }
  }

  private onStderr(chunk: string): void {
    for (const line of chunk.split("\n")) {
      const b = parseBlockLine(line);
      if (b) this.post({ type: "block", tool: b.tool, severity: b.severity, findings: b.findings });
    }
  }

  // ── webview html (CSP + nonce; script/style from media/) ──────────────────────
  private html(webview: vscode.Webview): string {
    const nonce = Array.from({ length: 24 }, () => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 36)]).join("");
    const uri = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", f));
    return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${uri("chat.css")}"></head>
<body>
  <div id="banner" class="banner" hidden></div>
  <div id="log" class="log"></div>
  <div id="composer">
    <div class="modes"><button data-mode="plan">Plan</button><button data-mode="ask">Ask</button><button data-mode="agent" class="active">Agent</button></div>
    <textarea id="input" rows="3" placeholder="Ask the gated Lucid agent… (every tool call is scanned)"></textarea>
    <div class="row"><button id="send">Send</button><button id="stop">Stop</button><button id="new">New</button></div>
  </div>
  <script nonce="${nonce}" src="${uri("chat.js")}"></script>
</body></html>`;
  }
}
