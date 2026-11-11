// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/plugins/install.ts - P-PLUGINS.2 (ADR-0462): gated install / uninstall of `.lplugin` packages.
//
// Mirrors the KG Pack import (desktop/kb_pack.ts) with the gates a CODE package needs, all fail-closed,
// in this order, and nothing reaches the live install folder unless every one passes:
//   download  https only (loopback http only under the LUCID_PLUGIN_DEV_LOOPBACK smoke switch), a size cap,
//             and a managed egress DENY is honored;
//   manifest  schema 1, safe paths (no traversal, no absolute, no case collisions), id == the requested id;
//   hash      every file matches the signed `files` list, nothing missing, nothing extra;
//   signature REQUIRED for premium, verified against the publisher key baked into the IDE;
//   authenticode  every .exe/.dll of a daemon package on Windows is Valid and signed by TECHLEAD 187 LLC;
//   scan      the existing fail-closed scanner over every text file (a dead scanner refuses too).
// Layout: userData/plugins/<id>/<version>/ (the package), userData/plugins/<id>/current.json (the atomic
// version pointer: written to a temp file and renamed), userData/plugin-data/<id>/ (the plugin's state,
// kept across updates and, unless asked, across uninstall). Every attempt is appended to
// ~/.omp/lucid-plugins.jsonl.

import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import type { TrustedPackKey } from "../../harness/kb/pack.ts";
import { DEFAULT_POLICY, scanAndDecide, type GateDecision } from "../../harness/security/gate.ts";
import { readAllZipEntries } from "../../harness/personal/unzip.ts";
import {
  PLUGIN_LICENSE, PLUGIN_MANIFEST, PLUGIN_SIGNATURE, canonicalPluginBytes, validatePluginManifest, verifyPluginEntries,
  type PluginGate, type PluginManifest,
} from "../../harness/plugins/package.ts";
import { trustedPluginKeys } from "../../harness/plugins/publisher_key.ts";
import { needsAuthenticode, probeAuthenticode, type AuthenticodeProbe } from "./authenticode.ts";
import { extractHost } from "../egress_policy.ts";
import { managedConfig, type ManagedEgressPolicy } from "../managed_config.ts";
import { isScannerUnavailable } from "../kb_pack.ts";
import { kbScanner } from "../kb_store.ts";
import { recordBlock } from "../security_log.ts";

/** Download ceiling (compressed) and expansion ceiling (uncompressed). */
export const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;
export const MAX_EXPANDED_BYTES = 1024 * 1024 * 1024;
/** The scanner answers one request within 5 s; a bundle is scanned in slices that fit comfortably. */
const SCAN_SLICE_CHARS = 200_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const dataRoot = (): string => process.env.LUCID_DATA_ROOT || join(homedir(), ".omp");
/** userData/plugins (LUCID_PLUGINS_DIR overrides, for tests and isolated smoke runs). */
export function pluginsRoot(): string { return process.env.LUCID_PLUGINS_DIR || join(dataRoot(), "plugins"); }
/** userData/plugin-data/<id>: the plugin's writable state, never removed by an update. */
export function pluginDataDir(id: string): string { return join(process.env.LUCID_PLUGIN_DATA_DIR || join(dataRoot(), "plugin-data"), id); }
/** The attempt log the contract names: ~/.omp/lucid-plugins.jsonl. */
export function pluginLogPath(): string { return process.env.LUCID_PLUGIN_LOG_PATH || join(homedir(), ".omp", "lucid-plugins.jsonl"); }

export interface InstalledPlugin {
  manifest: PluginManifest;
  /** The installed package folder (read-only to the plugin: LUCID_PLUGIN_ROOT). */
  dir: string;
  installedAt: string;
  signed: boolean;
  keyId?: string;
}

interface CurrentPointer { id: string; version: string; installedAt: string; signed: boolean; keyId?: string }

