// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Herd (ADR-0535): the side the IDE's plugin runtime starts. /healthz answers 200 only while instance
// main wins its nonce handshake, under the control plane's Host and Origin guards; the worker gets the
// add-on's data dir, the IDE's node_modules and data root, and never the runtime's host token.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { startHubControl, type HubControl } from "../../../harness/launcher/hub_control.ts";
import { instancePaths } from "../src/instance.ts";
import { ideBun, ideRepo, startHealthServer, workerEnv } from "../src/runtime_host.ts";

let data: string;
let port: number;
let health: Server;
let control: HubControl | null = null;

beforeEach(async () => {
  data = mkdtempSync(join(tmpdir(), "herd-runtime-"));
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  port = probe.port!;
  probe.stop(true);
  health = await startHealthServer(data, port);
});
afterEach(() => {
  control?.stop();
  control = null;
  health.close();
  rmSync(data, { recursive: true, force: true });
});

const get = (path: string, headers: Record<string, string> = {}) => fetch(`http://127.0.0.1:${port}${path}`, { headers });

describe("/healthz", () => {
  test("503 until instance main answers its handshake, then 200", async () => {
    expect((await get("/healthz")).status).toBe(503);
    control = startHubControl({ dir: instancePaths(data, "main").run, exec: async () => null });
    const res = await get("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, instance: "main", pid: process.pid });
  });

  test("another instance does not make the add-on healthy", async () => {
    control = startHubControl({ dir: instancePaths(data, "work").run, exec: async () => null });
    expect((await get("/healthz")).status).toBe(503);
  });

  test("a browser Origin is 403, other paths are 404, and the token never appears", async () => {
    control = startHubControl({ dir: instancePaths(data, "main").run, exec: async () => null });
    expect((await get("/healthz", { origin: "http://evil.example" })).status).toBe(403);
    expect((await get("/cmd")).status).toBe(404);
    expect(await (await get("/healthz")).text()).not.toContain(control.discovery.token);
  });
});

describe("the worker", () => {
  test("the IDE's bundled bun beside Electron, then ~/.bun, then PATH; Bun itself runs as is", () => {
    const win = "C:/Program Files/LucidAgentIDE/LucidAgentIDE.exe";
    const bundled = join("C:/Program Files/LucidAgentIDE", "resources", "runtimes", "bun.exe");
    expect(ideBun(win, "win32", false, (p) => p === bundled)).toBe(bundled);
    expect(ideBun(win, "win32", false, () => false)).toBe("bun.exe");
    expect(ideBun("/usr/local/bin/bun", "linux", true, () => false)).toBe("/usr/local/bin/bun");
    const mac = "/Applications/LucidAgentIDE.app/Contents/MacOS/LucidAgentIDE";
    expect(ideBun(mac, "darwin", false, (p) => p === join("/Applications/LucidAgentIDE.app/Contents/MacOS", "..", "Resources", "runtimes", "bun"))).toContain("Resources");
  });

  test("the IDE checkout: the packaged resources/repo, else a dev checkout above Electron", () => {
    const win = "C:/Program Files/LucidAgentIDE/LucidAgentIDE.exe";
    const packaged = join("C:/Program Files/LucidAgentIDE", "resources", "repo");
    expect(ideRepo(win, "win32", (p) => p === join(packaged, "node_modules"))).toBe(packaged);
    const dev = "/src/lucid";
    const electron = join(dev, "desktop", "node_modules", "electron", "dist", "electron");
    expect(ideRepo(electron, "linux", (p) => p === join(dev, "harness", "launcher") || p === join(dev, "node_modules"))).toBe(join(dev));
    expect(ideRepo(electron, "linux", () => false)).toBeNull();
  });

  test("env: the data dir and data root, the IDE's node_modules first, no host token, no run-as-node", () => {
    const dataDir = join("/home/u/.omp", "plugin-data", "herd");
    const env = workerEnv({ PATH: "/bin", LUCID_PLUGIN_HOST_TOKEN: "secret", ELECTRON_RUN_AS_NODE: "1", NODE_PATH: "/x", LUCID_HERD_REPO: "/r" }, dataDir, "/repo");
    expect(env.LUCID_PLUGIN_DATA).toBe(dataDir);
    expect(env.LUCID_DATA_ROOT).toBe(join("/home/u/.omp"));
    expect(env.NODE_PATH).toBe(`${join("/repo", "node_modules")}${delimiter}/x`);
    expect(env.PATH).toBe("/bin");
    expect("LUCID_PLUGIN_HOST_TOKEN" in env).toBe(false);
    expect("ELECTRON_RUN_AS_NODE" in env).toBe(false);
    expect("LUCID_HERD_REPO" in env).toBe(false); // attach only: the IDE's engine is the one to find
    expect(workerEnv({ LUCID_DATA_ROOT: "/d" }, dataDir, null)).toMatchObject({ LUCID_DATA_ROOT: "/d" });
  });
});
