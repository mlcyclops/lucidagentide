// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/acp_backend_recovery.test.ts - P-RECOVER.1 (ADR-0385): the REAL Backend singleton driving a REAL
// fake ACP agent subprocess (harness/mcp/testing/fake_acp_agent.ts), through the same ompBin() resolution,
// spawn, handshake and session calls production uses.
//
// The fake is reached through an executable wrapper, because spawn() cannot run a script directly on
// Windows: the repo's own Bun shim (node_modules/.bin/omp.exe + omp.bunx) is copied into a temp
// node_modules/.bin, and the file it launches (@oh-my-pi/pi-coding-agent/dist/cli.js, relative to the shim)
// is our wrapper. On POSIX the wrapper is a `#!/usr/bin/env bun` script. The wrapper:
//   - answers `--version` (ompBin() probes it),
//   - appends every ACP method it receives to a trace file (pid, method, sessionId), so a test can see what
//     the backend actually asked the agent to do,
//   - writes its pid to a file (the Windows tree-kill check), and
//   - either runs the harness fake agent, or (FAKE_LOAD_FAIL=1) a minimal agent whose session/load errors.
//
// Isolation: HOME/USERPROFILE and LUCID_GUI_SETTINGS_FILE point at a temp dir before the backend module is
// imported, and the incident directory / acp log are injected through configureRecovery.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resetSandboxStatus } from "./sandbox_status.ts";

const REPO = join(import.meta.dir, "..");
const FAKE_AGENT = join(REPO, "harness", "mcp", "testing", "fake_acp_agent.ts");
const ROOT = mkdtempSync(join(tmpdir(), "lucid-recover-"));
const HOME = join(ROOT, "home");
const WS = join(ROOT, "ws");
const INCIDENTS = join(ROOT, "incidents");
const TRACE = join(ROOT, "trace.log");
const PIDS = join(ROOT, "pids.log");
mkdirSync(join(HOME, ".omp"), { recursive: true });
mkdirSync(WS, { recursive: true });
// bun test runs every file in ONE process, so the overrides below must be undone in afterAll or later
// files would read a deleted temp HOME.
const ENV_KEYS = ["HOME", "USERPROFILE", "LUCID_GUI_SETTINGS_FILE", "FAKE_TRACE_FILE", "FAKE_PID_FILE", "LUCID_OMP_BIN", "FAKE_ACP_MODE", "FAKE_LOAD_FAIL", "FAKE_TOOL_CHILD"] as const;
const ENV_BEFORE = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.LUCID_GUI_SETTINGS_FILE = join(HOME, ".omp", "lucid-gui.json");
writeFileSync(process.env.LUCID_GUI_SETTINGS_FILE, JSON.stringify({ workspace: WS }));
process.env.FAKE_TRACE_FILE = TRACE;
process.env.FAKE_PID_FILE = PIDS;

const WRAPPER = `
import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
if (process.argv.includes("--version")) { console.log("fake-omp 0.0.0"); process.exit(0); }
if (process.env.FAKE_PID_FILE) appendFileSync(process.env.FAKE_PID_FILE, process.pid + "\\n");
if (process.env.FAKE_TOOL_CHILD === "1") {
  // Stands in for a tool the agent is running (a build, a dev server): it ignores stdin, so the agent's
  // own exit on stdin EOF does not end it.
  const tool = spawn(process.execPath, ["-e", "await Bun.sleep(60000)"], { stdio: "ignore", windowsHide: true });
  appendFileSync(process.env.FAKE_PID_FILE, "tool " + tool.pid + "\\n");
}
if (process.env.FAKE_LOAD_FAIL === "1") {
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => {
    buf += c;
    let nl;
    while ((nl = buf.indexOf("\\n")) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id === undefined || !m.method) continue;
      const reply = m.method === "session/load" ? { error: { code: -32002, message: "Session not found" } }
        : { result: m.method === "initialize" ? { protocolVersion: 1, agentCapabilities: {} } : m.method === "session/new" ? { sessionId: "fresh-session-2" } : {} };
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, ...reply }) + "\\n");
    }
  });
} else {
  await import(${JSON.stringify(pathToFileURL(FAKE_AGENT).href)});
}
// Registered AFTER the agent's own stdin listener: attaching first would start the stream flowing before
// the agent listens, and it could miss the first request.
let traceBuf = "";
process.stdin.on("data", (c) => {
  traceBuf += String(c);
  let nl;
  while ((nl = traceBuf.indexOf("\\n")) >= 0) {
    const line = traceBuf.slice(0, nl); traceBuf = traceBuf.slice(nl + 1);
    try { const m = JSON.parse(line); if (m.method && process.env.FAKE_TRACE_FILE) appendFileSync(process.env.FAKE_TRACE_FILE, process.pid + " " + m.method + " " + (m.params?.sessionId ?? "-") + "\\n"); } catch {}
  }
});
`;