/** The installed, current version of `id`, or null when absent or unreadable. Re-validates the manifest. */
export function readInstalled(id: string, root = pluginsRoot()): InstalledPlugin | null {
  if (!ID_RE.test(id)) return null;
  let ptr: CurrentPointer;
  try { ptr = JSON.parse(readFileSync(join(root, id, "current.json"), "utf8")) as CurrentPointer; } catch { return null; }
  if (!ptr || ptr.id !== id || typeof ptr.version !== "string") return null;
  const dir = join(root, id, ptr.version);
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(join(dir, PLUGIN_MANIFEST), "utf8")); } catch { return null; }
  const v = validatePluginManifest(raw, { requireFiles: true });
  if (!v.ok || v.manifest.id !== id || v.manifest.version !== ptr.version) return null;
  return { manifest: v.manifest, dir, installedAt: String(ptr.installedAt ?? ""), signed: !!ptr.signed, keyId: ptr.keyId };
}

export function listInstalled(root = pluginsRoot()): InstalledPlugin[] {
  let names: string[];
  try { names = readdirSync(root); } catch { return []; }
  return names.sort().map((n) => readInstalled(n, root)).filter((p): p is InstalledPlugin => !!p);
}

/** The installed LICENSE text (capped), so the card can show what the user accepted. */
export function readPluginLicense(id: string): { ok: boolean; id?: string; version?: string; text?: string; error?: string } {
  const p = readInstalled(id);
  if (!p) return { ok: false, error: "that plugin is not installed" };
  try { return { ok: true, id, version: p.manifest.version, text: readFileSync(join(p.dir, PLUGIN_LICENSE), "utf8").slice(0, 256 * 1024) }; }
  catch { return { ok: false, error: "the installed package has no readable LICENSE" }; }
}

export type InstallResult =
  | { ok: true; id: string; version: string; signed: boolean; keyId?: string }
  | { ok: false; gate: PluginGate; reason: string; logPath?: string };

export interface InstallDeps {
  fetchImpl?: typeof fetch;
  /** Trusted publisher keys; default: the key baked into this build. */
  trusted?: TrustedPackKey[];
  /** Fail-closed scan decision for one text slice; default: the shared KB scanner sidecar. */
  decide?: (text: string) => Promise<GateDecision>;
  authenticode?: AuthenticodeProbe;
  platform?: string;
  maxDownloadBytes?: number;
  /** The enterprise egress ceiling (default: managed config). A managed-denied host, or a host outside a
   *  restrictive managed allow-list, refuses the download, the same tighten-only rule as clampEgress. */
  managedEgress?: ManagedEgressPolicy;
  /** Called after every gate passed and before the version pointer moves (the runtime stops the plugin). */
  beforeSwitch?: (id: string) => Promise<void>;
  record?: (b: { tool: string; severity?: string; findings?: string; reason: string }) => void;
  root?: string;
}

/** Append one attempt to ~/.omp/lucid-plugins.jsonl. Never throws. The URL is logged without its query
 *  string: a signed download URL's signature is a credential. */
export function logPluginAttempt(entry: Record<string, unknown>): string {
  const path = pluginLogPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify({ at: new Date().toISOString(), platform: `${process.platform}-${process.arch}`, appVersion: process.env.LUCID_APP_VERSION, ...entry }) + "\n", "utf8");
  } catch { /* a diagnostic must never break the operation it describes */ }
  return path;
}

/** Is this download URL acceptable? https anywhere; plain http only to loopback under the explicit
 *  LUCID_PLUGIN_DEV_LOOPBACK=1 smoke switch. Returns a refusal reason or null. Pure apart from env. */
export function downloadUrlProblem(url: string): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return "not a valid URL"; }
  if (u.username || u.password) return "credentials in the URL are not allowed";
  if (u.protocol === "https:") return null;
  if (u.protocol === "http:" && process.env.LUCID_PLUGIN_DEV_LOOPBACK === "1" && (u.hostname === "127.0.0.1" || u.hostname === "localhost")) return null;
  return "plugin downloads must use https";
}

async function download(url: string, deps: InstallDeps): Promise<{ ok: true; bytes: Buffer } | { ok: false; reason: string }> {
  const cap = deps.maxDownloadBytes ?? MAX_DOWNLOAD_BYTES;
  let res: Response;
  try { res = await (deps.fetchImpl ?? fetch)(url, { redirect: "error", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) }); }
  catch (e) { return { ok: false, reason: `download failed: ${(e as Error).message}` }; }
  if (!res.ok) return { ok: false, reason: `download failed (${res.status})` };
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > cap) return { ok: false, reason: `package is ${declared} bytes, over the ${cap}-byte limit` };
  if (!res.body) return { ok: false, reason: "download returned no body" };
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > cap) { await reader.cancel().catch(() => {}); return { ok: false, reason: `package exceeds the ${cap}-byte limit` }; }
      chunks.push(value);
    }
  } catch (e) { return { ok: false, reason: `download interrupted: ${(e as Error).message}` }; }
  return { ok: true, bytes: Buffer.concat(chunks) };
}

