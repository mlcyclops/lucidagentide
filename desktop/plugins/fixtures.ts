// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/plugins/fixtures.ts - test fixtures for the P-PLUGINS.2 installer and runtime: a real stage
// directory packed by the real tools/build_plugin.ts with a throwaway Ed25519 key. Used by the tests only.

import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TrustedPackKey } from "../../harness/kb/pack.ts";
import type { GateDecision } from "../../harness/security/gate.ts";
import { buildPlugin } from "../../tools/build_plugin.ts";

export interface TestKey { privateKey: KeyObject; trusted: TrustedPackKey[] }

export function testKey(id = "test-publisher"): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privateKey, trusted: [{ id, key: publicKey }] };
}

export const CLEAN: GateDecision = { block: false, reason: "clean", trustLabel: "trusted", findings: [], failClosed: false };

/** A server plugin that records its pid and a grandchild's pid in LUCID_PLUGIN_DATA (so a test can prove
 *  the whole tree ends), answers /api/health with its id, and serves "hello" elsewhere. */
export const SERVER_JS = `
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const data = process.env.LUCID_PLUGIN_DATA;
const kid = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000000)"], { stdio: "ignore" });
fs.writeFileSync(path.join(data, "pids.json"), JSON.stringify({ server: process.pid, child: kid.pid }));
http.createServer((req, res) => {
  if (req.url === "/api/health") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, id: process.env.LUCID_PLUGIN_ID, agent: process.env.LUCID_AGENT_BIN, root: process.env.LUCID_PLUGIN_ROOT })); return; }
  res.writeHead(200, { "content-type": "text/plain" }); res.end("hello");
}).listen(Number(process.env.PORT), process.env.HOST);
`;

export function writeStage(files: Record<string, string>, manifest: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "lplugin-stage-"));
  writeFileSync(join(dir, "lucid-plugin.json"), JSON.stringify(manifest, null, 2));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  return dir;
}

export function serverManifest(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 1, id: "fixture-server", name: "Fixture Server", version: "0.1.0", publisher: "TECHLEAD 187 LLC",
    license: "LUCID-Premium-Plugin-1.0", tier: "premium", section: "civilian", kind: "server",
    entry: { main: "app/server.cjs", healthPath: "/api/health" },
    mcp: { command: "node", args: ["app/mcp.cjs"] },
    ai: { provider: "lucid" },
    permissions: ["network:loopback", "fs:plugin-data"],
    ...over,
  };
}

/** Build the fixture server plugin with the real packer; returns the zip bytes. */
export function buildServerFixture(key: TestKey | null, over: Record<string, unknown> = {}, extra: Record<string, string> = {}): Buffer {
  const src = writeStage({ "LICENSE": "LUCID Premium Plugin License (test fixture)\n", "app/server.cjs": SERVER_JS, "app/mcp.cjs": "process.stdin.resume();\n", ...extra }, serverManifest(over));
  const out = mkdtempSync(join(tmpdir(), "lplugin-out-"));
  return readFileSync(buildPlugin({ src, out, privateKey: key?.privateKey }).zipPath);
}
