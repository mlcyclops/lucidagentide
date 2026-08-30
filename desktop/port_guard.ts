// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/port_guard.ts - P-PORTGUARD.1 (ADR-0305): the engine port handshake, pure core.
//
// Field incident, 2026-08-30: an orphaned `bun server.ts` from a scaffold fork had been LISTENING
// on *:5319 for three days. main.ts's waitForServer() accepted ANY 200 from /api/health, so the
// LUCID window rendered a stranger's UI (a sign-in card, no less) through two upgrades and a
// checksum-verified reinstall. The fix is identity, not luck: main mints a per-launch nonce, hands
// it to the spawned engine via env, and only a health body echoing that nonce counts as "our
// engine is up". Anything else fails LOUDLY with a copy/paste incident block naming the squatter
// (ADR-0305: never roll ports silently; per-port userData is a deliberate identity, ADR-0206/0278).
//
// This module is the PURE decision core (unit-tested, no Electron imports, no I/O): main.ts owns
// the wiring - fetch /api/health -> healthVerdict; on a foreign verdict, spawn ownerProbeSpec ->
// parseOwnerProbe -> formatPortIncident for both the error dialog and engine.log, so the report
// text is tested here instead of hand-rolled at the callsite (ADR-0305 increment plan).

/**
 * What a single /api/health observation tells us about the port:
 * - "ours": the response carries the nonce only our spawned child can know.
 * - "foreign-missing-nonce": something answered 200 without our identity (no/null nonce, or a body
 *   we cannot even recognize). Fail-closed: an unrecognizable answerer is a stranger, not a maybe.
 * - "foreign-wrong-nonce": a nonce was presented and it is NOT ours - an active impersonation
 *   attempt or a stale sibling launch; either way, not our engine.
 * - "not-ready": no successful HTTP response yet; keep polling, nothing to accuse.
 */
export type HealthVerdict = "ours" | "foreign-missing-nonce" | "foreign-wrong-nonce" | "not-ready";

/**
 * Classify one health poll. `body` is the parsed JSON (or whatever the caller managed to parse);
 * it is deliberately `unknown` because a squatter controls that shape entirely.
 *
 * Order matters and mirrors ADR-0305's fail-closed law (AGENTS.md invariant 3): "someone answered
 * health" is NOT "my engine is up". A 200 whose body is not an object with ok === true is treated
 * as foreign-missing-nonce, not not-ready: OUR engine only ever answers 200 once it is genuinely
 * ok, so a malformed 200 means a foreign process is squatting on the port.
 */
export function healthVerdict(expectedNonce: string, httpOk: boolean, body: unknown): HealthVerdict {
  if (!httpOk) return "not-ready";
  // Wrong shape (non-object, null, array) or ok !== true: something we do not recognize answered.
  if (typeof body !== "object" || body === null || Array.isArray(body)) return "foreign-missing-nonce";
  if (!("ok" in body) || body.ok !== true) return "foreign-missing-nonce";
  const nonce = "nonce" in body ? body.nonce : undefined;
  // Absent or null nonce: a health endpoint that never heard of our handshake (the incident case).
  if (nonce === undefined || nonce === null) return "foreign-missing-nonce";
  // A nonce was presented: either it is ours or it is an impersonation. Non-string counts as wrong.
  if (nonce !== expectedNonce) return "foreign-wrong-nonce";
  return "ours";
}

/** Best-effort attribution of the process squatting on the port. Every field is nullable because
 *  the probe is diagnostic, not load-bearing: partial forensics beat none (ADR-0305 requirement:
 *  when attribution fails the report SAYS so instead of omitting the section). */
export interface SquatterInfo {
  pid: number | null;
  name: string | null;
  startedAt: string | null;
  command: string | null;
}

export interface PortIncidentInput {
  port: number;
  productName: string;
  appVersion: string;
  platform: string;
  /** What SHOULD have been listening, e.g. "LUCID engine (bin/lucid-engine, agent flavor)". */
  engineDescription: string;
  verdict: HealthVerdict;
  /** null = the owner probe produced nothing usable; the block must say so explicitly. */
  observed: SquatterInfo | null;
}

/**
 * Render the copy/paste incident block (ADR-0305, user requirement 2026-08-30): markdown suitable
 * to paste VERBATIM into an email to a contributor or a GitHub issue. Both the error dialog and
 * engine.log consume this exact string, so the forensics a user ships us are the forensics we
 * tested, not whatever a callsite improvised.
 */
export function formatPortIncident(i: PortIncidentInput): string {
  const lines = [
    "### LUCID port incident report (ADR-0305 engine handshake)",
    "",
    `- Product: ${i.productName} ${i.appVersion}`,
    `- Platform: ${i.platform}`,
    `- Port: ${i.port}`,
    `- Expected engine: ${i.engineDescription}`,
    `- Health-nonce verdict: ${i.verdict}`,
  ];
  if (i.observed) {
    // "unknown" per field rather than dropping the line: a partially attributed squatter is still
    // far more actionable than a bare verdict (the incident was solved BY pid + start time).
    lines.push(
      "- Observed listener:",
      `  - Name: ${i.observed.name ?? "unknown"}`,
      `  - PID: ${i.observed.pid ?? "unknown"}`,
      `  - Started: ${i.observed.startedAt ?? "unknown"}`,
      `  - Command: ${i.observed.command ?? "unknown"}`,
    );
  } else {
    lines.push(
      "- Observed listener: process attribution FAILED (the owner probe returned nothing usable)." +
        " Something is answering this port, but the listening process could not be identified.",
    );
  }
  return lines.join("\n") + "\n";
}

