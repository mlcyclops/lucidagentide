// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/plugins/runtime.ts - P-PLUGINS.2 (ADR-0462 (5)(6)): start, watch and stop installed plugins.
//
// Three kinds, one lifecycle (installed -> starting -> running | error):
//   web     the engine serves the package's `entry.root` on its OWN loopback origin (a dedicated Bun server
//           per plugin) with a tight CSP, so a plugin page never shares an origin with the IDE;
//   server  `entry.main` runs under Electron's own Node (ELECTRON_RUN_AS_NODE=1), no separate Node install;
//   daemon  the package's signed `entry.exe` (Authenticode-checked at install on Windows).
// Ports: a stable per-plugin port in 47100-47899 (a plugin's browser storage is keyed by origin, so its port
// must not wander), persisted in plugins/ports.json and moved only when something else holds it; the
// holder is named in the log with port_guard's attribution (ADR-0305/0458). Health: `healthPath` must
// answer 2xx within the timeout, else the process tree is killed and the plugin reports `error`. A crash
// after that flips the state to `error` and unregisters its MCP server. Processes are never detached on
// Windows, and every stop is a tree kill (taskkill /T, by absolute path, the acp.ts rule), so a plugin
// cannot outlive the engine: main's quit tree-kills the engine and everything under it.
//
// Env: a plugin gets an ALLOWLISTED environment (OS basics plus the contract vars), never the engine's
// env, which carries provider keys and vault-injected tokens. PORT, HOST, LUCID_PLUGIN_ID,
// LUCID_PLUGIN_DATA, LUCID_PLUGIN_ROOT, LUCID_PLUGIN_URL, LUCID_AGENT_BIN (the omp the engine itself runs:
// plugin AI goes through LUCID Agent).

import type { Server } from "bun";
import { spawn, spawnSync, execFile, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, extname, join, resolve, sep } from "node:path";
import { safeRelPath, type DaemonEntry, type PluginManifest, type ServerEntry, type WebEntry } from "../../harness/plugins/package.ts";
import { formatSquatter, ownerProbeSpec, parseOwnerProbe } from "../port_guard.ts";
import { listInstalled, pluginDataDir, pluginsRoot, readInstalled, type InstalledPlugin } from "./install.ts";
import { removePluginMcp, setPluginMcp, type PluginMcpServer } from "./mcp.ts";
import { PLUGIN_PORT_MAX, PLUGIN_PORT_MIN } from "./ports.ts";

const HEALTH_TIMEOUT_MS = 30_000;
const STOP_WAIT_MS = 5_000;
const TAIL_CHARS = 4_000;

export type PluginState = "installed" | "running" | "starting" | "error";

export interface PluginStatus {
  id: string; name: string; version: string;
  kind: PluginManifest["kind"]; tier: PluginManifest["tier"]; section: PluginManifest["section"];
  state: PluginState; url?: string; error?: string;
  license: string; hasMcp: boolean;
}

export interface RuntimeDeps {
  /** The Node runtime for server kind and `mcp.command: "node"`: Electron's binary, run as Node. */
  nodeExe: () => string | null;
  /** The omp binary the engine runs (LUCID_AGENT_BIN). */
  agentBin: () => string;
  /** The MCP set changed (respawn omp so the agent's tools follow). */
  onMcpChange: () => void;
  healthTimeoutMs?: number;
  root?: string;
  platform?: string;
}

interface Running {
  state: "starting" | "running" | "error";
  port: number;
  url: string;
  proc?: ChildProcess;
  server?: Server<undefined>;
  error?: string;
  tail: string;
  stopping: boolean;
  exited: Promise<void>;
}

/** Where the Electron binary is: LUCID_ELECTRON_EXE (main.ts passes its own execPath), else the dev
 *  install's desktop/node_modules/electron. Null when neither exists (server plugins cannot start). */