/** Build the executable fake omp. Returns the path LUCID_OMP_BIN should name. */
function buildFakeOmp(): string {
  if (process.platform === "win32") {
    const bin = join(ROOT, "node_modules", ".bin");
    const dist = join(ROOT, "node_modules", "@oh-my-pi", "pi-coding-agent", "dist");
    mkdirSync(bin, { recursive: true });
    mkdirSync(dist, { recursive: true });
    copyFileSync(join(REPO, "node_modules", ".bin", "omp.exe"), join(bin, "omp.exe"));
    copyFileSync(join(REPO, "node_modules", ".bin", "omp.bunx"), join(bin, "omp.bunx"));
    writeFileSync(join(dist, "cli.js"), WRAPPER);
    return join(bin, "omp.exe");
  }
  const bin = join(ROOT, "bin", "omp");
  mkdirSync(join(ROOT, "bin"), { recursive: true });
  writeFileSync(bin, `#!/usr/bin/env bun\n${WRAPPER}`);
  chmodSync(bin, 0o755);
  return bin;
}

const OMP = buildFakeOmp();
process.env.LUCID_OMP_BIN = OMP;
process.env.FAKE_ACP_MODE = "hang";

// Real time is unavoidable here: the conditions live in a separate agent PROCESS (its trace file, its pid),
// which fake timers cannot advance. `until` polls the real signal instead of guessing a duration.
async function until(pred: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("condition not reached in time");
    await Bun.sleep(25);
  }
}
type Trace = { pid: string; method: string; sessionId: string };
function trace(): Trace[] {
  if (!existsSync(TRACE)) return [];
  return readFileSync(TRACE, "utf8").trim().split("\n").filter(Boolean).map((l) => { const [pid, method, sessionId] = l.split(" "); return { pid: pid!, method: method!, sessionId: sessionId! }; });
}
function incidents(): { kind: string; outcome: string }[] {
  if (!existsSync(INCIDENTS)) return [];
  return readdirSync(INCIDENTS).filter((n) => n.endsWith(".json")).map((n) => JSON.parse(readFileSync(join(INCIDENTS, n), "utf8")));
}

// Dynamic on purpose: static imports are hoisted above the environment setup, and acp.ts / acp_backend.ts
// read HOME-derived paths at module load, which must never resolve to this machine's real ones.
const { backend } = await import("./acp_backend.ts");
const { ACPClient } = await import("./acp.ts");
const persisted: string[] = [];

beforeAll(() => {
  // Safety: if the fake cannot be proven, ompBin() would fall through to a REAL omp on PATH. Refuse.
  const probe = Bun.spawnSync([OMP, "--version"], { stdout: "pipe", stderr: "ignore" });
  if (!String(probe.stdout).includes("fake-omp")) throw new Error(`the fake omp at ${OMP} did not answer --version; refusing to run against a real omp`);
  // Guarded so the wedge tests can also be run against the pre-P-RECOVER.1 Backend (which lacks this
  // method) to show they fail there for the right reason.
  if ("configureRecovery" in backend) backend.configureRecovery({ persistSession: (id) => { persisted.push(id); }, incidentDir: INCIDENTS, acpLog: join(ROOT, "acp.log") });
});

