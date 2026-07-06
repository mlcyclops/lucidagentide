// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/preview_electron.test.ts — P-PREVIEW.7 (ADR-0179): Electron-app detection + launch planning.
// Pins: detection evidence (dependency, devDependency, start script, main-imports-electron; the
// parent-dir fallback), non-Electron pages detecting FALSE (a plain page must never grow a launch
// button), platform-correct binary paths, and the launch-plan preference order (app-local install →
// PATH electron → null = show the manual command). All fs injected - no disk, no spawn here.

import { describe, expect, test } from "bun:test";
import { detectElectronApp, electronBinaryIn, electronLaunchPlan } from "./preview_electron.ts";

type Files = Record<string, string>;
const io = (files: Files, platform: NodeJS.Platform = "win32") => ({
  exists: (p: string) => Object.prototype.hasOwnProperty.call(files, p.replace(/\\/g, "/")),
  readText: (p: string) => {
    const k = p.replace(/\\/g, "/");
    if (!(k in files)) throw new Error("ENOENT");
    return files[k]!;
  },
  platform,
});
const APP = "C:/apps/demo";
const HTML = `${APP}/index.html`;

describe("detectElectronApp", () => {
  test("devDependencies.electron detects, with the app's own installed binary found", () => {
    const det = detectElectronApp(HTML, io({
      [`${APP}/package.json`]: JSON.stringify({ devDependencies: { electron: "^31.0.0" } }),
      [`${APP}/node_modules/electron/dist/electron.exe`]: "bin",
    }));
    expect(det.electron).toBe(true);
    expect(det.appDir.replace(/\\/g, "/")).toBe(APP);
    expect(det.reasons.join()).toContain("devDependencies.electron");
    expect(det.localElectron?.replace(/\\/g, "/")).toBe(`${APP}/node_modules/electron/dist/electron.exe`);
  });
  test("a start script running electron detects even without the dependency", () => {
    const det = detectElectronApp(HTML, io({ [`${APP}/package.json`]: JSON.stringify({ scripts: { start: "electron ." } }) }));
    expect(det.electron).toBe(true);
    expect(det.reasons.join()).toContain("start script runs electron");
  });
  test("main entry importing electron detects", () => {
    const det = detectElectronApp(HTML, io({
      [`${APP}/package.json`]: JSON.stringify({ main: "main.js" }),
      [`${APP}/main.js`]: `const { app, BrowserWindow } = require("electron");`,
    }));
    expect(det.electron).toBe(true);
    expect(det.reasons.join()).toContain("main.js imports electron");
  });
  test("the package.json may sit one level up (html in a src/ subdir)", () => {
    const det = detectElectronApp(`${APP}/src/index.html`, io({ [`${APP}/package.json`]: JSON.stringify({ dependencies: { electron: "31.0.0" } }) }));
    expect(det.electron).toBe(true);
    expect(det.appDir.replace(/\\/g, "/")).toBe(APP);
  });
  test("a plain web page detects FALSE - no evidence, no launch surface", () => {
    for (const files of [
      {} as Files,                                                             // no package.json at all
      { [`${APP}/package.json`]: JSON.stringify({ dependencies: { react: "18" }, scripts: { start: "vite" } }) },
      { [`${APP}/package.json`]: "{not json" },                                // unreadable → no evidence
    ]) {
      const det = detectElectronApp(HTML, io(files));
      expect(det.electron).toBe(false);
      expect(det.localElectron).toBeNull();
    }
  });
  test("file:// targets work too", () => {
    const det = detectElectronApp(`file:///C:/apps/demo/index.html`, io({ [`${APP}/package.json`]: JSON.stringify({ devDependencies: { electron: "31" } }) }));
    expect(det.electron).toBe(true);
  });
});

describe("electronBinaryIn", () => {
  test("platform-correct binary locations", () => {
    expect(electronBinaryIn("/x/node_modules", "win32").replace(/\\/g, "/")).toBe("/x/node_modules/electron/dist/electron.exe");
    expect(electronBinaryIn("/x/node_modules", "darwin").replace(/\\/g, "/")).toBe("/x/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
    expect(electronBinaryIn("/x/node_modules", "linux").replace(/\\/g, "/")).toBe("/x/node_modules/electron/dist/electron");
  });
});

describe("electronLaunchPlan", () => {
  const detected = (localElectron: string | null) => ({ electron: true, appDir: APP, reasons: ["test"], localElectron });
  test("prefers the app's own electron install", () => {
    const plan = electronLaunchPlan(detected(`${APP}/node_modules/electron/dist/electron.exe`), "/usr/bin/electron");
    expect(plan?.via).toBe("app-local");
    expect(plan?.cwd).toBe(APP);
    expect(plan?.args).toEqual(["."]);
  });
  test("falls back to a PATH electron", () => {
    expect(electronLaunchPlan(detected(null), "/usr/bin/electron")?.via).toBe("path");
  });
  test("no runtime anywhere → null (the caller shows the manual command)", () => {
    expect(electronLaunchPlan(detected(null), null)).toBeNull();
  });
  test("never plans a launch for a non-Electron detection", () => {
    expect(electronLaunchPlan({ electron: false, appDir: APP, reasons: [], localElectron: null }, "/usr/bin/electron")).toBeNull();
  });
});
