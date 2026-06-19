// tools/acp_probe.ts
//
// Proves omp runs as an Agent Client Protocol (ACP) server — the exact seam an
// Electron / desktop front end (or an existing ACP client like acp-ui, Zed, or
// JetBrains) uses to drive omp. Spawns `omp acp`, performs the ACP `initialize`
// handshake over stdio (newline-delimited JSON-RPC 2.0), and prints the agent's
// advertised capabilities.
//
//   bun run acp:probe

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

function ompBin(): string {
  for (const c of [join(homedir(), ".bun", "bin", "omp.exe"), join(homedir(), ".bun", "bin", "omp")]) {
    if (existsSync(c)) return c;
  }
  return "omp";
}

const TIMEOUT_MS = 8000;

const proc = Bun.spawn([ompBin(), "acp"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", cwd: process.cwd() });

const request = {
  jsonrpc: "2.0",
  id: 0,
  method: "initialize",
  params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } },
};
proc.stdin.write(JSON.stringify(request) + "\n");
await proc.stdin.flush?.();

const dec = new TextDecoder();
let buf = "";
function findResponse(): any | undefined {
  for (const line of buf.split("\n")) {
    const s = line.trim();
    if (!s.startsWith("{")) continue;
    try {
      const o = JSON.parse(s);
      if (o.id === 0 && (o.result || o.error)) return o;
    } catch {
      /* partial line; keep reading */
    }
  }
  return undefined;
}

const resp = (await Promise.race([
  (async () => {
    for await (const chunk of proc.stdout) {
      buf += dec.decode(chunk);
      const r = findResponse();
      if (r) return r;
    }
    return findResponse();
  })(),
  new Promise((r) => setTimeout(() => r(undefined), TIMEOUT_MS)),
])) as any;

proc.kill();

if (!resp || !resp.result) {
  console.error(`✗ ACP initialize did not return a result within ${TIMEOUT_MS}ms.`);
  if (buf) console.error("raw stdout:", buf.slice(0, 500));
  process.exit(1);
}

const r = resp.result;
const cap = r.agentCapabilities ?? {};
const keys = (o: unknown) => (o && typeof o === "object" ? Object.keys(o as object).join(", ") : "-") || "-";

console.log("✓ omp speaks ACP (Agent Client Protocol) over stdio\n");
console.log(`  agent       : ${r.agentInfo?.name ?? "?"} ${r.agentInfo?.version ?? ""}`.trimEnd());
console.log(`  protocol    : v${r.protocolVersion}`);
console.log(`  auth        : ${(r.authMethods ?? []).map((a: any) => a.id).join(", ") || "(none)"}`);
console.log(`  loadSession : ${!!cap.loadSession}`);
console.log(`  sessions    : ${keys(cap.sessionCapabilities)}`);
console.log(`  prompt      : ${keys(cap.promptCapabilities)}`);
console.log(`  mcp         : ${keys(cap.mcpCapabilities)}`);
console.log("\n  → A desktop/Electron front end (or acp-ui / Zed / JetBrains) can drive omp");
console.log("    over this channel, reusing the credentials already configured under ~/.omp.");
process.exit(0);
