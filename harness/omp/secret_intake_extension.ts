// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/omp/secret_intake_extension.ts - P-SECRET-INTAKE.1 (ADR-0476): the agent-side `request_secret`
// tool. The agent asks the USER for a secret through LUCID's own masked dialog instead of asking them to
// paste it into chat or a file; the value goes from the dialog into the engine vault and never reaches the
// model.
//
// HOW IT REACHES THE ENGINE: the dev.ts env-URL convention (cf. LUCID_SANDBOX_GRANT_URL). The child
// inherits LUCID_SECRET_REQUEST_URL (`.../api/secret/request?t=<AGENT_TOKEN>`) and POSTs the request; the
// engine shows the dialog in the master turn and answers `{pending, id}` after each short hold until the
// user answers, cancels, or the 10-minute deadline passes, so the tool polls `{ id }` (no single request
// outlives an idle or fetch timeout). Aborting the tool call (the user pressed Stop) sends `{ id, withdraw }`
// so the dialog closes too.
//
// WHAT THE MODEL SEES: exactly `{"stored":true,"ref":...,"envName":...}` or `{"stored":false,"reason":...}`.
// The reply is rebuilt field by field from a whitelist (formatSecretResult), so even a desktop bug that put
// more on the wire could not hand the model anything else. Only the five declared arguments are sent:
// a `value` or any other extra argument the model invents is dropped before the request leaves.
//
// NEVER THROWS: registration is wrapped, and a dead engine is a returned `stored:false`. Registers nothing
// without LUCID_SECRET_REQUEST_URL, so a plain `omp` run never sees the tool.

import { writeStderrNotice } from "./stderr_notice.ts";

// omp's plugin API is a library boundary whose type isn't exported to us; type the minimal surface we use.
interface TypeBoxType {
  Object: (props: Record<string, unknown>) => unknown;
  String: (opts?: { description?: string }) => unknown;
  Boolean: (opts?: { description?: string }) => unknown;
  Optional: (schema: unknown) => unknown;
}
interface ToolResultShape {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}
interface ToolDefinition {
  name: string;
  label: string;
  description: string;
  approval: string;
  parameters: unknown;
  execute: (toolCallId: string, params: unknown, signal?: AbortSignal) => Promise<ToolResultShape>;
}
interface OmpPluginApi {
  registerTool?: (def: ToolDefinition) => void;
  typebox?: { Type?: Partial<TypeBoxType> };
}

/** The engine's own deadline is 10 minutes; the tool keeps polling a little longer so the engine's
 *  `timeout` answer arrives first. */
export const REQUEST_SECRET_WAIT_MS = 10 * 60_000 + 30_000;
/** One poll: the engine holds it 25 s at most, so 60 s means the engine is gone. */
const POLL_FETCH_MS = 60_000;

export const REQUEST_SECRET_DESCRIPTION =
  "Ask the USER for a secret (API key, token, password, PEM private key, service-account JSON) through " +
  "LUCID's private masked dialog and store it directly in LUCID's encrypted vault. You never see the value: " +
  "the result is only {\"stored\":true,\"ref\":...,\"envName\":...} or {\"stored\":false,\"reason\":...}. " +
  "ALWAYS use this instead of asking the user to paste a secret into chat, a file, or a terminal. If the user " +
  "already pasted one into chat, do not copy it anywhere: call this tool so they can enter it safely, and " +
  "suggest they rotate the exposed one. Arguments: name (what it is, e.g. \"OpenAI API key\"), purpose (one " +
  "plain sentence the user reads: why you need it), kind (apikey, token, bearer, pat, oauth, password, basic, " +
  "pem, jwt, saml, json or other), envName when a program reads it from an environment variable (e.g. " +
  "OPENAI_API_KEY), and workspaceScoped=true when it belongs only to the current project (needs envName). " +
  "The call waits until the user answers (up to 10 minutes). On stored:true refer to it by ref or envName and " +
  "never print, echo or read the value back. On stored:false do not retry in a loop: tell the user what you " +
  "needed and continue without it.";

function prop(v: unknown, key: string): unknown {
  return v && typeof v === "object" && key in v ? (v as Record<string, unknown>)[key] : undefined;
}

/** The model-facing result, rebuilt from a whitelist: `{stored:true, ref, envName}` or `{stored:false, reason}`.
 *  Anything else on the wire (or an unreadable answer) becomes a `stored:false`. */
export function formatSecretResult(raw: unknown): string {
  const data = prop(raw, "data") ?? raw;
  const ref = prop(data, "ref");
  if (prop(data, "stored") === true && typeof ref === "string" && ref) {
    const envName = prop(data, "envName");
    return JSON.stringify({ stored: true, ref, envName: typeof envName === "string" && envName ? envName : null });
  }
  const reason = prop(data, "reason") ?? prop(raw, "error");
  return JSON.stringify({ stored: false, reason: typeof reason === "string" && reason ? reason.slice(0, 300) : "the LUCID desktop returned an unreadable answer" });
}

