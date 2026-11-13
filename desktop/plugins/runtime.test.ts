// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-PLUGINS.2 (ADR-0462): the plugin runtime, driven end to end. A fixture server plugin is packed by the
// real tools/build_plugin.ts, installed through the real gates, started, reached on its health path,
// registered as an MCP server, and stopped; the server AND the grandchild it spawned must both be gone
// (no orphan). The Node runtime is injected as this test's own Bun binary, which runs the CommonJS fixture
// the way Electron's Node does in the app.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLEAN, buildServerFixture, testKey, writeStage } from "./fixtures.ts";
import { installPluginBytes } from "./install.ts";
import { pluginDataDir, readInstalled } from "./installed.ts";
import { readRunIntents, runIntentDir, setRunIntent } from "./intent.ts";
import { pluginMcpServers } from "./mcp.ts";
import { pluginOrigin, PLUGIN_PORT_MAX, PLUGIN_PORT_MIN } from "./ports.ts";
import { PluginRuntime, preferredPort, resolveWebFile, webCsp, type RuntimeDeps } from "./runtime.ts";
import { buildPlugin } from "../../tools/build_plugin.ts";
import { pluginSelfNavigation } from "../navigation_policy.ts";
import type { PluginManifest } from "../../harness/plugins/package.ts";

const KEY = testKey();
const ENV_KEYS = ["LUCID_PLUGINS_DIR", "LUCID_PLUGIN_DATA_DIR", "LUCID_PLUGIN_LOG_PATH", "LUCID_LICENSE_DEV", "LUCID_LICENSE_DEV_PUB", "OPENAI_API_KEY"] as const;
let saved: Record<string, string | undefined> = {};
let work = "";
let runtime: PluginRuntime | null = null;
let mcpChanges = 0;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  work = mkdtempSync(join(tmpdir(), "lplugin-runtime-"));
  process.env.LUCID_PLUGINS_DIR = join(work, "plugins");
  process.env.LUCID_PLUGIN_DATA_DIR = join(work, "plugin-data");
  process.env.LUCID_PLUGIN_LOG_PATH = join(work, "lucid-plugins.jsonl");
  mcpChanges = 0;
});
afterEach(async () => {
  await runtime?.stopAll();
  runtime = null;
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(work, { recursive: true, force: true });
});

const deps = { trusted: KEY.trusted, decide: async () => CLEAN, record: () => {}, managedEgress: {} };

function makeRuntime(healthTimeoutMs = 20_000, extra: Partial<RuntimeDeps> = {}): PluginRuntime {
  runtime = new PluginRuntime({ nodeExe: () => process.execPath, agentBin: () => "C:/lucid/omp.exe", onMcpChange: () => { mcpChanges++; }, healthTimeoutMs, ...extra });
  return runtime;
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
// Real-time polling on purpose: the condition is the OS process table (a tree kill landing, a crash being
// observed), which no fake clock can advance; the loop returns the moment the condition holds.
async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return true; await Bun.sleep(100); }
  return cond();
}

