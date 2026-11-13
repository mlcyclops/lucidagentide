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
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { readInstalled, type InstalledPlugin } from "../../desktop/plugins/installed.ts";

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

/** Electron's userData folder for the packaged IDE (named after desktop/package.json's name). */
export const IDE_USER_DATA = "lucidagentide-desktop";

/** The IDE's data root: where it installs plugins and its engine writes discovery. LUCID_DATA_ROOT when
 *  the IDE started this process (it sets it for its children); else the installed IDE's own userData
 *  folder when it exists; else ~/.omp (a standalone dev engine). A plain terminal has no
 *  LUCID_DATA_ROOT, so `lucid herd` used to look in ~/.omp and call an installed Herd missing (found on
 *  the Mac, 2026-11-11; the same on Windows outside the IDE). */
export function herdDataRoot(env: Env, platform: string = process.platform, home: string = homedir(), exists: (p: string) => boolean = existsSync): string {
  if (env.LUCID_DATA_ROOT) return env.LUCID_DATA_ROOT;
  const base = platform === "win32" ? env.APPDATA || join(home, "AppData", "Roaming")
    : platform === "darwin" ? join(home, "Library", "Application Support")
    : env.XDG_CONFIG_HOME || join(home, ".config");
  const ide = join(base, IDE_USER_DATA);
  return exists(ide) ? ide : join(home, ".omp");
}

/** The client command for the installed package at `dir`, pure. The client gets the IDE's data root
 *  (`root`, so it finds the running engine's discovery), the add-on's data dir (where every Herd file
 *  lives, never the classic hub's), its own package root, this checkout (to spawn an engine when none
 *  runs, as `lucid hub` does), and this checkout's node_modules on NODE_PATH: client.js keeps its npm
 *  packages (pi-tui and its native addon) external and loads the IDE's own copies, the ones the classic
 *  hub runs on. */
export function herdLaunch(dir: string, argv: readonly string[], env: Env, repo: string, bun: string, root: string): HerdLaunch {
  const modules = join(repo, "node_modules");
  return {
    cmd: bun,
    args: [join(dir, "client.js"), ...argv],
    env: {
      ...env,
      LUCID_DATA_ROOT: root,
      LUCID_PLUGIN_DATA: join(env.LUCID_PLUGIN_DATA_DIR || join(root, "plugin-data"), HERD_ID),
      LUCID_PLUGIN_ROOT: dir,
      LUCID_HERD_REPO: repo,
      NODE_PATH: env.NODE_PATH ? `${modules}${delimiter}${env.NODE_PATH}` : modules,
    },
  };
}

/** `installed`: given by tests; otherwise the add-on as the IDE installed it under the data root. */
export async function runHerd(argv: readonly string[], env: Env, repo: string, installed?: InstalledPlugin | null): Promise<number> {
  const root = herdDataRoot(env);
  const found = installed === undefined ? readInstalled(HERD_ID, env.LUCID_PLUGINS_DIR || join(root, "plugins")) : installed;
  if (!found) {
    process.stderr.write(`${HERD_NOT_INSTALLED}\n`);
    return 2;
  }
  const plan = herdLaunch(found.dir, argv, env, repo, herdBun(repo), root);
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
