// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/creator/creator_endpoint.ts - the portable Creator endpoint contract (lucid-creator-endpoint v1).
//
// The DGX Loader runs three Creator services on a DGX box (dgx-avatar on 8088, dgx-cad on 8089, dgx-vision on
// 8090, all bound to 127.0.0.1 on the box) and EXPORTS how to reach them as this JSON, dropped into the same-machine mailbox
// <personal dir>/creator_endpoints/<id>.json. LUCID imports it as a Creator endpoint declaration attested as
// a DGX enclave host, which is what lets it through the CUI lockdown. This module is the LUCID-side source of
// truth for the shape and mirrors harness/voice/voice_endpoint.ts exactly in posture:
//   - unknown kind/version/provider is rejected, never guessed at;
//   - NO SECRETS may ride the file: a credential-like key anywhere, or a userinfo URL, rejects it outright;
//   - ids are slug-guarded so an import can never write outside its own name;
//   - the enclave block is REQUIRED: the import is an attestation, and a file without one attests nothing.

import type { VoiceEndpointTransport } from "../voice/voice_endpoint.ts";

export type CreatorEndpointProvider = "dgx-avatar" | "dgx-cad" | "dgx-vision";
export const CREATOR_ENDPOINT_PROVIDERS: readonly CreatorEndpointProvider[] = ["dgx-avatar", "dgx-cad", "dgx-vision"] as const;
const isEndpointProvider = (v: unknown): v is CreatorEndpointProvider =>
  typeof v === "string" && (CREATOR_ENDPOINT_PROVIDERS as readonly string[]).includes(v);

export interface CreatorEndpointEnclave {
  kind: "dgx";
  /** The DGX box the service runs on (display and audit data; LUCID dials `url`, never this). */
  host: string;
}

export interface CreatorEndpointConfig {
  kind: "lucid-creator-endpoint";
  version: 1;
  /** Stable slug, [a-z0-9-], 1-64 chars. Doubles as the mailbox filename stem. */
  id: string;
  label: string;
  provider: CreatorEndpointProvider;
  /** Base URL LUCID calls (the tunnel mouth, e.g. http://127.0.0.1:8088). */
  url: string;
  enclave: CreatorEndpointEnclave;
  /** Same shape as the voice endpoint's transport. Informational only: LUCID never executes the command. */
  transport?: VoiceEndpointTransport;
  exportedAt?: number;
  source?: string;
}

export type CreatorEndpointParse = { ok: true; config: CreatorEndpointConfig } | { ok: false; reason: string };

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Same credential-key screen as the voice endpoint contract (contract section 3). */
const SECRET_KEY_RE = /token|secret|password|passwd|apikey|api_key|bearer|credential|private/i;
/** A hostname or IP literal: no scheme, no userinfo, no path, no whitespace. */
const HOST_RE = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?)$/;

/** Validate an untrusted parsed-JSON payload into a CreatorEndpointConfig. Fail-closed and specific: every
 *  rejection names what is wrong so the import report can show it verbatim. */
export function parseCreatorEndpointConfig(raw: unknown): CreatorEndpointParse {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "not a JSON object" };
  for (const key of collectKeys(raw)) {
    if (SECRET_KEY_RE.test(key)) return { ok: false, reason: `refusing a config carrying a credential-like field ("${key}") - secrets never travel in endpoint exports` };
  }
  if (!("kind" in raw) || raw.kind !== "lucid-creator-endpoint") return { ok: false, reason: "not a lucid-creator-endpoint file" };
  if (!("version" in raw) || raw.version !== 1) return { ok: false, reason: `unsupported version (${"version" in raw ? String(raw.version) : "missing"}) - this LUCID understands version 1` };
  if (!("id" in raw) || typeof raw.id !== "string" || !SLUG_RE.test(raw.id)) return { ok: false, reason: "id must be a 1-64 char lowercase slug (a-z, 0-9, hyphen)" };
  if (!("label" in raw) || typeof raw.label !== "string" || !raw.label.trim() || raw.label.length > 80) return { ok: false, reason: "label must be a non-empty string (max 80 chars)" };
  if (!("provider" in raw) || !isEndpointProvider(raw.provider)) {
    return { ok: false, reason: `unsupported provider (${"provider" in raw ? String(raw.provider).slice(0, 40) : "missing"}) - this LUCID imports ${CREATOR_ENDPOINT_PROVIDERS.join(", ")} endpoints` };
  }
  const provider: CreatorEndpointProvider = raw.provider;
  if (!("url" in raw) || typeof raw.url !== "string") return { ok: false, reason: "url is required" };
  let url: URL;
  try { url = new URL(raw.url); } catch { return { ok: false, reason: `url does not parse (${raw.url.slice(0, 80)})` }; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, reason: `url must be http(s), got ${url.protocol}` };
  if (url.username || url.password) return { ok: false, reason: "url must not embed credentials - secrets never travel in endpoint exports" };
  if (url.search || url.hash) return { ok: false, reason: "url must be a bare base URL (no query string or fragment)" };

  if (!("enclave" in raw) || !raw.enclave || typeof raw.enclave !== "object" || Array.isArray(raw.enclave)) {
    return { ok: false, reason: "enclave is required: a creator endpoint import attests a DGX enclave host" };
  }
  const enc = raw.enclave;
  if (!("kind" in enc) || enc.kind !== "dgx") return { ok: false, reason: "enclave.kind must be \"dgx\"" };
  if (!("host" in enc) || typeof enc.host !== "string" || !HOST_RE.test(enc.host.trim())) return { ok: false, reason: "enclave.host must be a hostname or IP address" };
  const host = enc.host.trim();

  const source = "source" in raw && typeof raw.source === "string" ? raw.source.slice(0, 80) : undefined;
  const exportedAt = "exportedAt" in raw && typeof raw.exportedAt === "number" && Number.isFinite(raw.exportedAt) ? raw.exportedAt : undefined;
  let transport: VoiceEndpointTransport | undefined;
  if ("transport" in raw && raw.transport && typeof raw.transport === "object") {
    const t = raw.transport;
    const kind = "kind" in t && (t.kind === "direct" || t.kind === "ssh-forward" || t.kind === "https-proxy") ? t.kind : "direct";
    transport = {
      kind,
      ...("command" in t && typeof t.command === "string" && t.command.trim() ? { command: t.command.trim().slice(0, 500) } : {}),
      ...("note" in t && typeof t.note === "string" && t.note.trim() ? { note: t.note.trim().slice(0, 300) } : {}),
    };
  }
  return {
    ok: true,
    config: {
      kind: "lucid-creator-endpoint",
      version: 1,
      id: raw.id,
      label: raw.label.trim(),
      provider,
      url: `${url.origin}${url.pathname.replace(/\/+$/, "")}`,
      enclave: { kind: "dgx", host },
      ...(transport ? { transport } : {}),
      ...(exportedAt !== undefined ? { exportedAt } : {}),
      ...(source ? { source } : {}),
    },
  };
}

/** Every key at every depth of a parsed-JSON value (arrays descended, cycles impossible in JSON). */
function collectKeys(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) { for (const v of value) collectKeys(v, out); return out; }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) { out.push(k); collectKeys(v, out); }
  }
  return out;
}
