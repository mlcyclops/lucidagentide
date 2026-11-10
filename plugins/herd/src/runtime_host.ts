// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Herd (ADR-0541): what the IDE's plugin runtime starts (Plugins drawer, Herd, Open). The runtime runs
// a server plugin's `entry.main` under Electron's own Node (desktop/plugins/runtime.ts, asNode), so
// this side uses Node APIs only. The hub itself is Bun code (Bun.serve, pi-tui), so the runtime host
// does three things:
//   1. serves `GET /healthz` on the runtime's PORT (loopback Host, no Origin): 200 once instance
//      `main` answers its nonce handshake, 503 before;
//   2. serves the read-only GUI mirror of instance `main` on the same PORT (gui_server.ts, ADR-0497):
//      the page the IDE opens in Herd's Preview tab, with live updates, never an approval or a prompt;
//   3. runs instance `main` as `<IDE bun> <package>/client.js server start` with the add-on's data dir,
//      unless a verified `main` already runs (started earlier by `lucid herd`): that one is adopted,
//      never stopped by the drawer, because the drawer did not start it.
// The worker ends when the runtime stops the plugin (its tree kill takes the worker too); the worker
// ending ends this process, which the runtime reports. The runtime gives no engine checkout, so the
// worker only attaches to the IDE's own engine (it never spawns one here).

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { guardRequest, MIRROR_ASSETS, MIRROR_HEADERS, MirrorFeed, readMirror, type MirrorSink } from "./gui_server.ts";
import { connectInstance, DEFAULT_INSTANCE } from "./instance.ts";

type Env = Readonly<Record<string, string | undefined>>;

/** The bun that runs the worker: this process when it already is Bun, else the IDE's bundled runtime
 *  (`<resources>/runtimes/bun[.exe]`, beside the Electron executable that runs this file), else the
 *  user's ~/.bun, else `bun` on PATH. */
export function ideBun(execPath: string, platform: string, isBun: boolean, exists: (p: string) => boolean = existsSync): string {
  if (isBun) return execPath;
  const exe = platform === "win32" ? "bun.exe" : "bun";
  const resources = platform === "darwin" ? join(dirname(execPath), "..", "Resources") : join(dirname(execPath), "resources");
  return [join(resources, "runtimes", exe), join(homedir(), ".bun", "bin", exe)].find(exists) ?? exe;
}

/** The IDE checkout whose node_modules client.js loads its npm packages from (the packaged
 *  `<resources>/repo`, or a dev checkout above an unpackaged Electron), or null. */
export function ideRepo(execPath: string, platform: string, exists: (p: string) => boolean = existsSync): string | null {
  const resources = platform === "darwin" ? join(dirname(execPath), "..", "Resources") : join(dirname(execPath), "resources");
  const packaged = join(resources, "repo");
  if (exists(join(packaged, "node_modules"))) return packaged;
  // Dev: <repo>/desktop/node_modules/electron/dist/electron(.exe), or .../Electron.app/Contents/MacOS/Electron.
  for (let dir = dirname(execPath), i = 0; i < 8 && dirname(dir) !== dir; i++, dir = dirname(dir)) {
    if (exists(join(dir, "harness", "launcher")) && exists(join(dir, "node_modules"))) return dir;
  }
  return null;
}

/** The worker's environment: the runtime's allowlisted env, minus what only this process needs (the
 *  host token, Electron's run-as-node switch), plus the data root the engine discovery and the
 *  classic seed read (the runtime passes no LUCID_DATA_ROOT; its data dir is
 *  `<data root>/plugin-data/herd`) and the IDE's node_modules on NODE_PATH (client.js keeps its npm
 *  packages external). No LUCID_HERD_REPO: here the worker attaches to the IDE's engine only. */
export function workerEnv(env: Env, data: string, repo: string | null): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...env, LUCID_PLUGIN_DATA: data, LUCID_DATA_ROOT: env.LUCID_DATA_ROOT || dirname(dirname(data)) };
  if (repo !== null) out.NODE_PATH = env.NODE_PATH ? `${join(repo, "node_modules")}${delimiter}${env.NODE_PATH}` : join(repo, "node_modules");
  delete out.LUCID_PLUGIN_HOST_TOKEN;
  delete out.ELECTRON_RUN_AS_NODE;
  delete out.LUCID_HERD_REPO;
  return out;
}

