// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Herd (ADR-0541): argv and file naming. `--name` picks an instance before the verb or after
// `server start|stop`; instance names are file-safe; every instance file lives in the add-on's data
// dir; `server list` names only instances whose server wins the handshake.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHubControl, type HubControl } from "../../../harness/launcher/hub_control.ts";
import { splitName } from "../src/cli.ts";
import { herdDataDir, instanceName, instancePaths, liveInstances } from "../src/instance.ts";

describe("splitName", () => {
  test("the default instance, a leading --name, and --name after server start|stop", () => {
    expect(splitName([])).toEqual({ name: "main", rest: [] });
    expect(splitName(["--name", "work", "split-window", "-h"])).toEqual({ name: "work", rest: ["split-window", "-h"] });
    expect(splitName(["server", "stop", "--name", "work"])).toEqual({ name: "work", rest: ["server", "stop"] });
    expect(splitName(["server", "list"])).toEqual({ name: "main", rest: ["server", "list"] });
  });
  test("a missing, doubled or unsafe name is a usage or bad_name refusal", () => {
    expect(() => splitName(["--name"])).toThrow("needs an instance name");
    expect(() => splitName(["--name", "a", "server", "stop", "--name", "b"])).toThrow("twice");
    expect(() => splitName(["--name", "../x"])).toThrow("instance name");
  });
});

describe("instance names and files", () => {
  test("names are file-safe and case-blind-safe", () => {
    for (const bad of ["", "Main", "../x", "a.b", "x".repeat(33), "-lead"]) expect(() => instanceName(bad)).toThrow();
    expect(instanceName(undefined)).toBe("main");
    expect(instanceName("work_2-b")).toBe("work_2-b");
  });
  test("every file of an instance is under the add-on data dir, none is a classic hub file", () => {
    const p = instancePaths(join("/d", "plugin-data", "herd"), "work");
    for (const f of [p.spaces, p.priorities, p.snapshots, p.run, p.log]) expect(f.startsWith(join("/d", "plugin-data", "herd"))).toBe(true);
    expect([p.spaces, p.priorities].some((f) => f.endsWith("hub-spaces.json") || f.endsWith("hub-agent-priorities.json"))).toBe(false);
  });
  test("the data dir is the runtime's LUCID_PLUGIN_DATA when set", () => {
    expect(herdDataDir({ LUCID_PLUGIN_DATA: "/x/herd" })).toBe("/x/herd");
  });
});

describe("liveInstances", () => {
  let data: string;
  let controls: HubControl[] = [];
  beforeEach(() => { data = mkdtempSync(join(tmpdir(), "herd-live-")); controls = []; });
  afterEach(() => { for (const c of controls) c.stop(); rmSync(data, { recursive: true, force: true }); });

  test("only instances whose server wins the handshake, by name; stale files and odd folders are ignored", async () => {
    controls.push(startHubControl({ dir: instancePaths(data, "main").run, exec: async () => null }));
    controls.push(startHubControl({ dir: instancePaths(data, "work").run, exec: async () => null }));
    const stale = instancePaths(data, "gone").run;
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, "hub-discovery-4242.json"), JSON.stringify({ v: 1, pid: 4242, port: 1, nonce: "n", token: "t" }));
    mkdirSync(join(data, "run", "Not.A.Name"), { recursive: true });
    expect((await liveInstances(data)).map((h) => h.name)).toEqual(["main", "work"]);
  });
});
