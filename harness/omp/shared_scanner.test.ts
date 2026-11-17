// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/omp/shared_scanner.test.ts
//
// P-SCANLIVE.3 (ADR-0605, issue #632): one scanner sidecar per omp process, however many sessions and
// subagents bind LUCID's extensions. The field leak: a held lane's omp process kept 145 sidecars, because
// mcp_result_gate.ts started one in every factory run and security_extension.ts one per module evaluation.
//
// A stand-in sidecar appends its pid to spawns.log when it starts, so these tests count the sidecar
// processes actually spawned, not client objects.

import { test, expect, beforeAll, afterAll, afterEach, setSystemTime, spyOn } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import mcpResultGate, { type GatedResult, type ToolResultInput } from "./mcp_result_gate.ts";
import { _resetSharedScannerForTest, sharedScanner } from "./shared_scanner.ts";
import type * as SharedScannerModule from "./shared_scanner.ts";
import { ScanUnavailableError, sidecarDir } from "../security/scanner_client.ts";
import type * as ScannerClientModule from "../security/scanner_client.ts";

const HERE = import.meta.dir;
const REPO = join(HERE, "..", "..");
const MCP_EVENT: ToolResultInput = { toolName: "mcp__remote_fetch", content: [{ type: "text", text: "plain remote output" }] };

type Handler = (event: ToolResultInput, ctx: unknown) => Promise<unknown>;
type ExtensionApi = Parameters<typeof mcpResultGate>[0];

/** The slice of omp's ExtensionAPI the gate's factory uses: it registers one tool_result handler. */
function fakePi(handlers: Handler[]): ExtensionApi {
  const on = (event: string, fn: Handler) => {
    if (event === "tool_result") handlers.push(fn);
  };
  return { on } as unknown as ExtensionApi;
}

async function run(h: Handler): Promise<GatedResult | undefined> {
  return (await h(MCP_EVENT, {})) as GatedResult | undefined;
}

function textOf(r: GatedResult | undefined): string {
  const first = r?.content[0];
  return first?.type === "text" ? first.text : "";
}

afterEach(() => setSystemTime());

/** Wait until `pred` holds, polling every 20ms, failing after `ms`. A real sidecar process exits, and
 *  Windows releases its cwd, on the OS's schedule; neither raises an event this test could await. */
async function until(pred: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("condition not reached");
    await Bun.sleep(20);
  }
}

let dir: string;
let log: string;
const saved = { dir: process.env.LUCID_SCANNER_DIR, py: process.env.SCANNER_PYTHON };

/** Sidecar processes started since the last fresh(). */
function spawns(): number {
  return existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0;
}

/** Forget the process's client and the spawn count, so a test starts with no sidecar. */
function fresh(): void {
  _resetSharedScannerForTest();
  writeFileSync(log, "");
}

beforeAll(() => {
  _resetSharedScannerForTest(); // a client another file started would point at the real sidecar
  dir = mkdtempSync(join(tmpdir(), "scanshare-"));
  log = join(dir, "spawns.log");
  // A stand-in sidecar: records its pid on start, then answers every scan clean.
  writeFileSync(join(dir, "server.py"), [
    "import json, os, sys",
    "here = os.path.dirname(os.path.abspath(__file__))",
    "with open(os.path.join(here, 'spawns.log'), 'a') as log:",
    "    log.write(str(os.getpid()) + '\\n')",
    "for raw in sys.stdin:",
    "    req = json.loads(raw)",
    "    sys.stdout.write(json.dumps({'id': req['id'], 'findings': [], 'scanner_version': 'stand-in'}) + '\\n')",
    "    sys.stdout.flush()",
    "",
  ].join("\n"));
  // The real sidecar's interpreter, resolved before LUCID_SCANNER_DIR is pointed at the stand-in.
  const realVenv = join(sidecarDir(), ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  process.env.SCANNER_PYTHON = saved.py ?? (existsSync(realVenv) ? realVenv : process.platform === "win32" ? "python" : "python3");
  process.env.LUCID_SCANNER_DIR = dir;
});

afterAll(async () => {
  _resetSharedScannerForTest();
  if (saved.dir === undefined) delete process.env.LUCID_SCANNER_DIR; else process.env.LUCID_SCANNER_DIR = saved.dir;
  if (saved.py === undefined) delete process.env.SCANNER_PYTHON; else process.env.SCANNER_PYTHON = saved.py;
  // A just-killed sidecar holds its cwd until Windows finishes tearing it down (EBUSY until then).
  await until(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  });
});

test("the MCP gate's factory run 8 times in one process starts ONE sidecar", async () => {
  fresh();
  const handlers: Handler[] = [];
  for (let i = 0; i < 8; i++) await mcpResultGate(fakePi(handlers));
  expect(handlers.length).toBe(8);
  // Every run's handler gets an answer, so every sidecar any run started has written its pid by now.
  const results = await Promise.all(handlers.map(run));
  for (const r of results) {
    expect(r?.isError).toBeFalsy();
    expect(textOf(r).startsWith("UNTRUSTED_CONTENT_START")).toBe(true);
  }
  expect(spawns()).toBe(1);
  expect(sharedScanner()).toBe(sharedScanner());
}, 30_000);

