// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/security/scanner_client.test.ts
//
// P-SCANLIVE.1 (ADR-0571): a sidecar that dies or hangs is replaced by the next scan after a backoff,
// and fails closed until then. The field failure: a sidecar killed from outside left the gate
// blocking every tool call ("scanner not running") until the whole app was restarted.

import { test, expect, describe, beforeAll, afterAll, afterEach, setSystemTime } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScannerClient, sidecarDir, type ScannerExit } from "./scanner_client.ts";
import { scanAndDecide } from "./gate.ts";

const ZWSP = String.fromCodePoint(0x200b);

/** The respawn backoff reads Date.now(), so a test moves the clock past it instead of sleeping. */
function skipBackoff(ms: number): void {
  setSystemTime(new Date(Date.now() + ms + 1));
}
afterEach(() => setSystemTime());

/** Wait until `pred` holds, polling every 20ms, failing after `ms`. */
async function until(pred: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("condition not reached");
    await Bun.sleep(20);
  }
}

test("a sidecar killed from outside blocks, reports its exit, then is respawned by a later scan", async () => {
  const exits: ScannerExit[] = [];
  const client = new ScannerClient({ timeoutMs: 4000, onExit: (e) => exits.push(e) });
  client.start();
  try {
    expect((await scanAndDecide(client, "benign")).block).toBe(false);
    const first = client.pid!;
    process.kill(first);
    await until(() => !client.alive);

    expect(exits.length).toBe(1);
    expect(exits[0]!.reason).toContain("exited");
    expect(exits[0]!.restartInMs).toBeGreaterThan(0);

    // Inside the backoff: still fail-closed, and the reason names the exit instead of "not running".
    const during = await scanAndDecide(client, "benign");
    expect(during.block).toBe(true);
    expect(during.failClosed).toBe(true);
    expect(during.reason).toContain("last exit");

    skipBackoff(exits[0]!.restartInMs);
    const after = await scanAndDecide(client, "benign text after the restart");
    expect(after.block).toBe(false);
    expect(client.pid).not.toBe(first);
    // A real scanner is back, not a pass-through: hidden Unicode still blocks.
    const poisoned = await scanAndDecide(client, `edit${ZWSP}file`);
    expect(poisoned.block).toBe(true);
    expect(poisoned.failClosed).toBe(false);
  } finally {
    client.stop();
  }
});

test("stop() is terminal: a stopped client never respawns, however long it waits", async () => {
  const client = new ScannerClient({ timeoutMs: 4000 });
  client.start();
  client.stop();
  skipBackoff(60_000); // far past any respawn backoff
  const d = await scanAndDecide(client, "benign");
  expect(d.block).toBe(true);
  expect(d.failClosed).toBe(true);
  expect(client.alive).toBe(false);
});

describe("a hung sidecar", () => {
  // A stand-in sidecar: the FIRST process never answers (hung); every later one answers clean.
  let dir: string;
  const saved = { dir: process.env.LUCID_SCANNER_DIR, py: process.env.SCANNER_PYTHON };
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "scanlive-"));
    writeFileSync(join(dir, "server.py"), [
      "import json, os, sys, time",
      "marker = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'hung-once')",
      "if not os.path.exists(marker):",
      "    open(marker, 'w').close()",
      "    time.sleep(3600)",
      "for raw in sys.stdin:",
      "    req = json.loads(raw)",
      "    sys.stdout.write(json.dumps({'id': req['id'], 'findings': [], 'scanner_version': 'fake'}) + '\\n')",
      "    sys.stdout.flush()",
      "",
    ].join("\n"));
    // The real sidecar's interpreter, resolved before LUCID_SCANNER_DIR is pointed at the stand-in.
    const realVenv = join(sidecarDir(), ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
    process.env.SCANNER_PYTHON = saved.py ?? (existsSync(realVenv) ? realVenv : process.platform === "win32" ? "python" : "python3");
    process.env.LUCID_SCANNER_DIR = dir;
  });
  afterAll(async () => {
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

  test("is killed on a scan timeout and replaced by a later scan", async () => {
    const exits: ScannerExit[] = [];
    const client = new ScannerClient({ timeoutMs: 1500, onExit: (e) => exits.push(e) });
    client.start();
    try {
      const hung = await scanAndDecide(client, "benign");
      expect(hung.block).toBe(true);
      expect(hung.failClosed).toBe(true);
      expect(hung.reason).toContain("timeout");

      await until(() => exits.length === 1);
      expect(exits[0]!.reason).toContain("no response within 1500ms");

      skipBackoff(exits[0]!.restartInMs);
      const after = await scanAndDecide(client, "benign");
      expect(after.block).toBe(false);
    } finally {
      client.stop();
    }
  });
});