afterEach(() => {
  backend.restart();
  delete process.env.FAKE_LOAD_FAIL;
  process.env.FAKE_ACP_MODE = "hang";
  rmSync(TRACE, { force: true });
  rmSync(INCIDENTS, { recursive: true, force: true });
});

afterAll(() => {
  backend.restart();
  resetSandboxStatus(); // spawning the real Backend publishes a sandbox posture into this shared store
  for (const k of ENV_KEYS) { if (ENV_BEFORE[k] === undefined) delete process.env[k]; else process.env[k] = ENV_BEFORE[k]; }
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* a child may still hold a file on Windows */ }
});

describe("session-switch wedge: a cleared turn releases the session", () => {
  for (const [label, switchSession] of [
    ["loadSession", () => backend.loadSession("fake-session-1")],
    ["newSession", () => backend.newSession()],
  ] as const) {
    test(`${label} during a hanging turn, then prompt() runs instead of throwing "already running"`, async () => {
      process.env.FAKE_ACP_MODE = "hang";
      const first = backend.prompt("first question", () => {});
      await until(() => trace().some((t) => t.method === "session/prompt"));
      await switchSession();
      // The cleared turn's session was told to stop, so omp is not left generating into it.
      expect(trace().some((t) => t.method === "session/cancel" && t.sessionId === "fake-session-1")).toBe(true);
      const second = backend.prompt("second question", () => {});
      // Pre-fix the refusal is immediate (a rejected promise); a live turn is one still pending once the
      // fake has actually received its session/prompt, which is the real signal awaited here.
      const state = await Promise.race([
        second.then(() => "resolved", (e: Error) => `rejected: ${e.message}`),
        until(() => trace().filter((t) => t.method === "session/prompt").length >= 2).then(() => "running", () => "never sent"),
      ]);
      expect(state).toBe("running");
      expect(backend.turnStatus()?.running).toBe(true);
      backend.cancel(); // the fake answers the hanging prompt as cancelled
      await second;
      await first; // the first turn unwound on its own cancel, without touching the second
      expect(backend.midTurn().busy).toBe(false);
    }, 30_000);
  }
});

describe("master child revival", () => {
  test("a dead master child is revived by the next prompt, resuming the same session", async () => {
    process.env.FAKE_ACP_MODE = "crash";
    await backend.prompt("this turn loses its agent", () => {});
    expect(backend.healthStatus().dead).toBe(true);
    await until(() => trace().some((t) => t.method === "session/new")); // the trace can lag the agent's reply
    const deadPid = trace().find((t) => t.method === "session/new")!.pid; // the crash exits before tracing its prompt

    process.env.FAKE_ACP_MODE = "clean";
    const tokens: string[] = [];
    await backend.prompt("are you back?", (e) => { if (e.type === "token") tokens.push(e.text); });
    expect(tokens.join("")).toContain("Hello from the fake hermes agent");
    const revived = trace().filter((t) => t.pid !== deadPid);
    expect(revived.some((t) => t.method === "session/load" && t.sessionId === "fake-session-1")).toBe(true);
    expect(revived.some((t) => t.method === "session/new")).toBe(false);
    expect(revived.find((t) => t.method === "session/prompt")?.sessionId).toBe("fake-session-1");
    expect(backend.healthStatus().dead).toBe(false);
    expect(incidents().map((i) => [i.kind, i.outcome])).toContainEqual(["agent-child-failed", "recovered"]);
  }, 30_000);
});

