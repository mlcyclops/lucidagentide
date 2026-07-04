// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/mcp/acp_client.ts
//
// P-AGENTFW.1 (ADR-0135): a harness-side Agent Client Protocol client — the SAME line-delimited JSON-RPC
// transport as desktop/acp.ts, copied into the harness so the security core does not import the desktop
// shell (clean layering). The agent-firewall uses it to reach a remote ACP agent (hermes / openclaw): it
// spawns the remote's `… acp` command, runs the ACP handshake with LEAST PRIVILEGE (no client filesystem),
// drives session/new → session/prompt, and collects the streamed reply.
//
// Fail-closed posture: the remote's `session/request_permission` asks are DENIED (cancelled) — LUCID is not
// a confused deputy for the remote's privileged tools. A prompt that does not resolve within the timeout
// rejects, so the firewall returns an error result rather than hanging.

import { spawn, type ChildProcess } from "node:child_process";

/** The remote-connection spec the client spawns (a subset of RemoteAgentEntry). */
export interface RemoteAgentConn {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}

/** The assembled result of one remote prompt turn. */
export interface AcpPromptResult {
  /** Concatenated assistant message text. */
  text: string;
  /** Terminal stop reason from the ACP `session/prompt` result. */
  stopReason: string;
  /** Brief, human-readable lines describing the remote's tool activity (scanned as untrusted, like text). */
  toolActivity: string[];
}

/** The narrow capability the firewall depends on — lets tests inject a fake remote. */
export interface RemoteAgent {
  prompt(text: string): Promise<AcpPromptResult>;
  cancel(): void;
  stop(): void;
}

export interface AcpAgentClientOptions {
  /** Reject a prompt that has not resolved within this many ms. Default 120s. */
  promptTimeoutMs?: number;
  /** Best-effort log sink for the remote's stderr / lifecycle (never stdout). */
  onLog?: (line: string) => void;
}

interface PendingRpc {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

export class AcpAgentClient implements RemoteAgent {
  #proc: ChildProcess | null = null;
  #buf = "";
  #nextId = 1;
  #pending = new Map<number, PendingRpc>();
  #sessionId: string | null = null;
  #ready: Promise<void> | null = null;
  #promptTimeoutMs: number;
  #onLog: (line: string) => void;

  // Per-turn collectors, reset at the start of each prompt.
  #textChunks: string[] = [];
  #toolActivity: string[] = [];

  constructor(private readonly conn: RemoteAgentConn, opts: AcpAgentClientOptions = {}) {
    this.#promptTimeoutMs = opts.promptTimeoutMs ?? 120_000;
    this.#onLog = opts.onLog ?? (() => {});
  }

  async prompt(text: string): Promise<AcpPromptResult> {
    await this.#ensureSession();
    this.#textChunks = [];
    this.#toolActivity = [];
    const result = await this.#requestWithTimeout("session/prompt", {
      sessionId: this.#sessionId,
      prompt: [{ type: "text", text }],
    });
    let stopReason = "end_turn";
    if (typeof result === "object" && result !== null) {
      const r = result as Record<string, unknown>; // ACP session/prompt result object
      if (typeof r.stopReason === "string") stopReason = r.stopReason;
    }
    return { text: this.#textChunks.join(""), stopReason, toolActivity: this.#toolActivity.slice() };
  }