/**
 * The platform-specific command that resolves the LISTENING owner of `port`. Returned as
 * cmd + args (never a shell-interpolated string on win32) so main.ts can spawn it directly.
 * Unknown platform: null - the incident block then reports attribution as failed, which is the
 * honest answer rather than guessing at a probe that does not exist there.
 */
export function ownerProbeSpec(platform: string, port: number): { cmd: string; args: string[] } | null {
  if (platform === "win32") {
    // Get-NetTCPConnection gives the owning pid of the LISTENING socket; Get-Process turns it into
    // name/start/path; ConvertTo-Json gives us a shape parseOwnerProbe can parse without locale
    // guessing. -NoProfile keeps user profiles from polluting stdout. SilentlyContinue everywhere:
    // this probe must never throw a dialog of its own - empty output just means "attribution failed".
    const script =
      `$c = Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -First 1; ` +
      `if ($c) { Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue | Select-Object Id, ProcessName, StartTime, Path | ConvertTo-Json }`;
    return { cmd: "powershell.exe", args: ["-NoProfile", "-Command", script] };
  }
  if (platform === "darwin" || platform === "linux") {
    // lsof -t prints just the pid of the LISTEN owner; ps lstart gives the start timestamp that
    // cracked the original incident (a process listening since Aug 27 under an Aug 30 report).
    // The [ -n "$pid" ] guard replaces `xargs -r`, whose empty-input behavior differs between GNU
    // and BSD; an empty probe must produce empty stdout, not a ps usage error.
    const script =
      `pid="$(lsof -tnP -iTCP:${port} -sTCP:LISTEN 2>/dev/null | head -n 1)" && ` +
      `[ -n "$pid" ] && ps -p "$pid" -o pid=,lstart=,command=`;
    return { cmd: "sh", args: ["-c", script] };
  }
  return null;
}

/**
 * Parse the stdout of ownerProbeSpec's command back into SquatterInfo. Garbage in (empty output,
 * truncated JSON, a ps usage error) is null out: the probe is best-effort and the incident block
 * handles null by saying attribution failed (ADR-0305).
 */
export function parseOwnerProbe(platform: string, stdout: string): SquatterInfo | null {
  const text = stdout.trim();
  if (!text) return null;
  if (platform === "win32") return parseWindowsProbe(text);
  if (platform === "darwin" || platform === "linux") return parsePosixProbe(text);
  return null;
}

/** Windows PowerShell 5.1's ConvertTo-Json emits DateTime as "/Date(<epoch ms>)/"; PowerShell 7
 *  emits ISO-ish strings. Normalize the former to ISO so the incident block is human-readable. */
function normalizeWindowsTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const m = /\/Date\((-?\d+)\)\//.exec(value);
  if (m) {
    const ms = Number(m[1]);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  return value;
}

function parseWindowsProbe(text: string): SquatterInfo | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  // ConvertTo-Json emits a bare object for one process and an array for several (multiple sockets
  // can share a LISTEN owner set); the first entry is the one that answered our health poll's port.
  const record: unknown = Array.isArray(parsed) ? parsed[0] : parsed;
  if (typeof record !== "object" || record === null) return null;
  const pid = "Id" in record && typeof record.Id === "number" ? record.Id : null;
  // No pid means the JSON is not the shape our own script emits: treat as garbage, not as partial.
  if (pid === null) return null;
  const name = "ProcessName" in record && typeof record.ProcessName === "string" ? record.ProcessName : null;
  const startedAt = "StartTime" in record ? normalizeWindowsTimestamp(record.StartTime) : null;
  const command = "Path" in record && typeof record.Path === "string" ? record.Path : null;
  return { pid, name, startedAt, command };
}

/** One `ps -o pid=,lstart=,command=` line: pid, then EXACTLY five lstart tokens (weekday, month,
 *  day, time, year - the day may be space-padded), then the command, which may contain spaces. */
const POSIX_PS_LINE = /^\s*(\d+)\s+((?:\S+\s+){4}\S+)\s+(\S.*)$/;

function parsePosixProbe(text: string): SquatterInfo | null {
  // head -n 1 in the probe already limits to one pid, but be defensive about multi-line stdout.
  const line = text.split("\n")[0] ?? "";
  const m = POSIX_PS_LINE.exec(line);
  if (!m) return null;
  const pid = Number(m[1]);
  if (!Number.isInteger(pid)) return null;
  // Collapse ps's column padding (e.g. "Aug  7") so the incident block reads cleanly.
  const startedAt = m[2].replace(/\s+/g, " ");
  const command = m[3].trim();
  // ps gives no separate name column; the basename of the command's first word is the closest
  // equivalent to Windows' ProcessName ("bun" from "/usr/local/bin/bun server.ts").
  const first = command.split(/\s+/)[0] ?? "";
  const name = first ? (first.split(/[\\/]/).pop() ?? first) : null;
  return { pid, name, startedAt, command };
}
