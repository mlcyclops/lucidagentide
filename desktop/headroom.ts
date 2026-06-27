// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/headroom.ts
//
// Opt-in integration of `headroom` (https://github.com/chopratejas/headroom) - an
// on-device token-compression proxy (60–95% fewer tokens). ADR-0008.
//
// This is the lifecycle + detection layer: detect whether the user has installed
// the `headroom` CLI, start/stop `headroom proxy --port 8787`, and report status.
// It is OFF by default and a pure no-op until the user (a) installs headroom and
// (b) flips the Settings toggle - so it never affects a default install.
//
// SCOPE / SAFETY (see ADR-0008): request-routing through the proxy and the
// gov-deployment security review (confirm compression stays on-device; confirm the
// scanner gate still sees content first; confirm AskSage's custom upstream +
// `x-access-tokens` forward correctly) are a JOINT next step that needs headroom
// actually installed - intentionally NOT wired blind here.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { load, save } from "./settings_store.ts";

export const HEADROOM_PORT = 8787;
export const HEADROOM_URL = `http://localhost:${HEADROOM_PORT}`;

let proc: ChildProcess | null = null;

/** Resolve the headroom CLI: common user-install locations, then PATH. */
function headroomBin(): string {
  const exe = process.platform === "win32" ? ".exe" : "";
  for (const c of [
    join(homedir(), ".local", "bin", `headroom${exe}`),
    join(homedir(), ".bun", "bin", `headroom${exe}`),
  ]) if (existsSync(c)) return c;
  return "headroom";
}

export interface HeadroomStatus {
  installed: boolean;
  version: string | null;
  running: boolean;
  enabled: boolean;
  port: number;
  url: string;
  installHint: string;
}

function detectVersion(): string | null {
  try {
    const r = spawnSync(headroomBin(), ["--version"], { timeout: 4000, encoding: "utf8" });
    if (r.status === 0) return (r.stdout || r.stderr || "").trim().split("\n")[0] || "installed";
    return null;
  } catch {
    return null;
  }
}

export function headroomStatus(): HeadroomStatus {
  const version = detectVersion();
  return {
    installed: version !== null,
    version,
    running: !!proc && !proc.killed,
    enabled: !!load().headroomEnabled,
    port: HEADROOM_PORT,
    url: HEADROOM_URL,
    installHint: 'pip install "headroom-ai[proxy]"  (Python 3.10+, runs on-device)',
  };
}

/** Start the proxy if installed and not already running. Best-effort. */
export function startHeadroom(): HeadroomStatus {
  const st = headroomStatus();
  if (st.installed && !st.running) {
    try {
      proc = spawn(headroomBin(), ["proxy", "--port", String(HEADROOM_PORT)], {
        stdio: "inherit",
        env: { ...process.env, HEADROOM_UPDATE_CHECK: "off" },
      });
      proc.on("exit", () => { proc = null; });
    } catch {
      proc = null;
    }
  }
  return headroomStatus();
}

export function stopHeadroom(): HeadroomStatus {
  try { proc?.kill(); } catch { /* ignore */ }
  proc = null;
  return headroomStatus();
}

/** Persist the toggle and (best-effort) start/stop the proxy to match. */
export function setHeadroomEnabled(enabled: boolean): HeadroomStatus {
  const s = load(); s.headroomEnabled = enabled; save(s);
  return enabled ? startHeadroom() : stopHeadroom();
}
