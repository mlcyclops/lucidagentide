// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/gpu_watchdog.test.ts - ADR-0246 (P-GPUFIX.1): the zombie-SID GPU-sandbox watchdog.
// The brick: every sandboxed GPU child dies 0xC0000022 before the window shows; after 9 retries
// Electron logs FATAL and the app dies. The watchdog must relaunch with --disable-gpu-sandbox on
// the 2nd pre-render fatal GPU death, must NEVER relaunch when the sandbox is already off (loop
// guard), and must ignore normal GPU lifecycle exits and non-GPU children.

import { describe, expect, test } from "bun:test";
import {
  GPU_RELAUNCH_AFTER_DEATHS,
  GPU_SANDBOX_SWITCH,
  decideGpuAction,
  formatExitCode,
  gpuDeathLogLine,
  isFatalGpuDeath,
  relaunchArgs,
} from "./gpu_watchdog.ts";

const STATUS_ACCESS_DENIED = -1073741790; // 0xC0000022 as the signed 32-bit int Electron reports
const boot = { deathsBefore: 0, windowRendered: false, sandboxOff: false };

describe("isFatalGpuDeath", () => {
  test("GPU launch-failed / abnormal-exit / crashed are fatal", () => {
    for (const reason of ["launch-failed", "abnormal-exit", "crashed"]) {
      expect(isFatalGpuDeath({ type: "GPU", reason })).toBe(true);
    }
  });
  test("normal GPU lifecycle exits are not fatal", () => {
    for (const reason of ["clean-exit", "killed"]) {
      expect(isFatalGpuDeath({ type: "GPU", reason })).toBe(false);
    }
  });
  test("non-GPU children never count, even with a fatal reason", () => {
    expect(isFatalGpuDeath({ type: "Utility", reason: "launch-failed" })).toBe(false);
    expect(isFatalGpuDeath({ reason: "launch-failed" })).toBe(false);
  });
});

describe("decideGpuAction", () => {
  test("first pre-render fatal death logs but does not relaunch yet", () => {
    const r = decideGpuAction({ type: "GPU", reason: "launch-failed", exitCode: STATUS_ACCESS_DENIED }, boot);
    expect(r).toEqual({ action: "log", deaths: 1 });
  });
  test(`death #${GPU_RELAUNCH_AFTER_DEATHS} before first render relaunches (the zombie-SID brick)`, () => {
    const r = decideGpuAction(
      { type: "GPU", reason: "launch-failed", exitCode: STATUS_ACCESS_DENIED },
      { ...boot, deathsBefore: GPU_RELAUNCH_AFTER_DEATHS - 1 },
    );
    expect(r).toEqual({ action: "relaunch", deaths: GPU_RELAUNCH_AFTER_DEATHS });
  });
  test("abnormal-exit counts toward the threshold too", () => {
    const r = decideGpuAction({ type: "GPU", reason: "abnormal-exit" }, { ...boot, deathsBefore: 1 });
    expect(r.action).toBe("relaunch");
  });
  test("ignored events do not advance the death count", () => {
    expect(decideGpuAction({ type: "GPU", reason: "clean-exit" }, { ...boot, deathsBefore: 1 }))
      .toEqual({ action: "ignore", deaths: 1 });
    expect(decideGpuAction({ type: "Utility", reason: "crashed" }, boot))
      .toEqual({ action: "ignore", deaths: 0 });
  });
  test("LOOP GUARD: with the sandbox already off, repeated deaths only log, never relaunch", () => {
    for (const deathsBefore of [0, 1, 5, 20]) {
      const r = decideGpuAction(
        { type: "GPU", reason: "launch-failed" },
        { deathsBefore, windowRendered: false, sandboxOff: true },
      );
      expect(r.action).toBe("log");
    }
  });
  test("after the first window rendered, a GPU crash is not the boot brick: log only", () => {
    const r = decideGpuAction(
      { type: "GPU", reason: "crashed" },
      { deathsBefore: 4, windowRendered: true, sandboxOff: false },
    );
    expect(r).toEqual({ action: "log", deaths: 5 });
  });
});

describe("formatExitCode", () => {
  test("signed NTSTATUS renders as the recognizable unsigned hex", () => {
    expect(formatExitCode(STATUS_ACCESS_DENIED)).toBe("0xC0000022");
  });
  test("small codes stay decimal; absent/invalid codes render empty", () => {
    expect(formatExitCode(1)).toBe("1");
    expect(formatExitCode(0)).toBe("0");
    expect(formatExitCode(undefined)).toBe("");
    expect(formatExitCode(NaN)).toBe("");
  });
});

describe("gpuDeathLogLine", () => {
  test("a relaunch line names the switch, the upstream issue, and 0xC0000022", () => {
    const line = gpuDeathLogLine(
      { type: "GPU", reason: "launch-failed", exitCode: STATUS_ACCESS_DENIED },
      2, "relaunch", "2026-07-18T00:00:00.000Z",
    );
    expect(line).toContain("0xC0000022");
    expect(line).toContain(`--${GPU_SANDBOX_SWITCH}`);
    expect(line).toContain("electron/electron#51761");
    expect(line).toContain("death #2");
    expect(line.endsWith("\n")).toBe(true);
  });
  test("a log-only line still carries reason and count", () => {
    const line = gpuDeathLogLine({ type: "GPU", reason: "abnormal-exit" }, 1, "log", "2026-07-18T00:00:00.000Z");
    expect(line).toContain("reason=abnormal-exit");
    expect(line).toContain("death #1");
    expect(line).not.toContain("relaunching");
  });
});

describe("relaunchArgs", () => {
  test("appends the switch to the current argv", () => {
    expect(relaunchArgs(["main.js", "--foo"])).toEqual(["main.js", "--foo", `--${GPU_SANDBOX_SWITCH}`]);
  });
  test("never duplicates the switch", () => {
    const argv = ["main.js", `--${GPU_SANDBOX_SWITCH}`];
    expect(relaunchArgs(argv)).toEqual(argv);
  });
  test("does not mutate its input", () => {
    const argv = ["main.js"];
    relaunchArgs(argv);
    expect(argv).toEqual(["main.js"]);
  });
});
