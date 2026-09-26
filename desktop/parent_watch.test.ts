// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/parent_watch.test.ts - P-PORTGUARD.2: the engine's parent-death watchdog, pure core.
// The invariant under test: the engine ends itself ONLY on proof the Electron main is gone, and a
// standalone engine (no LUCID_MAIN_PID) is never watched at all.

import { describe, expect, test } from "bun:test";
import { parentAlive, parentWatchConfig } from "./parent_watch.ts";

const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });

describe("parentWatchConfig", () => {
  test("watches the pid main handed down, at the default cadence", () => {
    expect(parentWatchConfig({ LUCID_MAIN_PID: "4242" }, 99)).toEqual({ pid: 4242, intervalMs: 2000 });
  });
  test("a standalone engine run is NOT watched", () => {
    // `bun run desktop/dev.ts`, CI, a bare engine binary: no Electron main exists, so self-terminating
    // on a missing pid would kill a legitimate session.
    expect(parentWatchConfig({}, 99)).toBeNull();
    expect(parentWatchConfig({ LUCID_MAIN_PID: "" }, 99)).toBeNull();
  });
  test("garbage, non-positive, and self pids disable the watchdog rather than guessing", () => {
    expect(parentWatchConfig({ LUCID_MAIN_PID: "not-a-pid" }, 99)).toBeNull();
    expect(parentWatchConfig({ LUCID_MAIN_PID: "0" }, 99)).toBeNull();
    expect(parentWatchConfig({ LUCID_MAIN_PID: "-7" }, 99)).toBeNull();
    expect(parentWatchConfig({ LUCID_MAIN_PID: "12.5" }, 99)).toBeNull();
    expect(parentWatchConfig({ LUCID_MAIN_PID: "99" }, 99)).toBeNull(); // inherited into the wrong process
  });
  test("the interval override is clamped, so no setting can spin or sleep forever", () => {
    expect(parentWatchConfig({ LUCID_MAIN_PID: "7", LUCID_PARENT_WATCH_MS: "250" }, 99)?.intervalMs).toBe(250);
    expect(parentWatchConfig({ LUCID_MAIN_PID: "7", LUCID_PARENT_WATCH_MS: "1" }, 99)?.intervalMs).toBe(100);
    expect(parentWatchConfig({ LUCID_MAIN_PID: "7", LUCID_PARENT_WATCH_MS: "900000" }, 99)?.intervalMs).toBe(60_000);
    expect(parentWatchConfig({ LUCID_MAIN_PID: "7", LUCID_PARENT_WATCH_MS: "junk" }, 99)?.intervalMs).toBe(2000);
  });
});

describe("parentAlive", () => {
  test("a signal-0 probe that returns means the parent is up", () => {
    expect(parentAlive(4242, () => {})).toBe(true);
  });
  test("ESRCH - and only ESRCH - means the parent is gone", () => {
    expect(parentAlive(4242, () => { throw errno("ESRCH"); })).toBe(false);
  });
  test("EPERM means alive-but-not-ours: an engine must never exit on someone else's pid", () => {
    expect(parentAlive(4242, () => { throw errno("EPERM"); })).toBe(true);
  });
  test("an unrecognized probe failure keeps the engine running (fail-safe, not fail-closed)", () => {
    expect(parentAlive(4242, () => { throw errno("EINVAL"); })).toBe(true);
    expect(parentAlive(4242, () => { throw new Error("no code at all"); })).toBe(true);
  });
});