/** The runtime's PORT: `GET /healthz` (200 while instance main answers its handshake, else 503) and
 *  the read-only GUI mirror of instance main (gui_server.ts, ADR-0497), all behind guardRequest: a
 *  loopback Host, GET only, no foreign Origin, and the runtime's host token on /host/*. */
export function startRuntimeServer(data: string, port: number, hostToken: string | null): Promise<Server> {
  const feed = new MirrorFeed(() => readMirror(data, DEFAULT_INSTANCE));
  const server = createServer((req, res) => {
    const json = (status: number, body: unknown) => res.writeHead(status, { ...MIRROR_HEADERS, "content-type": "application/json" }).end(JSON.stringify(body));
    const verdict = guardRequest({ method: req.method, url: req.url, host: req.headers.host, origin: req.headers.origin, token: req.headers["x-lucid-host-token"] }, port, hostToken);
    if (!verdict.ok) { json(verdict.status, { error: verdict.error }); return; }
    switch (verdict.route) {
      case "health":
        void connectInstance(data, DEFAULT_INSTANCE).then((hub) => json(hub ? 200 : 503, hub ? { ok: true, instance: DEFAULT_INSTANCE, pid: hub.pid } : { ok: false, instance: DEFAULT_INSTANCE }));
        return;
      case "page": case "script": case "style": {
        const asset = MIRROR_ASSETS[verdict.route];
        res.writeHead(200, { ...MIRROR_HEADERS, "content-type": asset.type }).end(asset.body);
        return;
      }
      case "state": case "host-state":
        void readMirror(data, DEFAULT_INSTANCE).then((s) => json(200, s), () => json(502, { error: "unavailable" }));
        return;
      case "events": {
        const sink: MirrorSink = { send: (chunk) => { if (!res.destroyed && !res.writableEnded) res.write(chunk); } };
        const unsubscribe = feed.subscribe(sink);
        if (!unsubscribe) { json(429, { error: "too_many_viewers" }); return; }
        res.writeHead(200, { ...MIRROR_HEADERS, "content-type": "text/event-stream; charset=utf-8", connection: "keep-alive" });
        res.write("retry: 3000\n\n");
        res.once("close", unsubscribe); // the page went away (the response's close, not the request's)
        return;
      }
    }
  });
  const ready = Promise.withResolvers<Server>();
  server.once("error", ready.reject);
  server.listen(port, "127.0.0.1", () => ready.resolve(server));
  return ready.promise;
}

/** The runtime entry (server.js). Returns the exit code once the worker has ended. */
export async function runRuntimeHost(env: Env): Promise<number> {
  const port = Number(env.PORT);
  const data = env.LUCID_PLUGIN_DATA;
  const root = env.LUCID_PLUGIN_ROOT;
  if (!data || !root || !Number.isInteger(port) || port <= 0 || port > 65535) {
    process.stderr.write("[herd] server.js is started by the IDE's plugin runtime (Plugins, Free, Herd, Open). In a terminal, run `lucid herd`.\n");
    return 2;
  }
  const health = await startRuntimeServer(data, port, env.LUCID_PLUGIN_HOST_TOKEN || null);
  const adopted = await connectInstance(data, DEFAULT_INSTANCE);
  if (adopted) {
    process.stdout.write(`[herd] instance main already runs (pid ${adopted.pid}); serving its health and its read-only view only\n`);
    const closed = Promise.withResolvers<number>();
    for (const sig of ["SIGTERM", "SIGINT"] as const) process.once(sig, () => { health.close(); closed.resolve(0); });
    return closed.promise;
  }
  const bun = ideBun(process.execPath, process.platform, process.versions.bun !== undefined);
  const repo = ideRepo(process.execPath, process.platform);
  const worker: ChildProcess = spawn(bun, [join(root, "client.js"), "server", "start"], { env: workerEnv(env, data, repo), stdio: ["ignore", "inherit", "inherit"], windowsHide: true });
  const ended = Promise.withResolvers<number>();
  worker.once("error", (e) => { process.stderr.write(`[herd] could not start the Herd server with ${bun}: ${e.message}\n`); ended.resolve(1); });
  worker.once("exit", (code) => ended.resolve(code ?? 1));
  const forward = (sig: "SIGTERM" | "SIGINT") => { try { worker.kill(sig); } catch { /* gone */ } };
  for (const sig of ["SIGTERM", "SIGINT"] as const) process.once(sig, () => forward(sig));
  const code = await ended.promise;
  health.close();
  return code;
}
