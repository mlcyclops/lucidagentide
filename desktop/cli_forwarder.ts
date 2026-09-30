// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/cli_forwarder.ts - P-TUI.2: `lucid hub` (and the rest of the `lucid` command) from any terminal
// on a machine that only has the installed app, no source checkout.
//
// The real command is bin\lucid.exe, the compiled launcher every desktop dist already ships in
// resources\repo\bin (P-EXT.4, compile-lucid). That folder is not on PATH and the install directory can change, so every launch of the packaged app
// writes a one-line forwarder to it into %LOCALAPPDATA%\Microsoft\WindowsApps, the per-user folder Windows
// puts on PATH by default. Nothing edits PATH itself (the NSIS PATH string functions truncate long values,
// the classic way an installer destroys a user's PATH).
//
// The forwarder's second line is a marker. A `lucid.cmd` without it belongs to somebody else and is never
// overwritten; the uninstaller (build/installer.nsh) deletes the file only when the marker is present.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Must match the prefix installer.nsh compares before deleting. */
export const FORWARDER_MARKER = "rem LUCID-CLI-FORWARDER";

/** The forwarder's full text for a given installed bin\lucid.exe. CRLF, as cmd expects. */
export function forwarderScript(target: string): string {
  return ["@echo off", `${FORWARDER_MARKER}: forwards \`lucid\` to the installed LUCID Agent IDE. Rewritten on each app launch, removed on uninstall.`, `"${target}" %*`, ""].join("\r\n");
}

export type ForwarderOutcome = "written" | "current" | "foreign" | "no-target" | "failed";

/** Decide what to do with the file currently at the forwarder path (null = absent). Pure. */
export function forwarderAction(existing: string | null, wanted: string): ForwarderOutcome | "write" {
  if (existing === null) return "write";
  if (!existing.split(/\r?\n/, 3)[1]?.startsWith(FORWARDER_MARKER)) return "foreign";
  return existing === wanted ? "current" : "write";
}

/** Install or refresh the forwarder. Never throws; the outcome is logged by the caller. */
export function installCliForwarder(opts: { localAppData: string; resourcesPath: string }): ForwarderOutcome {
  try {
    const target = join(opts.resourcesPath, "repo", "bin", "lucid.exe");
    if (!existsSync(target)) return "no-target";
    const dir = join(opts.localAppData, "Microsoft", "WindowsApps");
    const file = join(dir, "lucid.cmd");
    const wanted = forwarderScript(target);
    let existing: string | null = null;
    try { existing = readFileSync(file, "utf8"); } catch { /* absent */ }
    const action = forwarderAction(existing, wanted);
    if (action !== "write") return action;
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, wanted);
    return "written";
  } catch {
    return "failed"; // a read-only or policy-locked WindowsApps: the app still works, only the shortcut is missing
  }
}
