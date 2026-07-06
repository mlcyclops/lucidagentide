// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_ppreview7.ts
//
// P-PREVIEW.7 (ADR-0179): the silent-white preview, explained + runnable. An Electron renderer dies
// in the sandboxed preview frame (no Node/require) and paints nothing - v-white-screen. Proves:
//   [1] the injected bridge now carries a ONE-SHOT health report (empty-body + bounded error tail,
//       parent-only postMessage) so the renderer can explain instead of staying mute;
//   [2] DETECTION is evidence-based and fail-false: electron dependency / start script / main-imports
//       detect TRUE (with the parent-dir fallback); a plain web page detects FALSE - a page that
//       isn't an Electron app can never grow a launch button;
//   [3] the LAUNCH PLAN prefers the app's OWN electron install, falls back to a PATH electron, and
//       is NULL otherwise (the UI then shows the manual `npx electron .` command) - and it never
//       plans anything for a non-Electron detection (the endpoint refuses those outright);
//   [4] LIVE (informational): detection against the real demo app dir on this machine, when present.
//
// Run with: bun run harness/scripts/demo_ppreview7.ts

import { PREVIEW_BRIDGE_JS, injectPreviewBridge } from "../../desktop/preview_bridge.ts";
import { detectElectronApp, electronLaunchPlan } from "../../desktop/preview_electron.ts";
import { existsSync } from "node:fs";

function fail(m: string): never { console.error(`FAIL: ${m}`); process.exit(1); }
function ok(m: string): void { console.log(`  PASS  ${m}`); }

console.log("P-PREVIEW.7 demo - explain the silent-white preview + user-clicked external Electron run\n");

// [1] the health report ships inside the injected bridge
{
  const html = injectPreviewBridge("<html><body><h1>x</h1></body></html>");
  for (const marker of ["preview-health", "emptyBody: bodyEmpty()", "healthSent", "errs.slice(-6)"]) {
    if (!html.includes(marker)) fail(`bridge is missing the health reporter marker: ${marker}`);
  }
  if (!PREVIEW_BRIDGE_JS.includes("window.parent.postMessage")) fail("health must go to the parent only");
  ok("bridge: one-shot health report injected (empty-body + bounded error tail, parent-only)");
}

// [2] detection: evidence in, verdict out - and fail-false for plain pages
{
  const files: Record<string, string> = {
    "C:/apps/el/package.json": JSON.stringify({ devDependencies: { electron: "^31" }, main: "main.js" }),
    "C:/apps/el/main.js": `const { app } = require("electron");`,
    "C:/apps/el/node_modules/electron/dist/electron.exe": "bin",
    "C:/apps/web/package.json": JSON.stringify({ dependencies: { react: "18" }, scripts: { start: "vite" } }),
  };
  const io = {
    exists: (p: string) => p.replace(/\\/g, "/") in files,
    readText: (p: string) => { const k = p.replace(/\\/g, "/"); if (!(k in files)) throw new Error("ENOENT"); return files[k]!; },
    platform: "win32" as const,
  };
  const el = detectElectronApp("C:/apps/el/index.html", io);
  if (!el.electron || !el.localElectron) fail("electron app did not detect (or its local binary was missed)");
  const sub = detectElectronApp("C:/apps/el/src/index.html", io);
  if (!sub.electron || sub.appDir.replace(/\\/g, "/") !== "C:/apps/el") fail("parent-dir package.json fallback failed");
  const web = detectElectronApp("C:/apps/web/index.html", io);
  if (web.electron) fail("a plain web page must NEVER detect as an Electron app");
  const none = detectElectronApp("C:/apps/nowhere/index.html", io);
  if (none.electron) fail("no package.json must mean no detection");
  ok("detection: dep/main evidence detects (incl. parent dir); plain pages and bare dirs detect FALSE");
}

// [3] launch planning: app-local → PATH → null; non-Electron never plans
{
  const det = { electron: true, appDir: "C:/apps/el", reasons: ["r"], localElectron: "C:/apps/el/node_modules/electron/dist/electron.exe" };
  if (electronLaunchPlan(det, "C:/path/electron.exe")?.via !== "app-local") fail("must prefer the app's own electron");
  if (electronLaunchPlan({ ...det, localElectron: null }, "C:/path/electron.exe")?.via !== "path") fail("must fall back to PATH electron");
  if (electronLaunchPlan({ ...det, localElectron: null }, null) !== null) fail("no runtime must plan NOTHING (manual command instead)");
  if (electronLaunchPlan({ electron: false, appDir: "C:/apps/web", reasons: [], localElectron: null }, "C:/path/electron.exe") !== null) {
    fail("a non-Electron detection must never produce a launch plan");
  }
  ok("launch plan: app-local install preferred, PATH fallback, null when absent, refuses non-Electron");
}

// [4] LIVE detection on this machine's demo app (informational - absent dir is fine)
{
  const demo = "C:/Users/neorc/AppData/Local/Temp/lucid-electron-demo/index.html";
  if (existsSync(demo)) {
    const det = detectElectronApp(demo);
    console.log(`  info  LIVE: ${det.electron ? "detected" : "not detected"} - ${det.reasons.join("; ") || "no evidence"}${det.localElectron ? " · app-local electron present" : ""}`);
  } else {
    console.log("  info  LIVE: demo app dir not present on this machine - skipped");
  }
}

console.log("\nP-PREVIEW.7 demo: ALL GREEN - the white preview explains itself and offers a real run.");
