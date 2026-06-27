// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/editor.ts — P-IDE.5 (ADR-0036): gated read/write for the in-app code editor.
//
// Saves go through the SAME in-process scanner gate as every other write path (CLAUDE.md #3 fail-
// closed, #4 gate-in-process): the buffer is scanned and a >=high finding — OR an unavailable
// scanner — BLOCKS the write. Nothing the editor saves lands on disk unscanned. Paths are confined
// to the user's home subtree via pathWithin — the SAME GUI file boundary the folder browser, import,
// and export already enforce (M2, ADR-0023) — so the editor can't read or overwrite system files.
// omp's own ACP filesystem write is intentionally disabled for the GUI (acp_backend initialize →
// writeTextFile:false), so this gated endpoint — not a model tool call — is how the editor persists,
// and it keeps the gate in the loop.

import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { pathWithin } from "./path_guard.ts";
import { ScannerClient } from "../harness/security/scanner_client.ts";
import { scanAndDecide } from "../harness/security/gate.ts";

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
const MAX_BYTES = 5_000_000; // the editor is for source files, not multi-MB blobs

let scanner: ScannerClient | null = null;
function getScanner(): ScannerClient { if (!scanner) { scanner = new ScannerClient(); scanner.start(); } return scanner; }

export interface EditorReadResult { ok: boolean; error?: string; path?: string; content?: string; mtime?: number; sha256?: string }
export interface EditorSaveResult {
  ok: boolean; error?: string; blocked?: boolean; conflict?: boolean; reason?: string;
  path?: string; mtime?: number; sha256?: string; currentSha?: string;
}
export interface EditorSaveInput { path: string; content: string; baseSha?: string; overwrite?: boolean }

/** Confine a GUI-supplied path to the user's home subtree (the GUI file boundary; null to reject). */
function safePath(p: string): string | null { return pathWithin(homedir(), String(p ?? "").trim()); }

/** Read a workspace file into the editor: content + mtime + content hash (for conflict detection). */
export function readEditorFile(pathArg: string): EditorReadResult {
  const safe = safePath(pathArg);
  if (!safe) return { ok: false, error: "That file is outside your home folder." };
  // TOCTOU-safe (js/file-system-race, ADR-0025): open the file ONCE, then fstat + read the SAME
  // descriptor. Never statSync(path)-then-readFileSync(path) — the path could be swapped between the
  // check and the use; the fd binds to the inode we actually read.
  let fd: number | undefined;
  try {
    fd = openSync(safe, "r");
    const st = fstatSync(fd);
    if (!st.isFile()) return { ok: false, error: "That path is not a file." };
    if (st.size > MAX_BYTES) return { ok: false, error: `That file is too large for the editor (> ${Math.round(MAX_BYTES / 1e6)} MB).` };
    const buf = Buffer.allocUnsafe(st.size);
    let off = 0;
    while (off < st.size) { const n = readSync(fd, buf, off, st.size - off, off); if (n <= 0) break; off += n; }
    const content = buf.subarray(0, off).toString("utf8");
    return { ok: true, path: safe, content, mtime: st.mtimeMs, sha256: sha256(content) };
  } catch (e) {
    return { ok: false, error: (e as { code?: string })?.code === "ENOENT" ? "That file doesn't exist." : "Couldn't read that file." };
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* already closed / never opened */ }
  }
}

/**
 * Save the editor buffer to a workspace path, THROUGH the gate. Order matters:
 *   1) confine the path,                          (no arbitrary-file write)
 *   2) detect a conflict (on-disk hash drifted),  (no silent clobber — caller confirms overwrite)
 *   3) scan the buffer fail-closed,               (no unscanned bytes hit disk)
 *   4) write.
 * `deps.scanner` is injectable for tests; production uses a shared sidecar client.
 */
export async function saveEditorFile(input: EditorSaveInput, deps: { scanner?: ScannerClient } = {}): Promise<EditorSaveResult> {
  const safe = safePath(input.path);
  if (!safe) return { ok: false, error: "Save location must be inside your home folder." };
  const content = String(input.content ?? "");
  if (Buffer.byteLength(content, "utf8") > MAX_BYTES) return { ok: false, error: "That file is too large to save from the editor." };

  // Conflict: the file changed on disk since the editor opened it (hash drift), or a Save-As would
  // land on a file the editor never opened (no baseSha). Don't clobber without confirmation. Read
  // DIRECTLY (no existsSync check-then-read; js/file-system-race, ADR-0025): ENOENT just means the
  // file isn't there yet → no conflict; any other read error → skip the check and let the write try.
  if (!input.overwrite) {
    let onDisk: string | undefined;
    try { onDisk = readFileSync(safe, "utf8"); } catch { /* missing or unreadable → no conflict check */ }
    if (onDisk !== undefined) {
      const cur = sha256(onDisk);
      if (!input.baseSha) return { ok: false, conflict: true, error: "A file already exists there.", currentSha: cur };
      if (cur !== input.baseSha) return { ok: false, conflict: true, error: "This file changed on disk since you opened it.", currentSha: cur };
    }
  }

  // Gate: scan fail-closed. A >=high finding (zero-width / bidi / tag-block / PUA …) or a missing
  // scanner BLOCKS — the buffer never reaches disk unscanned.
  const decision = await scanAndDecide(deps.scanner ?? getScanner(), content);
  if (decision.block) {
    return { ok: false, blocked: true, reason: decision.failClosed ? "The scanner is unavailable, so the save was blocked (fail-closed)." : decision.reason };
  }

  try {
    mkdirSync(dirname(safe), { recursive: true });
    writeFileSync(safe, content, "utf8");
    return { ok: true, path: safe, mtime: statSync(safe).mtimeMs, sha256: sha256(content) };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) };
  }
}
