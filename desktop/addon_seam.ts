// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/addon_seam.ts — P-AGENT.10 (ADR-0136): the public seam to the PRIVATE enterprise add-on repo
// (lucidagentIDEaddon, a sibling of this checkout; override with env LUCID_ADDON_DIR).
//
// Pattern (ADR-0068/0069/A012): the public core ships complete, working features on portable ARTIFACTS
// (files + manifests); the add-on ships CONNECTORS that move those artifacts into private infrastructure
// (a hosted n8n instance, a KMS, SharePoint, …). This module only: (a) detects whether a connector is
// installed, and (b) dispatches an artifact to it via a documented CLI contract. It never loads add-on
// code into the engine process — connectors run as child processes with their own dependencies.
//
// CLI contract (documented for the add-on side): `bun <connector-dir>/src/cli.ts <verb> --file <artifact>`
// prints ONE JSON line: `{ "ok": boolean, "detail": string, "url"?: string }`. Anything else (bad exit,
// unparseable output, timeout) is reported as a failure — the seam never fabricates success.
//
// SECURITY: the add-on directory is FIRST-PARTY private code chosen by the operator (env/sibling path),
// never resolved from the open workspace — a cloned repo cannot plant a "connector" and have LUCID run it.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..");

/** The add-on checkout root: env override first, else the documented sibling folder. */
export function addonDir(): string {
  return process.env.LUCID_ADDON_DIR || join(REPO, "..", "lucidagentIDEaddon");
}

export interface ConnectorStatus {
  installed: boolean;
  dir?: string; // connector directory when installed
  note: string; // human-readable status for the UI (why it's unavailable / what it can do)
}

/** Probe for a named connector under `<addon>/connectors/<name>` (must carry a package.json + src/cli.ts). */
export function connectorStatus(name: string): ConnectorStatus {
  const dir = join(addonDir(), "connectors", name);
  const entry = join(dir, "src", "cli.ts");
  // read-don't-stat where it matters is for content; presence probes here gate UX only (never security).
  if (!existsSync(join(dir, "package.json")) || !existsSync(entry)) {
    return {
      installed: false,
      note: `The ${name} connector is part of the LUCID enterprise add-on (lucidagentIDEaddon/connectors/${name}). Install the add-on beside this checkout or set LUCID_ADDON_DIR.`,
    };
  }
  return { installed: true, dir, note: `${name} connector installed (${dir})` };
}

export interface ConnectorResult {
  ok: boolean;
  detail: string;
  url?: string;
}

/** Dispatch an artifact file to an installed connector verb. Fail-honest: every failure mode (missing
 *  connector, bad exit, unparseable reply, timeout) returns ok:false with the reason — never a fake pass. */
export function runConnector(name: string, verb: string, artifactFile: string, timeoutMs = 60_000): ConnectorResult {
  const st = connectorStatus(name);
  if (!st.installed || !st.dir) return { ok: false, detail: st.note };
  try {
    const proc = Bun.spawnSync(["bun", join(st.dir, "src", "cli.ts"), verb, "--file", artifactFile], {
      cwd: st.dir,
      stdout: "pipe",
      stderr: "pipe",
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    });
    const out = new TextDecoder().decode(proc.stdout).trim();
    const err = new TextDecoder().decode(proc.stderr).trim();
    if (proc.exitCode !== 0) return { ok: false, detail: (err || out || `connector exited ${proc.exitCode}`).slice(0, 500) };
    const lastLine = out.split("\n").at(-1) ?? "";
    let parsed: unknown;
    try {
      parsed = JSON.parse(lastLine);
    } catch {
      return { ok: false, detail: `connector reply was not JSON: ${lastLine.slice(0, 200)}` };
    }
    if (typeof parsed !== "object" || parsed === null) return { ok: false, detail: "connector reply was not an object" };
    const r = parsed as Record<string, unknown>;
    return {
      ok: r.ok === true,
      detail: typeof r.detail === "string" ? r.detail : r.ok === true ? "done" : "connector reported failure",
      ...(typeof r.url === "string" ? { url: r.url } : {}),
    };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

/** Convenience: read a connector's declared version (package.json) for the UI/status endpoints. */
export function connectorVersion(name: string): string | null {
  const st = connectorStatus(name);
  if (!st.installed || !st.dir) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(st.dir, "package.json"), "utf8"));
    if (parsed && typeof parsed === "object" && "version" in parsed) {
      const v = parsed.version;
      return typeof v === "string" ? v : null;
    }
    return null;
  } catch {
    return null;
  }
}
