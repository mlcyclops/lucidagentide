// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/security/scanner_client.ts
//
// TS side of the scanner IPC contract (ADR-0002). Spawns the pure Python
// scanner sidecar and speaks newline-delimited JSON over stdin/stdout.
//
// FAIL-CLOSED LAW (CLAUDE.md #3): every way of NOT getting a valid scan result
// -- dead process, malformed response, timeout, missing id -- surfaces here as a
// thrown `ScanUnavailableError`. This module never returns "no findings" to mean
// "couldn't scan". The GATE that consumes this (gate.ts) maps the throw to BLOCK.
//
// The sidecar is invoked via the project venv's Python directly (no runtime `uv`
// on PATH required); override with env SCANNER_PYTHON if needed.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Finding } from "../contracts.ts";
// P-PACKSCAN.1 (ADR-0368): the ONE probed repo root (ADR-0356). Same import direction the launcher
// already uses (harness/launcher/lucid_acp.ts imports it too), so this adds no new coupling.
import { repoAsset } from "../../desktop/repo_root.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Where the Python sidecar lives on disk.
 *
 *  LUCID_SCANNER_DIR is the explicit override the standalone launcher sets (`lucid_acp.ts`), and it
 *  wins. Read LAZILY, never as a module-level const: the launcher sets it in main() AFTER this module
 *  is imported, so a const would capture the stale value.
 *
 *  P-PACKSCAN.1 (ADR-0368): the FALLBACK is now the PROBED repo root, not `join(HERE, "..", "..")`.
 *  This is the third appearance of the ADR-0356 bug. `HERE` comes from `import.meta.url`, which a
 *  `bun build --compile` binary VIRTUALIZES to `B:\~BUN\root`, so the old fallback resolved to
 *  `B:\~BUN\scanner-sidecar`, a path in no filesystem. The launcher was immune because it sets the env
 *  explicitly; the packaged desktop ENGINE (`bin/lucid-engine`, also a compiled binary, ADR-0260) never
 *  set it, so on every packaged install the engine's ScannerClient spawned `python server.py` with a
 *  nonexistent cwd, the child died instantly, and EVERY engine-side scan failed closed. The visible
 *  symptom was a KG Pack import refusing with `page "..." flagged: fail-closed: scan unavailable
 *  (scanner not running)`, which reads like a malicious pack and was in fact a missing directory.
 *
 *  Still fail-closed either way: an unresolvable dir makes the scan THROW, never pass. The probe only
 *  changes whether a correct install can find a sidecar that is sitting right there. */
export function sidecarDir(): string {
  const explicit = (process.env.LUCID_SCANNER_DIR ?? "").trim();
  if (explicit) return explicit;
  return repoAsset("scanner-sidecar");
}

export interface ScanResponse {
  id: string;
  findings: Finding[];
  scanner_version: string;
}

/** Thrown for ANY failure to obtain a valid scan result. The gate treats this
 *  as block/quarantine. Never swallow it into a "safe" path. */
export class ScanUnavailableError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ScanUnavailableError";
  }
}

function resolvePython(): string {
  if (process.env.SCANNER_PYTHON) return process.env.SCANNER_PYTHON;
  const win = join(sidecarDir(), ".venv", "Scripts", "python.exe");
  const posix = join(sidecarDir(), ".venv", "bin", "python");
  if (existsSync(win)) return win;
  if (existsSync(posix)) return posix;
  // Last resort, and on POSIX it used to be the bare name `python`, which modern Linux does not ship:
  // Ubuntu 24.04 provides `python3` only (no python-is-python3 by default), so the spawn failed
  // instantly and the gate reported "scanner stdin not writable" (P-SCANPY.1 / ADR-0366). `python3` is
  // the correct name to ask for; a caller that needs a specific interpreter sets SCANNER_PYTHON, and
  // the packaged launcher now always does (harness/launcher/lucid_acp.ts scannerPythonCandidates).
  return process.platform === "win32" ? "python" : "python3";
}

