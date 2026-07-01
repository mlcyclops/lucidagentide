// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/network_whitelist.ts
//
// P-NETWL.1 (ADR-0106): a user-authored network WHITELIST that sits on top of the per-website egress gate
// (P-EGRESS.1, egress_policy.ts). Where egress_policy remembers ad-hoc "always allow this host" choices,
// this is the deliberate, structured allow-list the user (or an admin, later) curates:
//
//   - separate INTERNAL (intranet) and EXTERNAL (internet) zones,
//   - TLD-level (`*.com`) and sub-level exact (`api.example.com`) domain patterns,
//   - optional IP / CIDR ranges (`10.0.0.0/8`, `192.168.1.5`),
//   - a per-entry TRUST SCOPE (`always` | `project` | `loop`) mirroring how tool-call approvals scope,
//   - an optional per-loop CALL BUDGET, and
//   - an optional AUTH reference (JWT/OAuth/SAML/PEM/API-key/basic) whose SECRET lives OS-encrypted in the
//     credential vault (cred_vault.ts) - this entry only ever holds an opaque `vaultRef`, never the secret.
//
// This file is PURE + self-contained (matching + verdict + a thin JSON persistence). It imports nothing
// from egress_policy so egress_policy can import IT with no cycle. It runs in the Bun backend (dev.ts /
// acp_backend.ts) alongside egress_policy; the SECRET side (cred_vault.ts) lives in the Electron main.
//
// FAIL-CLOSED is the invariant: this layer can only ever GRANT an auto-allow. Any malformed entry, parse
// error, or unmatched target yields "no whitelist match", and the call falls through to the normal egress
// prompt. No path here can turn a would-be prompt into a block being skipped for the wrong reason.
//
// SCOPE OF P-NETWL.1: only the `always` scope is ENFORCED here. `project` and `loop` entries are stored and
// round-tripped (so the schema is frozen once) but are NOT yet granted by whitelistMatch - they land with
// the Settings UI (P-NETWL.2) and the Goal Loop (P-NETWL.3). The call budget is likewise recorded now and
// enforced by the loop later. Recognizing them now keeps the on-disk schema stable across those increments.

import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const FILE = join(homedir(), ".omp", "lucid-whitelist.json");

/** Bump only via a migration-aware load (never edit an entry shape in place). */
export const WHITELIST_SCHEMA_VERSION = 1;

/** Trust scopes are a CLOSED set. Only `always` is enforced in P-NETWL.1. */
export const TRUST_SCOPES = ["always", "project", "loop"] as const;
export type TrustScope = (typeof TRUST_SCOPES)[number];

/** The auth kinds a whitelisted endpoint may require. The secret itself never lives here. */
export const AUTH_KINDS = ["jwt", "oauth", "saml", "pem", "apikey", "basic"] as const;
export type AuthKind = (typeof AUTH_KINDS)[number];

/** intranet vs internet - the user keeps these as separate lists in the UI. */
export const NET_ZONES = ["internal", "external"] as const;
export type NetZone = (typeof NET_ZONES)[number];

export type EntryKind = "domain" | "ip";

/** A reference to a secret in the OS-encrypted credential vault (cred_vault.ts). Non-secret metadata only. */
export interface AuthRef {
  kind: AuthKind;
  vaultRef: string;      // opaque id into the encrypted vault; NEVER the secret bytes
  username?: string;     // non-secret: basic-auth user, or an API-key label
  header?: string;       // non-secret: header name for apikey (e.g. "X-API-Key")
  note?: string;
}

export interface WhitelistEntry {
  id: string;                  // stable id (minted once, never regenerated)
  kind: EntryKind;             // "domain" (pattern) | "ip" (single IP or CIDR)
  pattern: string;             // normalized domain pattern, or an IP / CIDR string
  zone: NetZone;               // internal (intranet) | external (internet)
  scope: TrustScope;           // always | project | loop  (only "always" enforced in .1)
  project?: string | null;     // workspace path this applies to when scope === "project"
  callBudget?: number | null;  // max calls to this host per loop (enforced by the loop, P-NETWL.3)
  auth?: AuthRef | null;
  addedAt?: number;
}