export function resolvePluginNode(desktopDir: string, env: Record<string, string | undefined> = process.env): string | null {
  const fromMain = env.LUCID_ELECTRON_EXE?.trim();
  if (fromMain && existsSync(fromMain)) return fromMain;
  const pkg = join(desktopDir, "node_modules", "electron");
  try {
    const exe = join(pkg, "dist", readFileSync(join(pkg, "path.txt"), "utf8").trim());
    if (existsSync(exe)) return exe;
  } catch { /* no dev electron */ }
  return null;
}

/** The plugin's preferred port: a stable hash of its id into the plugin range. */
export function preferredPort(id: string): number {
  const span = PLUGIN_PORT_MAX - PLUGIN_PORT_MIN + 1;
  return PLUGIN_PORT_MIN + (createHash("sha256").update(id).digest().readUInt32BE(0) % span);
}

/** The web-kind CSP: same-origin everything, no inline script or eval, framable only by the loopback IDE,
 *  widened only by the manifest's exact https origins for img/media/connect (validated at install). */
export function webCsp(m: PluginManifest): string {
  const extra = (d: "img-src" | "media-src" | "connect-src"): string => (m.csp?.[d] ?? []).map((o) => ` ${o}`).join("");
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob:${extra("img-src")}`,
    `media-src 'self' data: blob:${extra("media-src")}`,
    "font-src 'self' data:",
    `connect-src 'self'${extra("connect-src")}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors http://localhost:* http://127.0.0.1:*",
  ].join("; ");
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".cjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".map": "application/json; charset=utf-8", ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
  ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".wav": "audio/wav", ".ogg": "audio/ogg", ".mp4": "video/mp4",
  ".webm": "video/webm", ".wasm": "application/wasm", ".pdf": "application/pdf",
};

/** Resolve a request path to a file under the web root, or null (traversal, missing). SPA-friendly: an
 *  extension-less path that is not a file serves the index. Pure apart from the stat. */
export function resolveWebFile(webRoot: string, index: string, pathname: string): string | null {
  let rel: string;
  try { rel = decodeURIComponent(pathname).replace(/^\/+/, ""); } catch { return null; }
  if (!rel || rel.endsWith("/")) rel += index;
  if (!safeRelPath(rel)) return null;
  const base = resolve(webRoot) + sep;
  const abs = resolve(webRoot, rel);
  if (!abs.startsWith(base)) return null;
  try { if (statSync(abs).isFile()) return abs; } catch { /* fall through */ }
  if (!extname(rel)) { const idx = resolve(webRoot, index); if (idx.startsWith(base) && existsSync(idx)) return idx; }
  return null;
}

/** OS basics a child legitimately needs; nothing else from the engine's env crosses over. */
const PASS_ENV = [
  "PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "windir", "SystemDrive", "COMSPEC", "TEMP", "TMP", "TMPDIR",
  "USERPROFILE", "HOME", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "ProgramData", "ProgramFiles",
  "ProgramFiles(x86)", "CommonProgramFiles", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS",
  "LANG", "LC_ALL", "TZ", "USER", "USERNAME", "LOGNAME", "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
];

/** The contract env for one plugin (also the MCP child's env). */
export function pluginEnv(p: InstalledPlugin, port: number, agentBin: string): Record<string, string> {
  return {
    PORT: String(port),
    HOST: "127.0.0.1",
    LUCID_PLUGIN_ID: p.manifest.id,
    LUCID_PLUGIN_DATA: pluginDataDir(p.manifest.id),
    LUCID_PLUGIN_ROOT: p.dir,
    LUCID_PLUGIN_URL: `http://127.0.0.1:${port}`,
    LUCID_AGENT_BIN: agentBin,
  };
}

function childEnv(contract: Record<string, string>, asNode: boolean): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of PASS_ENV) { const v = process.env[k]; if (v !== undefined) env[k] = v; }
  Object.assign(env, contract);
  if (asNode) env.ELECTRON_RUN_AS_NODE = "1";
  return env;
}

