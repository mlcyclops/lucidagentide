// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/secret_fallback.ts
//
// P-SECRET-INTAKE.1 (ADR-0476): the notepad fallback for the agent-triggered secret dialog. When the dialog
// captures nothing, fails, or the user picks "Use a text file instead", the engine:
//   1. picks a PRIVATE temp base: never the workspace, never a synced folder (synced_path.ts), never the
//      roaming profile; XDG_RUNTIME_DIR (a per-user tmpfs) first on Linux, the OS temp dir otherwise;
//   2. creates a fresh random directory there and makes it readable by the current user ONLY (POSIX 0700
//      dir + 0600 file; Windows: inheritance removed and a single full-control ACE for the user's SID via
//      icacls), then VERIFIES that by reading the permissions back. Any failure removes what was created
//      and refuses (FallbackRefused): fail-closed, no "best effort" plaintext file;
//   3. opens the empty file in the OS editor (Notepad on Windows, TextEdit on macOS, xdg-open on Linux) with
//      a fixed argv, no shell;
//   4. polls for a non-empty save that is stable across two polls, reads it, overwrites the bytes with
//      zeros (fsync), deletes the file AND its directory (so a second save from the still-open editor
//      fails instead of recreating the secret), and hands the text to the caller.
// Step 2 is createUserOnlyDir, shared with the destination request dirs (vault_destinations.ts); every such
// dir holds an owner marker (the creating pid), and sweepOrphanTempDirs wipes and removes the dirs a killed
// or crashed engine left behind (run at engine start, and with includeOwn at graceful shutdown).
// The path never reaches the agent: it goes to the dialog only, so the user knows which file to save.
// Values never reach a log line here; only the refusal reasons are logged by the caller.

import { chmodSync, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { isSyncedPath, type SyncedPathEnv } from "./synced_path.ts";

/** A secret file larger than this is not a secret someone pasted; it is refused (and wiped). */
export const MAX_SECRET_FILE_BYTES = 64 * 1024;

export class FallbackRefused extends Error {
  constructor(message: string) { super(message); this.name = "FallbackRefused"; }
}

/** What the watcher hands back: the text, a refusal after the file was wiped, or null (closed / timed out). */
export type FallbackRead = { value: string } | { error: string } | null;

export interface FallbackSession {
  /** The file the user edits (shown in the dialog; never sent to the agent). */
  path: string;
  /** Resolves once with the saved text, a refusal, or null when disposed first. */
  read: Promise<FallbackRead>;
  /** Stop watching; wipe and delete whatever is left. Idempotent. */
  dispose(): void;
}

export interface FallbackOptions extends SyncedPathEnv {
  /** Shown in the file name (sanitized), e.g. the secret's env name. */
  label: string;
  /** The current workspace: the file is never created inside it. */
  workspace?: string;
  /** Test seam: candidate temp bases in order (default: platform rule above). */
  bases?: string[];
  /** Test seam: open the file for the user (default: the OS editor, fixed argv). */
  openEditor?: (file: string) => void;
  /** Test seam: make `dir` user-only; throw on failure (default: chmod / icacls). */
  restrict?: (dir: string) => void;
  /** Test seam: is `path` readable by the current user only? (default: stat / icacls read-back). */
  userOnly?: (path: string) => boolean;
  pollMs?: number;
  /** Test seam: drive the save poll; returns its stop function (default: setInterval every pollMs). */
  ticker?: (tick: () => void) => () => void;
  /** Watcher deadline; the caller's request deadline normally disposes first. */
  timeoutMs?: number;
}

// ── private temp base ─────────────────────────────────────────────────────────────────────────────────

/** Candidate bases for the platform, before filtering. */
export function tempBaseCandidates(opts: SyncedPathEnv = {}): string[] {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const out: string[] = [];
  if (platform === "linux" && env.XDG_RUNTIME_DIR) out.push(env.XDG_RUNTIME_DIR);
  out.push(tmpdir());
  if (platform === "win32" && env.LOCALAPPDATA) out.push(join(env.LOCALAPPDATA, "Temp"));
  return out;
}

/** The first candidate that exists, is absolute, is not synced and is not inside the workspace. */
export function privateTempBase(opts: Pick<FallbackOptions, "bases" | "workspace" | "env" | "home" | "platform">): string {
  const sync: SyncedPathEnv = { env: opts.env, home: opts.home, platform: opts.platform };
  for (const base of opts.bases ?? tempBaseCandidates(sync)) {
    if (!base || !isAbsolute(base) || !existsSync(base)) continue;
    if (isSyncedPath(base, sync)) continue;
    if (opts.workspace) {
      const rel = relative(resolve(opts.workspace), resolve(base));
      if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) continue; // the workspace or inside it
    }
    return resolve(base);
  }
  throw new FallbackRefused("there is no private temp folder outside synced folders and the workspace on this computer");
}