describe("server plugins", () => {
  test("start reaches health on a stable loopback port, registers MCP, and stop leaves no orphan", async () => {
    expect((await installPluginBytes(buildServerFixture(KEY), "fixture-server", deps)).ok).toBe(true);
    const rt = makeRuntime();
    expect(rt.list()).toMatchObject([{ id: "fixture-server", state: "installed", kind: "server", tier: "premium", hasMcp: true, license: "LUCID-Premium-Plugin-1.0" }]);

    const started = await rt.start("fixture-server");
    expect(started.ok).toBe(true);
    const url = started.ok ? started.url : "";
    expect(pluginOrigin(url)).toBe(url.replace(/\/$/, ""));
    const port = Number(new URL(url).port);
    expect(port).toBeGreaterThanOrEqual(PLUGIN_PORT_MIN);
    expect(port).toBeLessThanOrEqual(PLUGIN_PORT_MAX);

    const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json() as Record<string, string>;
    expect(health).toMatchObject({ ok: true, id: "fixture-server", agent: "C:/lucid/omp.exe" });
    expect(health.root).toContain(join("fixture-server", "0.1.0"));
    expect(rt.list()[0]).toMatchObject({ state: "running", url });

    const mcp = pluginMcpServers();
    expect(mcp.map((s) => s.name)).toEqual(["plugin-fixture-server"]);
    expect(mcp[0]!.command).toBe(process.execPath);
    expect(mcp[0]!.args[0]).toContain(join("0.1.0", "app", "mcp.cjs"));
    expect(mcp[0]!.env).toContainEqual({ name: "PORT", value: String(port) });
    expect(mcp[0]!.env).toContainEqual({ name: "ELECTRON_RUN_AS_NODE", value: "1" });
    expect(mcpChanges).toBe(1);

    const pids = JSON.parse(readFileSync(join(pluginDataDir("fixture-server"), "pids.json"), "utf8")) as { server: number; child: number };
    expect(alive(pids.server)).toBe(true);
    expect(alive(pids.child)).toBe(true);

    expect(await rt.stop("fixture-server")).toEqual({ ok: true });
    expect(await until(() => !alive(pids.server) && !alive(pids.child), 10_000)).toBe(true);
    expect(pluginMcpServers()).toEqual([]);
    expect(mcpChanges).toBe(2);
    expect(rt.list()[0]).toMatchObject({ state: "installed" });

    // The port is remembered: a restart lands on the same origin (browser storage is keyed by it).
    const again = await rt.start("fixture-server");
    expect(again.ok && again.url).toBe(url);
  }, 60_000);

  // A plugin that checks a development license (remote-spokes ADR-A092) gets the developer's two variables under a
  // dev build of the IDE; an engine secret still never crosses.
  test("under a dev build the development license variables reach a plugin; the engine's other environment does not", async () => {
    process.env.LUCID_LICENSE_DEV = "1";
    process.env.LUCID_LICENSE_DEV_PUB = "MCowBQYDK2VwAyEAdevpublickey";
    process.env.OPENAI_API_KEY = "sk-not-for-plugins";
    expect((await installPluginBytes(buildServerFixture(KEY), "fixture-server", deps)).ok).toBe(true);
    const rt = makeRuntime(20_000, { appVersion: "2.6.0-dev.3" });
    expect((await rt.start("fixture-server")).ok).toBe(true);
    const env = pluginMcpServers()[0]!.env;
    expect(env).toContainEqual({ name: "LUCID_LICENSE_DEV", value: "1" });
    expect(env).toContainEqual({ name: "LUCID_LICENSE_DEV_PUB", value: "MCowBQYDK2VwAyEAdevpublickey" });
    expect(env.map((e) => e.name)).not.toContain("OPENAI_API_KEY");
  }, 60_000);

  // ADR-0542: a release drops the development overrides, so a plugin there accepts publisher licenses only.
  test("a release drops the development license variables", async () => {
    process.env.LUCID_LICENSE_DEV = "1";
    process.env.LUCID_LICENSE_DEV_PUB = "MCowBQYDK2VwAyEAdevpublickey";
    expect((await installPluginBytes(buildServerFixture(KEY), "fixture-server", deps)).ok).toBe(true);
    const p = readInstalled("fixture-server")!;
    const names = makeRuntime(20_000, { appVersion: "2.6.0" }).mcpServerFor(p, PLUGIN_PORT_MIN)!.env.map((e) => e.name);
    expect(names).not.toContain("LUCID_LICENSE_DEV");
    expect(names).not.toContain("LUCID_LICENSE_DEV_PUB");
    expect(names).toContain("LUCID_PLUGIN_ID");
  });

  // ADR-0506: the engine's own way into a server plugin. The token exists only while the plugin runs, only the
  // plugin process holds it (never its MCP child, never the renderer's list), and a restart mints a new one.
  test("hostEndpoint hands the engine a per-launch token the plugin accepts and nothing else carries", async () => {
    expect((await installPluginBytes(buildServerFixture(KEY), "fixture-server", deps)).ok).toBe(true);
    const rt = makeRuntime();
    expect(rt.hostEndpoint("fixture-server")).toBeNull();
    expect((await rt.start("fixture-server")).ok).toBe(true);
    const ep = rt.hostEndpoint("fixture-server");
    expect(ep?.token).toMatch(/^[0-9a-f]{64}$/);
    const check = (token: string) => fetch(`${ep!.url}/host/check`, { headers: { "x-lucid-host-token": token } }).then((r) => r.status);
    expect(await check(ep!.token)).toBe(204);
    expect(await check("0".repeat(64))).toBe(403);
    expect(pluginMcpServers()[0]!.env.map((e) => e.name)).not.toContain("LUCID_PLUGIN_HOST_TOKEN");
    expect(JSON.stringify(rt.list())).not.toContain(ep!.token);

    expect(await rt.stop("fixture-server")).toEqual({ ok: true });
    expect(rt.hostEndpoint("fixture-server")).toBeNull();
    expect((await rt.start("fixture-server")).ok).toBe(true);
    const next = rt.hostEndpoint("fixture-server");
    expect(next?.token).not.toBe(ep!.token);
    expect(await fetch(`${next!.url}/host/check`, { headers: { "x-lucid-host-token": ep!.token } }).then((r) => r.status)).toBe(403);
  }, 60_000);

  test("a crash after start flips the state to error and unregisters MCP", async () => {
    expect((await installPluginBytes(buildServerFixture(KEY), "fixture-server", deps)).ok).toBe(true);
    const rt = makeRuntime();
    expect((await rt.start("fixture-server")).ok).toBe(true);
    const pids = JSON.parse(readFileSync(join(pluginDataDir("fixture-server"), "pids.json"), "utf8")) as { server: number; child: number };
    process.kill(pids.server);
    expect(await until(() => rt.list()[0]?.state === "error", 10_000)).toBe(true);
    expect(rt.list()[0]?.error).toContain("exited");
    expect(pluginMcpServers()).toEqual([]);
    try { process.kill(pids.child); } catch { /* already gone */ }
  }, 60_000);

  test("a server that never answers health is killed and reported", async () => {
    const zip = buildServerFixture(KEY, {}, { "app/server.cjs": "console.log('booting'); setInterval(() => {}, 1000000);\n" });
    expect((await installPluginBytes(zip, "fixture-server", deps)).ok).toBe(true);
    const rt = makeRuntime(1_500);
    const r = await rt.start("fixture-server");
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.error).toContain("/api/health");
    expect(rt.list()[0]?.state).toBe("installed");
    expect(pluginMcpServers()).toEqual([]);
  }, 30_000);

  test("starting something that is not installed is a clean error", async () => {
    expect(await makeRuntime().start("nope")).toEqual({ ok: false, error: "that plugin is not installed" });
  });
});