describe("verified resume (POST /api/recovery/resume)", () => {
  test("a session/load the agent accepts resumes and persists the id", async () => {
    process.env.FAKE_ACP_MODE = "clean";
    const r = await backend.resumeSession("prev-session-9");
    expect(r).toEqual({ ok: true, sessionId: "prev-session-9" });
    expect(backend.currentSessionId()).toBe("prev-session-9");
    expect(persisted.at(-1)).toBe("prev-session-9");
    expect(incidents()).toEqual([]);
  }, 30_000);

  test("a session/load the agent rejects is a failure with an incident, and leaves no session", async () => {
    process.env.FAKE_LOAD_FAIL = "1";
    const r = await backend.resumeSession("prev-session-9");
    expect(r.ok).toBe(false);
    expect(typeof r.incidentId).toBe("string");
    expect(backend.currentSessionId()).toBeNull();
    expect(incidents().map((i) => [i.kind, i.outcome])).toEqual([["session-unrecoverable", "not-recovered"]]);
    // The next prompt starts a fresh session instead of talking to the one that failed to load.
    await backend.prompt("hello", () => {});
    expect(backend.currentSessionId()).toBe("fresh-session-2");
  }, 30_000);
});

describe("in-place recovery (POST /api/recovery/recover)", () => {
  test("respawns the child and resumes the same session; a concurrent request is refused, not doubled", async () => {
    process.env.FAKE_ACP_MODE = "clean";
    expect((await backend.resumeSession("live-session-3")).ok).toBe(true);
    // The trace is appended by a second stdin listener in the agent, so it can land after the agent's
    // reply: wait for the line, never read it in the same tick (a CI run on Windows lost that race).
    const loadsOf = () => trace().filter((t) => t.method === "session/load" && t.sessionId === "live-session-3");
    await until(() => loadsOf().length >= 1);
    const before = loadsOf()[0]!.pid;
    const [a, b] = await Promise.all([backend.recoverMaster(), backend.recoverMaster()]);
    const won = a.ok ? a : b;
    const lost = a.ok ? b : a;
    expect(won).toMatchObject({ ok: true, sessionId: "live-session-3" });
    expect(lost.ok).toBe(false);
    expect(lost.reason).toContain("already in progress");
    // Both calls have settled, so every load that will ever be sent has been sent; only the trace can lag.
    await until(() => new Set(loadsOf().map((t) => t.pid)).size >= 2);
    const loads = loadsOf();
    expect(new Set(loads.map((t) => t.pid)).size).toBe(2); // exactly one respawn loaded the session
    expect(loads.at(-1)!.pid).not.toBe(before);
    expect(incidents().map((i) => [i.kind, i.outcome])).toEqual([["agent-child-failed", "recovered"]]);
  }, 30_000);
});

describe("ACPClient.stop() ends the whole child tree", () => {
  // The agent itself exits on stdin EOF once the shim is gone, so the case that needs the tree kill is a
  // process the AGENT started (a tool run) that does not read stdin: without it, that process outlives stop().
  test.skipIf(process.platform !== "win32")("a tool process the agent started does not outlive stop()", async () => {
    process.env.FAKE_ACP_MODE = "hang";
    process.env.FAKE_TOOL_CHILD = "1";
    rmSync(PIDS, { force: true });
    const c = new ACPClient(OMP, ["acp"], WS);
    try {
      c.start();
      await c.request("initialize", { protocolVersion: 1 }, { timeoutMs: 20_000 });
      await until(() => existsSync(PIDS) && readFileSync(PIDS, "utf8").includes("tool "));
      const toolPid = Number(/tool (\d+)/.exec(readFileSync(PIDS, "utf8"))![1]);
      const alive = () => { try { process.kill(toolPid, 0); return true; } catch { return false; } };
      expect(alive()).toBe(true);
      c.stop();
      try { await until(() => !alive(), 5_000); } finally { if (alive()) process.kill(toolPid); }
    } finally {
      delete process.env.FAKE_TOOL_CHILD;
    }
  }, 30_000);
});
