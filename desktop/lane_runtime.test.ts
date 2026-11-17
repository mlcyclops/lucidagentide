// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-HOLDER.2 (ADR-0574): held lanes run from a per-version copy of the runtime, so an update can replace the install
// folder while they live on. What must hold:
//   - only a packaged layout has a copy; the copy carries what a lane runs and none of the IDE's big binaries;
//   - a held lane's command, arguments and path variables point at the copy, but only to what the copy has;
//   - P-HOLDER.3 (ADR-0606): a held lane's omp Python kernel resolves to the copy's interpreter, never the install's;
//   - a new build gets its own copy, and cleanup never deletes the current copy or one a held lane's record names.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, sep } from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolveExplicitPythonRuntime } from "@oh-my-pi/pi-coding-agent/eval/py/runtime";
import { cfgPythonInterpreter } from "@oh-my-pi/pi-coding-agent/eval/settings";
import { HolderPool } from "./lane_holder.ts";
import { installResources, LaneRuntime, PYTHON_OVERLAY, pythonOverlayYaml } from "./lane_runtime.ts";

const made: string[] = [];
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

/** A packaged install's `resources` folder with the files a lane runs and some it does not. */
function install(): { resources: string; data: string } {
  const base = mkdtempSync(join(tmpdir(), "lucid-lane-runtime-"));
  made.push(base);
  const resources = join(base, "Programs", "LucidAgentIDE", "resources");
  const file = (rel: string, body = rel) => { const p = join(resources, rel); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, body); };
  file(join("repo", "package.json"), JSON.stringify({ version: "0.0.0" }));
  file(join("repo", "desktop", "package.json"), JSON.stringify({ version: "2.5.4-beta.4" }));
  file(join("repo", "bin", "lucid-holder.exe"));
  file(join("repo", "bin", "lucid-engine.exe"), "x".repeat(4096));
  file(join("repo", "bin", "lucid.exe"));
  file(join("repo", "node_modules", ".bin", "omp.exe"));
  file(join("repo", "node_modules", "@oh-my-pi", "pi-coding-agent", "dist", "cli.js"));
  file(join("repo", "harness", "omp", "security_extension.ts"));
  file(join("repo", "scanner-sidecar", "server.py"));
  file(join("runtimes", "bun.exe"));
  file(join("runtimes", "uv-win32-x64.exe"));
  file(join("runtimes", "python-win32-x64", "python.exe"));
  return { resources, data: join(base, "data") };
}
/** A lane's working folder with no venv of its own (made fresh under `data`). */
function lanes(data: string, name = "work"): string {
  const cwd = join(data, "lanes", name);
  mkdirSync(cwd, { recursive: true });
  return cwd;
}
/** A Windows venv at `venv` whose pyvenv.cfg says it is built on the Python in `home`. */
function venvAt(venv: string, home: string): void {
  mkdirSync(join(venv, "Scripts"), { recursive: true });
  writeFileSync(join(venv, "Scripts", "python.exe"), "venv launcher");
  writeFileSync(join(venv, "pyvenv.cfg"), `home = ${home}\ninclude-system-site-packages = false\nversion = 3.12.7\n`);
}
const runtime = (resources: string, data: string, log: string[] = []) =>
  new LaneRuntime({ resources, root: join(data, "lane-runtime"), platform: "win32", arch: "x64", log: (l) => log.push(l) });

describe("which installs get a runtime copy", () => {
  test("a packaged install's resources folder does; a source checkout does not", () => {
    const { resources } = install();
    expect(installResources(join(resources, "repo"))).toBe(resources);
    expect(installResources(join(tmpdir(), "lucidagentide"))).toBeNull();
    // resources/repo without runtimes/ is not a packaged install either
    const bare = mkdtempSync(join(tmpdir(), "lucid-bare-"));
    made.push(bare);
    mkdirSync(join(bare, "resources", "repo"), { recursive: true });
    expect(installResources(join(bare, "resources", "repo"))).toBeNull();
  });
});