// ── user-only permissions ─────────────────────────────────────────────────────────────────────────────

/** `whoami /user /fo csv /nh` -> the account name and SID. Null when the output does not parse. */
export function parseWhoamiUser(out: string): { name: string; sid: string } | null {
  const m = /"([^"]+)","(S-1-[0-9-]+)"/.exec(out);
  return m ? { name: m[1]!, sid: m[2]! } : null;
}

/** The trustees of every ACE in an `icacls <path>` listing (the path prefix on the first line removed).
 *  Lines without an ACE (blank, the localized summary line) are skipped. */
export function parseIcaclsTrustees(out: string, path: string): string[] {
  const lines = out.split(/\r?\n/);
  if (lines[0]?.startsWith(path)) lines[0] = lines[0].slice(path.length);
  const trustees: string[] = [];
  for (const line of lines) {
    const m = /^\s*(.+?):\(/.exec(line);
    if (m) trustees.push(m[1]!.trim());
  }
  return trustees;
}

/** True when every ACE belongs to this user (by account name or SID) and there is at least one. */
export function icaclsUserOnly(out: string, path: string, who: { name: string; sid: string }): boolean {
  const trustees = parseIcaclsTrustees(out, path);
  return trustees.length > 0 && trustees.every((t) => isOwnTrustee(t, who));
}

/** An icacls trustee that names this user, by account name or SID. */
function isOwnTrustee(t: string, who: { name: string; sid: string }): boolean {
  return t.toLowerCase() === who.name.toLowerCase() || t.toUpperCase() === who.sid.toUpperCase() || t.toUpperCase() === `*${who.sid.toUpperCase()}`;
}

const run = (argv: string[]): { code: number; out: string } => {
  const r = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode ?? 1, out: new TextDecoder().decode(r.stdout) };
};

/** whoami and icacls run by absolute System32 path. A bare `whoami.exe` resolves through PATH, and Git for
 *  Windows' usr/bin (on PATH for many developers) ships a coreutils whoami.exe that rejects `/user`, which
 *  made every private temp dir refuse on those machines. */
