// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-SECRET-INTAKE.1 (ADR-0476): the synced-folder rule the notepad fallback relies on. Every input (env,
// home, platform) is explicit, so the verdicts do not depend on the machine running the test.

import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { isSyncedPath, syncedRoots } from "./synced_path.ts";

const home = resolve("/home/ada");

describe("isSyncedPath", () => {
  test("a path under an announced OneDrive root is synced, a sibling is not", () => {
    const env = { OneDrive: join(home, "Work Sync") };
    expect(isSyncedPath(join(home, "Work Sync", "keys", "a.txt"), { env, home, platform: "win32" })).toBe(true);
    expect(isSyncedPath(join(home, "Work Sync Other", "a.txt"), { env, home, platform: "win32" })).toBe(false);
  });

  test("the Windows roaming profile (%APPDATA%) counts as synced; the local temp dir does not", () => {
    const env = { APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local") };
    expect(isSyncedPath(join(home, "AppData", "Roaming", "x"), { env, home, platform: "win32" })).toBe(true);
    expect(isSyncedPath(join(home, "AppData", "Local", "Temp", "x"), { env, home, platform: "win32" })).toBe(false);
  });

  test("client folder names anywhere in the path are synced (Known Folder Move, business, team, macOS File Provider)", () => {
    const opts = { env: {}, home, platform: "linux" as const };
    for (const p of [
      "/data/OneDrive - Contoso/Desktop/a.txt",
      "/data/Dropbox (Team)/a.txt",
      "/Users/ada/Library/Mobile Documents/com~apple~CloudDocs/a.txt",
      "/Users/ada/Library/CloudStorage/GoogleDrive-ada/a.txt",
      "/mnt/Google Drive/a.txt",
      "/mnt/My Drive/a.txt",
      "/srv/Box Sync/a.txt",
      "/srv/iCloudDrive/a.txt",
    ]) expect({ p, synced: isSyncedPath(p, opts) }).toEqual({ p, synced: true });
    for (const p of ["/tmp/lucid-secret-x/a.txt", "/run/user/1000/a.txt", "/data/onedrive-notes-archive/a.txt"]) {
      expect({ p, synced: isSyncedPath(p, opts) }).toEqual({ p, synced: false });
    }
  });

  test("the conventional client folders under home are roots even without env vars", () => {
    const roots = syncedRoots({ env: {}, home, platform: "darwin" });
    expect(roots).toContain(join(home, "Dropbox"));
    expect(roots).toContain(join(home, "Library", "CloudStorage"));
    expect(isSyncedPath(join(home, "Dropbox", "a"), { env: {}, home, platform: "darwin" })).toBe(true);
  });

  test("Windows and macOS compare case-insensitively", () => {
    const env = { OneDrive: join(home, "OneDrive") };
    expect(isSyncedPath(join(home, "ONEDRIVE", "x").toUpperCase(), { env, home, platform: "win32" })).toBe(true);
  });
});