describe("the copy", () => {
  test("carries what a held lane runs, not the IDE's own binaries, and is made once", async () => {
    const { resources, data } = install();
    const log: string[] = [];
    const rt = runtime(resources, data, log);
    expect(rt.key).toMatch(/^2\.5\.4-beta\.4-[0-9a-f]{10}$/);
    const dir = await rt.prepare();
    expect(dir).toBe(rt.dir);
    for (const rel of [["repo", "bin", "lucid-holder.exe"], ["repo", "node_modules", ".bin", "omp.exe"], ["repo", "node_modules", "@oh-my-pi", "pi-coding-agent", "dist", "cli.js"], ["repo", "harness", "omp", "security_extension.ts"], ["repo", "scanner-sidecar", "server.py"], ["runtimes", "bun.exe"], ["runtimes", "python-win32-x64", "python.exe"]]) {
      expect({ rel: rel.join("/"), there: existsSync(join(dir!, ...rel)) }).toEqual({ rel: rel.join("/"), there: true });
    }
    for (const rel of [["repo", "bin", "lucid-engine.exe"], ["repo", "bin", "lucid.exe"], ["runtimes", "uv-win32-x64.exe"]]) {
      expect({ rel: rel.join("/"), there: existsSync(join(dir!, ...rel)) }).toEqual({ rel: rel.join("/"), there: false });
    }
    expect(rt.holderIn(dir!)).toBe(join(dir!, "repo", "bin", "lucid-holder.exe"));
    // A second engine on the same build finds the complete copy and copies nothing.
    const again = runtime(resources, data, log);
    expect(await again.prepare()).toBe(dir);
    expect(log.filter((l) => l.includes("copied"))).toHaveLength(1);
    expect(readdirSync(join(data, "lane-runtime"))).toEqual([rt.key]);
  });

  test("a held lane's command, arguments and path variables point at the copy, only where the copy has the file", async () => {
    const { resources, data } = install();
    const rt = runtime(resources, data);
    const dir = (await rt.prepare())!;
    const omp = join(resources, "repo", "node_modules", ".bin", "omp.exe");
    const gate = join(resources, "repo", "harness", "omp", "security_extension.ts");
    const lucid = join(resources, "repo", "bin", "lucid.exe");
    const other = join(tmpdir(), "elsewhere", "tool.exe");
    // On Windows the install folder may come back in another case; only that prefix differs here.
    const m = rt.map(dir, resources.toUpperCase() + omp.slice(resources.length), ["acp", "-e", gate, "--note", lucid], {
      PATH: [join(resources, "runtimes"), join(resources, "repo", "bin"), "C:\\Windows\\System32"].join(delimiter),
      SCANNER_PYTHON: join(resources, "runtimes", "python-win32-x64", "python.exe"),
      LUCID_BUN_BIN: join(resources, "runtimes", "bun.exe"),
      OTHER: other, EMPTY: undefined,
    }, lanes(data));
    expect(m.cmd).toBe(join(dir, "repo", "node_modules", ".bin", "omp.exe"));
    expect(m.args).toEqual(["acp", "-e", join(dir, "repo", "harness", "omp", "security_extension.ts"), "--note", lucid]); // lucid.exe is not copied
    expect(m.env.PATH).toBe([join(dir, "runtimes"), join(dir, "repo", "bin"), "C:\\Windows\\System32"].join(delimiter));
    expect(m.env.SCANNER_PYTHON).toBe(join(dir, "runtimes", "python-win32-x64", "python.exe"));
    expect(m.env.LUCID_BUN_BIN).toBe(join(dir, "runtimes", "bun.exe"));
    expect(m.env.OTHER).toBe(other);
    expect("EMPTY" in m.env && m.env.EMPTY === undefined).toBe(true);
  });
});

