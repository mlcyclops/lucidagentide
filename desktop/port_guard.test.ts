// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/port_guard.test.ts - P-PORTGUARD.1 (ADR-0305): the engine port handshake, pure core.
// The incident: a foreign `bun server.ts` squatting on *:5319 answered /api/health with a plain
// 200 and LUCID rendered a stranger's UI. The guard must accept ONLY a health body echoing the
// per-launch nonce, classify everything else as foreign (fail-closed), and render a copy/paste
// incident block with real forensics (name, pid, start time, command) or an explicit statement
// that attribution failed.

import { describe, expect, test } from "bun:test";
import {
  formatPortIncident,
  healthVerdict,
  ownerProbeSpec,
  parseOwnerProbe,
  type PortIncidentInput,
} from "./port_guard.ts";

const NONCE = "a3f1c9e2-per-launch";

describe("healthVerdict", () => {
  test("matching nonce with ok:true is ours", () => {
    expect(healthVerdict(NONCE, true, { ok: true, nonce: NONCE })).toBe("ours");
  });
  test("no HTTP success yet is not-ready, regardless of body", () => {
    expect(healthVerdict(NONCE, false, undefined)).toBe("not-ready");
    expect(healthVerdict(NONCE, false, { ok: true, nonce: NONCE })).toBe("not-ready");
  });
  test("THE INCIDENT: ok:true with no nonce field is foreign-missing-nonce", () => {
    expect(healthVerdict(NONCE, true, { ok: true })).toBe("foreign-missing-nonce");
  });
  test("ok:true with an explicit null nonce is foreign-missing-nonce", () => {
    expect(healthVerdict(NONCE, true, { ok: true, nonce: null })).toBe("foreign-missing-nonce");
  });
  test("ok:true with a different nonce is foreign-wrong-nonce (impersonation, not absence)", () => {
    expect(healthVerdict(NONCE, true, { ok: true, nonce: "someone-elses" })).toBe("foreign-wrong-nonce");
    // A present-but-non-string nonce is also "wrong", not "missing": something TRIED to answer.
    expect(healthVerdict(NONCE, true, { ok: true, nonce: 42 })).toBe("foreign-wrong-nonce");
  });
  test("FAIL-CLOSED: a 200 with a non-object body is foreign-missing-nonce, never ours or not-ready", () => {
    for (const body of [null, undefined, "ok", 200, true, ["ok"]]) {
      expect(healthVerdict(NONCE, true, body)).toBe("foreign-missing-nonce");
    }
  });
  test("FAIL-CLOSED: a 200 without ok === true is foreign-missing-nonce, even with a matching nonce", () => {
    expect(healthVerdict(NONCE, true, { nonce: NONCE })).toBe("foreign-missing-nonce");
    expect(healthVerdict(NONCE, true, { ok: false, nonce: NONCE })).toBe("foreign-missing-nonce");
    expect(healthVerdict(NONCE, true, { ok: "true", nonce: NONCE })).toBe("foreign-missing-nonce");
  });
});

describe("formatPortIncident", () => {
  const base: PortIncidentInput = {
    port: 5319,
    productName: "LUCID Agent IDE",
    appVersion: "1.14.1",
    platform: "darwin",
    engineDescription: "LUCID engine (bin/lucid-engine, agent flavor)",
    verdict: "foreign-missing-nonce",
    observed: {
      pid: 40409,
      name: "bun",
      startedAt: "Wed Aug 27 09:14:02 2026",
      command: "bun server.ts",
    },
  };

  test("carries every forensic field the ADR-0305 user requirement names", () => {
    const block = formatPortIncident(base);
    expect(block).toContain("5319");
    expect(block).toContain("LUCID Agent IDE");
    expect(block).toContain("1.14.1");
    expect(block).toContain("darwin");
    expect(block).toContain("LUCID engine (bin/lucid-engine, agent flavor)");
    expect(block).toContain("foreign-missing-nonce");
    expect(block).toContain("40409");
    expect(block).toContain("bun");
    expect(block).toContain("Wed Aug 27 09:14:02 2026");
    expect(block).toContain("bun server.ts");
  });
  test("null observed says attribution failed EXPLICITLY instead of omitting the section", () => {
    const block = formatPortIncident({ ...base, observed: null });
    expect(block).toContain("attribution FAILED");
    // The verdict and port survive even without attribution: the report stays actionable.
    expect(block).toContain("5319");
    expect(block).toContain("foreign-missing-nonce");
  });
  test("partial attribution renders unknown per field rather than dropping lines", () => {
    const block = formatPortIncident({
      ...base,
      observed: { pid: 40409, name: null, startedAt: null, command: null },
    });
    expect(block).toContain("40409");
    expect(block).toContain("unknown");
    expect(block).not.toContain("attribution FAILED");
  });
});