export interface WhitelistStore {
  version: number;
  entries: WhitelistEntry[];
}

/** Context for a verdict (the current project / whether we're inside a goal loop). Reserved for the
 *  `project` / `loop` scopes that P-NETWL.2/.3 will enforce; unused by the `always`-only path today. */
export interface WhitelistContext {
  project?: string | null;
  loop?: boolean;
}

export const emptyStore = (): WhitelistStore => ({ version: WHITELIST_SCHEMA_VERSION, entries: [] });

// ── host / ip primitives (self-contained; egress_policy has its own extractHost) ─────────────────────

/** Lowercase host of a URL or a bare host, port stripped; null if nothing host-like. */
export function normalizeHost(target: string): string | null {
  if (!target) return null;
  const t = target.trim();
  try {
    const h = new URL(t).hostname.toLowerCase();
    return stripBrackets(h) || null;
  } catch {
    const m = /^(?:[a-z][a-z0-9+.-]*:\/\/)?([^/:\s]+)/i.exec(t);
    return m ? stripBrackets(m[1]!.toLowerCase()) : null;
  }
}
const stripBrackets = (h: string): string => h.replace(/^\[/, "").replace(/\]$/, "");

/** True for a dotted-quad IPv4 literal (each octet 0-255). */
export function isIpv4(host: string): boolean {
  return ipv4ToInt(host) !== null;
}

/** IPv4 string → uint32, or null if not a valid dotted quad. */
export function ipv4ToInt(ip: string): number | null {
  const parts = ip.trim().split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}

/** Does `host` fall inside a single IP or an IPv4 CIDR (`10.0.0.0/8`)? Pure, IPv4-only for now. */
export function matchIp(pattern: string, host: string): boolean {
  const hostInt = ipv4ToInt(host);
  if (hostInt === null) return false;
  const p = pattern.trim();
  const slash = p.indexOf("/");
  if (slash < 0) {
    const patInt = ipv4ToInt(p);
    return patInt !== null && patInt === hostInt;
  }
  const base = ipv4ToInt(p.slice(0, slash));
  const bitsRaw = Number(p.slice(slash + 1));
  if (base === null || !Number.isInteger(bitsRaw) || bitsRaw < 0 || bitsRaw > 32) return false;
  if (bitsRaw === 0) return true; // /0 = everything
  const mask = (0xffffffff << (32 - bitsRaw)) >>> 0;
  return (base & mask) === (hostInt & mask);
}

/** Does `host` match a domain pattern? `*.example.com` matches example.com and any subdomain; an exact
 *  pattern matches only itself. Case-insensitive; a leading dot is tolerated. */
export function matchDomain(pattern: string, host: string): boolean {
  const pat = pattern.trim().toLowerCase().replace(/^\./, "");
  const h = host.trim().toLowerCase();
  if (!pat || !h) return false;
  if (pat.startsWith("*.")) {
    const suffix = pat.slice(2);
    if (!suffix) return false;
    return h === suffix || h.endsWith("." + suffix);
  }
  return h === pat;
}

// ── verdict (the load-bearing, fail-closed grant) ───────────────────────────────────────────────────

/** Pure: does the whitelist AUTO-ALLOW this target, and via which entry? Returns the matching entry or
 *  null. P-NETWL.1 enforces ONLY scope `always`; `project`/`loop` are recognized but not yet granted.
 *  Fail-closed: a malformed entry is skipped, never granted. */
export function whitelistMatch(store: WhitelistStore | null | undefined, target: string, _ctx: WhitelistContext = {}): WhitelistEntry | null {
  const host = normalizeHost(target);
  if (!host) return null;
  const entries = store?.entries;
  if (!Array.isArray(entries)) return null;
  for (const e of entries) {
    try {
      if (!e || typeof e !== "object" || typeof e.pattern !== "string") continue;
      if (e.scope !== "always") continue; // only `always` enforced in P-NETWL.1
      const ok = e.kind === "ip" ? matchIp(e.pattern, host) : matchDomain(e.pattern, host);
      if (ok) return e;
    } catch { /* fail-closed: a bad entry never grants access */ }
  }
  return null;
}