// P-HOLDER.3 (ADR-0606, issue #633): a held lane's omp Python kernel ran on ~/.omp/python-env, a venv built on the
// install folder's Python, so it pinned the install folder. The lane's env now hands omp an overlay naming the copy's
// interpreter, read here through omp's own settings loader and interpreter resolution.
describe("a held lane's Python kernel runs on the copy", () => {
  /** What omp in the lane resolves as its kernel interpreter for env `env` in `cwd`: `python.interpreter` from the
   *  files PI_CONFIG_FILES lists (omp's Settings reads that variable itself), then omp's explicit-interpreter path. */
  async function ompKernelPython(env: Record<string, string | undefined>, cwd: string, data: string): Promise<string | undefined> {
    const agentDir = join(data, "omp-agent-empty");
    mkdirSync(agentDir, { recursive: true });
    const saved = process.env.PI_CONFIG_FILES;
    if (env.PI_CONFIG_FILES === undefined) delete process.env.PI_CONFIG_FILES; else process.env.PI_CONFIG_FILES = env.PI_CONFIG_FILES;
    try {
      const settings = await Settings.loadReadOnly({ cwd, agentDir });
      const interpreter = cfgPythonInterpreter.get(settings)?.trim() || undefined;
      return interpreter ? resolveExplicitPythonRuntime(interpreter, cwd, {}).pythonPath : undefined;
    } finally {
      if (saved === undefined) delete process.env.PI_CONFIG_FILES; else process.env.PI_CONFIG_FILES = saved;
    }
  }
  const under = (p: string, root: string) => p.toLowerCase().startsWith((root + sep).toLowerCase());

  test("the copy carries an omp overlay naming the copy's own Python, never the install folder's", async () => {
    const { resources, data } = install();
    const rt = runtime(resources, data);
    const dir = (await rt.prepare())!;
    const body = readFileSync(join(dir, PYTHON_OVERLAY), "utf8");
    expect(body).toBe(pythonOverlayYaml(join(dir, "runtimes", "python-win32-x64", "python.exe")));
    expect(body).not.toContain(JSON.stringify(resources).slice(1, -1));
  });

  test("a lane with no venv of its own: omp's kernel interpreter is the copy's python.exe, not under the install", async () => {
    const { resources, data } = install();
    const rt = runtime(resources, data);
    const dir = (await rt.prepare())!;
    const cwd = lanes(data);
    const earlier = join(data, "someone-elses.yml");
    writeFileSync(earlier, "{}\n");
    const m = rt.map(dir, join(resources, "repo", "node_modules", ".bin", "omp.exe"), ["acp"], {
      PATH: join(resources, "runtimes", "python-win32-x64"),
      PI_CONFIG_FILES: earlier,
    }, cwd);
    // An existing list is kept; the copy's overlay is appended to it.
    expect(m.env.PI_CONFIG_FILES).toBe([earlier, join(dir, PYTHON_OVERLAY)].join(delimiter));
    expect(m.env.PATH).toBe(join(dir, "runtimes", "python-win32-x64"));
    const py = (await ompKernelPython(m.env, cwd, data))!;
    expect(py).toBe(join(dir, "runtimes", "python-win32-x64", "python.exe"));
    expect(existsSync(py)).toBe(true);
    expect(under(py, dir)).toBe(true);
    expect(under(py, resources)).toBe(false);
  });

  test("without the overlay omp would pick no LUCID interpreter at all (so the test above means something)", async () => {
    const { data } = install();
    expect(await ompKernelPython({}, lanes(data), data)).toBeUndefined();
  });

  test("a lane whose own venv omp would pick first keeps it, unless that venv is built on the install's Python", async () => {
    const { resources, data } = install();
    const rt = runtime(resources, data);
    const dir = (await rt.prepare())!;
    const overlay = join(dir, PYTHON_OVERLAY);
    const omp = join(resources, "repo", "node_modules", ".bin", "omp.exe");
    const elsewhere = join(data, "user-python");

    // The project's .venv on the user's own Python: omp picks it before anything else, so it is left alone.
    const own = lanes(data, "own");
    venvAt(join(own, ".venv"), elsewhere);
    expect(rt.map(dir, omp, [], {}, own).env.PI_CONFIG_FILES).toBeUndefined();
    // VIRTUAL_ENV wins over the folder, as in omp.
    const active = join(data, "active-venv");
    venvAt(active, elsewhere);
    expect(rt.map(dir, omp, [], { VIRTUAL_ENV: active }, lanes(data, "plain")).env.PI_CONFIG_FILES).toBeUndefined();

    // A venv built on the install folder's Python pins it like ~/.omp/python-env did: the copy's interpreter instead.
    const pinned = lanes(data, "pinned");
    venvAt(join(pinned, "venv"), join(resources, "runtimes", "python-win32-x64"));
    expect(rt.map(dir, omp, [], {}, pinned).env.PI_CONFIG_FILES).toBe(overlay);
    // VIRTUAL_ENV naming a folder with no interpreter: omp falls through to its managed env, so the copy's instead.
    expect(rt.map(dir, omp, [], { VIRTUAL_ENV: join(data, "gone") }, lanes(data, "plain")).env.PI_CONFIG_FILES).toBe(overlay);
  });

  test("a copy made before this change (no overlay) adds nothing", async () => {
    const { resources, data } = install();
    const rt = runtime(resources, data);
    const dir = (await rt.prepare())!;
    rmSync(join(dir, PYTHON_OVERLAY));
    expect(rt.map(dir, join(resources, "repo", "node_modules", ".bin", "omp.exe"), [], {}, lanes(data)).env.PI_CONFIG_FILES).toBeUndefined();
  });
});

