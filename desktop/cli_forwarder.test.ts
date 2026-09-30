// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-TUI.2: the `lucid` forwarder the packaged app writes into the per-user WindowsApps folder. The rule that
// matters: a lucid.cmd the user (or another tool) put there is never overwritten, and ours is refreshed
// when the install moved.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FORWARDER_MARKER, installCliForwarder } from "./cli_forwarder.ts";

function fixture(): { localAppData: string; resourcesPath: string; file: string } {
  const root = mkdtempSync(join(tmpdir(), "lucid-fwd-"));
  const resourcesPath = join(root, "resources");
  mkdirSync(join(resourcesPath, "repo", "bin"), { recursive: true });
  writeFileSync(join(resourcesPath, "repo", "bin", "lucid.exe"), "MZ");
  return { localAppData: join(root, "local"), resourcesPath, file: join(root, "local", "Microsoft", "WindowsApps", "lucid.cmd") };
}

describe("installCliForwarder", () => {
  test("writes a marked forwarder that calls the installed bin\\lucid.exe, then leaves a current one alone", () => {
    const f = fixture();
    expect(installCliForwarder(f)).toBe("written");
    const text = readFileSync(f.file, "utf8");
    expect(text.split("\r\n")[1]!.startsWith(FORWARDER_MARKER)).toBe(true);
    expect(text).toContain(`"${join(f.resourcesPath, "repo", "bin", "lucid.exe")}" %*`);
    expect(installCliForwarder(f)).toBe("current");
  });

  test("a lucid.cmd that is not ours is never overwritten", () => {
    const f = fixture();
    mkdirSync(join(f.localAppData, "Microsoft", "WindowsApps"), { recursive: true });
    writeFileSync(f.file, "@echo off\r\nrem my own lucid tool\r\n");
    expect(installCliForwarder(f)).toBe("foreign");
    expect(readFileSync(f.file, "utf8")).toBe("@echo off\r\nrem my own lucid tool\r\n");
  });

  test("ours is rewritten when the install moved", () => {
    const f = fixture();
    mkdirSync(join(f.localAppData, "Microsoft", "WindowsApps"), { recursive: true });
    writeFileSync(f.file, `@echo off\r\n${FORWARDER_MARKER}: old\r\n"C:\\old\\lucid.cmd" %*\r\n`);
    expect(installCliForwarder(f)).toBe("written");
    expect(readFileSync(f.file, "utf8")).not.toContain("C:\\old");
  });

  test("an install without bin\\lucid.exe writes nothing", () => {
    expect(installCliForwarder({ localAppData: mkdtempSync(join(tmpdir(), "lucid-fwd-")), resourcesPath: join(tmpdir(), "no-such-resources") })).toBe("no-target");
  });
});