test("through omp's own loader: 3 session imports and 3 subagent rebinds of both extensions share ONE sidecar", async () => {
  fresh();
  // A child process, so omp's loader hooks never reach the other test files in this run. It does what an
  // `omp acp` lane does: each session/new imports the extensions afresh (omp re-evaluates their module
  // graph) and each subagent rebinds the imported factories. Then every MCP gate binding scans once.
  const paths = [join(HERE, "security_extension.ts"), join(HERE, "mcp_result_gate.ts")];
  const probe = [
    `import { bindPreparedExtensions, loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";`,
    `const paths = ${JSON.stringify(paths)};`,
    `const event = ${JSON.stringify(MCP_EVENT)};`,
    `const errors = [];`,
    `const handlers = [];`,
    `const take = (r) => {`,
    `  errors.push(...r.errors.map((e) => e.error));`,
    `  for (const ext of r.extensions) if (ext.resolvedPath.endsWith("mcp_result_gate.ts")) handlers.push(...(ext.handlers.get("tool_result") ?? []));`,
    `};`,
    `const sessions = [];`,
    `for (let i = 0; i < 3; i++) sessions.push(await loadExtensions(paths, process.cwd()));`,
    `sessions.forEach(take);`,
    `for (let i = 0; i < 3; i++) take(await bindPreparedExtensions(sessions[0].preparedExtensions ?? [], process.cwd()));`,
    `const results = await Promise.all(handlers.map((h) => h(event, {})));`,
    `console.log("PROBE " + JSON.stringify({ errors, handlers: handlers.length, results }));`,
    `process.exit(0);`,
  ].join("\n");
  const child = Bun.spawn([process.execPath, "-e", probe], { cwd: REPO, env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  const line = stdout.split("\n").find((l) => l.startsWith("PROBE "));
  if (!line) throw new Error(`the loader probe printed no result (exit ${code}): ${stderr.slice(-2000)}`);
  const out = JSON.parse(line.slice("PROBE ".length)) as { errors: string[]; handlers: number; results: (GatedResult | undefined)[] };
  expect(out.errors).toEqual([]);
  expect(out.handlers).toBe(6);
  for (const r of out.results) {
    expect(r?.isError).toBeFalsy();
    expect(textOf(r).startsWith("UNTRUSTED_CONTENT_START")).toBe(true);
  }
  expect(spawns()).toBe(1);
}, 60_000);

test("a re-evaluated module graph finds the same client, and a scan error still matches instanceof", async () => {
  fresh();
  const first = sharedScanner();
  // omp's reload imports a module again under a `?mtime=` tag, which Bun keys as a separate module. Dynamic
  // on purpose: a static import cannot load a second copy of a module.
  const again = (await import(`${join(HERE, "shared_scanner.ts")}?mtime=605001`)) as typeof SharedScannerModule;
  expect(again.sharedScanner).not.toBe(sharedScanner);
  expect(again.sharedScanner()).toBe(first);

  // The shared client may throw an error built by another evaluation's class (memory/ingest.ts tells a
  // scan failure from any other error with instanceof).
  const other = (await import(`${join(HERE, "..", "security", "scanner_client.ts")}?mtime=605002`)) as typeof ScannerClientModule;
  expect(other.ScanUnavailableError).not.toBe(ScanUnavailableError);
  expect(new other.ScanUnavailableError("x") instanceof ScanUnavailableError).toBe(true);
  expect(new ScanUnavailableError("x") instanceof other.ScanUnavailableError).toBe(true);
  expect(new Error("x") instanceof ScanUnavailableError).toBe(false);
}, 30_000);

test("FAIL-CLOSED: the shared sidecar dies, every binding withholds, the exit is on stderr, one respawn serves all", async () => {
  fresh();
  const handlers: Handler[] = [];
  for (let i = 0; i < 3; i++) await mcpResultGate(fakePi(handlers));
  const client = sharedScanner();
  expect((await run(handlers[0]!))?.isError).toBeFalsy();
  const write = spyOn(process.stderr, "write");
  try {
    const firstPid = client.pid!;
    process.kill(firstPid);
    await until(() => !client.alive);
    // The ADR-0571 exit notice still reaches stderr (the desktop keeps it in lucid-acp.log).
    expect(write.mock.calls.some(([chunk]) => String(chunk).includes("scanner sidecar exited"))).toBe(true);

    // Dead shared sidecar: every binding's MCP result is withheld, never passed.
    for (const h of handlers) {
      const r = await run(h);
      expect(r?.isError).toBe(true);
      expect(textOf(r)).toContain("fail-closed");
    }

    // After the backoff the next scan respawns ONE sidecar for every binding, on the same client. The
    // backoff reads Date.now(), so the clock moves past its 30s ceiling instead of the test sleeping.
    setSystemTime(new Date(Date.now() + 30_001));
    const after = await Promise.all(handlers.map(run));
    for (const r of after) expect(r?.isError).toBeFalsy();
    expect(sharedScanner()).toBe(client);
    expect(client.pid).not.toBe(firstPid);
    expect(spawns()).toBe(2);
  } finally {
    write.mockRestore();
  }
}, 30_000);