/** Thin verdict wrapper. */
export function whitelistVerdict(store: WhitelistStore | null | undefined, target: string, ctx: WhitelistContext = {}): "allow" | "none" {
  return whitelistMatch(store, target, ctx) ? "allow" : "none";
}

// ── pure store edits ─────────────────────────────────────────────────────────────────────────────────

/** Coerce arbitrary parsed JSON into a valid store, dropping any entry that can't be validated. A dropped
 *  entry means "not whitelisted" (fail-closed) - never a silent widening. */
export function sanitizeStore(raw: unknown): WhitelistStore {
  const r = (raw ?? {}) as { entries?: unknown };
  const out: WhitelistEntry[] = [];
  if (Array.isArray(r.entries)) {
    for (const e of r.entries) {
      const v = sanitizeEntry(e);
      if (v) out.push(v);
    }
  }
  return { version: WHITELIST_SCHEMA_VERSION, entries: out };
}

function sanitizeEntry(e: unknown): WhitelistEntry | null {
  if (!e || typeof e !== "object") return null;
  const o = e as Record<string, unknown>;
  const id = typeof o.id === "string" && o.id ? o.id : null;
  const pattern = typeof o.pattern === "string" ? o.pattern.trim() : "";
  const kind: EntryKind = o.kind === "ip" ? "ip" : "domain";
  const zone: NetZone = o.zone === "internal" ? "internal" : "external";
  const scope: TrustScope = (TRUST_SCOPES as readonly string[]).includes(o.scope as string) ? (o.scope as TrustScope) : "always";
  if (!id || !pattern) return null;
  const entry: WhitelistEntry = { id, kind, pattern, zone, scope };
  if (typeof o.project === "string") entry.project = o.project;
  if (typeof o.callBudget === "number" && Number.isFinite(o.callBudget) && o.callBudget >= 0) entry.callBudget = Math.floor(o.callBudget);
  if (typeof o.addedAt === "number") entry.addedAt = o.addedAt;
  const auth = sanitizeAuth(o.auth);
  if (auth) entry.auth = auth;
  return entry;
}

function sanitizeAuth(a: unknown): AuthRef | null {
  if (!a || typeof a !== "object") return null;
  const o = a as Record<string, unknown>;
  if (!(AUTH_KINDS as readonly string[]).includes(o.kind as string)) return null;
  if (typeof o.vaultRef !== "string" || !o.vaultRef) return null;
  const ref: AuthRef = { kind: o.kind as AuthKind, vaultRef: o.vaultRef };
  if (typeof o.username === "string") ref.username = o.username;
  if (typeof o.header === "string") ref.header = o.header;
  if (typeof o.note === "string") ref.note = o.note;
  return ref;
}

/** Add or replace an entry by id. Pure - returns a NEW store, never mutates. */
export function upsertEntry(store: WhitelistStore, entry: WhitelistEntry): WhitelistStore {
  const clean = sanitizeEntry(entry);
  if (!clean) return { version: WHITELIST_SCHEMA_VERSION, entries: [...(store.entries ?? [])] };
  const rest = (store.entries ?? []).filter((e) => e.id !== clean.id);
  return { version: WHITELIST_SCHEMA_VERSION, entries: [...rest, clean] };
}

/** Remove an entry by id. Pure. */
export function removeEntry(store: WhitelistStore, id: string): WhitelistStore {
  return { version: WHITELIST_SCHEMA_VERSION, entries: (store.entries ?? []).filter((e) => e.id !== id) };
}

// ── thin persistence (machine-level, like egress_policy / settings) ──────────────────────────────────

export function loadWhitelist(): WhitelistStore {
  try {
    if (!existsSync(FILE)) return emptyStore();
    return sanitizeStore(JSON.parse(readFileSync(FILE, "utf8")));
  } catch { return emptyStore(); }
}

export function saveWhitelist(store: WhitelistStore): void {
  try {
    writeFileSync(FILE, JSON.stringify(sanitizeStore(store), null, 2), "utf8");
    chmodSync(FILE, 0o600); // user-only; the config isn't secret but there's no reason to widen it
  } catch { /* best-effort; never break a turn */ }
}