function portFree(port: number): Promise<boolean> {
  const { promise, resolve: done } = Promise.withResolvers<boolean>();
  const srv = createServer();
  srv.once("error", () => done(false));
  srv.listen({ port, host: "127.0.0.1", exclusive: true }, () => srv.close(() => done(true)));
  return promise;
}

/** Best-effort attribution of who holds `port`, via port_guard's probe (never throws). */
function describeHolder(port: number, platform: string): Promise<string> {
  const spec = ownerProbeSpec(platform, port);
  if (!spec) return Promise.resolve("unknown holder");
  const { promise, resolve: done } = Promise.withResolvers<string>();
  execFile(spec.cmd, spec.args, { timeout: 3_000, windowsHide: true }, (err, out) => {
    done(err ? "unknown holder" : formatSquatter(parseOwnerProbe(platform, String(out))).join(" ").replace(/\s+/g, " "));
  });
  return promise;
}

/** End a child's whole tree: taskkill /T by absolute path on Windows, the process group elsewhere. */
function killTree(proc: ChildProcess, platform: string, sync: boolean): void {
  const pid = proc.pid;
  if (pid === undefined || proc.exitCode !== null || proc.signalCode !== null) return;
  if (platform === "win32") {
    const tk = join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");
    const args = ["/PID", String(pid), "/T", "/F"];
    if (sync) spawnSync(tk, args, { windowsHide: true, stdio: "ignore", timeout: 10_000 });
    else spawn(tk, args, { windowsHide: true, stdio: "ignore" }).on("error", () => { try { proc.kill(); } catch { /* gone */ } });
    return;
  }
  try { process.kill(-pid, sync ? "SIGKILL" : "SIGTERM"); } catch { try { proc.kill(sync ? "SIGKILL" : "SIGTERM"); } catch { /* gone */ } }
  if (!sync) setTimeout(() => { if (proc.exitCode === null && proc.signalCode === null) { try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ } } }, 3_000).unref();
}

export class PluginRuntime {
  private running = new Map<string, Running>();
  private starting = new Map<string, Promise<{ ok: true; url: string } | { ok: false; error: string }>>();
  private readonly platform: string;

  constructor(private readonly deps: RuntimeDeps) {
    this.platform = deps.platform ?? process.platform;
  }

  private root(): string { return this.deps.root ?? pluginsRoot(); }

  /** Every installed plugin with its live state. */
  list(): PluginStatus[] {
    return listInstalled(this.root()).map((p) => {
      const r = this.running.get(p.manifest.id);
      return {
        id: p.manifest.id, name: p.manifest.name, version: p.manifest.version,
        kind: p.manifest.kind, tier: p.manifest.tier, section: p.manifest.section,
        state: r ? r.state : "installed",
        url: r?.state === "running" ? r.url : undefined,
        error: r?.state === "error" ? r.error : undefined,
        license: p.manifest.license, hasMcp: !!p.manifest.mcp,
      };
    });
  }