describe("ownerProbeSpec", () => {
  test("win32 is a single powershell.exe -NoProfile -Command invocation", () => {
    const spec = ownerProbeSpec("win32", 5319);
    expect(spec).not.toBeNull();
    expect(spec!.cmd).toBe("powershell.exe");
    expect(spec!.args[0]).toBe("-NoProfile");
    expect(spec!.args[1]).toBe("-Command");
    expect(spec!.args).toHaveLength(3);
    const script = spec!.args[2];
    expect(script).toContain("Get-NetTCPConnection");
    expect(script).toContain("-LocalPort 5319");
    expect(script).toContain("Get-Process");
    expect(script).toContain("ConvertTo-Json");
  });
  test.each(["darwin", "linux"])("%s is an sh -c lsof-to-ps pipeline", (platform) => {
    const spec = ownerProbeSpec(platform, 5320);
    expect(spec).not.toBeNull();
    expect(spec!.cmd).toBe("sh");
    expect(spec!.args[0]).toBe("-c");
    const script = spec!.args[1];
    expect(script).toContain("lsof -tnP -iTCP:5320 -sTCP:LISTEN");
    expect(script).toContain("ps -p");
    expect(script).toContain("-o pid=,lstart=,command=");
  });
  test("unknown platforms get null, not a guessed probe", () => {
    expect(ownerProbeSpec("freebsd", 5319)).toBeNull();
    expect(ownerProbeSpec("aix", 5319)).toBeNull();
    expect(ownerProbeSpec("", 5319)).toBeNull();
  });
});

describe("parseOwnerProbe", () => {
  // PowerShell 7 ConvertTo-Json: bare object, ISO-ish StartTime kept verbatim.
  const WIN_BARE = JSON.stringify({
    Id: 40409,
    ProcessName: "bun",
    StartTime: "2026-08-27T09:14:02.0000000-07:00",
    Path: "C:\\Users\\dev\\.bun\\bin\\bun.exe",
  });
  // Windows PowerShell 5.1 ConvertTo-Json: array form plus the \/Date(ms)\/ DateTime encoding.
  const WIN_ARRAY =
    '[{"Id":40409,"ProcessName":"bun","StartTime":"\\/Date(1756300000000)\\/","Path":"C:\\\\Users\\\\dev\\\\.bun\\\\bin\\\\bun.exe"},' +
    '{"Id":999,"ProcessName":"other","StartTime":null,"Path":null}]';

  test("win32 bare-object ConvertTo-Json parses with the ISO StartTime verbatim", () => {
    expect(parseOwnerProbe("win32", WIN_BARE)).toEqual({
      pid: 40409,
      name: "bun",
      startedAt: "2026-08-27T09:14:02.0000000-07:00",
      command: "C:\\Users\\dev\\.bun\\bin\\bun.exe",
    });
  });
  test("win32 array form takes the first entry and normalizes /Date(ms)/ to ISO", () => {
    const info = parseOwnerProbe("win32", WIN_ARRAY);
    expect(info).not.toBeNull();
    expect(info!.pid).toBe(40409);
    expect(info!.name).toBe("bun");
    expect(info!.startedAt).toBe(new Date(1756300000000).toISOString());
    expect(info!.command).toBe("C:\\Users\\dev\\.bun\\bin\\bun.exe");
  });
  test("posix ps line: pid, five-token lstart, command with spaces", () => {
    const info = parseOwnerProbe("linux", " 40409 Wed Aug 27 09:14:02 2026 bun server.ts --port 5319\n");
    expect(info).toEqual({
      pid: 40409,
      name: "bun",
      startedAt: "Wed Aug 27 09:14:02 2026",
      command: "bun server.ts --port 5319",
    });
  });
  test("posix ps pads single-digit days with an extra space; the parse still lands", () => {
    const info = parseOwnerProbe("darwin", "312 Mon Sep  7 08:00:00 2026 /usr/local/bin/node dist/index.js");
    expect(info).not.toBeNull();
    expect(info!.pid).toBe(312);
    expect(info!.startedAt).toBe("Mon Sep 7 08:00:00 2026");
    expect(info!.name).toBe("node");
    expect(info!.command).toBe("/usr/local/bin/node dist/index.js");
  });
  test("empty stdout is null on every platform (probe found nothing)", () => {
    for (const platform of ["win32", "darwin", "linux"]) {
      expect(parseOwnerProbe(platform, "")).toBeNull();
      expect(parseOwnerProbe(platform, "  \n ")).toBeNull();
    }
  });
  test("garbage is null, never a half-filled SquatterInfo", () => {
    expect(parseOwnerProbe("win32", "not json at all")).toBeNull();
    expect(parseOwnerProbe("win32", '"just a string"')).toBeNull();
    expect(parseOwnerProbe("win32", '{"ProcessName":"bun"}')).toBeNull(); // no Id: not our script's shape
    expect(parseOwnerProbe("linux", "ps: illegal option -- q")).toBeNull();
    expect(parseOwnerProbe("darwin", "40409")).toBeNull(); // pid with no lstart/command
    expect(parseOwnerProbe("freebsd", "40409 Wed Aug 27 09:14:02 2026 bun server.ts")).toBeNull();
  });
});