  /** Establish the ACP session (initialize + session/new) WITHOUT prompting, and return the remote's
   *  session id. Lets callers substantiate connectivity distinctly from a prompt turn (a prompt can fail
   *  on the remote's own model while the transport/handshake is provably fine). */
  async connect(): Promise<{ sessionId: string }> {
    await this.#ensureSession();
    return { sessionId: this.#sessionId ?? "" };
  }

  cancel(): void {
    if (this.#proc && this.#sessionId) this.#notify("session/cancel", { sessionId: this.#sessionId });
  }

  stop(): void {
    try { this.#proc?.kill(); } catch { /* ignore */ }
    this.#proc = null;
    this.#sessionId = null;
    this.#ready = null;
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────────────────────────────
  #ensureSession(): Promise<void> {
    if (this.#ready) return this.#ready;
    this.#ready = (async () => {
      this.#start();
      await this.#request("initialize", {
        protocolVersion: 1,
        // Least privilege: never offer the remote our client-side filesystem.
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      });
      // We hand the remote NO mcp servers (least privilege; openclaw rejects per-session mcpServers anyway).
      const s = await this.#request("session/new", { cwd: this.conn.cwd ?? process.cwd(), mcpServers: [] });
      if (typeof s === "object" && s !== null) {
        const r = s as Record<string, unknown>; // ACP session/new result object
        if (typeof r.sessionId === "string") this.#sessionId = r.sessionId;
        else if (typeof r.id === "string") this.#sessionId = r.id;
      }
      if (!this.#sessionId) throw new Error("remote ACP agent returned no session id");
    })();
    return this.#ready;
  }

  #start(): void {
    if (this.#proc) return;
    const proc = spawn(this.conn.command, this.conn.args, {
      cwd: this.conn.cwd ?? process.cwd(),
      env: { ...process.env, ...(this.conn.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#proc = proc;
    proc.stdout?.setEncoding("utf8");
    proc.stdout?.on("data", (d: string) => this.#onData(d));
    proc.stderr?.setEncoding("utf8");
    proc.stderr?.on("data", (d: string) => this.#onLog(d.trimEnd()));
    proc.on("exit", (code) => this.#die(`remote agent exited (code=${code})`));
    proc.on("error", (e) => this.#die(`remote agent spawn error: ${String(e)}`));
  }

  #die(why: string): void {
    const err = new Error(why);
    for (const [, p] of this.#pending) p.reject(err);
    this.#pending.clear();
    this.#proc = null;
    this.#sessionId = null;
    this.#ready = null;
  }

  // ── transport ─────────────────────────────────────────────────────────────────────────────────────
  #onData(chunk: string): void {
    this.#buf += chunk;
    let nl: number;
    while ((nl = this.#buf.indexOf("\n")) >= 0) {
      const line = this.#buf.slice(0, nl).trim();
      this.#buf = this.#buf.slice(nl + 1);
      if (line) this.#handle(line);
    }
  }

  #handle(line: string): void {
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { return; }
    if (typeof parsed !== "object" || parsed === null) return;
    const msg = parsed as Record<string, unknown>; // a parsed JSON-RPC object; fields narrowed below
    const id = typeof msg.id === "number" ? msg.id : undefined;
    const method = typeof msg.method === "string" ? msg.method : undefined;

    // Response to one of our requests.
    if (id !== undefined && method === undefined) {
      const p = this.#pending.get(id);
      if (!p) return;
      this.#pending.delete(id);
      if ("error" in msg) p.reject(msg.error);
      else p.resolve(msg.result);
      return;
    }
    // Request FROM the remote agent (needs a response).
    if (id !== undefined && method !== undefined) {
      this.#answer(id, method);
      return;
    }
    // Notification.
    if (method === "session/update") this.#onUpdate(msg.params);
  }

  /** Answer an agent→client request. All are DENIED/declined (fail-closed) — we grant the remote nothing. */
  #answer(id: number, method: string): void {
    if (method === "session/request_permission") {
      this.#write({ jsonrpc: "2.0", id, result: { outcome: { outcome: "cancelled" } } });
      return;
    }
    // Any other agent request (elicitation, fs, terminal) is declined with an empty result.
    this.#write({ jsonrpc: "2.0", id, result: {} });
  }

  #onUpdate(params: unknown): void {
    if (typeof params !== "object" || params === null) return;
    const p = params as Record<string, unknown>; // ACP session/update params
    const update = typeof p.update === "object" && p.update !== null ? (p.update as Record<string, unknown>) : p;
    const kind = typeof update.sessionUpdate === "string" ? update.sessionUpdate : "";
    if (kind === "agent_message_chunk") {
      const content = typeof update.content === "object" && update.content !== null ? (update.content as Record<string, unknown>) : null;
      if (content && content.type === "text" && typeof content.text === "string") this.#textChunks.push(content.text);
      return;
    }
    if (kind === "tool_call" || kind === "tool_call_update") {
      const title = typeof update.title === "string" ? update.title : typeof update.kind === "string" ? update.kind : "tool";
      const status = typeof update.status === "string" ? ` (${update.status})` : "";
      this.#toolActivity.push(`[remote-tool] ${title}${status}`);
    }
  }

  #request(method: string, params: unknown): Promise<unknown> {
    const id = this.#nextId++;
    const pr = new Promise<unknown>((resolve, reject) => this.#pending.set(id, { resolve, reject }));
    this.#write({ jsonrpc: "2.0", id, method, params });
    return pr;
  }

  #requestWithTimeout(method: string, params: unknown): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`remote ACP ${method} timed out after ${this.#promptTimeoutMs}ms`)), this.#promptTimeoutMs);
      this.#request(method, params).then(
        (v) => { clearTimeout(timer); resolve(v); },
        (e) => { clearTimeout(timer); reject(e); },
      );
    });
  }

  #notify(method: string, params: unknown): void {
    this.#write({ jsonrpc: "2.0", method, params });
  }

  #write(o: unknown): void {
    this.#proc?.stdin?.write(JSON.stringify(o) + "\n");
  }
}
