// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/plugins/ports.ts - P-PLUGINS.2 (ADR-0462): the loopback port range plugins live in. Shared by
// the engine's runtime (desktop/plugins/runtime.ts, Bun) and Electron main's navigation policy
// (desktop/navigation_policy.ts, Node), so this file stays dependency-free.

export const PLUGIN_PORT_MIN = 47100;
export const PLUGIN_PORT_MAX = 47899;

/** The plugin origin of `url` (http on localhost or 127.0.0.1, a port in the plugin range), or null. */
export function pluginOrigin(url: unknown): string | null {
  if (typeof url !== "string") return null;
  try {
    const u = new URL(url);
    const port = Number(u.port);
    if (u.protocol !== "http:" || (u.hostname !== "localhost" && u.hostname !== "127.0.0.1")) return null;
    return port >= PLUGIN_PORT_MIN && port <= PLUGIN_PORT_MAX ? u.origin : null;
  } catch { return null; }
}