describe("one copy per build, and cleanup", () => {
  test("a new build gets its own copy; cleanup keeps the current one and any a held lane uses", async () => {
    const { resources, data } = install();
    const first = runtime(resources, data);
    await first.prepare();
    writeFileSync(join(resources, "runtimes", "bun.exe"), "a newer bun, another size");
    const second = runtime(resources, data);
    expect(second.key).not.toBe(first.key);
    await second.prepare();
    mkdirSync(join(data, "lane-runtime", "old-1234567890"));
    mkdirSync(join(data, "lane-runtime", `${second.key}.partial-1`));

    // A held lane still runs on the first build: its copy stays.
    expect(second.cleanup(new Set([first.key])).sort()).toEqual([`${second.key}.partial-1`, "old-1234567890"].sort());
    expect(readdirSync(join(data, "lane-runtime")).sort()).toEqual([first.key, second.key].sort());
    // Once no record names it, it goes; the current copy never does.
    expect(second.cleanup(new Set())).toEqual([first.key]);
    expect(readdirSync(join(data, "lane-runtime"))).toEqual([second.key]);
  });

  test("one holder record that cannot be read: that pass deletes nothing, not even the live lane's copy", async () => {
    const { resources, data } = install();
    const first = runtime(resources, data);
    await first.prepare();
    writeFileSync(join(resources, "runtimes", "bun.exe"), "a newer bun, another size");
    const second = runtime(resources, data);
    await second.prepare();
    mkdirSync(join(data, "lane-runtime", "old-1234567890"));
    const pool = new HolderPool(join(data, "lane-holders"), "lucid-holder-unused", second);
    // A live lane on the first build, its record as the pool writes it.
    const holderId = "live-1a2b";
    const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\lucid-holder-${holderId}-${"0".repeat(32)}` : join(pool.dir, `${holderId}.sock`);
    writeFileSync(join(pool.dir, "live.lane.json"), JSON.stringify({ v: 1, laneId: "live", holderId, endpoint, token: "t".repeat(64), runtime: first.key }));
    // Another lane's record, cut off mid-write: whatever copy it named is unknown.
    writeFileSync(join(pool.dir, "other.lane.json"), `{"v":1,"laneId":"other","runtime":"${first.key}`);
    const before = readdirSync(join(data, "lane-runtime")).sort();

    expect(pool.all().map((r) => r.laneId)).toEqual(["live"]);
    expect(pool.runtimesInUse()).toBeNull();
    expect(pool.cleanupRuntimes()).toBeNull();
    expect(readdirSync(join(data, "lane-runtime")).sort()).toEqual(before);

    // Once every record reads, the pass runs: the live lane's copy and the current one stay.
    rmSync(join(pool.dir, "other.lane.json"));
    expect(pool.runtimesInUse()).toEqual(new Set([first.key]));
    expect(pool.cleanupRuntimes()).toEqual(["old-1234567890"]);
    expect(readdirSync(join(data, "lane-runtime")).sort()).toEqual([first.key, second.key].sort());
  });
});
