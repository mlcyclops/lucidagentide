// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/local_agent_manifest.test.ts - P-LEGIBLE.1 (ADR-0384). The manifest is collected by endpoint
// tooling and may be forwarded to a cloud console, so the load-bearing property is what it must NEVER
// contain: a credential, an MCP header/arg/env, or a URL path/query.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_FLAVOR } from "./build_flavor.ts";
import { buildLocalAgentManifest, LOCAL_AGENT_MANIFEST_FILE, writeLocalAgentManifest, type ManifestInput } from "./local_agent_manifest.ts";

const input = (over: Partial<ManifestInput> = {}): ManifestInput => ({
  build: AGENT_FLAVOR,
  version: "9.9.9",
  port: 5319,
  hostExecutable: "LucidAgentIDE.exe",
  engineExecutable: "lucid-engine.exe",
  autoApprove: true,
  mcpServers: [],
  now: new Date("2026-09-23T00:00:00Z"),
  ...over,
});

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lucid-manifest-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

test("MCP secrets never reach the manifest: origin-only endpoints, basename-only commands", () => {
  const m = buildLocalAgentManifest(input({
    mcpServers: [
      // The exact shapes settings_store.mcpServersForAcp emits: http with a bearer header, stdio with args/env.
      { type: "http", name: "jira", url: "https://svc:hunter2@mcp.example.com:8443/v1/sse?api_key=SECRET-Q#frag", headers: [{ name: "Authorization", value: "Bearer SECRET-H" }] },
      { name: "agentfw-1", command: "C:\\Program Files\\LucidAgentIDE\\resources\\repo\\bin\\lucid.exe", args: ["agent-firewall", "--conn", "SECRET-A"], env: [{ name: "TOKEN", value: "SECRET-E" }] },
      { type: "sse", name: "broken", url: "not a url" },
    ],
  }));

  expect(m.mcpServers).toEqual([{ name: "jira", type: "http", endpoint: "https://mcp.example.com:8443" }]);
  expect(m.localMcps).toEqual([{ name: "agentfw-1", transportType: "stdio", commandName: "lucid.exe" }]);
  const json = JSON.stringify(m);
  for (const secret of ["hunter2", "SECRET", "/v1/sse", "Authorization", "agent-firewall", "Program Files"]) {
    expect(json).not.toContain(secret);
  }
});

test("autoApprove uses Defender's string vocabulary, and a standalone engine names no host", () => {
  const m = buildLocalAgentManifest(input({ autoApprove: false, hostExecutable: null, engineExecutable: "bun.exe" }));
  expect(m.autoApprove).toBe("false");
  expect(m.relatedProcess).toBeNull();
  expect(m.processes).toEqual(["bun.exe"]);
});

test("the writer round-trips the manifest and reports, rather than throws, when it cannot write", () => {
  const m = buildLocalAgentManifest(input());
  const ok = writeLocalAgentManifest(dir, m);
  expect(ok).toEqual({ ok: true, path: join(dir, LOCAL_AGENT_MANIFEST_FILE) });
  expect(JSON.parse(readFileSync(join(dir, LOCAL_AGENT_MANIFEST_FILE), "utf8"))).toEqual(m);

  const notADir = join(dir, "file");
  writeFileSync(notADir, "x");
  const bad = writeLocalAgentManifest(notADir, m);
  expect(bad.ok).toBe(false);
});
