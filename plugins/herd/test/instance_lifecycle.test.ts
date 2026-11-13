// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Herd (ADR-0563): one server per instance name, and no instance outlives the add-on. A held lock
// refuses a second server hub_running before anything else runs; a lock whose pid is dead is
// reclaimed; the runtime host's stop stops every verified instance through the same path as `lucid
// herd server stop` and names one that will not stop.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHubControl, type HubControl } from "../../../harness/launcher/hub_control.ts";
import { runHubServer } from "../src/hub_server.ts";
import { acquireInstanceLock, connectInstance, instancePaths } from "../src/instance.ts";
import { stopHerdInstances } from "../src/runtime_host.ts";

let data: string;
const controls: HubControl[] = [];

beforeEach(() => { data = mkdtempSync(join(tmpdir(), "herd-life-")); });
afterEach(() => {
  for (const c of controls.splice(0)) c.stop();
  rmSync(data, { recursive: true, force: true });
});

/** A verified instance on loopback. `stops`: whether `server stop` really ends it. */
function fakeInstance(name: string, stops: boolean, seen: string[][]): HubControl {
  const ctl: HubControl = startHubControl({
    dir: instancePaths(data, name).run,
    exec: async () => null,
    commands: (argv) => {
      seen.push([name, ...argv]);
      if (argv[0] !== "server" || argv[1] !== "stop") return undefined;
      // After the reply, as the real server does: a forced server stop inside the handler would cut
      // the reply's socket, and Bun.serve exposes no "response flushed" signal to await instead.
      if (stops) setImmediate(() => ctl.stop());
      return Promise.resolve({ stopping: name, pid: process.pid });
    },
  });
  controls.push(ctl);
  return ctl;
}

const lockPath = (name: string) => join(instancePaths(data, name).run, "server.lock");

describe("one server per name", () => {
  test("a second server for the same name refuses hub_running while the first holds the lock", async () => {
    const first = acquireInstanceLock(data, "work");
    if ("heldBy" in first) throw new Error("the first lock was refused");
    expect(readFileSync(lockPath("work"), "utf8").trim()).toBe(String(process.pid));
    expect(acquireInstanceLock(data, "work")).toEqual({ heldBy: process.pid });

    const errors: string[] = [];
    const write = process.stderr.write;
    process.stderr.write = ((chunk: string) => { errors.push(String(chunk)); return true; }) as typeof process.stderr.write;
    let code: number;
    try { code = await runHubServer({ LUCID_PLUGIN_DATA: data }, { name: "work" }); }
    finally { process.stderr.write = write; }
    expect(code).toBe(1);
    expect(JSON.parse(errors.join("").trim()).error).toBe("hub_running");
    // The refused launch never touched the holder's lock.
    expect(readFileSync(lockPath("work"), "utf8").trim()).toBe(String(process.pid));

    first.release();
    expect(existsSync(lockPath("work"))).toBe(false);
    const again = acquireInstanceLock(data, "work");
    expect("release" in again).toBe(true);
    if ("release" in again) again.release();
  });

  test("a stale lock (its pid is not alive) is reclaimed; a live one is not", () => {
    mkdirSync(instancePaths(data, "work").run, { recursive: true });
    writeFileSync(lockPath("work"), "424242\n");
    expect(acquireInstanceLock(data, "work", process.pid, (pid) => pid === process.pid)).not.toHaveProperty("heldBy");
    expect(readFileSync(lockPath("work"), "utf8").trim()).toBe(String(process.pid));
    rmSync(lockPath("work"));
    writeFileSync(lockPath("work"), "424242\n");
    expect(acquireInstanceLock(data, "work", process.pid, () => true)).toEqual({ heldBy: 424242 });
  });
});

describe("stopping the add-on stops every verified instance", () => {
  test("an adopted main and a named instance are both stopped through `server stop`", async () => {
    const seen: string[][] = [];
    fakeInstance("main", true, seen);
    fakeInstance("work", true, seen);
    const log: string[] = [];
    expect(await stopHerdInstances(data, 5_000, (l) => log.push(l))).toBe(true);
    expect(seen.map((s) => s.join(" ")).sort()).toEqual(["main server stop", "work server stop"]);
    expect(await connectInstance(data, "main")).toBeNull();
    expect(await connectInstance(data, "work")).toBeNull();
    expect(log.join("")).toContain("stopped instances main, work");
  });

  test("an instance that will not stop is logged by name and the stop reports failure", async () => {
    const seen: string[][] = [];
    fakeInstance("main", true, seen);
    fakeInstance("stuck", false, seen);
    const log: string[] = [];
    // A real (short) stop window: the timeout path polls the live handshake on the platform clock.
    expect(await stopHerdInstances(data, 600, (l) => log.push(l))).toBe(false);
    expect(await connectInstance(data, "main")).toBeNull();
    expect(await connectInstance(data, "stuck")).not.toBeNull();
    expect(log.join("")).toContain("could not stop instance stuck: stop_timeout");
  });
});
