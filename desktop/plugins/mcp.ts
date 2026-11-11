// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/plugins/mcp.ts - P-PLUGINS.2 (ADR-0462 (6)): the MCP servers of RUNNING plugins.
//
// omp owns the MCP transport; the engine only hands it configs on session/new (ADR-0020). A plugin that
// declares `mcp` is registered here when it reaches health and removed when it stops, crashes, or is
// uninstalled; settings_store.mcpServersForAcp appends these entries, and the runtime respawns omp on
// every change so the agent's tool list matches what is actually running. In-memory on purpose: nothing
// stays registered for a plugin that is not running, including after an engine restart.

/** One ACP `McpServerStdio` entry: omp discriminates stdio by `command` (no url/type); env is EnvVariable[].
 *  A type alias (not an interface) so it stays assignable to the Record<string, unknown> ACP array. */
export type PluginMcpServer = {
  name: string;
  command: string;
  args: string[];
  env: { name: string; value: string }[];
};

const registered = new Map<string, PluginMcpServer>();

export function setPluginMcp(id: string, server: PluginMcpServer): void { registered.set(id, server); }

/** Remove one plugin's server. Returns whether anything was registered (so callers respawn only on change). */
export function removePluginMcp(id: string): boolean { return registered.delete(id); }

/** The entries for session/new.mcpServers, in a stable (id) order. */
export function pluginMcpServers(): PluginMcpServer[] {
  return [...registered.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, s]) => s);
}
