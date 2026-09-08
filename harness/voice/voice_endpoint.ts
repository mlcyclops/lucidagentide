// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/voice/voice_endpoint.ts - P-VOICE.7: the portable voice-endpoint config contract.
//
// A self-hosted TTS endpoint (a dots.tts service on a DGX, today; anything OpenAI-speech-shaped,
// tomorrow) is ENVIRONMENT data, not code: host, port, tunnel recipe, model. Hardcoding one box's
// name anywhere is exactly the bug this file removes. The DGX Loader EXPORTS this JSON (one-click
// into ~/.omp/voice_endpoints/ for same-machine handoff, or a save-file for transfer); LUCID imports
// it (auto-scan of the handoff dir, or manual upload) and the endpoint becomes a labeled, selectable
// row in Settings > Voice. The contract is versioned and fail-closed:
//   - unknown kind/version is rejected, never guessed at;
//   - NO SECRETS may ride the file: userinfo URLs and token-ish keys are rejected outright
//     (credentials belong in the vault / server-side config, never in a shareable export);
//   - ids are slug-guarded so an import can never write outside its own name.
//
// The DGX Loader repo documents its half in docs/adr/0017 (export builder + buttons); this module
// is the LUCID-side source of truth for the shape.

export interface VoiceEndpointTransport {
  kind: "direct" | "ssh-forward" | "https-proxy";
  /** The tunnel recipe to reproduce reachability (e.g. an `ssh -L` command). Informational only:
   *  LUCID shows it when the endpoint is down; it NEVER executes it. */
  command?: string;
  note?: string;
}

export interface VoiceEndpointConfig {
  kind: "lucid-voice-endpoint";
  version: 1;
  /** Stable slug, [a-z0-9-], 1-64 chars. Doubles as the handoff filename stem. */
  id: string;
  /** Human label ("Nick DGX", "Lab Spark 2") - display data, never code. */
  label: string;
  /** The engine this endpoint serves. Only dots-tts today; the field exists so tomorrow's engines
   *  don't need a version bump. */
  engine: "dots-tts";
  /** Base URL LUCID calls (the tunnel/proxy mouth, e.g. http://127.0.0.1:8084). */
  url: string;
  /** Model checkpoint the service loads; defaults to the dots.tts soar checkpoint when omitted. */
  model?: string;
  transport?: VoiceEndpointTransport;
  exportedAt?: number;
  /** Which tool wrote the file (e.g. "dgx-loader 1.2.1"). */
  source?: string;
}

export type EndpointParse = { ok: true; config: VoiceEndpointConfig } | { ok: false; reason: string };

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** JSON keys that smell like credentials. A config carrying ANY of these is rejected wholesale -
 *  the correct place for a token is the vault, and a shareable file must never tempt otherwise. */
const SECRET_KEY_RE = /token|secret|password|passwd|apikey|api_key|bearer|credential|private/i;

/** Validate an untrusted parsed-JSON payload into a VoiceEndpointConfig. Fail-closed and specific:
 *  every rejection names what is wrong so the import UI can show it verbatim. */
export function parseVoiceEndpointConfig(raw: unknown): EndpointParse {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "not a JSON object" };
  for (const key of collectKeys(raw)) {
    if (SECRET_KEY_RE.test(key)) return { ok: false, reason: `refusing a config carrying a credential-like field ("${key}") - secrets never travel in endpoint exports` };
  }
  if (!("kind" in raw) || raw.kind !== "lucid-voice-endpoint") return { ok: false, reason: "not a lucid-voice-endpoint file" };
  if (!("version" in raw) || raw.version !== 1) return { ok: false, reason: `unsupported version (${"version" in raw ? String(raw.version) : "missing"}) - this LUCID understands version 1` };
  if (!("id" in raw) || typeof raw.id !== "string" || !SLUG_RE.test(raw.id)) return { ok: false, reason: "id must be a 1-64 char lowercase slug (a-z, 0-9, hyphen)" };
  if (!("label" in raw) || typeof raw.label !== "string" || !raw.label.trim() || raw.label.length > 80) return { ok: false, reason: "label must be a non-empty string (max 80 chars)" };
  if (!("engine" in raw) || raw.engine !== "dots-tts") return { ok: false, reason: `unsupported engine (${"engine" in raw ? String(raw.engine) : "missing"}) - this LUCID speaks dots-tts endpoints` };
  if (!("url" in raw) || typeof raw.url !== "string") return { ok: false, reason: "url is required" };
  let url: URL;
  try { url = new URL(raw.url); } catch { return { ok: false, reason: `url does not parse (${raw.url.slice(0, 80)})` }; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, reason: `url must be http(s), got ${url.protocol}` };
  if (url.username || url.password) return { ok: false, reason: "url must not embed credentials - secrets never travel in endpoint exports" };

  const model = "model" in raw && typeof raw.model === "string" && raw.model.trim() ? raw.model.trim().slice(0, 120) : undefined;
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
      kind: "lucid-voice-endpoint",
      version: 1,
      id: raw.id,
      label: raw.label.trim(),
      engine: "dots-tts",
      url: `${url.origin}${url.pathname.replace(/\/+$/, "")}`,
      ...(model ? { model } : {}),
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
