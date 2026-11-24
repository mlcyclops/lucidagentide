// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_fleet_conn_1.ts
//
// P-FLEET.CONN1: proof, in this repo's own Electron, that a window holding more streams to the loopback engine than
// Chromium's six-per-host cap still gets its other requests answered once main.ts lifts the cap for 127.0.0.1.
//   1. A loopback server streams forever on /hang (like a working agent's NDJSON turn) and answers /quick at once.
//   2. A hidden Electron window opens 8 /hang streams, then times one /quick request.
//   3. Without the switch the /quick request is still waiting after 5 s (what froze Visualize at "0 agents" with
//      four agents working); with main.ts's exact switch value it answers.
// The switch value is read from main.ts, so the proof follows the shipped line.
//
// Run: bun run desktop/scripts/demo_p_fleet_conn_1.ts

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const desktop = join(import.meta.dir, "..");
const m = /appendSwitch\("ignore-connections-limit", "([^"]+)"\)/.exec(readFileSync(join(desktop, "main.ts"), "utf8"));
if (!m) throw new Error("main.ts does not lift the per-host connection cap");
const hosts = m[1]!;
const electron = join(desktop, "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron");

const server = Bun.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 0, fetch(req) {
  const p = new URL(req.url).pathname;
  if (p === "/hang") return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("{}\n")); } }), { headers: { "content-type": "application/x-ndjson" } });
  if (p === "/quick") return new Response("ok");
  return new Response(`<script>
    for (let i = 0; i < 8; i++) fetch("/hang?" + i).then((r) => r.body.getReader().read());
    setTimeout(async () => {
      const r = await Promise.race([fetch("/quick").then((x) => x.text()), new Promise((res) => setTimeout(() => res("PENDING"), 5000))]);
      document.title = "RESULT " + r;
    }, 1000);
  </script>`, { headers: { "content-type": "text/html" } });
} });

const dir = mkdtempSync(join(tmpdir(), "lucid-conn1-"));
const main = join(dir, "main.cjs");
writeFileSync(main, `const { app, BrowserWindow } = require("electron");
if (process.env.CONN1_HOSTS) app.commandLine.appendSwitch("ignore-connections-limit", process.env.CONN1_HOSTS);
app.setPath("userData", ${JSON.stringify(join(dir, "ud"))});
app.whenReady().then(() => {
  const w = new BrowserWindow({ show: false });
  w.loadURL("http://127.0.0.1:${server.port}/");
  const t = setInterval(() => { const s = w.getTitle(); if (s.startsWith("RESULT")) { console.log(s); clearInterval(t); app.quit(); } }, 100);
  setTimeout(() => { console.log("RESULT none"); app.quit(); }, 30000);
});
`);
// Async, never spawnSync: the loopback server above runs on this process's event loop.
const run = async (h: string): Promise<string> => {
  const env: Record<string, string | undefined> = { ...process.env, CONN1_HOSTS: h };
  delete env.ELECTRON_RUN_AS_NODE;
  const p = Bun.spawn([electron, main], { env, stdout: "pipe", stderr: "ignore" });
  const timer = setTimeout(() => p.kill(), 60_000);
  const out = await new Response(p.stdout).text();
  clearTimeout(timer);
  return /RESULT (\S+)/.exec(out)?.[1] ?? `no result (${await p.exited})`;
};
try {
  const capped = await run("");
  const lifted = await run(hosts);
  console.log(`8 open streams, then one quick request: without the switch -> ${capped}; with "${hosts}" -> ${lifted}`);
  if (capped !== "PENDING") throw new Error(`expected the capped window to queue the request, got ${capped} (has Chromium's limit changed?)`);
  if (lifted !== "ok") throw new Error(`the quick request still queued with the switch: ${lifted}`);
  console.log("P-FLEET.CONN1 passed: with main.ts's switch a window holding 8 streams to the loopback engine still gets answers.");
} finally {
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
}
