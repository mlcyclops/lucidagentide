// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// ADR-0535: `lucid herd` in core only launches the INSTALLED add-on's client, with the IDE's bun, the
// add-on's data dir and the IDE's node_modules; without the add-on it says how to install it and
// exits 2, starting nothing.

import { describe, expect, spyOn, test } from "bun:test";
import { delimiter, join } from "node:path";
import { HERD_NOT_INSTALLED, herdBun, herdLaunch, runHerd } from "./herd_cli.ts";

describe("lucid herd without the add-on", () => {
  test("prints the one sentence and exits 2", async () => {
    const stderr: string[] = [];
    const spy = spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true; });
    try {
      expect(await runHerd(["server", "list"], {}, "/repo", null)).toBe(2);
    } finally { spy.mockRestore(); }
    expect(stderr.join("")).toBe(`${HERD_NOT_INSTALLED}\n`);
    expect(HERD_NOT_INSTALLED).toBe("Herd is an optional add-on and is not installed. Install it in the IDE: Plugins, Free, Herd.");
  });
});

describe("the launch", () => {
  test("the IDE's bundled bun beside the packaged repo, else bun on PATH", () => {
    const repo = join("/opt/LucidAgentIDE/resources", "repo");
    const bundled = join(repo, "..", "runtimes", "bun");
    expect(herdBun(repo, "linux", (p) => p === bundled)).toBe(bundled);
    expect(herdBun(repo, "linux", () => false)).toBe("bun");
    expect(herdBun(repo, "win32", () => false)).toBe("bun.exe");
  });

  test("client.js with the argv as given, the data dir, the package root, the repo and its node_modules", () => {
    const plan = herdLaunch("/plugins/herd/0.1.0", ["--name", "work", "status"], { PATH: "/bin", NODE_PATH: "/x" }, "/repo", "bun");
    expect(plan.cmd).toBe("bun");
    expect(plan.args).toEqual([join("/plugins/herd/0.1.0", "client.js"), "--name", "work", "status"]);
    expect(plan.env).toMatchObject({ PATH: "/bin", LUCID_PLUGIN_ROOT: "/plugins/herd/0.1.0", LUCID_HERD_REPO: "/repo", NODE_PATH: `${join("/repo", "node_modules")}${delimiter}/x` });
    expect(plan.env.LUCID_PLUGIN_DATA?.endsWith(join("plugin-data", "herd"))).toBe(true);
  });
});
