// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/preview_electron.ts — P-PREVIEW.7 (ADR-0179): detect an ELECTRON app behind a previewed page,
// and plan a USER-initiated external launch.
//
// The sandboxed preview iframe runs BROWSER code only - an Electron renderer (require("electron"),
// Node APIs) dies silently there, and because Electron apps typically build their whole UI from JS,
// the pane shows blank white with no explanation. This module powers the fix WITHOUT poking a hole
// in the sandbox: detect that the previewed file belongs to an Electron app, then (on the user's
// explicit click) launch it as a real, separate OS process - outside LUCID, exactly as if the user
// ran `electron .` in a terminal themselves.
//
// Security posture: the launch is USER-initiated (a button click on their own machine, running code
// they asked the agent to build - equivalent to running it from their shell), never agent-initiated;
// the endpoint refuses paths that don't detect as an Electron app; and every actual launch emits an
// "exec" SecurityEvent (metadata only) into the same OCSF/SIEM stream as gate decisions. The agent's
// own subprocess path stays behind the ADR-0157 runtime boundary - this module never touches it.
//
// Everything here is PURE with injected fs (unit-testable); dev.ts wires the real fs + spawn.

import { existsSync as realExists, readFileSync as realRead } from "node:fs";
import { dirname, join } from "node:path";
import { toFsPath } from "./preview_file.ts";

export interface ElectronIo {
  exists: (p: string) => boolean;
  readText: (p: string) => string;
  platform?: NodeJS.Platform;
}
const REAL_IO: ElectronIo = { exists: realExists, readText: (p) => realRead(p, "utf8") };

export interface ElectronDetection {
  electron: boolean;
  appDir: string;
  reasons: string[];          // human-readable evidence ("package.json devDependencies.electron", ...)
  localElectron: string | null; // the app's own installed binary, when present
}

/** The electron npm package's real binary location per platform (dist/ is downloaded by its postinstall). */
export function electronBinaryIn(nodeModulesDir: string, platform: NodeJS.Platform): string {
  const base = join(nodeModulesDir, "electron", "dist");
  if (platform === "win32") return join(base, "electron.exe");
  if (platform === "darwin") return join(base, "Electron.app", "Contents", "MacOS", "Electron");
  return join(base, "electron");
}

/** Detect whether the previewed HTML belongs to an Electron app. Evidence, in strength order:
 *  a package.json (in the file's dir or one level up) declaring the `electron` dependency or an
 *  `electron .`-style start script; a `main` entry whose file mentions require("electron").
 *  Never throws - unreadable/absent files simply contribute no evidence. */
export function detectElectronApp(htmlTarget: string, io: ElectronIo = REAL_IO): ElectronDetection {
  const platform = io.platform ?? process.platform;
  const fileDir = dirname(toFsPath(htmlTarget));
  const reasons: string[] = [];
  let appDir = fileDir;

  for (const dir of [fileDir, dirname(fileDir)]) {
    const pkgPath = join(dir, "package.json");
    if (!io.exists(pkgPath)) continue;
    try {
      const pkg = JSON.parse(io.readText(pkgPath)) as {
        main?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; scripts?: Record<string, string>;
      };
      if (pkg.devDependencies?.electron) reasons.push("package.json devDependencies.electron");
      if (pkg.dependencies?.electron) reasons.push("package.json dependencies.electron");
      const start = pkg.scripts?.start ?? "";
      if (/(^|\s|\/)electron(\s|$|\.)/.test(start)) reasons.push(`start script runs electron ("${start.slice(0, 60)}")`);
      if (pkg.main && io.exists(join(dir, pkg.main))) {
        try {
          const main = io.readText(join(dir, pkg.main));
          if (/require\(["']electron["']\)|from ["']electron["']/.test(main)) reasons.push(`${pkg.main} imports electron`);
        } catch { /* evidence only */ }
      }
      if (reasons.length > 0) { appDir = dir; break; }
    } catch { /* unreadable package.json contributes nothing */ }
  }

  const bin = electronBinaryIn(join(appDir, "node_modules"), platform);
  const localElectron = reasons.length > 0 && io.exists(bin) ? bin : null;
  return { electron: reasons.length > 0, appDir, reasons, localElectron };
}

export interface LaunchPlan { cmd: string; args: string[]; cwd: string; via: "app-local" | "path" }

/** Plan the external launch. Preference: the app's OWN electron install (what the agent's
 *  `npm install` produced), else an `electron` on the user's PATH. Null when neither exists -
 *  the caller then shows the manual `npx electron .` instruction instead of launching. */
export function electronLaunchPlan(det: ElectronDetection, pathElectron: string | null): LaunchPlan | null {
  if (!det.electron) return null;
  if (det.localElectron) return { cmd: det.localElectron, args: ["."], cwd: det.appDir, via: "app-local" };
  if (pathElectron) return { cmd: pathElectron, args: ["."], cwd: det.appDir, via: "path" };
  return null;
}
