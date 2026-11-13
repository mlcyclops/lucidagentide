// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-HOLDER.2 (ADR-0573): held lanes run from a per-version copy of the runtime, so an update can replace the install
// folder while they live on. What must hold:
//   - only a packaged layout has a copy; the copy carries what a lane runs and none of the IDE's big binaries;
//   - a held lane's command, arguments and path variables point at the copy, but only to what the copy has;
//   - a new build gets its own copy, and cleanup never deletes the current copy or one a held lane's record names.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { installResources, LaneRuntime } from "./lane_runtime.ts";

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
    });
    expect(m.cmd).toBe(join(dir, "repo", "node_modules", ".bin", "omp.exe"));
    expect(m.args).toEqual(["acp", "-e", join(dir, "repo", "harness", "omp", "security_extension.ts"), "--note", lucid]); // lucid.exe is not copied
    expect(m.env.PATH).toBe([join(dir, "runtimes"), join(dir, "repo", "bin"), "C:\\Windows\\System32"].join(delimiter));
    expect(m.env.SCANNER_PYTHON).toBe(join(dir, "runtimes", "python-win32-x64", "python.exe"));
    expect(m.env.LUCID_BUN_BIN).toBe(join(dir, "runtimes", "bun.exe"));
    expect(m.env.OTHER).toBe(other);
    expect("EMPTY" in m.env && m.env.EMPTY === undefined).toBe(true);
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
});