const SYSTEM32 = join(process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows", "System32");

let cachedUser: { name: string; sid: string } | null = null;
function windowsUser(): { name: string; sid: string } {
  if (cachedUser) return cachedUser;
  const r = run([join(SYSTEM32, "whoami.exe"), "/user", "/fo", "csv", "/nh"]);
  const who = r.code === 0 ? parseWhoamiUser(r.out) : null;
  if (!who) throw new FallbackRefused("could not identify the current Windows account to lock the file to it");
  cachedUser = who;
  return who;
}

/** Default restrict: POSIX 0700, or on Windows inheritance removed plus one full-control ACE for the user's
 *  SID, inherited by the file created inside. Throws when the OS refuses. */
export function restrictToUser(dir: string, platform: NodeJS.Platform = process.platform): void {
  if (platform !== "win32") { chmodSync(dir, 0o700); return; }
  const who = windowsUser();
  const r = run([join(SYSTEM32, "icacls.exe"), dir, "/inheritance:r", "/grant:r", `*${who.sid}:(OI)(CI)F`]);
  if (r.code !== 0) throw new FallbackRefused("Windows refused to restrict the temp folder to your account");
}

/** Default verify: POSIX owner = us and no group/other bits; Windows every ACE is the user's. */
export function isUserOnly(path: string, platform: NodeJS.Platform = process.platform): boolean {
  try {
    if (platform !== "win32") {
      const st = statSync(path);
      const uid = typeof process.getuid === "function" ? process.getuid() : -1;
      return (st.mode & 0o077) === 0 && (uid < 0 || st.uid === uid);
    }
    const r = run([join(SYSTEM32, "icacls.exe"), path]);
    return r.code === 0 && icaclsUserOnly(r.out, path, windowsUser());
  } catch {
    return false;
  }
}

/** For a refusal message: who else holds access to `path` (Windows trustees other than this user, never
 *  a value), so a support log names the cause instead of only the symptom. Empty when unknown. */
function foreignAccessNote(path: string, platform: NodeJS.Platform): string {
  if (platform !== "win32") return "";
  try {
    const who = windowsUser();
    const r = run([join(SYSTEM32, "icacls.exe"), path]);
    if (r.code !== 0) return ` (icacls exited ${r.code})`;
    const others = parseIcaclsTrustees(r.out, path).filter((t) => !isOwnTrustee(t, who));
    return others.length ? ` (also: ${others.join(", ").slice(0, 200)}; you are ${who.name})` : ` (no access entries read; you are ${who.name})`;
  } catch {
    return "";
  }
}

// ── the file ──────────────────────────────────────────────────────────────────────────────────────────

/** Create `<base>/lucid-secret-XXXXXX/paste-<label>-here.txt`, empty, user-only (verified). Throws
 *  FallbackRefused, leaving nothing behind, when any step fails. */
export function createUserOnlyFile(opts: FallbackOptions): { dir: string; file: string } {
  const userOnly = opts.userOnly ?? ((p: string) => isUserOnly(p, opts.platform ?? process.platform));
  const dir = createUserOnlyDir(FALLBACK_DIR_PREFIX, opts);
  try {
    const label = opts.label.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "secret";
    const file = join(dir, `paste-${label}-here.txt`);
    closeSync(openSync(file, "wx", 0o600));
    if (!userOnly(file)) throw new FallbackRefused("the temp file could not be made readable by you only");
    return { dir, file };
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e instanceof FallbackRefused ? e : new FallbackRefused(`the temp file could not be created: ${String((e as Error)?.message ?? e).slice(0, 160)}`);
  }
}

/** The notepad fallback's dir prefix (the orphan sweep looks for it). */
export const FALLBACK_DIR_PREFIX = "lucid-secret-";
/** The owner marker inside every user-only dir: this process's pid, so a sweep never takes a live dir. */
const OWNER_MARKER = "owner.pid";

/** Create `<private temp base>/<prefix>XXXXXX`, user-only (verified), holding an owner marker (the pid,
 *  user-only too). Throws FallbackRefused, leaving nothing behind, when any step fails. */
export function createUserOnlyDir(prefix: string, opts: Pick<FallbackOptions, "bases" | "workspace" | "env" | "home" | "platform" | "restrict" | "userOnly"> = {}): string {
  const platform = opts.platform ?? process.platform;
  const base = privateTempBase(opts);
  const restrict = opts.restrict ?? ((d: string) => restrictToUser(d, platform));
  const userOnly = opts.userOnly ?? ((p: string) => isUserOnly(p, platform));
  const dir = mkdtempSync(join(base, prefix));
  try {
    restrict(dir);
    if (!userOnly(dir)) throw new FallbackRefused(`the temp folder could not be made readable by you only${foreignAccessNote(dir, platform)}`);
    const marker = join(dir, OWNER_MARKER);
    const fd = openSync(marker, "wx", 0o600);
    try { writeSync(fd, String(process.pid)); } finally { closeSync(fd); }
    if (!userOnly(marker)) throw new FallbackRefused("the temp file could not be made readable by you only");
    return dir;
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e instanceof FallbackRefused ? e : new FallbackRefused(`the temp file could not be created: ${String((e as Error)?.message ?? e).slice(0, 160)}`);
  }
}

/** Wipe (zeros, then delete) and remove leftover `<prefix>*` dirs directly under each private temp base
 *  candidate: the plaintext an engine kill or crash left behind. A dir whose owner marker names another
 *  live process is kept; this process's own dirs are kept unless `includeOwn` (graceful shutdown). Never
 *  follows a symlink (lstat), never throws. `afterOverwrite` is the wipeAndDelete test seam. */
export function sweepOrphanTempDirs(prefixes: readonly string[], opts: { includeOwn?: boolean; bases?: string[]; afterOverwrite?: (file: string) => void } = {}): { removed: number; kept: number } {
  let removed = 0;
  let kept = 0;
  let bases: string[] = [];
  try { bases = opts.bases ?? tempBaseCandidates(); } catch { /* nothing to sweep */ }
  for (const base of new Set(bases.map((b) => resolve(b)))) {
    let names: string[];
    try { names = readdirSync(base); } catch { continue; }
    for (const name of names) {
      if (!prefixes.some((p) => name.startsWith(p))) continue;
      const dir = join(base, name);
      try {
        if (!lstatSync(dir).isDirectory()) continue;
        let pid = Number.NaN;
        try {
          // CodeQL #128 (js/file-system-race): open the marker once and read through that descriptor; the
          // lstat AFTER the open still refuses a symlinked marker, and nothing is re-opened by name. The 0o600
          // mode is inert for "r" (see wipeAndDelete, CodeQL #124).
          const marker = join(dir, OWNER_MARKER);
          const fd = openSync(marker, "r", 0o600);
          try {
            if (fstatSync(fd).isFile() && lstatSync(marker).isFile()) pid = Number.parseInt(readFileSync(fd, "utf8").trim(), 10);
          } finally { closeSync(fd); }
        } catch { /* no marker: an orphan from before markers, or a half-made dir */ }
        if (pid === process.pid ? !opts.includeOwn : Number.isInteger(pid) && pid > 0 && pidAlive(pid)) { kept++; continue; }
        for (const f of readdirSync(dir)) {
          const p = join(dir, f);
          try { if (lstatSync(p).isFile()) wipeAndDelete(p, { afterOverwrite: opts.afterOverwrite }); } catch { /* removed below regardless */ }
        }
        rmSync(dir, { recursive: true, force: true });
        removed++;
      } catch {
        kept++;
      }
    }
  }
  return { removed, kept };
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException)?.code === "EPERM"; }
}