  /** Start (or return the running instance of) a plugin. Concurrent calls share one start. */
  start(id: string): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
    const live = this.running.get(id);
    if (live?.state === "running") return Promise.resolve({ ok: true as const, url: live.url });
    const pending = this.starting.get(id);
    if (pending) return pending;
    const p = this.doStart(id).finally(() => this.starting.delete(id));
    this.starting.set(id, p);
    return p;
  }

  private async pickPort(id: string): Promise<number> {
    const file = join(this.root(), "ports.json");
    let ports: Record<string, number> = {};
    try { ports = JSON.parse(readFileSync(file, "utf8")) as Record<string, number>; } catch { /* first start */ }
    const want = Number.isInteger(ports[id]) ? ports[id]! : preferredPort(id);
    const span = PLUGIN_PORT_MAX - PLUGIN_PORT_MIN + 1;
    const taken = new Set(Object.entries(ports).filter(([k]) => k !== id).map(([, v]) => v));
    let wantBusy = false;
    for (let i = 0; i < span; i++) {
      const port = PLUGIN_PORT_MIN + ((want - PLUGIN_PORT_MIN + i) % span);
      if (taken.has(port)) continue; // another plugin's home port, even while that plugin is stopped
      if (!(await portFree(port))) { if (port === want) wantBusy = true; continue; }
      // ADR-0305/0458: a port never moves silently; name whoever holds the plugin's home port.
      if (wantBusy) console.error(`[plugins] ${id}: port ${want} is held by ${await describeHolder(want, this.platform)}; using ${port}`);
      if (ports[id] !== port) {
        ports[id] = port;
        try { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(ports, null, 2)); } catch { /* the port still works this session */ }
      }
      return port;
    }
    throw new Error(`no free loopback port in ${PLUGIN_PORT_MIN}-${PLUGIN_PORT_MAX}`);
  }

  private async doStart(id: string): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
    const p = readInstalled(id, this.root());
    if (!p) return { ok: false, error: "that plugin is not installed" };
    const old = this.running.get(id);
    if (old) await this.stop(id); // a crashed instance: clear it before a fresh start
    let port: number;
    try { port = await this.pickPort(id); } catch (e) { return { ok: false, error: (e as Error).message }; }
    mkdirSync(pluginDataDir(id), { recursive: true });
    const url = `http://localhost:${port}/`;

    if (p.manifest.kind === "web") {
      const e = p.manifest.entry as WebEntry;
      const webRoot = join(p.dir, e.root);
      const csp = webCsp(p.manifest);
      let server: Server<undefined>;
      try {
        server = Bun.serve({
          hostname: "127.0.0.1", port,
          fetch(req) {
            if (req.method !== "GET" && req.method !== "HEAD") return new Response("method not allowed", { status: 405 });
            const file = resolveWebFile(webRoot, e.index, new URL(req.url).pathname);
            const headers: Record<string, string> = { "content-security-policy": csp, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cache-control": "no-cache" };
            if (!file) return new Response("not found", { status: 404, headers });
            headers["content-type"] = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
            return new Response(Bun.file(file), { headers });
          },
        });
      } catch (err) { return { ok: false, error: `could not serve the plugin: ${(err as Error).message}` }; }
      this.running.set(id, { state: "running", port, url, server, tail: "", stopping: false, exited: Promise.resolve() });
      this.registerMcp(p, port);
      return { ok: true, url };
    }

    const contract = pluginEnv(p, port, this.deps.agentBin());
    let cmd: string, args: string[], asNode: boolean, healthPath: string;
    if (p.manifest.kind === "server") {
      const e = p.manifest.entry as ServerEntry;
      const node = this.deps.nodeExe();
      if (!node) return { ok: false, error: "the Electron runtime for server plugins was not found" };
      cmd = node; args = [join(p.dir, e.main)]; asNode = true; healthPath = e.healthPath;
    } else {
      const e = p.manifest.entry as DaemonEntry;
      cmd = join(p.dir, e.exe); args = e.args ?? []; asNode = false; healthPath = e.healthPath;
    }
    let proc: ChildProcess;
    try {
      proc = spawn(cmd, args, {
        cwd: p.dir, env: childEnv(contract, asNode), stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true, detached: this.platform !== "win32",
      });
    } catch (err) { return { ok: false, error: `could not start: ${(err as Error).message}` }; }
    const exit = Promise.withResolvers<void>();
    const r: Running = { state: "starting", port, url, proc, tail: "", stopping: false, exited: exit.promise };
    const onExit = (why: string): void => {
      if (!r.stopping && this.running.get(id) === r && r.state !== "error") {
        r.state = "error";
        r.error = `${why}${r.tail.trim() ? `: ${r.tail.trim().slice(-600)}` : ""}`;
        console.error(`[plugins] ${id} ${r.error}`);
        if (removePluginMcp(id)) this.deps.onMcpChange();
      }
      exit.resolve();
    };
    proc.once("exit", (code, signal) => onExit(`exited (${code ?? signal})`));
    // A spawn failure (missing exe, EACCES) emits "error" and never "exit".
    proc.once("error", (err) => { if (proc.pid === undefined) onExit(`could not start: ${err.message}`); });
    const onData = (d: Buffer): void => {
      const s = d.toString();
      r.tail = (r.tail + s).slice(-TAIL_CHARS);
      for (const line of s.split(/\r?\n/)) if (line.trim()) console.log(`[plugin:${id}] ${line.slice(0, 500)}`);
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
    this.running.set(id, r);

    const deadline = Date.now() + (this.deps.healthTimeoutMs ?? HEALTH_TIMEOUT_MS);
    while (Date.now() < deadline) {
      if (r.state === "error") return { ok: false, error: r.error ?? "the plugin exited during startup" };
      if (r.stopping) return { ok: false, error: "stopped during startup" };
      try {
        const res = await fetch(`http://127.0.0.1:${port}${healthPath}`, { signal: AbortSignal.timeout(2_000) });
        await res.body?.cancel().catch(() => {});
        if (res.ok) {
          r.state = "running";
          this.registerMcp(p, port);
          return { ok: true, url };
        }
      } catch { /* not listening yet */ }
      await Bun.sleep(250);
    }
    const tail = r.tail.trim().slice(-600);
    await this.stop(id);
    return { ok: false, error: `no healthy answer from ${healthPath} within ${Math.round((this.deps.healthTimeoutMs ?? HEALTH_TIMEOUT_MS) / 1000)}s${tail ? `: ${tail}` : ""}` };
  }

  /** The ACP stdio entry for a plugin's `mcp`, with paths resolved against the package root. */
  mcpServerFor(p: InstalledPlugin, port: number): PluginMcpServer | null {
    const m = p.manifest.mcp;
    if (!m) return null;
    const asNode = m.command === "node";
    const command = asNode ? this.deps.nodeExe() : join(p.dir, m.command);
    if (!command) return null;
    const files = p.manifest.files ?? {};
    const args = (m.args ?? []).map((a) => (safeRelPath(a) && a in files ? join(p.dir, a) : a));
    // The same allowlisted env the plugin's own process gets, so the MCP child starts identically whether or
    // not omp merges its own environment into a stdio server's.
    const env = Object.entries(childEnv(pluginEnv(p, port, this.deps.agentBin()), asNode)).map(([name, value]) => ({ name, value }));
    return { name: `plugin-${p.manifest.id}`, command, args, env };
  }

  private registerMcp(p: InstalledPlugin, port: number): void {
    const s = this.mcpServerFor(p, port);
    if (!s) { if (p.manifest.mcp) console.error(`[plugins] ${p.manifest.id}: MCP not registered (the Electron runtime was not found)`); return; }
    setPluginMcp(p.manifest.id, s);
    this.deps.onMcpChange();
  }

  /** Stop one plugin (idempotent): unregister its MCP, end its server or process tree, wait for exit. */
  async stop(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const r = this.running.get(id);
    if (!r) return { ok: true };
    r.stopping = true;
    if (removePluginMcp(id)) this.deps.onMcpChange();
    if (r.server) r.server.stop(true);
    if (r.proc) {
      killTree(r.proc, this.platform, false);
      const ended = await Promise.race([r.exited.then(() => true), Bun.sleep(STOP_WAIT_MS).then(() => false)]);
      if (!ended) {
        killTree(r.proc, this.platform, true);
        this.running.delete(id);
        return { ok: false, error: `the plugin process ${r.proc.pid} did not exit after a tree kill` };
      }
    }
    this.running.delete(id);
    return { ok: true };
  }

  async stopAll(): Promise<void> { await Promise.all([...this.running.keys()].map((id) => this.stop(id))); }

  /** Synchronous last resort for the engine's exit handlers: no awaiting, just end every tree. */
  stopAllSync(): void {
    for (const [id, r] of this.running) {
      r.stopping = true;
      removePluginMcp(id);
      try { r.server?.stop(true); } catch { /* exiting */ }
      if (r.proc) try { killTree(r.proc, this.platform, true); } catch { /* exiting */ }
    }
    this.running.clear();
  }
}
