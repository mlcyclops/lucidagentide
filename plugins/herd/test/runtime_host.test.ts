// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Herd (ADR-0541): the side the IDE's plugin runtime starts. /healthz answers 200 only while instance
// main wins its nonce handshake, under the control plane's Host and Origin guards; the worker gets the
// add-on's data dir, the IDE's node_modules and data root, and never the runtime's host token.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { startHubControl, type HubControl } from "../../../harness/launcher/hub_control.ts";
import { instancePaths } from "../src/instance.ts";
import { ideBun, ideRepo, startRuntimeServer, workerEnv } from "../src/runtime_host.ts";

const HOST_TOKEN = "f".repeat(64);
let data: string;
let port: number;
let health: Server;
let control: HubControl | null = null;

beforeEach(async () => {
  data = mkdtempSync(join(tmpdir(), "herd-runtime-"));
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  port = probe.port!;
  probe.stop(true);
  health = await startRuntimeServer(data, port, HOST_TOKEN);
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

// ADR-0497 as the add-on: the read-only mirror of instance main on the same PORT.
describe("the GUI mirror", () => {
  const LAYOUT = {
    v: 2, active: "s1", nextSpace: 2,
    spaces: [{
      id: "s1", name: "work", activeTab: "s1:t1", nextPane: 3, nextTab: 2,
      tabs: [{ id: "s1:t1", name: "pair", focus: 0, zoom: false, tree: { kind: "split", dir: "v", ratio: 0.7, a: { kind: "leaf", id: "s1:p1", deck: "agent", lane: "L1", laneName: "alpha" }, b: { kind: "leaf", id: "s1:p2", deck: "fleet" } } }],
    }],
  };
  const startMain = () => {
    const spaces = instancePaths(data, "main").spaces;
    mkdirSync(dirname(spaces), { recursive: true });
    writeFileSync(spaces, JSON.stringify(LAYOUT));
    return startHubControl({
      dir: instancePaths(data, "main").run,
      exec: async (op) => (op.op === "agent.list" ? [{ id: "L1", name: "alpha", status: "needs-approval", attention: "needs-you", cwd: "C:/secret/repo" }] : null),
    });
  };

  test("the page: strict CSP, its own Origin only, GET only, no CORS", async () => {
    const page = await get("/");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    expect(page.headers.get("access-control-allow-origin")).toBeNull();
    expect(await page.text()).toContain('<script src="/mirror.js" defer></script>');
    expect((await get("/mirror.js", { origin: `http://localhost:${port}` })).status).toBe(200);
    expect((await get("/api/mirror", { origin: "http://evil.example" })).status).toBe(403);
    expect((await fetch(`http://127.0.0.1:${port}/`, { method: "POST" })).status).toBe(405);
  });

  test("down until instance main answers; then its tabs, tree and lanes, metadata only", async () => {
    expect(await (await get("/api/mirror")).json()).toMatchObject({ v: 1, instance: "main", up: false, spaces: [] });
    control = startMain();
    const res = await get("/api/mirror");
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({
      up: true, focusedTab: "s1:t1", counts: { agents: 1, needsYou: 1, unseen: 0 },
      spaces: [{ id: "s1", tabs: [{ id: "s1:t1", tree: { dir: "v", ratio: 0.7, a: { agent: { name: "alpha", status: "needs-approval", attention: "needs-you" } }, b: { deck: "fleet" } } }] }],
    });
    expect(text).not.toContain("secret");
    expect(text).not.toContain(control.discovery.token);
  });

  test("the host route answers only with the runtime's host token", async () => {
    control = startMain();
    expect((await get("/host/mirror")).status).toBe(403);
    expect((await get("/host/mirror", { "x-lucid-host-token": "0".repeat(64) })).status).toBe(403);
    const ok = await get("/host/mirror", { "x-lucid-host-token": HOST_TOKEN });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ up: true, counts: { needsYou: 1 } });
  });

  test("the live feed sends the current state at once", async () => {
    control = startMain();
    const res = await get("/api/mirror/events");
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let got = "";
    while (!got.includes("\n\ndata: ") || !got.endsWith("\n\n")) {
      const { done, value } = await reader.read();
      if (done) break;
      got += dec.decode(value, { stream: true });
    }
    await reader.cancel();
    expect(got.startsWith("retry: 3000\n\n")).toBe(true);
    const event = got.split("\n\n").find((chunk) => chunk.startsWith("data: "));
    expect(JSON.parse(event!.slice("data: ".length))).toMatchObject({ up: true, focusedTab: "s1:t1" });
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
