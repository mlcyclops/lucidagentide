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
import { ScannerClient, ScanUnavailableError, chooseSidecarDir, resolveSidecarDir, type ScannerExit } from "./scanner_client.ts";
import { scanAndDecide } from "./gate.ts";
import { repoAsset } from "../../desktop/repo_root.ts";

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
    const realVenv = join(resolveSidecarDir().dir, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
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
      // An override that holds server.py wins over the probed repo sidecar (ADR-0604).
      expect(client.sidecar).toEqual({ dir, source: "env", usable: true, note: "" });
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

// P-SCANLIVE.2 (ADR-0604, #631): a stale user-level LUCID_SCANNER_DIR used to win over the probed
// sidecar, so every scan failed closed with nothing saying why.
describe("which sidecar directory is used", () => {
  const holds = (...dirs: string[]) => (d: string) => dirs.includes(d);
  const PROBED = "/repo/scanner-sidecar";

  test("a stale override loses to a probed directory that holds server.py, and the note names it", () => {
    const r = chooseSidecarDir("/old-install/scanner-sidecar", PROBED, holds(PROBED));
    expect(r).toMatchObject({ dir: PROBED, source: "probe", usable: true });
    expect(r.note).toContain("/old-install/scanner-sidecar");
  });

  test("an override that holds server.py wins over the probe (the launcher's own child)", () => {
    const r = chooseSidecarDir(" /lane/scanner-sidecar ", PROBED, holds("/lane/scanner-sidecar", PROBED));
    expect(r).toEqual({ dir: "/lane/scanner-sidecar", source: "env", usable: true, note: "" });
  });

  test("with no override the probe is used", () => {
    expect(chooseSidecarDir(undefined, PROBED, holds(PROBED))).toEqual({ dir: PROBED, source: "probe", usable: true, note: "" });
    expect(chooseSidecarDir("  ", PROBED, holds(PROBED))).toEqual({ dir: PROBED, source: "probe", usable: true, note: "" });
  });

  test("with neither usable the result is unusable and the note names every directory tried", () => {
    const both = chooseSidecarDir("/old-install/scanner-sidecar", PROBED, holds());
    expect(both.usable).toBe(false);
    expect(both.note).toContain("/old-install/scanner-sidecar");
    expect(both.note).toContain(PROBED);
    const probeOnly = chooseSidecarDir(undefined, PROBED, holds());
    expect(probeOnly.usable).toBe(false);
    expect(probeOnly.note).toContain(PROBED);
  });

  test("a stale LUCID_SCANNER_DIR in the real environment is ignored: the repo sidecar starts and scans", async () => {
    const saved = process.env.LUCID_SCANNER_DIR;
    const stale = mkdtempSync(join(tmpdir(), "scanstale-")); // exists, but holds no server.py
    process.env.LUCID_SCANNER_DIR = stale;
    try {
      const r = resolveSidecarDir();
      expect(r).toMatchObject({ dir: repoAsset("scanner-sidecar"), source: "probe", usable: true });
      expect(r.note).toContain(stale);
      const client = new ScannerClient({ timeoutMs: 4000 });
      client.start();
      try {
        expect(client.sidecar?.source).toBe("probe");
        expect((await scanAndDecide(client, "benign")).block).toBe(false);
        // A real scanner, not a pass-through.
        expect((await scanAndDecide(client, `edit${ZWSP}file`)).failClosed).toBe(false);
      } finally {
        client.stop();
      }
    } finally {
      if (saved === undefined) delete process.env.LUCID_SCANNER_DIR; else process.env.LUCID_SCANNER_DIR = saved;
      rmSync(stale, { recursive: true, force: true });
    }
  });

  test("FAIL-CLOSED: with no usable directory nothing is spawned and every scan throws, naming the directory", async () => {
    const gone = "/gone/scanner-sidecar";
    const exits: ScannerExit[] = [];
    const client = new ScannerClient({
      timeoutMs: 4000,
      onExit: (e) => exits.push(e),
      resolveDir: () => chooseSidecarDir(gone, PROBED, () => false),
    });
    client.start();
    try {
      expect(client.alive).toBe(false);
      expect(client.pid).toBeUndefined();
      expect(exits.length).toBe(1);
      expect(exits[0]!.reason).toContain(gone);
      expect(exits[0]!.reason).toContain(PROBED);

      const err = await client.scan("benign").then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(ScanUnavailableError);
      expect((err as Error).message).toContain(gone);

      const d = await scanAndDecide(client, "benign");
      expect(d.block).toBe(true);
      expect(d.failClosed).toBe(true);
      expect(d.reason).toContain(gone);

      // Past the backoff the retry resolves again, still finds nothing, and still blocks.
      skipBackoff(exits[exits.length - 1]!.restartInMs);
      const again = await scanAndDecide(client, "benign");
      expect(again.block).toBe(true);
      expect(again.failClosed).toBe(true);
      expect(again.reason).toContain(gone);
      expect(exits.length).toBeGreaterThan(1);
    } finally {
      client.stop();
    }
  });
});
