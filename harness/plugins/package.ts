// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/plugins/package.ts - P-PLUGINS.2 (ADR-0462): the `.lplugin` package format, pure core.
//
// A plugin package is `<id>-<version>.lplugin.zip` holding `lucid-plugin.json` (schema 1), `LICENSE`, the
// payload, and `signature` (base64 Ed25519 over the CANONICAL manifest, which lists every payload file's
// SHA-256 in `files`). This module is the shared, testable core used by BOTH sides:
//   - tools/build_plugin.ts (the packer): validate the staged manifest, hash files, canonicalize, sign;
//   - desktop/plugins/install.ts (the installer): validate, check every hash, verify the signature.
// It does no I/O. The trust model is the KG Pack's (harness/kb/pack.ts) with one deliberate difference:
// a premium plugin is CODE that is sold, so an absent signature is a refusal, not "unsigned community".

import { sign as edSign, verify as edVerify, type KeyObject } from "node:crypto";
import { sha256Bytes, stableStringify, type TrustedPackKey } from "../kb/pack.ts";

export const PLUGIN_MANIFEST = "lucid-plugin.json";
export const PLUGIN_SIGNATURE = "signature";
export const PLUGIN_LICENSE = "LICENSE";
export const PLUGIN_SCHEMA = 1;

/** The only permissions a schema-1 manifest may declare. Unknown ones are refused (fail-closed), so a
 *  future capability cannot be smuggled in under a name this IDE does not enforce. */
export const PLUGIN_PERMISSIONS = ["network:loopback", "network:internet", "fs:plugin-data"] as const;
export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number];

/** CSP directives a web plugin may widen with exact https origins (and nothing else). */
export const PLUGIN_CSP_DIRECTIVES = ["img-src", "media-src", "connect-src"] as const;
export type PluginCspDirective = (typeof PLUGIN_CSP_DIRECTIVES)[number];

export type PluginKind = "web" | "server" | "daemon";
export type PluginTier = "premium" | "free";
export type PluginSection = "civilian" | "government";

export interface WebEntry { root: string; index: string }
export interface ServerEntry { main: string; healthPath: string }
export interface DaemonEntry { exe: string; args?: string[]; healthPath: string }

export interface PluginManifest {
  schema: 1;
  id: string;
  name: string;
  version: string;
  publisher: string;
  license: string;
  tier: PluginTier;
  section: PluginSection;
  kind: PluginKind;
  entry: WebEntry | ServerEntry | DaemonEntry;
  mcp?: { command: string; args?: string[] };
  ai?: { provider: "lucid" };
  permissions?: PluginPermission[];
  csp?: Partial<Record<PluginCspDirective, string[]>>;
  /** path (forward slashes, relative to the package root) -> lowercase hex sha256. Written by the packer. */
  files?: Record<string, string>;
  [extra: string]: unknown;
}

export type ManifestCheck = { ok: true; manifest: PluginManifest } | { ok: false; reason: string };

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const VERSION_RE = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,40})?$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/** Is `p` a safe package-relative path? Forward slashes only, no absolute/drive/UNC form, no `.`/`..`
 *  segment, no `:` (NTFS alternate streams), no control characters, no segment Windows would silently
 *  rewrite (trailing dot or space) or treat as a device. Pure; the zip and the manifest both go through it. */