/** The request body: the five declared arguments only (anything else the model sends is dropped). */
export function requestBody(params: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ["name", "kind", "purpose", "envName"]) {
    const v = prop(params, key);
    if (typeof v === "string") out[key] = v;
  }
  const scoped = prop(params, "workspaceScoped");
  if (scoped === true || scoped === "true") out.workspaceScoped = true;
  return out;
}

export default function secretIntakeExtension(piRaw: unknown): void {
  let schemaMode: "typebox" | "literal" = "literal";
  try {
    // Assert the minimal omp plugin shape (unexpressible library type; narrowed by the guards below).
    const pi = piRaw as OmpPluginApi;
    if (typeof pi?.registerTool !== "function") return;
    const url = (process.env.LUCID_SECRET_REQUEST_URL ?? "").trim();
    if (!url) return; // not launched by the LUCID desktop: no dialog to show, so no tool
    // TypeBox when the shim is healthy, else structurally identical JSON-Schema literals (preview pattern).
    const T = pi.typebox?.Type;
    const tb: TypeBoxType | null =
      T && typeof T.Object === "function" && typeof T.String === "function" && typeof T.Boolean === "function" && typeof T.Optional === "function"
        ? { Object: T.Object, String: T.String, Boolean: T.Boolean, Optional: T.Optional }
        : null;
    schemaMode = tb ? "typebox" : "literal";
    type PropSpec = { kind: "string" | "boolean"; description: string; optional?: boolean };
    const props: Record<string, PropSpec> = {
      name: { kind: "string", description: "What the secret is, for the user, e.g. \"OpenAI API key\" or \"GitHub token for acme/api\". Never the value." },
      purpose: { kind: "string", description: "One plain sentence the user reads in the dialog: why you need it and what you will use it for. Never the value." },
      kind: { kind: "string", description: "apikey, token, bearer, pat, oauth, password, basic, pem, jwt, saml, json or other." },
      envName: { kind: "string", description: "Environment variable name programs read it from, e.g. OPENAI_API_KEY (optional).", optional: true },
      workspaceScoped: { kind: "boolean", description: "true when the secret belongs only to the current project (requires envName).", optional: true },
    };
    let parameters: unknown;
    if (tb) {
      const shape: Record<string, unknown> = {};
      for (const [k, s] of Object.entries(props)) {
        const base = s.kind === "boolean" ? tb.Boolean({ description: s.description }) : tb.String({ description: s.description });
        shape[k] = s.optional ? tb.Optional(base) : base;
      }
      parameters = tb.Object(shape);
    } else {
      const properties: Record<string, unknown> = {};
      for (const [k, s] of Object.entries(props)) properties[k] = { type: s.kind, description: s.description };
      parameters = { type: "object", properties, required: Object.keys(props).filter((k) => !props[k]?.optional) };
    }
    pi.registerTool({
      name: "request_secret",
      label: "Request a secret",
      description: REQUEST_SECRET_DESCRIPTION,
      approval: "read", // the dialog IS the user's decision; this call executes nothing and returns no value
      parameters,
      async execute(_toolCallId: string, params: unknown, signal?: AbortSignal): Promise<ToolResultShape> {
        const done = (raw: unknown): ToolResultShape => ({ content: [{ type: "text", text: formatSecretResult(raw) }] });
        const post = (body: unknown, withSignal: boolean) => fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: withSignal && signal ? AbortSignal.any([signal, AbortSignal.timeout(POLL_FETCH_MS)]) : AbortSignal.timeout(POLL_FETCH_MS),
        });
        const deadline = Date.now() + REQUEST_SECRET_WAIT_MS;
        let id = "";
        let body: unknown = requestBody(params);
        try {
          // The engine holds each poll briefly and answers `{pending, id}` while the user is still deciding.
          for (;;) {
            const r = await post(body, true);
            if (!r.ok) return done({ stored: false, reason: `the LUCID desktop refused the request (HTTP ${r.status})` });
            const j: unknown = await r.json().catch(() => null);
            const data = prop(j, "data") ?? j;
            const pendingId = prop(data, "id");
            if (prop(data, "pending") !== true || typeof pendingId !== "string") return done(j);
            id = pendingId;
            if (Date.now() > deadline) return done({ stored: false, reason: "timeout" });
            body = { id };
          }
        } catch {
          if (signal?.aborted) {
            // Stop: close the user's dialog too (best effort; the engine's own deadline ends it otherwise).
            if (id) await post({ id, withdraw: true }, false).catch(() => null);
            return done({ stored: false, reason: "cancelled" });
          }
          return done({ stored: false, reason: "the LUCID desktop could not be reached" });
        }
      },
    });
  } catch (e) {
    const msg = e && typeof e === "object" && "message" in e ? String(e.message) : String(e);
    writeStderrNotice(`\n[LucidAgentIDE] request_secret tool not registered (schema mode: ${schemaMode}): ${msg}\n`);
  }
}
