// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Increment P-PLUGINS.2 (ADR-0462) - live smoke against a RUNNING dev engine.
//
// 1. Packs a tiny "hello-plugin" server fixture with the real packer and the REAL publisher key
//    (~/.omp/keys/lucid-plugin-publisher.key, baked into this build by `build_plugin.ts --init-key`).
// 2. Serves each package on a loopback http URL (the engine must run with LUCID_PLUGIN_DEV_LOOPBACK=1;
//    production downloads are https only).
// 3. Drives the engine's real HTTP routes: install-from-url -> start -> GET the plugin's health URL ->
//    list -> stop, and proves the hello plugin's server AND its grandchild are gone afterwards.
// Extra packages (e.g. the AgenticTrade187 build) are passed as --zip <path>.
//
//   bun desktop/scripts/demo_p_plugins_2.ts --engine http://127.0.0.1:5399 --token <LUCID_MAIN_TOKEN> [--zip <x.lplugin.zip>]...

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { readAllZipEntries } from "../../harness/personal/unzip.ts";
import type { PluginManifest, ServerEntry, DaemonEntry } from "../../harness/plugins/package.ts";
import { DEFAULT_KEY_PATH, buildPlugin, loadPrivateKey } from "../../tools/build_plugin.ts";
import { writeStage } from "../plugins/fixtures.ts";

const HELLO_JS = `
const http = require("http");
const { spawn } = require("child_process");
const kid = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000000)"], { stdio: "ignore", env: { ...process.env } });
http.createServer((req, res) => {
  if (req.url === "/api/health") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, id: process.env.LUCID_PLUGIN_ID, pid: process.pid, child: kid.pid, node: process.versions.node, electron: process.versions.electron || null, agentBin: process.env.LUCID_AGENT_BIN, data: process.env.LUCID_PLUGIN_DATA })); return; }
  res.writeHead(200, { "content-type": "text/html" }); res.end("<h1>hello from a LUCID plugin</h1>");
}).listen(Number(process.env.PORT), process.env.HOST);
`;

function args(): { engine: string; token: string; zips: string[] } {
  const a = process.argv.slice(2);
  const out = { engine: "", token: "", zips: [] as string[] };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--engine") out.engine = a[++i] ?? "";
    else if (a[i] === "--token") out.token = a[++i] ?? "";
    else if (a[i] === "--zip") out.zips.push(a[++i] ?? "");
    else throw new Error(`unknown argument ${a[i]}`);
  }
  if (!out.engine || !out.token) throw new Error("--engine and --token are required");
  return out;
}

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function main(): Promise<void> {
  const { engine, token, zips } = args();
  const api = async (path: string, body?: unknown): Promise<unknown> => {
    const res = await fetch(`${engine}${path}`, body === undefined
      ? { headers: { "x-lucid-token": token } }
      : { method: "POST", headers: { "x-lucid-token": token, "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await res.json() as { data?: unknown };
    return j.data ?? j;
  };

  const src = writeStage({ "LICENSE": "LUCID Premium Plugin License (smoke fixture)\n", "app/server.cjs": HELLO_JS }, {
    schema: 1, id: "hello-plugin", name: "Hello Plugin", version: "0.1.0", publisher: "TECHLEAD 187 LLC",
    license: "LUCID-Premium-Plugin-1.0", tier: "premium", section: "civilian", kind: "server",
    entry: { main: "app/server.cjs", healthPath: "/api/health" }, permissions: ["network:loopback", "fs:plugin-data"],
  });
  const built = buildPlugin({ src, out: mkdtempSync(join(tmpdir(), "lplugin-smoke-")), privateKey: loadPrivateKey(DEFAULT_KEY_PATH) });
  console.log(`built ${built.zipPath} (${built.bytes} bytes, signed by ${built.keyId})`);

  const packages = [built.zipPath, ...zips];
  const bytes = new Map(packages.map((p) => [basename(p), readFileSync(p)]));
  const host = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => {
    const b = bytes.get(decodeURIComponent(new URL(req.url).pathname.slice(1)));
    return b ? new Response(b) : new Response("not found", { status: 404 });
  } });

  let failed = false;
  try {
    for (const zip of packages) {
      const man = JSON.parse(readAllZipEntries(bytes.get(basename(zip))!, { maxTotalBytes: 1 << 30 }).find((e) => e.name === "lucid-plugin.json")!.data.toString()) as PluginManifest;
      console.log(`\n== ${man.id} ${man.version} (${man.kind})`);
      const url = `http://127.0.0.1:${host.port}/${encodeURIComponent(basename(zip))}`;
      const inst = await api("/api/plugins/install-from-url", { url, expectId: man.id });
      console.log("install:", JSON.stringify(inst));
      const start = await api("/api/plugins/start", { id: man.id }) as { ok: boolean; url?: string; error?: string };
      console.log("start:", JSON.stringify(start));
      if (!start.ok || !start.url) { failed = true; continue; }
      const port = new URL(start.url).port;
      const healthPath = man.kind === "web" ? "/" : (man.entry as ServerEntry | DaemonEntry).healthPath;
      const h = await fetch(`http://127.0.0.1:${port}${healthPath}`);
      const healthText = await h.text();
      console.log(`GET http://127.0.0.1:${port}${healthPath} -> ${h.status} ${healthText.slice(0, 400)}`);
      console.log("list:", JSON.stringify(await api("/api/plugins")));
      console.log("stop:", JSON.stringify(await api("/api/plugins/stop", { id: man.id })));
      const closed = await fetch(`http://127.0.0.1:${port}${healthPath}`).then(() => false, () => true);
      console.log(`port ${port} closed after stop: ${closed}`);
      if (man.id === "hello-plugin") {
        const pids = JSON.parse(healthText) as { pid: number; child: number };
        const deadline = Date.now() + 10_000;
        while ((alive(pids.pid) || alive(pids.child)) && Date.now() < deadline) await Bun.sleep(200);
        console.log(`server pid ${pids.pid} alive: ${alive(pids.pid)}; grandchild pid ${pids.child} alive: ${alive(pids.child)}`);
        if (alive(pids.pid) || alive(pids.child)) failed = true;
      }
      if (!h.ok || !closed) failed = true;
    }
  } finally {
    host.stop(true);
  }
  console.log(failed ? "\nSMOKE FAILED" : "\nSMOKE OK");
  process.exitCode = failed ? 1 : 0;
}

await main();