export function safeRelPath(p: unknown): p is string {
  if (typeof p !== "string" || !p || p.length > 400) return false;
  if (/[\u0000-\u001f\u007f\\:*?"<>|]/.test(p)) return false;
  if (p.startsWith("/")) return false;
  for (const seg of p.split("/")) {
    if (!seg || seg === "." || seg === "..") return false;
    if (seg.endsWith(".") || seg.endsWith(" ")) return false;
    if (WIN_RESERVED.test(seg)) return false;
  }
  return true;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max = 200): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= max;
const strArray = (v: unknown, maxItems: number, maxLen: number): v is string[] =>
  Array.isArray(v) && v.length <= maxItems && v.every((x) => typeof x === "string" && x.length <= maxLen && !/[\u0000]/.test(x));

/** An exact https origin (`https://host[:port]`, nothing after it), the only CSP widening allowed. */
function httpsOrigin(v: unknown): boolean {
  if (typeof v !== "string") return false;
  try { const u = new URL(v); return u.protocol === "https:" && u.origin === v && !u.username && !u.password; } catch { return false; }
}

/**
 * Validate a schema-1 manifest. `requireFiles` is true at install (the packer's `files` map must be
 * present and complete) and false for a staged manifest (the packer adds `files`). Pure; the reason
 * names the first problem so a packaging agent can fix it without guessing.
 */
export function validatePluginManifest(raw: unknown, opts: { requireFiles: boolean }): ManifestCheck {
  const bad = (reason: string): ManifestCheck => ({ ok: false, reason });
  if (!isObj(raw)) return bad("manifest is not a JSON object");
  const m = raw;
  if (m.schema !== PLUGIN_SCHEMA) return bad(`schema must be ${PLUGIN_SCHEMA}`);
  if (typeof m.id !== "string" || !ID_RE.test(m.id)) return bad("id must be lowercase letters, digits and dashes (max 64)");
  if (!text(m.name)) return bad("name is required");
  if (typeof m.version !== "string" || !VERSION_RE.test(m.version)) return bad("version must be MAJOR.MINOR.PATCH");
  if (!text(m.publisher)) return bad("publisher is required");
  if (!text(m.license)) return bad("license is required");
  if (m.tier !== "premium" && m.tier !== "free") return bad("tier must be premium or free");
  if (m.section !== "civilian" && m.section !== "government") return bad("section must be civilian or government");
  if (m.kind !== "web" && m.kind !== "server" && m.kind !== "daemon") return bad("kind must be web, server or daemon");
  if (!isObj(m.entry)) return bad("entry is required");
  const e = m.entry;
  const healthOk = (h: unknown) => typeof h === "string" && h.startsWith("/") && h.length <= 200 && !/[\s#]/.test(h);
  const entryFiles: string[] = [];
  if (m.kind === "web") {
    if (!safeRelPath(e.root)) return bad("entry.root must be a safe relative folder");
    if (!safeRelPath(e.index)) return bad("entry.index must be a safe relative path");
    entryFiles.push(`${e.root}/${e.index}`);
  } else if (m.kind === "server") {
    if (!safeRelPath(e.main)) return bad("entry.main must be a safe relative path");
    if (!healthOk(e.healthPath)) return bad("entry.healthPath must be a path starting with /");
    entryFiles.push(e.main);
  } else {
    if (!safeRelPath(e.exe)) return bad("entry.exe must be a safe relative path");
    if (e.args !== undefined && !strArray(e.args, 64, 1024)) return bad("entry.args must be an array of strings");
    if (!healthOk(e.healthPath)) return bad("entry.healthPath must be a path starting with /");
    entryFiles.push(e.exe);
  }
  if (m.mcp !== undefined) {
    if (!isObj(m.mcp)) return bad("mcp must be an object");
    const c = m.mcp.command;
    if (c !== "node" && !safeRelPath(c)) return bad('mcp.command must be "node" or a relative path inside the package');
    if (m.mcp.args !== undefined && !strArray(m.mcp.args, 64, 1024)) return bad("mcp.args must be an array of strings");
    if (c !== "node") entryFiles.push(c as string);
  }
  if (m.ai !== undefined && !(isObj(m.ai) && m.ai.provider === "lucid" && Object.keys(m.ai).length === 1)) {
    return bad('ai, when present, must be { "provider": "lucid" }');
  }
  const perms = m.permissions ?? [];
  if (!Array.isArray(perms) || !perms.every((p) => (PLUGIN_PERMISSIONS as readonly unknown[]).includes(p))) {
    return bad(`permissions may only contain ${PLUGIN_PERMISSIONS.join(", ")}`);
  }
  if (m.csp !== undefined) {
    if (m.kind !== "web") return bad("csp applies to web plugins only");
    if (!isObj(m.csp)) return bad("csp must be an object");
    for (const [k, v] of Object.entries(m.csp)) {
      if (!(PLUGIN_CSP_DIRECTIVES as readonly string[]).includes(k)) return bad(`csp may only widen ${PLUGIN_CSP_DIRECTIVES.join(", ")}`);
      if (!Array.isArray(v) || v.length > 16 || !v.every(httpsOrigin)) return bad(`csp.${k} must list exact https origins`);
    }
    if (Object.keys(m.csp).length && !perms.includes("network:internet")) return bad('csp origins require the "network:internet" permission');
  }
  if (opts.requireFiles) {
    if (!isObj(m.files)) return bad("files is missing (the package was not built by tools/build_plugin.ts)");
    const lower = new Set<string>();
    for (const [p, h] of Object.entries(m.files)) {
      if (!safeRelPath(p)) return bad(`unsafe path in files: ${JSON.stringify(p)}`);
      if (p === PLUGIN_MANIFEST || p === PLUGIN_SIGNATURE) return bad(`files must not list ${p}`);
      if (typeof h !== "string" || !SHA_RE.test(h)) return bad(`files["${p}"] is not a sha256`);
      const k = p.toLowerCase();
      if (lower.has(k)) return bad(`files lists ${p} twice (case-insensitively)`);
      lower.add(k);
    }
    if (!(PLUGIN_LICENSE in m.files)) return bad("the package has no LICENSE");
    for (const f of entryFiles) if (!(f in m.files)) return bad(`entry file ${f} is not in the package`);
  }
  return { ok: true, manifest: m as unknown as PluginManifest };
}

/** The SIGNED payload: the manifest (including `files`) with recursively sorted keys. The signature is a
 *  separate file, so nothing is stripped; re-deriving after a JSON round-trip yields the same bytes. */
export function canonicalPluginBytes(m: PluginManifest): Buffer {
  return Buffer.from(stableStringify(m), "utf8");
}

/** base64 Ed25519 signature over the canonical manifest. Packer-side only. */
export function signPluginManifest(m: PluginManifest, privateKey: KeyObject): string {
  return edSign(null, canonicalPluginBytes(m), privateKey).toString("base64");
}

/** Verify a base64 signature against the trusted publisher keys. FAIL-CLOSED: empty, malformed, no keys,
 *  or no match is `ok: false`. */
export function verifyPluginSignature(m: PluginManifest, sigB64: string, trusted: TrustedPackKey[]): { ok: boolean; keyId?: string; reason: string } {
  const sig = sigB64.trim();
  if (!sig) return { ok: false, reason: "the signature file is empty" };
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(sig)) return { ok: false, reason: "the signature is not base64" };
  if (!trusted.length) return { ok: false, reason: "no trusted plugin publisher key is built into this IDE" };
  const data = canonicalPluginBytes(m);
  const raw = Buffer.from(sig, "base64");
  for (const k of trusted) {
    try { if (edVerify(null, data, k.key, raw)) return { ok: true, keyId: k.id, reason: "verified" }; }
    catch { /* wrong key type for this entry: try the next */ }
  }
  return { ok: false, reason: "the signature does not match the LUCID plugin publisher key" };
}

export type PluginGate = "manifest" | "hash" | "signature" | "authenticode" | "scan" | "download";

export type PackageCheck =
  | { ok: true; manifest: PluginManifest; payload: { name: string; data: Buffer }[]; signed: boolean; keyId?: string }
  | { ok: false; gate: PluginGate; reason: string; manifest?: PluginManifest };

/**
 * The package gates that need no disk and no OS: manifest schema, path safety, every file's hash (and no
 * file missing or unlisted), then the signature (REQUIRED for premium; when present on a free plugin it
 * must still verify). `expectId` is the catalog id the user clicked, so a valid package for a DIFFERENT
 * plugin cannot ride a purchase. Pure.
 */
export function verifyPluginEntries(entries: { name: string; data: Buffer }[], opts: { expectId: string; trusted: TrustedPackKey[] }): PackageCheck {
  const seen = new Set<string>();
  for (const e of entries) {
    if (!safeRelPath(e.name)) return { ok: false, gate: "manifest", reason: `unsafe path in package: ${JSON.stringify(e.name)}` };
    const k = e.name.toLowerCase();
    if (seen.has(k)) return { ok: false, gate: "manifest", reason: `duplicate path in package: ${e.name}` };
    seen.add(k);
  }
  const manEntry = entries.find((e) => e.name === PLUGIN_MANIFEST);
  if (!manEntry) return { ok: false, gate: "manifest", reason: `the package has no ${PLUGIN_MANIFEST} at its root` };
  let raw: unknown;
  try { raw = JSON.parse(manEntry.data.toString("utf8")); } catch { return { ok: false, gate: "manifest", reason: `${PLUGIN_MANIFEST} is not valid JSON` }; }
  const v = validatePluginManifest(raw, { requireFiles: true });
  if (!v.ok) return { ok: false, gate: "manifest", reason: v.reason };
  const manifest = v.manifest;
  if (manifest.id !== opts.expectId) return { ok: false, gate: "manifest", reason: `package id "${manifest.id}" does not match the requested plugin "${opts.expectId}"`, manifest };

  const files = manifest.files!;
  const payload = entries.filter((e) => e.name !== PLUGIN_MANIFEST && e.name !== PLUGIN_SIGNATURE);
  for (const e of payload) {
    const want = files[e.name];
    if (!want) return { ok: false, gate: "hash", reason: `${e.name} is in the package but not in the signed file list`, manifest };
    if (sha256Bytes(e.data) !== want) return { ok: false, gate: "hash", reason: `${e.name} does not match its sha256 (tampered or corrupt)`, manifest };
  }
  const present = new Set(payload.map((e) => e.name));
  for (const p of Object.keys(files)) if (!present.has(p)) return { ok: false, gate: "hash", reason: `${p} is listed but missing from the package`, manifest };

  const sigEntry = entries.find((e) => e.name === PLUGIN_SIGNATURE);
  if (!sigEntry) {
    if (manifest.tier === "premium") return { ok: false, gate: "signature", reason: "premium plugins must be signed; this package has no signature", manifest };
    return { ok: true, manifest, payload, signed: false };
  }
  const s = verifyPluginSignature(manifest, sigEntry.data.toString("utf8"), opts.trusted);
  if (!s.ok) return { ok: false, gate: "signature", reason: s.reason, manifest };
  return { ok: true, manifest, payload, signed: true, keyId: s.keyId };
}
