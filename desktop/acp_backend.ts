// desktop/acp_backend.ts
//
// A real omp-ACP-backed chat/config singleton for the dev server. This is what
// makes the browser build produce GENUINE model replies (not a simulation):
// dev.ts exposes /api/chat, /api/config, etc. over it. It spawns
// `omp acp -e harness/omp/security_extension.ts`, so the security gate is loaded
// on the chat path here too. The wire format was captured from a live omp turn
// (DECISIONS ADR-0006).

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ACPClient } from "./acp.ts";
import { currentWorkspace } from "./workspace.ts";

const REPO = join(import.meta.dir, "..");
// Absolute so the gate loads from THIS repo even when omp runs in another workspace.
const GATE = join(REPO, "harness", "omp", "security_extension.ts");
function ompBin(): string {
  for (const c of [join(homedir(), ".bun", "bin", "omp.exe"), join(homedir(), ".bun", "bin", "omp")]) if (existsSync(c)) return c;
  return "omp";
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type ChatEvent =
  | { type: "token"; text: string }
  | { type: "tool"; name: string; detail: string }
  | { type: "block"; tool: string; reason: string; severity: string; findings: string }
  | { type: "usage"; used: number; size: number; cost: number }
  | { type: "done" };

class Backend {
  private acp: ACPClient | null = null;
  private sessionId: string | null = null;
  private starting: Promise<void> | null = null;
  private listener: ((e: ChatEvent) => void) | null = null;
  configOptions: any[] = [];
  commands: any[] = [];

  private emit(e: ChatEvent): void { this.listener?.(e); }

  private async start(): Promise<void> {
    if (this.acp) return;
    if (!this.starting) {
      this.starting = (async () => {
        const acp = new ACPClient(ompBin(), ["acp", "-e", GATE], currentWorkspace());
        acp.onNotify = (method, params) => {
          if (method !== "session/update") return;
          const u = params?.update ?? params;
          switch (u?.sessionUpdate) {
            case "agent_message_chunk": if (u.content?.type === "text") this.emit({ type: "token", text: u.content.text }); break;
            case "tool_call": this.emit({ type: "tool", name: String(u.kind ?? u.title ?? "tool"), detail: String(u.title ?? u.rawInput?.command ?? "") }); break;
            case "tool_call_update": if (u.status === "failed" || u.status === "rejected") this.emit({ type: "block", tool: String(u.kind ?? "tool"), reason: "blocked by the security gate", severity: "high", findings: "" }); break;
            case "usage_update": this.emit({ type: "usage", used: Number(u.used ?? 0), size: Number(u.size ?? 0), cost: Number(u.cost?.amount ?? 0) }); break;
            case "available_commands_update": this.commands = u.availableCommands ?? []; break;
            case "config_option_update": if (u.configOptions) this.configOptions = u.configOptions; break;
          }
        };
        acp.onRequest = async (m, params) => {
          if (m === "session/request_permission") {
            const opts: any[] = params?.options ?? [];
            const a = opts.find((o) => /allow/i.test(o.kind ?? o.optionId ?? "")) ?? opts[0];
            return a ? { outcome: { outcome: "selected", optionId: a.optionId } } : { outcome: { outcome: "cancelled" } };
          }
          return {};
        };
        acp.onStderr = (chunk) => {
          for (const line of chunk.split("\n")) {
            const m = /\[BLOCKED tool_call:(\w+)\].*?severity=(\w+).*?findings=([^\s]+)/.exec(line);
            if (m) this.emit({ type: "block", tool: m[1]!, reason: "hidden-Unicode content quarantined", severity: m[2]!, findings: m[3]! });
          }
        };
        acp.start();
        await acp.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } });
        this.acp = acp;
      })();
    }
    await this.starting;
  }

  private async ensureSession(): Promise<void> {
    await this.start();
    if (this.sessionId) return;
    const s: any = await this.acp!.request("session/new", { cwd: currentWorkspace(), mcpServers: [] });
    this.sessionId = s?.sessionId ?? s?.id ?? null;
    if (Array.isArray(s?.configOptions)) this.configOptions = s.configOptions;
    await sleep(350); // let available_commands_update arrive
  }

  async getConfig(): Promise<any[]> { await this.ensureSession(); return this.configOptions; }
  async getCommands(): Promise<any[]> { await this.ensureSession(); return this.commands.map((c) => ({ name: c.name, description: c.description, hint: c.input?.hint })); }
  async setConfig(configId: string, value: string): Promise<any[]> {
    await this.ensureSession();
    const r: any = await this.acp!.request("session/set_config_option", { sessionId: this.sessionId, configId, value }).catch(() => null);
    if (Array.isArray(r?.configOptions)) this.configOptions = r.configOptions;
    return this.configOptions;
  }
  async newSession(): Promise<void> {
    await this.start();
    if (this.sessionId) await this.acp!.request("session/close", { sessionId: this.sessionId }).catch(() => {});
    this.sessionId = null;
    await this.ensureSession();
  }

  /** Tear down the omp process so the next call respawns it (e.g. after an API
   *  key changes — the new env is picked up on the fresh spawn). */
  restart(): void {
    try { this.acp?.stop(); } catch { /* ignore */ }
    this.acp = null; this.starting = null; this.sessionId = null; this.listener = null;
  }

  /** Run one turn, streaming events to onEvent; resolves after `done`. */
  async prompt(text: string, onEvent: (e: ChatEvent) => void): Promise<void> {
    this.listener = onEvent;
    try {
      await this.ensureSession();
      await this.acp!.request("session/prompt", { sessionId: this.sessionId, prompt: [{ type: "text", text }] });
    } catch (e) {
      onEvent({ type: "token", text: `\n[agent unavailable: ${String((e as any)?.message ?? e)}]` });
    }
    onEvent({ type: "done" });
    this.listener = null;
  }
}

export const backend = new Backend();