describe("web plugins", () => {
  const webManifest = {
    schema: 1, id: "fixture-web", name: "Fixture Web", version: "1.0.0", publisher: "TECHLEAD 187 LLC",
    license: "LUCID-Premium-Plugin-1.0", tier: "premium", section: "government", kind: "web",
    entry: { root: "web", index: "index.html" }, permissions: ["network:internet"],
    csp: { "media-src": ["https://storage.googleapis.com"] },
  };

  test("serves the package root on its own origin with the tight CSP and no traversal", async () => {
    const src = writeStage({ "LICENSE": "license\n", "web/index.html": "<!doctype html><script src=app.js></script>", "web/app.js": "1;", "secret.txt": "outside the web root" }, webManifest);
    const zip = readFileSync(buildPlugin({ src, out: mkdtempSync(join(tmpdir(), "lplugin-out-")), privateKey: KEY.privateKey }).zipPath);
    expect((await installPluginBytes(zip, "fixture-web", deps)).ok).toBe(true);
    const rt = makeRuntime();
    const r = await rt.start("fixture-web");
    expect(r.ok).toBe(true);
    const port = Number(new URL(r.ok ? r.url : "http://x").port);

    const index = await fetch(`http://127.0.0.1:${port}/`);
    expect(index.status).toBe(200);
    expect(await index.text()).toContain("app.js");
    const csp = index.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).toContain("media-src 'self' data: blob: https://storage.googleapis.com");
    expect(index.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await fetch(`http://127.0.0.1:${port}/app.js`)).headers.get("content-type")).toContain("javascript");
    expect((await fetch(`http://127.0.0.1:${port}/%2e%2e/secret.txt`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port}/deep/route`)).status).toBe(200); // SPA fallback to the index

    expect(await rt.stop("fixture-web")).toEqual({ ok: true });
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
  }, 30_000);

  test("resolveWebFile refuses traversal and webCsp only widens declared directives", () => {
    const root = writeStage({ "web/index.html": "x" }, {});
    const webRoot = join(root, "web");
    expect(resolveWebFile(webRoot, "index.html", "/")).toBe(join(webRoot, "index.html"));
    expect(resolveWebFile(webRoot, "index.html", "/../lucid-plugin.json")).toBeNull();
    expect(resolveWebFile(webRoot, "index.html", "/%2e%2e%2flucid-plugin.json")).toBeNull();
    expect(resolveWebFile(webRoot, "index.html", "/missing.js")).toBeNull();
    const csp = webCsp(webManifest as unknown as PluginManifest);
    expect(csp).toContain("img-src 'self' data: blob:;");
    expect(csp).toContain("frame-ancestors http://localhost:* http://127.0.0.1:*");
  });
});

// P-PLUGINS.8 (ADR-0546): what the runtime does to the running-intent ledger. A new PluginRuntime over the same
// folders is the next launch.
describe("running intent across launches", () => {
  async function installWebFixture(): Promise<void> {
    const src = writeStage({ "LICENSE": "license\n", "web/index.html": "<!doctype html>" }, {
      schema: 1, id: "fixture-web", name: "Fixture Web", version: "1.0.0", publisher: "TECHLEAD 187 LLC",
      license: "LUCID-Premium-Plugin-1.0", tier: "premium", section: "government", kind: "web",
      entry: { root: "web", index: "index.html" }, permissions: ["network:internet"],
    });
    const zip = readFileSync(buildPlugin({ src, out: mkdtempSync(join(tmpdir(), "lplugin-out-")), privateKey: KEY.privateKey }).zipPath);
    expect((await installPluginBytes(zip, "fixture-web", deps)).ok).toBe(true);
  }
  const stateOf = (rt: PluginRuntime, id: string) => rt.list().find((p) => p.id === id)?.state;

  test("a new install waits for the user; a started plugin comes back at the next launch; the user's Stop holds", async () => {
    await installWebFixture();
    let rt = makeRuntime();
    expect(await rt.autostart()).toEqual([]); // newly installed: nothing runs unasked (ADR-0541)
    expect(stateOf(rt, "fixture-web")).toBe("installed");

    expect((await rt.start("fixture-web")).ok).toBe(true);
    expect(readRunIntents(runIntentDir())).toEqual(["fixture-web"]);
    if (process.platform !== "win32") expect(statSync(join(runIntentDir(), "fixture-web")).mode & 0o777).toBe(0o600);

    await rt.stopAll(); // the engine quitting is not the user stopping it
    expect(readRunIntents(runIntentDir())).toEqual(["fixture-web"]);
    rt = makeRuntime();
    expect(await rt.autostart()).toEqual([{ id: "fixture-web", ok: true, attempts: 1 }]);
    expect(stateOf(rt, "fixture-web")).toBe("running");

    expect(await rt.stop("fixture-web", { byUser: true })).toEqual({ ok: true });
    expect(readRunIntents(runIntentDir())).toEqual([]);
    rt = makeRuntime();
    expect(await rt.autostart()).toEqual([]);
    expect(stateOf(rt, "fixture-web")).toBe("installed");
  }, 30_000);

  test("uninstall forgets the intent; a recorded plugin with no package is skipped and forgotten", async () => {
    await installWebFixture();
    const rt = makeRuntime();
    expect((await rt.start("fixture-web")).ok).toBe(true);
    expect(await rt.uninstall("fixture-web", true)).toEqual({ ok: true });
    expect(readInstalled("fixture-web")).toBeNull();
    expect(readRunIntents(runIntentDir())).toEqual([]);

    setRunIntent("gone-private", runIntentDir()); // e.g. an unsigned private install a release cleanup removed
    expect(await makeRuntime().autostart()).toEqual([]);
    expect(readRunIntents(runIntentDir())).toEqual([]);
  }, 30_000);

  test("a release build ignores and forgets a development build's intent but honors a release one", async () => {
    await installWebFixture();
    setRunIntent("fixture-web", runIntentDir(), "2.6.0-dev.1");
    let rt = makeRuntime(20_000, { appVersion: "2.6.0" });
    expect(await rt.autostart()).toEqual([]);
    expect(stateOf(rt, "fixture-web")).toBe("installed");
    expect(readRunIntents(runIntentDir())).toEqual([]);

    setRunIntent("fixture-web", runIntentDir(), "2.6.0");
    rt = makeRuntime(20_000, { appVersion: "2.6.0" });
    expect(await rt.autostart()).toEqual([{ id: "fixture-web", ok: true, attempts: 1 }]);
    await rt.stopAll();

    setRunIntent("fixture-web", runIntentDir(), "2.6.0-dev.1");
    rt = makeRuntime(20_000, { appVersion: "2.6.0-dev.2" });
    expect(await rt.autostart()).toEqual([{ id: "fixture-web", ok: true, attempts: 1 }]);
  }, 30_000);

  test("an installed file with one byte changed is not autostarted; its intent goes and a block is recorded", async () => {
    await installWebFixture();
    const p = readInstalled("fixture-web")!;
    const file = join(p.dir, "web/index.html");
    const bytes = readFileSync(file);
    bytes[0] = bytes[0]! ^ 1;
    writeFileSync(file, bytes);
    setRunIntent("fixture-web", runIntentDir());
    const blocks: { tool: string; reason: string }[] = [];
    const rt = makeRuntime(20_000, { record: (b) => { blocks.push(b); } });
    expect(await rt.autostart()).toEqual([]);
    expect(stateOf(rt, "fixture-web")).toBe("installed");
    expect(readRunIntents(runIntentDir())).toEqual([]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.tool).toBe("plugin_autostart");
    expect(blocks[0]!.reason).toContain("web/index.html does not match its sha256");
  }, 30_000);

  test("a Stop while a start awaits its port cancels the launch and the intent", async () => {
    await installWebFixture();
    const port = Promise.withResolvers<number>();
    const asked = Promise.withResolvers<void>();
    const rt = makeRuntime(20_000, { pickPort: () => { asked.resolve(); return port.promise; } });
    const started = rt.start("fixture-web");
    await asked.promise; // the start is now held on its port
    expect(await rt.stop("fixture-web", { byUser: true })).toEqual({ ok: true });
    port.resolve(PLUGIN_PORT_MIN + 7);
    expect((await started).ok).toBe(false);
    expect(stateOf(rt, "fixture-web")).toBe("installed");
    expect(readRunIntents(runIntentDir())).toEqual([]);
  }, 30_000);

  test("a crash and an update's stop keep the intent; only the user's stop clears it", async () => {
    expect((await installPluginBytes(buildServerFixture(KEY), "fixture-server", deps)).ok).toBe(true);
    const rt = makeRuntime();
    expect((await rt.start("fixture-server")).ok).toBe(true);
    const pids = JSON.parse(readFileSync(join(pluginDataDir("fixture-server"), "pids.json"), "utf8")) as { server: number; child: number };
    process.kill(pids.server);
    expect(await until(() => stateOf(rt, "fixture-server") === "error", 10_000)).toBe(true);
    try { process.kill(pids.child); } catch { /* already gone */ }
    expect(readRunIntents(runIntentDir())).toEqual(["fixture-server"]);

    const up = await installPluginBytes(buildServerFixture(KEY, { version: "0.2.0" }), "fixture-server", { ...deps, beforeSwitch: async (id: string) => { await rt.stop(id); } });
    expect(up.ok).toBe(true);
    expect(readRunIntents(runIntentDir())).toEqual(["fixture-server"]);

    expect(await rt.stop("fixture-server", { byUser: true })).toEqual({ ok: true });
    expect(readRunIntents(runIntentDir())).toEqual([]);
  }, 60_000);
});

describe("ports and navigation", () => {
  test("the preferred port is stable and in range", () => {
    expect(preferredPort("pathfinder")).toBe(preferredPort("pathfinder"));
    for (const id of ["pathfinder", "myhome", "agentictrade187", "quantum-cloak"]) {
      expect(preferredPort(id)).toBeGreaterThanOrEqual(PLUGIN_PORT_MIN);
      expect(preferredPort(id)).toBeLessThanOrEqual(PLUGIN_PORT_MAX);
    }
  });

  test("a plugin frame may navigate within its own origin, nowhere else", () => {
    expect(pluginSelfNavigation("http://localhost:47200/a", "http://localhost:47200/b?x=1")).toBe(true);
    expect(pluginSelfNavigation("http://localhost:47200/a", "http://localhost:47201/")).toBe(false);
    expect(pluginSelfNavigation("http://localhost:47200/a", "https://example.com/")).toBe(false);
    expect(pluginSelfNavigation("http://localhost:5319/", "http://localhost:5319/x")).toBe(false);
    expect(pluginSelfNavigation(undefined, "http://localhost:47200/")).toBe(false);
  });
});
