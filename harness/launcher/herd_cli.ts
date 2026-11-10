// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// ADR-0541: `lucid herd [args]`. Herd (a hub server that outlives its terminal: attach, detach,
// reattach, named instances, OSC 7501) is an OPTIONAL free add-on, not part of core. Core only finds
// the INSTALLED add-on (desktop/plugins/installed.ts, the same reader the plugin runtime uses) and runs
// its terminal client with the IDE's bundled bun; everything Herd does lives in the package
// (plugins/herd in this repo, installed from the IDE's Plugins drawer). Not installed: one sentence
// on stderr and exit 2. Nothing here starts, installs or downloads anything.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { pluginDataDir, readInstalled, type InstalledPlugin } from "../../desktop/plugins/installed.ts";

type Env = Readonly<Record<string, string | undefined>>;

export const HERD_ID = "herd";
export const HERD_NOT_INSTALLED = "Herd is an optional add-on and is not installed. Install it in the IDE: Plugins, Free, Herd.";

/** The bun that runs the client: the IDE's bundled runtime beside the packaged repo
 *  (`<resources>/runtimes/bun[.exe]`), else `bun` on PATH. The same lookup `lucid kb` and the hub
 *  window (desktop/hub_launch.ts) use. */
export function herdBun(repo: string, platform: string = process.platform, exists: (p: string) => boolean = existsSync): string {
  const exe = platform === "win32" ? "bun.exe" : "bun";
  const bundled = join(repo, "..", "runtimes", exe);
  return exists(bundled) ? bundled : exe;
}

export interface HerdLaunch { cmd: string; args: string[]; env: Record<string, string | undefined> }

/** The client command for the installed package at `dir`. Pure apart from the data-dir env read.
 *  The client gets the add-on's data dir (where every Herd file lives, never the classic hub's), its
 *  own package root, this checkout (to spawn an engine when none runs, as `lucid hub` does), and this
 *  checkout's node_modules on NODE_PATH: client.js keeps its npm packages (pi-tui and its native
 *  addon) external and loads the IDE's own copies, the ones the classic hub runs on. */
export function herdLaunch(dir: string, argv: readonly string[], env: Env, repo: string, bun: string): HerdLaunch {
  const modules = join(repo, "node_modules");
  return {
    cmd: bun,
    args: [join(dir, "client.js"), ...argv],
    env: {
      ...env,
      LUCID_PLUGIN_DATA: pluginDataDir(HERD_ID),
      LUCID_PLUGIN_ROOT: dir,
      LUCID_HERD_REPO: repo,
      NODE_PATH: env.NODE_PATH ? `${modules}${delimiter}${env.NODE_PATH}` : modules,
    },
  };
}

export async function runHerd(argv: readonly string[], env: Env, repo: string, installed: InstalledPlugin | null = readInstalled(HERD_ID)): Promise<number> {
  if (!installed) {
    process.stderr.write(`${HERD_NOT_INSTALLED}\n`);
    return 2;
  }
  const plan = herdLaunch(installed.dir, argv, env, repo, herdBun(repo));
  // The client owns the terminal; a console ctrl+c that also reaches this parent must not end it
  // before the client has detached and restored the screen.
  const hold = (): void => { /* the client decides */ };
  process.on("SIGINT", hold);
  try {
    const child = spawn(plan.cmd, plan.args, { stdio: "inherit", env: plan.env });
    return await new Promise<number>((resolve) => {
      child.on("error", (e) => { process.stderr.write(`[lucid herd] could not start the Herd client: ${e.message}\n`); resolve(1); });
      child.on("close", (code) => resolve(code ?? 1));
    });
  } finally {
    process.off("SIGINT", hold);
  }
}
