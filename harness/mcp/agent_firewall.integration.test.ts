// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/mcp/agent_firewall.integration.test.ts
//
// P-AGENTFW.1 (ADR-0147) END-TO-END: the firewall driving a REAL remote-agent subprocess over the actual
// AcpAgentClient stdio transport (a faithful fake `hermes acp`, testing/fake_acp_agent.ts) — not the
// in-process fake used by the unit tests. Proves: handshake yields a session id; a clean reply round-trips
// as delimited UNTRUSTED_CONTENT; a poisoned reply is quarantined + withheld; a breakout attempt is
// neutralized; the remote's permission ask is denied — all across a live process boundary, plus the whole
// MCP protocol chain. A gated case connects to the REAL hermes binary when LUCID_LIVE_HERMES=1.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import { ScannerClient } from "../security/scanner_client.ts";
import { AgentFirewall } from "./agent_firewall.ts";
import { AcpAgentClient } from "./acp_client.ts";
import { McpStdioServer, type McpTool } from "./mcp_server.ts";

const ZWSP = String.fromCodePoint(0x200b);
const FAKE = join(import.meta.dir, "testing", "fake_acp_agent.ts");
const TIMEOUT = 20_000;

let scanner: ScannerClient;
beforeAll(() => { scanner = new ScannerClient({ timeoutMs: 4000 }); scanner.start(); });
afterAll(() => { scanner.stop(); });

function fakeClient(mode: string): AcpAgentClient {
  return new AcpAgentClient({ command: "bun", args: [FAKE], env: { FAKE_ACP_MODE: mode } }, { promptTimeoutMs: 15_000 });
}

function firewallFor(remote: AcpAgentClient) {
  return new AgentFirewall({ scanner, remote, connName: "hermes-int", connKind: "hermes" });
}

test("handshake over real stdio: connect() returns the remote session id", async () => {
  const c = fakeClient("clean");
  try {
    const { sessionId } = await c.connect();
    expect(sessionId).toBe("fake-session-1");
  } finally { c.stop(); }
}, TIMEOUT);

test("clean reply round-trips as delimited UNTRUSTED_CONTENT (incl. scanned tool activity)", async () => {
  const c = fakeClient("clean");
  try {
    const r = await firewallFor(c).handlePrompt("ping");
    const text = r.content[0]?.text ?? "";
    expect(r.isError).toBeFalsy();
    expect(text).toContain("UNTRUSTED_CONTENT_START");
    expect(text).toContain("UNTRUSTED_CONTENT_END");
    expect(text).toContain("Hello from the fake hermes agent. You said: ping");
    expect(text).toContain('trust="untrusted"');
    expect(text).toContain("[remote-tool] search"); // the remote's tool activity flowed through, scanned
  } finally { c.stop(); }
}, TIMEOUT);

test("poisoned remote reply is quarantined and WITHHELD across the process boundary", async () => {
  const c = fakeClient("poison");
  try {
    const r = await firewallFor(c).handlePrompt("ping");
    const text = r.content[0]?.text ?? "";
    expect(r.isError).toBe(true);
    expect(text).not.toContain(ZWSP);
    expect(text).not.toContain("payload smuggled");
    expect(text.toLowerCase()).toMatch(/withheld|quarantin/);
  } finally { c.stop(); }
}, TIMEOUT);

test("a real remote embedding the closing delimiter is neutralized (no breakout)", async () => {
  const c = fakeClient("breakout");
  try {
    const r = await firewallFor(c).handlePrompt("ping");
    const text = r.content[0]?.text ?? "";
    expect(r.isError).toBeFalsy();
    expect(text.split("UNTRUSTED_CONTENT_END").length).toBe(2); // only the real envelope closer remains
    expect(text).toContain("[lucid-neutralized-delimiter]");
  } finally { c.stop(); }
}, TIMEOUT);

test("the remote's session/request_permission is DENIED over the real transport", async () => {
  const c = fakeClient("permission");
  try {
    const r = await firewallFor(c).handlePrompt("do something dangerous");
    const text = r.content[0]?.text ?? "";
    expect(r.isError).toBeFalsy();
    // The fake agent echoes the outcome our client returned; we always deny → cancelled.
    expect(text).toContain("cancelled");
  } finally { c.stop(); }
}, TIMEOUT);

test("full MCP chain: tools/call → firewall → real subprocess → delimited result", async () => {
  const c = fakeClient("clean");
  try {
    const lines: Array<Record<string, unknown>> = [];
    const waiters = new Map<number, (v: Record<string, unknown>) => void>();
    const tools: McpTool[] = firewallFor(c).tools();
    const server = new McpStdioServer({
      serverInfo: { name: "lucid-agent-firewall", version: "1" },
      tools,
      write: (line) => {
        const msg = JSON.parse(line) as Record<string, unknown>;
        lines.push(msg);
        const id = msg.id;
        if (typeof id === "number" && waiters.has(id)) { waiters.get(id)!(msg); waiters.delete(id); }
      },
    });
    const send = (id: number, method: string, params?: unknown): Promise<Record<string, unknown>> => {
      const existing = lines.find((l) => l.id === id);
      const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
      if (existing) resolve(existing); else waiters.set(id, resolve);
      server.feed(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      return promise;
    };
    await send(1, "initialize", { protocolVersion: "2025-06-18" });
    const call = (await send(2, "tools/call", { name: "prompt", arguments: { prompt: "hi" } })).result as { content: Array<{ text: string }> };
    const text = call.content[0]?.text ?? "";
    expect(text).toContain("UNTRUSTED_CONTENT_START");
    expect(text).toContain("Hello from the fake hermes agent");
  } finally { c.stop(); }
}, TIMEOUT);

// Live proof against the REAL hermes ACP binary. Off by default (network + install); run with
// LUCID_LIVE_HERMES=1. Uses `uvx --from 'hermes-agent[acp]' hermes-acp` (the official ACP entrypoint).
// Asserts only the handshake — a prompt depends on the user's configured hermes model being reachable.
const LIVE = process.env.LUCID_LIVE_HERMES === "1";
test.skipIf(!LIVE)("live: real hermes acp handshake yields a session id", async () => {
  const c = new AcpAgentClient({ command: "uvx", args: ["--from", "hermes-agent[acp]", "hermes-acp"] }, { promptTimeoutMs: 90_000 });
  try {
    const { sessionId } = await c.connect();
    expect(sessionId.length).toBeGreaterThan(0);
  } finally { c.stop(); }
}, 120_000);

// Live proof against the REAL openclaw ACP bridge. Off by default; run with LUCID_LIVE_OPENCLAW=1 AND a
// reachable OpenClaw Gateway (e.g. `openclaw gateway run --dev --auth none --port 18789`). openclaw acp is
// a gateway BRIDGE, so it needs a live gateway; pass connect args via OPENCLAW_ACP_ARGS (e.g. "--url
// wss://host:18789 --token-file ~/.openclaw/gw.token") when not using the default loopback:18789.
const LIVE_OC = process.env.LUCID_LIVE_OPENCLAW === "1";
test.skipIf(!LIVE_OC)("live: real openclaw acp handshake (via a gateway) yields a session id", async () => {
  const extra = (process.env.OPENCLAW_ACP_ARGS ?? "").split(" ").filter(Boolean);
  const c = new AcpAgentClient({ command: "openclaw", args: ["acp", ...extra] }, { promptTimeoutMs: 45_000 });
  try {
    const { sessionId } = await c.connect();
    expect(sessionId.length).toBeGreaterThan(0);
  } finally { c.stop(); }
}, 60_000);
