// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/launcher/ide_client.test.ts
//
// P-EXT.2 (ADR-0038) — over-tests the security-critical IDE-client logic: the launcher candidate list
// can ONLY ever contain a `lucid` binary or the user's explicit path (never a bare agent command), and
// the gate's [BLOCKED] stderr signal parses correctly for the block banner.

import { expect, test } from "bun:test";
import {
  buildLauncherCandidates,
  installedAppLauncherPaths,
  launcherBinaryName,
  mapAcpUpdate,
  parseBlockLine,
  resolveLauncher,
} from "./ide_client.ts";

test("launcher binary name is OS-correct", () => {
  expect(launcherBinaryName("win32")).toBe("lucid.exe");
  expect(launcherBinaryName("darwin")).toBe("lucid");
  expect(launcherBinaryName("linux")).toBe("lucid");
});

test("installed-app paths point at the compiled lucid bin per OS", () => {
  const win = installedAppLauncherPaths({ LOCALAPPDATA: "C:/Users/x/AppData/Local" }, "win32");
  expect(win[0]!.replace(/\\/g, "/")).toContain("Programs/LucidAgentIDE/resources/repo/bin/lucid.exe");
  const mac = installedAppLauncherPaths({}, "darwin");
  expect(mac[0]).toContain("/Applications/LucidAgentIDE.app/Contents/resources/repo/bin/lucid");
});

test("SECURITY: candidate list contains only the explicit config path + lucid binaries — never omp", () => {
  const cands = buildLauncherCandidates({
    configPath: "/custom/lucid",
    env: { LOCALAPPDATA: "C:/AppData" },
    platform: "win32",
    pathDirs: ["/usr/bin", "/opt/tools"],
  });
  // the config path is first (user override wins)
  expect(cands[0]).toBe("/custom/lucid");
  // every entry is either the config path or a lucid binary; nothing else
  for (const c of cands) {
    expect(c === "/custom/lucid" || /(^|[\\/])lucid(\.exe)?$/.test(c)).toBe(true);
  }
  // no bare agent command can appear
  expect(cands.some((c) => /omp/.test(c))).toBe(false);
  // PATH dirs become <dir>/lucid.exe, not arbitrary commands
  expect(cands.some((c) => c.replace(/\\/g, "/") === "/usr/bin/lucid.exe")).toBe(true);
});

test("resolveLauncher returns the first existing candidate, else null (caller must NOT fall back)", () => {
  const exists = (p: string) => p === "/b/lucid";
  expect(resolveLauncher(["/a/lucid", "/b/lucid", "/c/lucid"], exists)).toBe("/b/lucid");
  expect(resolveLauncher(["/a/lucid", "/c/lucid"], exists)).toBeNull();
});

test("parseBlockLine reads the gate's [BLOCKED] stderr signal", () => {
  const line = "🛡️ [BLOCKED tool_call:write] reason=… severity=high findings=zero-width×2";
  const b = parseBlockLine(line)!;
  expect(b.tool).toBe("write");
  expect(b.severity).toBe("high");
  expect(b.findings).toBe("zero-width×2");
  expect(parseBlockLine("ordinary log line")).toBeNull();
});

test("mapAcpUpdate normalizes the common ACP updates; thinking is distinct; unknowns ignored", () => {
  expect(mapAcpUpdate({ update: { sessionUpdate: "agent_message_chunk", content: { text: "hi" } } })).toEqual({ kind: "message", text: "hi" });
  expect(mapAcpUpdate({ update: { sessionUpdate: "agent_thought_chunk", content: { text: "thinking" } } })).toEqual({ kind: "thought", text: "thinking" });
  expect(mapAcpUpdate({ update: { sessionUpdate: "tool_call", title: "Edit file" } })).toEqual({ kind: "tool", title: "Edit file", status: undefined });
  expect(mapAcpUpdate({ update: { sessionUpdate: "something_new" } })).toEqual({ kind: "ignored" });
  expect(mapAcpUpdate(null)).toEqual({ kind: "ignored" });
});