interface Pending {
  resolve: (r: ScanResponse) => void;
  reject: (e: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Reported when the sidecar ends without `stop()`: why it ended, the tail of its stderr, and how
 *  long until the next scan may respawn it. */
export interface ScannerExit {
  reason: string;
  stderrTail: string;
  restartInMs: number;
}

const STDERR_TAIL_CHARS = 2000;
const RESPAWN_BACKOFF_MIN_MS = 500;
const RESPAWN_BACKOFF_MAX_MS = 30_000;

/** P-SCANLIVE.1 (ADR-0571): a sidecar that dies on its own is RESPAWNED by the next scan, after a
 *  backoff that doubles while it keeps dying and resets on the first good response. Before this, a
 *  sidecar killed from outside (an installer closing every python.exe, AV, OOM) left the client dead
 *  for the life of the process: every later tool call failed closed with "scanner not running" and
 *  only restarting the app recovered it. Fail-closed is unchanged: the requests in flight when it
 *  dies are rejected, a scan during the backoff is rejected, and a respawn that cannot start rejects.
 *  `stop()` is terminal: a stopped client never respawns itself. */
export class ScannerClient {
  #proc: ReturnType<typeof spawn> | undefined;
  #pending = new Map<string, Pending>();
  #buf = "";
  #seq = 0;
  #alive = false;
  #timeoutMs: number;
  #onExit: ((e: ScannerExit) => void) | undefined;
  /** Set when the sidecar ended without stop(): the next scan may respawn it. */
  #crashed = false;
  #lastExit = "";
  #restartAt = 0;
  #backoffMs = 0;
  #stderrTail = "";
  /** Why this client is about to kill its own sidecar (a hung scan), reported instead of the signal. */
  #killReason = "";

  constructor(opts: { timeoutMs?: number; onExit?: (e: ScannerExit) => void } = {}) {
    this.#timeoutMs = opts.timeoutMs ?? 5000;
    this.#onExit = opts.onExit;
  }

  get alive(): boolean {
    return this.#alive;
  }

  /** The running sidecar's pid, for diagnostics; undefined when none is running. */
  get pid(): number | undefined {
    return this.#proc?.pid;
  }

  start(): void {
    if (this.#proc) return;
    this.#crashed = false;
    this.#buf = "";
    this.#stderrTail = "";
    this.#killReason = "";
    const py = resolvePython();
    const proc = spawn(py, ["server.py"], {
      cwd: sidecarDir(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#proc = proc;
    this.#alive = true;

    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => {
      if (this.#proc === proc) this.#onData(chunk);
    });
    // Drain stderr: an unread pipe fills and blocks the sidecar's next write, which hangs every scan.
    // The tail goes into the exit report, the only record of why a sidecar died.
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk: string) => {
      if (this.#proc === proc) this.#stderrTail = (this.#stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
    });

    // Death of the sidecar fails every in-flight request closed. Only the CURRENT process may do this:
    // the exit of one already replaced (stop() then start(), or a respawn) must not touch its successor.
    const die = (why: string) => {
      if (this.#proc !== proc) return;
      this.#proc = undefined;
      this.#alive = false;
      // Close our end: on Windows a venv python.exe is a launcher, and a killed launcher can leave the
      // real interpreter running on the inherited pipe until it reads EOF.
      proc.stdin?.destroy();
      const reason = this.#killReason || why;
      const err = new ScanUnavailableError(`scanner sidecar unavailable: ${reason}`);
      for (const [, p] of this.#pending) {
        clearTimeout(p.timer);
        p.reject(err);
      }
      this.#pending.clear();
      this.#crashed = true;
      this.#lastExit = reason;
      this.#backoffMs = Math.min(Math.max(this.#backoffMs * 2, RESPAWN_BACKOFF_MIN_MS), RESPAWN_BACKOFF_MAX_MS);
      this.#restartAt = Date.now() + this.#backoffMs;
      try {
        this.#onExit?.({ reason, stderrTail: this.#stderrTail.trim(), restartInMs: this.#backoffMs });
      } catch { /* a reporting failure never changes the outcome: the requests are already rejected */ }
    };
    proc.on("exit", (code, signal) => die(`exited code=${code} signal=${signal}`));
    proc.on("error", (e) => die(`spawn error: ${String(e)}`));
  }

  #onData(chunk: string): void {
    this.#buf += chunk;
    let nl: number;
    while ((nl = this.#buf.indexOf("\n")) >= 0) {
      const line = this.#buf.slice(0, nl).trim();
      this.#buf = this.#buf.slice(nl + 1);
      if (!line) continue;
      this.#dispatch(line);
    }
  }

  #dispatch(line: string): void {
    let resp: unknown;
    try {
      resp = JSON.parse(line);
    } catch {
      return; // unparseable line -> pending requests will time out -> fail closed
    }
    if (typeof resp !== "object" || resp === null) return;
    const r = resp as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id : undefined;
    if (!id) return; // no id to correlate -> requests time out -> fail closed
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    clearTimeout(pending.timer);

    if ("error" in r) {
      pending.reject(new ScanUnavailableError(`scanner error: ${String(r.error)}`));
      return;
    }
    if (!Array.isArray(r.findings) || typeof r.scanner_version !== "string") {
      pending.reject(new ScanUnavailableError("malformed scan response"));
      return;
    }
    this.#backoffMs = 0; // a sidecar that answers is healthy: the next death starts the backoff over
    pending.resolve({
      id,
      findings: r.findings as Finding[],
      scanner_version: r.scanner_version,
    });
  }

  /** A scan timed out: the sidecar is hung or still busy with an oversized request, and every request
   *  queued behind it would time out too. Kill it so the exit path rejects those and the next scan
   *  respawns a fresh one. */
  #killHung(): void {
    const proc = this.#proc;
    if (!proc) return;
    this.#killReason = `no response within ${this.#timeoutMs}ms, killed`;
    proc.kill();
  }

  /** Scan text. Resolves with findings on success; REJECTS (fail-closed) on any
   *  inability to obtain a valid result. */
  scan(text: string, policy?: Record<string, unknown>): Promise<ScanResponse> {
    if (!this.#alive && this.#crashed && Date.now() >= this.#restartAt) this.start();
    if (!this.#proc || !this.#alive) {
      const why = this.#crashed ? `scanner not running (last exit: ${this.#lastExit}; restart pending)` : "scanner not running";
      return Promise.reject(new ScanUnavailableError(why));
    }
    const id = `s${++this.#seq}`;
    const payload = JSON.stringify({ id, text, policy: policy ?? {} }) + "\n";

    return new Promise<ScanResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new ScanUnavailableError(`scan timeout after ${this.#timeoutMs}ms`));
        this.#killHung();
      }, this.#timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });

      const stdin = this.#proc?.stdin;
      if (!stdin || !stdin.writable) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(new ScanUnavailableError("scanner stdin not writable"));
        return;
      }
      stdin.write(payload, (err) => {
        if (err) {
          clearTimeout(timer);
          this.#pending.delete(id);
          reject(new ScanUnavailableError("write to scanner failed", err));
        }
      });
    });
  }

  /** Terminal: the sidecar is killed and never respawned by scan(); only an explicit start() revives it. */
  stop(): void {
    this.#alive = false;
    this.#crashed = false;
    this.#proc?.kill();
    this.#proc = undefined;
  }
}
