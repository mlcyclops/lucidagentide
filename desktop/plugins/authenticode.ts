// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/plugins/authenticode.ts - P-PLUGINS.2 (ADR-0462, ADR-0450): a daemon plugin's Windows binaries
// must carry a VALID Authenticode signature from TECHLEAD 187 LLC before they are installed.
//
// The check is the one CI's "Verify Authenticode signatures" step runs on every release exe
// (Get-AuthenticodeSignature: Status Valid + the signer subject), executed here per file. The path reaches
// PowerShell through an environment variable, never interpolated into the command, so a crafted file name
// cannot become script. PowerShell is named by its absolute System32 path so PATH cannot substitute it.
// Anything other than a clean "Valid by CN=TECHLEAD 187 LLC" answer (unsigned, expired, a different
// signer, PowerShell missing or slow, unparseable output) is a refusal.

import { spawnSync } from "node:child_process";
import { join } from "node:path";

export const AUTHENTICODE_PUBLISHER_CN = "TECHLEAD 187 LLC";
const PROBE_TIMEOUT_MS = 30_000;

/** Files whose Authenticode signature is checked: Windows PE images a daemon would load or run. */
export function needsAuthenticode(path: string): boolean {
  return /\.(exe|dll)$/i.test(path);
}

const SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$s = Get-AuthenticodeSignature -LiteralPath $env:LUCID_AUTHENTICODE_PATH",
  "$subject = if ($s.SignerCertificate) { $s.SignerCertificate.Subject } else { '' }",
  "[pscustomobject]@{ status = $s.Status.ToString(); subject = $subject } | ConvertTo-Json -Compress",
].join("; ");

/** Pure verdict over Get-AuthenticodeSignature's JSON. The CN must be exactly the publisher, as one RDN. */
export function authenticodeVerdict(stdout: string): { ok: boolean; reason: string } {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout.trim()); } catch { return { ok: false, reason: "could not read the signature check's output" }; }
  if (!parsed || typeof parsed !== "object") return { ok: false, reason: "could not read the signature check's output" };
  const status = "status" in parsed && typeof parsed.status === "string" ? parsed.status : "";
  const subject = "subject" in parsed && typeof parsed.subject === "string" ? parsed.subject : "";
  if (status !== "Valid") return { ok: false, reason: `Authenticode status is ${status || "unknown"}` };
  const cn = subject.split(",").map((rdn) => rdn.trim()).find((rdn) => /^CN=/i.test(rdn))?.slice(3).replace(/^"(.*)"$/, "$1");
  if (cn !== AUTHENTICODE_PUBLISHER_CN) return { ok: false, reason: `signed by ${cn ? `"${cn}"` : "an unknown subject"}, not ${AUTHENTICODE_PUBLISHER_CN}` };
  return { ok: true, reason: "valid" };
}

export type AuthenticodeProbe = (absPath: string) => { ok: boolean; reason: string };

/** Run the real check on one file (Windows only). */
export const probeAuthenticode: AuthenticodeProbe = (absPath) => {
  const ps = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const r = spawnSync(ps, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", SCRIPT], {
    env: { ...process.env, LUCID_AUTHENTICODE_PATH: absPath },
    encoding: "utf8", timeout: PROBE_TIMEOUT_MS, windowsHide: true,
  });
  if (r.error) return { ok: false, reason: `signature check could not run: ${r.error.message}` };
  if (r.status !== 0) return { ok: false, reason: `signature check failed (${r.status ?? r.signal}): ${String(r.stderr).trim().slice(0, 200)}` };
  return authenticodeVerdict(String(r.stdout));
};
