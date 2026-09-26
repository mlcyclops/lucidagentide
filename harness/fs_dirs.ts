// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/fs_dirs.ts - ensureDir: mkdir -p that treats "the directory is there" as success on every
// platform. THE BUG THIS EXISTS FOR: Bun on Windows can throw EEXIST out of
// mkdirSync(dir, { recursive: true }) even when `dir` already exists as a directory (OneDrive-backed
// folders make it more likely - sync locks and dehydrated placeholders confuse the walk). Node
// swallows that case; the stores treated it as a fatal write failure, so a command/agent-spec that
// validated clean died with "write failed: EEXIST" (the "Couldn't create the command" toast).
//
// The contract is GOAL-STATE, not call success: if the directory exists when mkdir settles, the job
// is done regardless of what the walk reported. A FILE squatting on the path, or a real permission
// failure, still throws the original error.

import { mkdirSync, statSync } from "node:fs";

/** Create `dir` (and parents) if needed; tolerate any mkdir error when `dir` is a directory after. */
export function ensureDir(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    let isDir = false;
    try { isDir = statSync(dir).isDirectory(); } catch { /* stat failed - the mkdir error stands */ }
    if (!isDir) throw e;
  }
}