/** Download a `.lplugin.zip` and install it through every gate. */
export async function installPluginFromUrl(url: string, expectId: string, deps: InstallDeps = {}): Promise<InstallResult> {
  const startedAt = Date.now();
  const source = url ? url.split("?")[0] : "(no url)";
  const fail = (gate: PluginGate, reason: string): InstallResult => {
    (deps.record ?? recordBlock)({ tool: "plugin_install", severity: "high", findings: gate, reason: `plugin "${expectId}" refused at the ${gate} gate: ${reason}` });
    return { ok: false, gate, reason, logPath: logPluginAttempt({ action: "install", source, expectId, ok: false, gate, reason, ms: Date.now() - startedAt }) };
  };
  if (!ID_RE.test(expectId)) return fail("manifest", "invalid plugin id");
  const problem = downloadUrlProblem(url);
  if (problem) return fail("download", problem);
  const host = extractHost(url) ?? "";
  const ceiling = deps.managedEgress ?? managedConfig().config?.security?.egress;
  const allowList = (ceiling?.allowedHosts ?? []).map((h) => h.trim().toLowerCase()).filter(Boolean);
  if ((ceiling?.deniedHosts ?? []).some((h) => h.trim().toLowerCase() === host) || (allowList.length && !allowList.includes(host))) {
    return fail("download", `your organization's network policy does not allow downloads from ${host}`);
  }
  const d = await download(url, deps);
  if (!d.ok) return fail("download", d.reason);
  const r = await installPluginBytes(d.bytes, expectId, deps);
  if (!r.ok) return fail(r.gate, r.reason);
  logPluginAttempt({ action: "install", source, expectId, ok: true, id: r.id, version: r.version, signed: r.signed, keyId: r.keyId, ms: Date.now() - startedAt });
  return r;
}

const TEXT_EXT = /\.(c?js|mjs|ts|tsx|jsx|json|html?|css|md|txt|py|svg|xml|ya?ml|toml|ini|cfg|sh|ps1|bat|cmd|map|csv|env|lock)$/i;

/** Text files the scanner reads: a known text extension, or an extension-less file (LICENSE, README)
 *  with no NUL byte. Binary payloads are covered by the hash and signature gates instead. */
export function isScannableText(name: string, data: Buffer): boolean {
  if (TEXT_EXT.test(name)) return true;
  const base = name.split("/").pop() ?? name;
  return !base.includes(".") && !data.subarray(0, 8192).includes(0);
}

async function scanPayload(payload: { name: string; data: Buffer }[], decide: (t: string) => Promise<GateDecision>): Promise<string | null> {
  for (const f of payload) {
    if (!isScannableText(f.name, f.data)) continue;
    const s = f.data.toString("utf8");
    for (let at = 0; at < s.length; at += SCAN_SLICE_CHARS) {
      let d: GateDecision;
      try { d = await decide(s.slice(at, at + SCAN_SLICE_CHARS)); }
      catch (e) { return `scanner unavailable: ${(e as Error).message}`; }
      if (d.block) return isScannerUnavailable(d.reason) ? `scanner unavailable: ${d.reason}` : `${f.name} flagged: ${d.reason}`;
    }
  }
  return null;
}

/** Install from package bytes (the download path and the tests share it). Does not log; the URL entry
 *  point owns the one log line per attempt. */
