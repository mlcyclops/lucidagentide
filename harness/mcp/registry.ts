// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/mcp/registry.ts
//
// P-AGENTFW.1 (ADR-0147): the registry of remote ACP agent runtimes (hermes / openclaw / any ACP agent)
// that LUCID connects to THROUGH the agent-firewall MCP proxy. One entry describes how to reach a remote
// agent (the command to spawn its ACP server, e.g. `hermes acp` or `openclaw acp --url … --token-file …`).
//
// CUSTODY (ADR-0147, mirrors ADR-0020 L1706): this file is written mode 0600 (dir ~/.omp 0700). It stores
// command/args, NOT secrets — the recommended pattern is `openclaw acp --token-file <path>` so the gateway
// token stays in the remote agent's own file and never lands here. Plaintext-at-0600 (like lucid-gui.json
// pre-P-MCP.2), not Electron safeStorage, because the omp-spawned firewall subprocess can't reach the
// Electron main-process crypto oracle.

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXE = process.platform === "win32" ? ".exe" : "";

/** The kind is a label used only for defaults / UI grouping; the connection is defined by command+args. */
export type RemoteAgentKind = "hermes" | "openclaw" | "acp";

/** One configured remote ACP agent reached through the firewall. */
export interface RemoteAgentEntry {
  id: string;
  name: string;
  kind: RemoteAgentKind;
  /** Executable that speaks ACP over stdio (e.g. "hermes", "openclaw", "npx"). */
  command: string;
  /** Args to that executable (e.g. ["acp"] or ["acp","--url","wss://…","--token-file","~/.openclaw/gw.token"]). */
  args: string[];
  /** Working directory for the spawned remote agent (defaults to the firewall's cwd). */
  cwd?: string;
  /** Extra environment for the remote agent process. NEVER put a raw secret here; prefer --token-file. */
  env?: Record<string, string>;
  /** Display/audit only: the endpoint the remote reaches (e.g. openclaw's wss gateway). */
  remoteUrl?: string;
  enabled: boolean;
}

/** The registry file. `LUCID_AGENTS_FILE` overrides it (test / custom-deployment seam). */
export function registryFile(): string {
  return process.env.LUCID_AGENTS_FILE || join(homedir(), ".omp", "lucid-agents.json");
}

/** The on-disk `lucid` launcher binary (P-EXT.4) — what omp spawns as the firewall's MCP command. */
export function lucidBinPath(): string {
  return join(HERE, "..", "..", "bin", `lucid${EXE}`);
}

/** Read the registry. Missing / corrupt / non-array file => []. */
export function listRemoteAgents(): RemoteAgentEntry[] {
  try {
    const parsed = JSON.parse(readFileSync(registryFile(), "utf8")) as { agents?: unknown };
    return Array.isArray(parsed?.agents) ? parsed.agents.filter(isEntry) : [];
  } catch {
    return [];
  }
}

export function getRemoteAgent(id: string): RemoteAgentEntry | undefined {
  return listRemoteAgents().find((a) => a.id === id);
}

/** Add or update (by id). Returns the stored entry. Persists at mode 0600. */
export function upsertRemoteAgent(e: {
  id?: string;
  name: string;
  kind?: RemoteAgentKind;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  remoteUrl?: string;
  enabled?: boolean;
}): RemoteAgentEntry {
  const agents = listRemoteAgents();
  const id = e.id?.trim() || `agent-${randomUUID().slice(0, 8)}`;
  const entry: RemoteAgentEntry = {
    id,
    name: e.name.trim() || "Remote agent",
    kind: e.kind ?? "acp",
    command: e.command.trim(),
    args: (e.args ?? []).map((a) => String(a)),
    cwd: e.cwd?.trim() || undefined,
    env: e.env && Object.keys(e.env).length ? e.env : undefined,
    remoteUrl: e.remoteUrl?.trim() || undefined,
    enabled: e.enabled ?? true,
  };
  const i = agents.findIndex((a) => a.id === id);
  if (i >= 0) agents[i] = entry; else agents.push(entry);
  save(agents);
  return entry;
}

export function removeRemoteAgent(id: string): void {
  save(listRemoteAgents().filter((a) => a.id !== id));
}

export function setRemoteAgentEnabled(id: string, enabled: boolean): void {
  const agents = listRemoteAgents();
  const e = agents.find((a) => a.id === id);
  if (e) { e.enabled = enabled; save(agents); }
}

/** The ACP `session/new.mcpServers` entries for ENABLED connections — each an `McpServerStdio` that spawns
 *  the firewall for that one connection (ADR-0147). omp discriminates stdio by the presence of `command`
 *  (no `url`, no `type`); env is the ACP `EnvVariable[]` shape. */
export function remoteAgentMcpServers(lucidBin: string = lucidBinPath()): Record<string, unknown>[] {
  const file = process.env.LUCID_AGENTS_FILE;
  const env = file ? [{ name: "LUCID_AGENTS_FILE", value: file }] : [];
  return listRemoteAgents()
    .filter((a) => a.enabled && a.command)
    .map((a) => ({
      name: `agentfw-${a.id}`,
      command: lucidBin,
      args: ["agent-firewall", "--conn", a.id],
      env,
    }));
}

function isEntry(v: unknown): v is RemoteAgentEntry {
  const o = v as Record<string, unknown> | null;
  return !!o && typeof o.id === "string" && typeof o.command === "string" && Array.isArray(o.args);
}

/** Persist the registry at mode 0600 (dir 0700). Best-effort chmod so an existing file is re-tightened. */
function save(agents: RemoteAgentEntry[]): void {
  const file = registryFile();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify({ agents }, null, 2), { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* best-effort */ }
}
