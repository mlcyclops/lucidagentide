// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/mcp/registry.test.ts
//
// P-AGENTFW.1 (ADR-0147): the remote-agent registry — round-trip, the ACP McpServerStdio assembly shape,
// and the 0600 custody perms (the token-adjacent config must never be world-readable).

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listRemoteAgents, getRemoteAgent, upsertRemoteAgent, removeRemoteAgent, setRemoteAgentEnabled, remoteAgentMcpServers } from "./registry.ts";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lucid-agents-"));
  file = join(dir, "lucid-agents.json");
  process.env.LUCID_AGENTS_FILE = file;
});

afterEach(() => {
  delete process.env.LUCID_AGENTS_FILE;
  rmSync(dir, { recursive: true, force: true });
});

test("upsert persists a normalized entry; list + get see it", () => {
  const e = upsertRemoteAgent({ name: "hermes-prod", kind: "hermes", command: "hermes", args: ["acp"] });
  expect(e.id).toBeTruthy();
  expect(e.enabled).toBe(true);
  expect(listRemoteAgents()).toHaveLength(1);
  expect(getRemoteAgent(e.id)).toMatchObject({ name: "hermes-prod", command: "hermes", args: ["acp"], kind: "hermes" });
});

test("upsert with the same id updates in place (no duplicate)", () => {
  const e = upsertRemoteAgent({ name: "a", command: "hermes", args: ["acp"] });
  upsertRemoteAgent({ id: e.id, name: "renamed", command: "hermes", args: ["acp", "--url", "wss://x"] });
  const all = listRemoteAgents();
  expect(all).toHaveLength(1);
  expect(all[0]).toMatchObject({ id: e.id, name: "renamed", args: ["acp", "--url", "wss://x"] });
});

test("setRemoteAgentEnabled toggles; removeRemoteAgent deletes", () => {
  const e = upsertRemoteAgent({ name: "oc", kind: "openclaw", command: "openclaw", args: ["acp"] });
  setRemoteAgentEnabled(e.id, false);
  expect(getRemoteAgent(e.id)?.enabled).toBe(false);
  removeRemoteAgent(e.id);
  expect(listRemoteAgents()).toHaveLength(0);
});

test("remoteAgentMcpServers emits an McpServerStdio ONLY for enabled+command entries", () => {
  const on = upsertRemoteAgent({ name: "on", command: "hermes", args: ["acp"] });
  const off = upsertRemoteAgent({ name: "off", command: "openclaw", args: ["acp"], enabled: false });
  const servers = remoteAgentMcpServers("/abs/lucid");
  expect(servers).toHaveLength(1);
  expect(servers[0]).toEqual({
    name: `agentfw-${on.id}`,
    command: "/abs/lucid",
    args: ["agent-firewall", "--conn", on.id],
    // The test seam propagates LUCID_AGENTS_FILE so the spawned firewall reads the same registry.
    env: [{ name: "LUCID_AGENTS_FILE", value: file }],
  });
  expect(servers.some((s) => (s as { name: string }).name.includes(off.id))).toBe(false);
});

test("the registry file is written 0600 (never world-readable)", () => {
  upsertRemoteAgent({ name: "x", command: "hermes", args: ["acp"] });
  if (process.platform !== "win32") {
    expect(statSync(file).mode & 0o777).toBe(0o600);
  }
});
