// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/local_agent_manifest.ts - P-LEGIBLE.1 (ADR-0384): the local-agent identity manifest.
//
// Microsoft Defender for Endpoint inventories local AI agents (Assets > AI agents > Local agents, the
// `AgentsInfo` advanced-hunting table with `Platform == "LocalAgents"`). An agent it does not recognize
// is invisible there, which in an Agent 365 shop reads as shadow AI. Defender's discovery list is
// maintained by Microsoft, and Microsoft publishes no vendor-writable manifest format or enrollment API,
// so no file we write enrolls us and nothing documents Defender reading this one. It is an ADVISORY,
// LUCID-defined file (schema `lucid.local-agent-manifest/1`) whose field names borrow the vocabulary of the profile
// Defender builds for supported agents (vendor, version, relatedProcess, autoApprove, mcpServers,
// localMcps). It sits at a stable per-user path (<userData>, e.g. %APPDATA%\lucidagentide-desktop for
// the standard build) so an endpoint admin can collect it (Intune remediation, live response, file
// inventory). The Windows NSIS uninstaller deletes it (desktop/build/installer.nsh); other install types
// have no uninstall hook, so collectors must pair it with a check that the executable is still installed.
//
// CONTENT RULE (issue #302 non-goal, the CUI egress concern): this file is METADATA ONLY. It never
// carries a prompt, a tool argument or result, file content, a credential, an MCP header, MCP args or
// env, or a URL path/query (those can embed tokens). Remote MCP endpoints are reduced to their origin
// and local MCP commands to their executable basename, which is what Defender itself reports.

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { BuildFlavorInfo } from "./build_flavor.ts";

export const LOCAL_AGENT_MANIFEST_FILE = "local-agent-manifest.json";
export const LOCAL_AGENT_MANIFEST_SCHEMA = "lucid.local-agent-manifest/1";
/** The publisher, as electron-builder stamps it (desktop/package.json `author` / linux `vendor`). */
export const LOCAL_AGENT_VENDOR = "TechLead 187 LLC";

/** Defender `McpServers` entry shape: name, type, endpoint. */
export interface ManifestRemoteMcp { name: string; type: string; endpoint: string }
/** Defender `localMcps` entry shape: name, transportType, commandName. */
export interface ManifestLocalMcp { name: string; transportType: "stdio"; commandName: string }

export interface LocalAgentManifest {
  schema: typeof LOCAL_AGENT_MANIFEST_SCHEMA;
  name: string;
  agentType: "agentic-ide";
  version: string;
  vendor: string;
  appId: string;
  productName: string;
  /** The process that hosts the agent (Defender `relatedProcess`). Null when the engine runs standalone. */
  relatedProcess: string | null;
  /** Every first-party process of a running install: the host, then the engine. */
  processes: string[];
  /** Defender reports this as the STRING "true"/"false", never a boolean. */
  autoApprove: "true" | "false";
  mcpServers: ManifestRemoteMcp[];
  localMcps: ManifestLocalMcp[];
  controlPlane: { bind: "127.0.0.1"; port: number; auth: "per-launch capability token (ADR-0024)" };
  runtimeProtection: {
    /** No UserPromptSubmit / PreToolUse / PostToolUse event interface is exposed to third parties. */
    agentNativeHooks: "none";
    /** Model traffic is TLS from the omp child or loopback-only for local models; Defender's network
     *  inspection cannot see pinned, HTTP/3, or loopback flows. */
    networkInspection: "not-effective";
  };
  content: "metadata-only";
  generatedAt: string;
}

export interface ManifestInput {
  build: BuildFlavorInfo;
  version: string;
  port: number;
  /** Basename of the Electron host executable, or null for a standalone engine. */
  hostExecutable: string | null;
  /** Basename of the running engine executable (lucid-engine[.exe] packaged, bun[.exe] in dev). */
  engineExecutable: string;
  autoApprove: boolean;
  /** The ACP `session/new.mcpServers` array (settings_store.mcpServersForAcp). Untrusted shape. */
  mcpServers: readonly Record<string, unknown>[];
  now: Date;
}

/** scheme://host[:port] of a URL, or null when it does not parse. Drops userinfo, path, query, fragment. */
function urlOrigin(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const u = new URL(raw.trim());
    return u.host ? `${u.protocol}//${u.host}` : null;
  } catch { return null; }
}

/** Split the ACP MCP array into Defender's remote/local lists, keeping only non-sensitive fields. */
export function manifestMcps(servers: readonly Record<string, unknown>[]): { mcpServers: ManifestRemoteMcp[]; localMcps: ManifestLocalMcp[] } {
  const mcpServers: ManifestRemoteMcp[] = [];
  const localMcps: ManifestLocalMcp[] = [];
  for (const s of servers) {
    const name = typeof s.name === "string" && s.name.trim() ? s.name.trim() : "unnamed";
    if (typeof s.command === "string" && s.command.trim()) {
      // Normalize `\` first: a Windows path must reduce to its basename on POSIX too.
      localMcps.push({ name, transportType: "stdio", commandName: basename(s.command.trim().replace(/\\/g, "/")) });
      continue;
    }
    const endpoint = urlOrigin(s.url);
    if (endpoint) mcpServers.push({ name, type: typeof s.type === "string" ? s.type : "http", endpoint });
  }
  return { mcpServers, localMcps };
}

export function buildLocalAgentManifest(i: ManifestInput): LocalAgentManifest {
  return {
    schema: LOCAL_AGENT_MANIFEST_SCHEMA,
    name: i.build.displayName,
    agentType: "agentic-ide",
    version: i.version,
    vendor: LOCAL_AGENT_VENDOR,
    appId: i.build.appId,
    productName: i.build.productName,
    relatedProcess: i.hostExecutable,
    processes: i.hostExecutable ? [i.hostExecutable, i.engineExecutable] : [i.engineExecutable],
    autoApprove: i.autoApprove ? "true" : "false",
    ...manifestMcps(i.mcpServers),
    controlPlane: { bind: "127.0.0.1", port: i.port, auth: "per-launch capability token (ADR-0024)" },
    runtimeProtection: { agentNativeHooks: "none", networkInspection: "not-effective" },
    content: "metadata-only",
    generatedAt: i.now.toISOString(),
  };
}

/** Write the manifest into `dir` via temp file + rename, so a collector never reads a torn file.
 *  Never throws: legibility is advisory, and a failed write must not affect the engine. */
export function writeLocalAgentManifest(dir: string, manifest: LocalAgentManifest): { ok: true; path: string } | { ok: false; error: string } {
  const path = join(dir, LOCAL_AGENT_MANIFEST_FILE);
  try {
    mkdirSync(dir, { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`);
    renameSync(tmp, path);
    return { ok: true, path };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
