// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/hub_launch.ts - P-TUI.2: open `lucid hub` (the terminal hub, P-TUI.1) in a NEW terminal window from
// the app, so the Fleet view and the launcher can offer it without the user knowing it is a CLI.
//
// The hub attaches to THIS engine through the P-TUI.0 discovery file, so the window it opens is a second
// client of the same fleet: lanes spawned in the GUI appear in its Fleet deck and vice versa.
//
// What runs: bin/lucid(.exe), the compiled launcher every desktop dist ships (P-EXT.4); in a source checkout
// that never compiled it, Bun runs harness/launcher/lucid_acp.ts instead. The engine opens the window (not
// the renderer, not the agent): the route is UI-token only, the command is fixed with no argument from the
// request, and it never runs inside the agent's sandbox.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface HubLaunchPlan {
  cmd: string;
  args: string[];
  /** Windows needs the command line passed through untouched so the nested quotes survive. */
  verbatim: boolean;
}

/** The argv that runs `lucid`: the compiled launcher when present, else Bun on the launcher source. */
export function lucidArgv(repo: string, platform: string, bun: string, exists: (p: string) => boolean): string[] {
  const exe = join(repo, "bin", platform === "win32" ? "lucid.exe" : "lucid");
  return exists(exe) ? [exe] : [bun, join(repo, "harness", "launcher", "lucid_acp.ts")];
}

/** The command that opens a terminal running `<lucid> hub`. Pure. Null when this platform has no known
 *  terminal program. */
export function hubLaunchPlan(platform: string, lucid: readonly string[], hasLinuxTerminal: boolean): HubLaunchPlan | null {
  const line = [...lucid.map((a) => `"${a}"`), "hub"].join(" ");
  if (platform === "win32") {
    // `start` opens a new console; `cmd /s /k "<line>"` strips exactly the outer quotes and keeps the window
    // open if the hub exits with an error, so the user can read it instead of watching a window vanish.
    return { cmd: "cmd.exe", args: ["/d", "/c", "start", "\"LUCID hub\"", "cmd.exe", "/s", "/k", `"${line}"`], verbatim: true };
  }
  if (platform === "darwin") {
    const script = line.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
    return { cmd: "osascript", args: ["-e", `tell application "Terminal" to do script "${script}"`, "-e", "tell application \"Terminal\" to activate"], verbatim: false };
  }
  if (hasLinuxTerminal) return { cmd: "x-terminal-emulator", args: ["-e", "sh", "-c", line], verbatim: false };
  return null;
}

/** Open the window. Resolves with a sentence for the UI either way; never throws. */
export async function openHubWindow(repo: string, resources: string): Promise<{ ok: boolean; reason?: string }> {
  const bundled = resources ? join(resources, "runtimes", process.platform === "win32" ? "bun.exe" : "bun") : "";
  const bun = bundled && existsSync(bundled) ? bundled : "bun";
  const plan = hubLaunchPlan(process.platform, lucidArgv(repo, process.platform, bun, existsSync), existsSync("/usr/bin/x-terminal-emulator"));
  if (!plan) return { ok: false, reason: "No terminal program was found to open the hub in. Run `lucid hub` in a terminal yourself." };
  const { promise, resolve } = Promise.withResolvers<{ ok: boolean; reason?: string }>();
  try {
    const child = spawn(plan.cmd, plan.args, { detached: true, stdio: "ignore", windowsHide: false, windowsVerbatimArguments: plan.verbatim });
    child.once("error", (e) => resolve({ ok: false, reason: `Could not open a terminal: ${e.message}` }));
    child.once("spawn", () => { child.unref(); resolve({ ok: true }); });
  } catch (e) {
    resolve({ ok: false, reason: `Could not open a terminal: ${e instanceof Error ? e.message : String(e)}` });
  }
  return await promise;
}
