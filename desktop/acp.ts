// desktop/acp.ts
//
// Minimal Agent Client Protocol client: drives `omp acp` over stdio
// (newline-delimited JSON-RPC 2.0). The handshake + capabilities are verified by
// tools/acp_probe.ts. The session/update → ChatEvent mapping follows the ACP
// spec; field shapes should be confirmed on the first real model turn (they
// could not be exercised headlessly).

import { spawn, type ChildProcess } from "node:child_process";

type Pending = { resolve: (v: any) => void; reject: (e: any) => void };

export class ACPClient {
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buf = "";

  /** notifications from the agent (e.g. "session/update"). */
  onNotify: (method: string, params: any) => void = () => {};
  /** agent→client requests we must answer (e.g. "session/request_permission"). */
  onRequest: (method: string, params: any) => Promise<any> = async () => ({});
  /** raw stderr (used to catch the gate's "[BLOCKED …]" line). */
  onStderr: (chunk: string) => void = () => {};
  onExit: (code: number | null) => void = () => {};

  constructor(private cmd: string, private args: string[], private cwd: string) {}

  start(): void {
    this.proc = spawn(this.cmd, this.args, { cwd: this.cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.proc.stdout!.on("data", (d) => this.onData(String(d)));
    this.proc.stderr!.on("data", (d) => this.onStderr(String(d)));
    this.proc.on("exit", (code) => this.onExit(code));
  }

  private onData(s: string): void {
    this.buf += s;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (line) this.handle(line);
    }
  }

  private async handle(line: string): Promise<void> {
    let msg: any;
    try { msg = JSON.parse(line); } catch { return; }

    // response to one of our requests
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (p) { this.pending.delete(msg.id); msg.error ? p.reject(msg.error) : p.resolve(msg.result); }
      return;
    }
    // request FROM the agent (needs a response)
    if (msg.method && msg.id !== undefined) {
      try { const result = await this.onRequest(msg.method, msg.params); this.write({ jsonrpc: "2.0", id: msg.id, result }); }
      catch (e) { this.write({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: String(e) } }); }
      return;
    }
    // notification
    if (msg.method) this.onNotify(msg.method, msg.params);
  }

  request<T = any>(method: string, params?: any): Promise<T> {
    const id = this.nextId++;
    const pr = new Promise<T>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.write({ jsonrpc: "2.0", id, method, params });
    return pr;
  }

  /** Send a JSON-RPC NOTIFICATION (no id, no response) — e.g. ACP `session/cancel`. */
  notify(method: string, params?: any): void {
    if (!this.proc) return;
    this.write({ jsonrpc: "2.0", method, params });
  }

  private write(o: unknown): void {
    this.proc?.stdin!.write(JSON.stringify(o) + "\n");
  }

  stop(): void { try { this.proc?.kill(); } catch { /* ignore */ } }
}