/** Text from the saved bytes: UTF-16 (Notepad's "Unicode") or UTF-8, BOM removed. */
export function decodeSecretFile(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString("utf16le");
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2, buf.length - ((buf.length - 2) % 2))); // swap16 needs an even length
    swapped.swap16();
    const text = swapped.toString("utf16le");
    swapped.fill(0);
    return text;
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString("utf8");
  return buf.toString("utf8");
}

/** Overwrite the file's bytes with zeros (fsync), then delete it. `afterOverwrite` is a test seam that
 *  sees the file between the overwrite and the delete. Best effort on copy-on-write or wear-levelled
 *  storage, which may keep the old blocks; the directory being user-only bounds that exposure. */
export function wipeAndDelete(file: string, hooks: { afterOverwrite?: (file: string) => void } = {}): void {
  // CodeQL #129 (js/file-system-race): no exists/stat by name before the open; the file is opened once and
  // sized from that descriptor, and a missing file is the open's own ENOENT. CodeQL #124
  // (js/insecure-temporary-file): "r+" never creates a file, so the 0o600 mode is inert; it is stated so no
  // open of a temp-dir path in this module carries a permissive default.
  let fd: number;
  try { fd = openSync(file, "r+", 0o600); } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return;
    throw e;
  }
  try {
    const size = fstatSync(fd).size;
    if (size > 0) {
      const zeros = Buffer.alloc(Math.min(size, 1 << 20));
      for (let at = 0; at < size; at += zeros.length) writeSync(fd, zeros, 0, Math.min(zeros.length, size - at), at);
      fsyncSync(fd);
    }
  } finally {
    closeSync(fd);
  }
  hooks.afterOverwrite?.(file);
  rmSync(file, { force: true });
}

/** The OS editor argv for a file: fixed programs, the path as its own argv element (no shell). */
export function editorCommand(file: string, platform: NodeJS.Platform = process.platform): string[] {
  if (platform === "win32") return ["notepad.exe", file];
  if (platform === "darwin") return ["open", "-e", file];
  return ["xdg-open", file];
}

/** Create the user-only file, open it for the user, and watch for the save. Throws FallbackRefused when
 *  the file cannot be made user-only or no editor could be started (nothing is left behind). */
export function startFallback(opts: FallbackOptions): FallbackSession {
  const { dir, file } = createUserOnlyFile(opts);
  const cleanup = () => {
    try { wipeAndDelete(file); } catch { /* the rmSync below still removes the folder */ }
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    if (opts.openEditor) opts.openEditor(file);
    else Bun.spawn(editorCommand(file, opts.platform), { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  } catch {
    cleanup();
    throw new FallbackRefused("no text editor could be opened on this computer");
  }
  const { promise, resolve: settle } = Promise.withResolvers<FallbackRead>();
  let done = false;
  let lastKey = "";
  const finish = (r: FallbackRead) => {
    if (done) return;
    done = true;
    stopTicker();
    clearTimeout(deadline);
    cleanup();
    settle(r);
  };
  const tick = () => {
    if (done) return;
    // CodeQL #130 (js/file-system-race): size, mtime and bytes come from ONE descriptor, never a stat by name
    // then a read by name. It is closed before finish() wipes and deletes the file. The 0o600 mode is inert
    // for "r" (see wipeAndDelete, CodeQL #124).
    let fd: number;
    try { fd = openSync(file, "r", 0o600); } catch { return; } // not there right now (an editor mid-save): look again
    let buf: Buffer | null = null;
    let tooBig = false;
    try {
      const st = fstatSync(fd);
      if (st.size === 0) lastKey = "";
      else if (st.size > MAX_SECRET_FILE_BYTES) tooBig = true;
      else {
        const key = `${st.size}:${st.mtimeMs}`;
        if (key !== lastKey) lastKey = key; // wait one more poll: the save must be stable
        else buf = readFileSync(fd);
      }
    } catch { return; } finally { closeSync(fd); }
    if (tooBig) { finish({ error: "the file is larger than a secret should be, so it was wiped and deleted unread" }); return; }
    if (!buf) return;
    const text = decodeSecretFile(buf);
    buf.fill(0);
    if (!text.trim()) { lastKey = ""; return; } // whitespace only: keep waiting for the real paste
    finish({ value: text });
  };
  const stopTicker = opts.ticker ? opts.ticker(tick) : (() => { const h = setInterval(tick, opts.pollMs ?? 500); return () => clearInterval(h); })();
  const deadline = setTimeout(() => finish(null), opts.timeoutMs ?? 10 * 60_000);
  return { path: file, read: promise, dispose: () => finish(null) };
}