export async function installPluginBytes(bytes: Buffer, expectId: string, deps: InstallDeps = {}): Promise<InstallResult> {
  let entries: { name: string; data: Buffer }[];
  try { entries = readAllZipEntries(bytes, { maxTotalBytes: MAX_EXPANDED_BYTES }); }
  catch (e) { return { ok: false, gate: "manifest", reason: `not a valid .lplugin.zip: ${(e as Error).message}` }; }
  const check = verifyPluginEntries(entries, { expectId, trusted: deps.trusted ?? trustedPluginKeys() });
  if (!check.ok) return { ok: false, gate: check.gate, reason: check.reason };
  const { manifest, payload } = check;

  const root = deps.root ?? pluginsRoot();
  const pluginDir = join(root, manifest.id);
  const staging = join(pluginDir, `.staging-${randomBytes(6).toString("hex")}`);
  const cleanup = (): void => { try { rmSync(staging, { recursive: true, force: true }); } catch { /* best effort */ } };
  try {
    mkdirSync(staging, { recursive: true });
    const base = resolve(staging) + sep;
    for (const f of payload) {
      const abs = resolve(staging, f.name);
      if (!abs.startsWith(base)) { cleanup(); return { ok: false, gate: "manifest", reason: `unsafe path in package: ${f.name}` }; }
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, f.data);
    }
    writeFileSync(join(staging, PLUGIN_MANIFEST), canonicalPluginBytes(manifest));
    const sig = entries.find((e) => e.name === PLUGIN_SIGNATURE);
    if (sig) writeFileSync(join(staging, PLUGIN_SIGNATURE), sig.data);
  } catch (e) { cleanup(); return { ok: false, gate: "manifest", reason: `could not unpack: ${(e as Error).message}` }; }

  if (manifest.kind === "daemon" && (deps.platform ?? process.platform) === "win32") {
    const probe = deps.authenticode ?? probeAuthenticode;
    for (const f of payload) {
      if (!needsAuthenticode(f.name)) continue;
      const v = probe(join(staging, f.name));
      if (!v.ok) { cleanup(); return { ok: false, gate: "authenticode", reason: `${f.name}: ${v.reason}` }; }
    }
  }

  const flagged = await scanPayload(payload, deps.decide ?? ((t: string) => scanAndDecide(kbScanner(), t, DEFAULT_POLICY)));
  if (flagged) { cleanup(); return { ok: false, gate: "scan", reason: flagged }; }

  // Every gate passed. Stop a running copy, then move the version in and flip the pointer atomically.
  try {
    await deps.beforeSwitch?.(manifest.id);
    const target = join(pluginDir, manifest.version);
    let displaced: string | null = null;
    if (existsSync(target)) { displaced = join(pluginDir, `.old-${randomBytes(6).toString("hex")}`); renameSync(target, displaced); }
    renameSync(staging, target);
    const ptr: CurrentPointer = { id: manifest.id, version: manifest.version, installedAt: new Date().toISOString(), signed: check.signed, keyId: check.keyId };
    const tmp = join(pluginDir, `.current-${randomBytes(4).toString("hex")}.json`);
    writeFileSync(tmp, JSON.stringify(ptr, null, 2));
    renameSync(tmp, join(pluginDir, "current.json"));
    mkdirSync(pluginDataDir(manifest.id), { recursive: true });
    // Older versions and leftovers go; the data dir is elsewhere and untouched.
    for (const n of readdirSync(pluginDir)) {
      if (n === manifest.version || n === "current.json") continue;
      try { rmSync(join(pluginDir, n), { recursive: true, force: true }); } catch { /* a locked file on Windows: retried on the next install */ }
    }
    if (displaced) try { rmSync(displaced, { recursive: true, force: true }); } catch { /* already handled above */ }
  } catch (e) {
    cleanup();
    return { ok: false, gate: "manifest", reason: `install failed: ${(e as Error).message}` };
  }
  return { ok: true, id: manifest.id, version: manifest.version, signed: check.signed, keyId: check.keyId };
}

/** Remove the installed package. The data dir stays unless `keepData` is false. */
export function uninstallPlugin(id: string, keepData: boolean, root = pluginsRoot()): { ok: true } | { ok: false; error: string } {
  if (!ID_RE.test(id)) return { ok: false, error: "invalid plugin id" };
  const dir = join(root, id);
  if (!existsSync(dir)) return { ok: false, error: "that plugin is not installed" };
  try {
    rmSync(dir, { recursive: true, force: true });
    if (!keepData) rmSync(pluginDataDir(id), { recursive: true, force: true });
  } catch (e) { return { ok: false, error: `uninstall failed: ${(e as Error).message}` }; }
  logPluginAttempt({ action: "uninstall", id, keepData, ok: true });
  return { ok: true };
}
