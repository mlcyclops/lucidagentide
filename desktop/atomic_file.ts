// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/atomic_file.ts
//
// The crash-safe write shared by the settings store (P-SETTINGS.1, ADR-0439) and the engine vault
// (P-VAULT-KEYS.1, ADR-0472): temp file + fsync + rename, so a reader sees the old bytes or the new
// bytes, never a torn file, and the result is user-only (0600; best-effort on Windows).

import { closeSync, fchmodSync, fstatSync, fsyncSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

export const errCode = (e: unknown): string | undefined => (e as NodeJS.ErrnoException | undefined)?.code;

/** Windows briefly refuses an open or a rename while another handle (antivirus, OneDrive, a second
 *  reader) holds the file; retry a few times before treating the failure as real. */
export const RETRYABLE = ["EPERM", "EBUSY", "EACCES"];
export function withRetry<T>(op: () => T): T {
  for (let attempt = 0; ; attempt++) {
    try { return op(); } catch (e) {
      if (attempt >= 9 || !RETRYABLE.includes(errCode(e) ?? "")) throw e;
      Bun.sleepSync(15);
    }
  }
}

/** Write `data` to `path` atomically (temp + fsync + rename). Returns the written file's stat. `rename`
 *  is injectable so the settings store's test seam can refuse it on cue. */
export function writeAtomic(path: string, data: string | Uint8Array, rename: (from: string, to: string) => void = renameSync): { mtimeMs: number; size: number } {
  const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    const fd = openSync(tmp, "w", 0o600);
    let st: { mtimeMs: number; size: number };
    try {
      writeFileSync(fd, data);
      try { fchmodSync(fd, 0o600); } catch { /* best-effort on Windows */ }
      fsyncSync(fd);
      st = fstatSync(fd); // rename keeps mtime + size, so this keys a memo for the final file
    } finally { closeSync(fd); }
    withRetry(() => rename(tmp, path));
    return st;
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* already renamed or never created */ }
    throw e;
  }
}
