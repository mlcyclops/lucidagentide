// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/addon_seam.ts — P-AGENT.10 (ADR-0138): the public seam to the PRIVATE enterprise add-on repo
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
import { join, resolve } from "node:path";
import { repoAsset } from "./repo_root.ts"; // P-GATE-PATH.1 (ADR-0356): never import.meta.dir

/** The add-on checkout root: env override first, else the documented sibling folder.
 *  P-GATE-PATH.1: resolved through repo_root.ts, because `join(import.meta.dir, "..")` in a compiled
 *  engine is Bun's virtual root, which put the sibling lookup somewhere no add-on could ever be. */
export function addonDir(): string {
  return process.env.LUCID_ADDON_DIR || repoAsset("..", "lucidagentIDEaddon");
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

/** A connector reply with every field the connector sent (`reply`), for verbs whose reply carries more
 *  than `{ ok, detail }` (the kms destination verbs, ADR-A044: `pushed`, `items`, `pulled`). */
export interface ConnectorReply extends ConnectorResult {
  /** The parsed one-line JSON object, or null when the connector printed none. */
  reply: Record<string, unknown> | null;
}

/** P-VAULT-DEST.1 (ADR-0478): the async form of runConnector, so a slow connector never blocks the engine's
 *  event loop. Same `bun <dir>/src/cli.ts <verb> --file <artifact>` contract. A connector that fails closed
 *  exits 1 AND prints its one JSON line (ADR-A044), so the line is parsed whatever the exit code: ok is true
 *  only for exit 0 with `ok: true`, and `detail` is the connector's own reason when it gave one. */
export async function runConnectorReply(name: string, verb: string, artifactFile: string, timeoutMs = 60_000): Promise<ConnectorReply> {
  const st = connectorStatus(name);
  if (!st.installed || !st.dir) return { ok: false, detail: st.note, reply: null };
  const dir = resolve(st.dir); // a relative LUCID_ADDON_DIR must not be re-resolved against the child's cwd
  try {
    const proc = Bun.spawn(["bun", join(dir, "src", "cli.ts"), verb, "--file", artifactFile], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    });
    const [out, err, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    const lastLine = out.trim().split("\n").at(-1)?.trim() ?? "";
    let reply: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = JSON.parse(lastLine);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) reply = parsed as Record<string, unknown>;
    } catch { /* no JSON line: reported below */ }
    if (!reply) {
      const why = exitCode !== 0 ? err.trim() || out.trim() || `connector exited ${exitCode}` : `connector reply was not JSON: ${lastLine.slice(0, 200)}`;
      return { ok: false, detail: why.slice(0, 500), reply: null };
    }
    const ok = exitCode === 0 && reply.ok === true;
    const detail = typeof reply.detail === "string" ? reply.detail : ok ? "done" : `connector reported failure (exit ${exitCode})`;
    return { ok, detail: detail.slice(0, 500), reply };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e), reply: null };
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
