// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/omp/azure_entra.ts
//
// P-AZURE-ENTRA.1 (ADR-0499): Azure OpenAI signed in with Microsoft Entra ID instead of an API key.
//
// omp's built-in `azure` provider (pi-ai `azure-openai-responses`) only knows a key: it always sends
// `api-key: <AZURE_OPENAI_API_KEY>`, and a models.yml `!command` key is cached until a 401, so neither can
// carry a token that must be refreshed before it expires. What omp DOES offer is a custom API
// (`registerProvider` with `streamSimple`, the AskSage pattern, ADR-0007) and a per-request `fetch`
// override that every built-in provider routes its HTTP through. So the stream below fetches an Entra
// access token (instance metadata service for a managed identity, or `az account get-access-token`),
// then runs omp's OWN Azure Responses stream for the same catalog model with a fetch that drops the
// placeholder `api-key` header and sends `Authorization: Bearer <token>` instead. Request shape,
// deployment map, API version, retries and parsing stay omp's.
//
// The token lives in this process's memory only (EntraTokenSource), is refreshed 5 minutes before it
// expires, and is added to the request INSIDE the transport fetch, below omp's PI_REQ_DEBUG recorder, so
// no log line, settings file, vault entry or error message ever carries it.

import type { Api, AssistantMessage, Context, FetchImpl, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { createInitialResponsesAssistantMessage } from "@oh-my-pi/pi-ai/providers/openai-shared";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getProxyForUrl } from "@oh-my-pi/pi-ai/utils/proxy";

/** Selects the sign-in: `key` (default, omp's own path), `managed-identity`, or `azure-cli`. */
export const AZURE_AUTH_MODE_ENV = "AZURE_OPENAI_AUTH_MODE";
/** Client id of a USER-assigned managed identity; blank means the VM's system-assigned identity. */
export const AZURE_CLIENT_ID_ENV = "AZURE_OPENAI_CLIENT_ID";
export const AZURE_AUTH_MODES = ["key", "managed-identity", "azure-cli"] as const;
export type AzureAuthMode = (typeof AZURE_AUTH_MODES)[number];
export type EntraMode = Exclude<AzureAuthMode, "key">;

/** The custom omp API the Entra-signed Azure models are registered under. */
export const AZURE_ENTRA_API = "lucid-azure-entra";
/** Stands in for AZURE_OPENAI_API_KEY so omp treats the provider as configured. Never sent: the Entra
 *  fetch deletes the `api-key` header it lands in. */
export const ENTRA_KEY_PLACEHOLDER = "lucid-entra-id";
/** The token audience for Azure OpenAI (Cognitive Services) data-plane calls. */
export const COGNITIVE_SERVICES_RESOURCE = "https://cognitiveservices.azure.com";
export const IMDS_TOKEN_URL = "http://169.254.169.254/metadata/identity/oauth2/token";
/** A held token is replaced once it is this close to expiry. */
export const REFRESH_MARGIN_MS = 5 * 60_000;
/** The exact `az` arguments the azure-cli mode runs. */
export const AZ_TOKEN_ARGS: readonly string[] = ["account", "get-access-token", "--resource", COGNITIVE_SERVICES_RESOURCE, "--output", "json"];

const IMDS_TIMEOUT_MS = 10_000;
const AZ_TIMEOUT_MS = 30_000;
const DETAIL_MAX = 300;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOOPBACK: Record<string, true> = { "127.0.0.1": true, localhost: true, "[::1]": true };

export interface AzureEntraConfig { mode: EntraMode; clientId?: string; baseUrl: string }
export type AzureAuthResolution =
  | { kind: "key" }
  | { kind: "entra"; config: AzureEntraConfig }
  | { kind: "invalid"; reason: string };

/** Read the Azure sign-in from the env omp's child inherits (Settings fields, or a headless engine's
 *  environment). Pure. An unknown mode or an unusable base URL is `invalid`, never a silent key fallback. */
export function resolveAzureAuth(env: Record<string, string | undefined>): AzureAuthResolution {
  const raw = (env[AZURE_AUTH_MODE_ENV] ?? "").trim().toLowerCase();
  if (raw === "" || raw === "key") return { kind: "key" };
  if (raw !== "managed-identity" && raw !== "azure-cli") {
    return { kind: "invalid", reason: `${AZURE_AUTH_MODE_ENV}="${detail(raw).slice(0, 40)}" is not one of ${AZURE_AUTH_MODES.join(", ")}` };
  }
  const resource = env.AZURE_OPENAI_RESOURCE_NAME?.trim();
  const base = env.AZURE_OPENAI_BASE_URL?.trim() || (resource ? `https://${resource}.openai.azure.com/openai/v1` : "");
  if (!base) return { kind: "invalid", reason: "Entra sign-in needs AZURE_OPENAI_BASE_URL or AZURE_OPENAI_RESOURCE_NAME" };
  let url: URL;
  try { url = new URL(base); } catch { return { kind: "invalid", reason: "AZURE_OPENAI_BASE_URL is not a URL" }; }
  // The token is a bearer credential for the whole account: it only ever travels over TLS (loopback
  // http is allowed so a local test double can stand in for the account).
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK[url.hostname])) {
    return { kind: "invalid", reason: "AZURE_OPENAI_BASE_URL must be https:// for Entra sign-in" };
  }
  const mode: EntraMode = raw === "managed-identity" ? "managed-identity" : "azure-cli";
  const clientId = mode === "managed-identity" ? env[AZURE_CLIENT_ID_ENV]?.trim() || undefined : undefined;
  if (clientId && !GUID.test(clientId)) return { kind: "invalid", reason: `${AZURE_CLIENT_ID_ENV} must be the identity's client id (a GUID)` };
  return { kind: "entra", config: { mode, ...(clientId ? { clientId } : {}), baseUrl: base.replace(/\/+$/, "") } };
}

/** Every sign-in failure. Messages name the mode and the cause, never a token. */
export class AzureEntraError extends Error {
  override name = "AzureEntraError";
}

export interface EntraToken { value: string; expiresAt: number }
export type TokenFetcher = () => Promise<EntraToken>;
export interface AzResult { code: number; stdout: string; stderr: string }
export type AzRunner = (args: readonly string[]) => Promise<AzResult>;

function detail(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, DETAIL_MAX);
}
function causeName(e: unknown): string {
  return e instanceof Error ? e.name : typeof e;
}
/** Epoch ms from an `expires_on` (epoch seconds, number or string), else `now + expires_in` seconds. */
function expiryOf(expiresOn: unknown, expiresIn: unknown, now: number): number | undefined {
  const on = Number(expiresOn);
  if (typeof expiresOn !== "boolean" && Number.isFinite(on) && on > 0) return on * 1000;
  const inS = Number(expiresIn);
  if (typeof expiresIn !== "boolean" && Number.isFinite(inS) && inS > 0) return now + inS * 1000;
  return undefined;
}
function record(text: string): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(text);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch { return undefined; }
}

/** Managed identity through the instance metadata service. `endpoint` and `fetch` are test seams. */
export function imdsTokenFetcher(opts: { clientId?: string; fetch?: FetchImpl; endpoint?: string; now?: () => number } = {}): TokenFetcher {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const now = opts.now ?? Date.now;
  return async () => {
    const url = new URL(opts.endpoint ?? IMDS_TOKEN_URL);
    url.searchParams.set("api-version", "2018-02-01");
    url.searchParams.set("resource", COGNITIVE_SERVICES_RESOURCE);
    if (opts.clientId) url.searchParams.set("client_id", opts.clientId);
    let res: Response;
    try {
      res = await doFetch(url.toString(), { headers: { Metadata: "true" }, signal: AbortSignal.timeout(IMDS_TIMEOUT_MS) });
    } catch (e) {
      throw new AzureEntraError(`managed identity: the instance metadata service did not answer (${causeName(e)}). LUCID must run on an Azure VM with a managed identity and reach 169.254.169.254 port 80; otherwise set ${AZURE_AUTH_MODE_ENV} to azure-cli or key.`);
    }
    const text = await res.text();
    // A non-200 body is IMDS's own {error, error_description}; a 200 body holds the token and is never quoted.
    if (!res.ok) {
      const err = record(text);
      const why = err ? [err.error, err.error_description].filter((x) => typeof x === "string").join(": ") : text;
      throw new AzureEntraError(`managed identity: IMDS answered HTTP ${res.status}${why ? `: ${detail(why)}` : ""}`);
    }
    const body = record(text);
    const value = body?.access_token;
    const expiresAt = body ? expiryOf(body.expires_on, body.expires_in, now()) : undefined;
    if (typeof value !== "string" || !value || expiresAt === undefined) {
      throw new AzureEntraError("managed identity: IMDS answered without an access token and its expiry");
    }
    return { value, expiresAt };
  };
}

/** Run the Azure CLI. On Windows `az` is a .cmd script, so it goes through cmd.exe (fixed arguments only). */
const runAz: AzRunner = async (args) => {
  const argv = process.platform === "win32" ? ["cmd.exe", "/d", "/s", "/c", "az", ...args] : ["az", ...args];
  const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true });
  const timer = setTimeout(() => proc.kill(), AZ_TIMEOUT_MS);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
};

/** The signed-in Azure CLI user (`az login` as the account the engine runs under). `run` is a test seam. */
export function azureCliTokenFetcher(opts: { run?: AzRunner; now?: () => number } = {}): TokenFetcher {
  const run = opts.run ?? runAz;
  const now = opts.now ?? Date.now;
  return async () => {
    let r: AzResult;
    try {
      r = await run(AZ_TOKEN_ARGS);
    } catch (e) {
      throw new AzureEntraError(`azure-cli: could not run az (${causeName(e)}). Install the Azure CLI and run az login, or set ${AZURE_AUTH_MODE_ENV} to managed-identity or key.`);
    }
    if (r.code !== 0) {
      throw new AzureEntraError(`azure-cli: az account get-access-token exited ${r.code}: ${detail(r.stderr) || "no error text"}. Run az login as the user LUCID runs as.`);
    }
    const body = record(r.stdout);
    const value = body?.accessToken;
    // `expires_on` (epoch seconds) is in az 2.54 and later; older builds only print a local
    // `expiresOn` like "2026-11-04 13:00:00.000000" (microseconds dropped: Date.parse takes milliseconds).
    let expiresAt = body ? expiryOf(body.expires_on, undefined, now()) : undefined;
    if (expiresAt === undefined && typeof body?.expiresOn === "string") {
      const local = Date.parse(body.expiresOn.slice(0, 19).replace(" ", "T"));
      if (Number.isFinite(local)) expiresAt = local;
    }
    if (typeof value !== "string" || !value || expiresAt === undefined) {
      throw new AzureEntraError("azure-cli: az printed no access token and expiry");
    }
    return { value, expiresAt };
  };
}

/**
 * One in-memory bearer for the process. Fetches on first use, reuses it until it is within
 * REFRESH_MARGIN_MS of expiry, coalesces concurrent refreshes into one fetch, and keeps serving the held
 * token if a refresh fails while that token has not actually expired yet. `invalidate()` (on a 401) drops
 * it so the next request signs in again.
 */
export class EntraTokenSource {
  readonly #fetchToken: TokenFetcher;
  readonly #now: () => number;
  #held: EntraToken | undefined;
  #pending: Promise<EntraToken> | undefined;

  constructor(fetchToken: TokenFetcher, now: () => number = Date.now) {
    this.#fetchToken = fetchToken;
    this.#now = now;
  }

  async bearer(): Promise<string> {
    const held = this.#held;
    if (held && held.expiresAt - REFRESH_MARGIN_MS > this.#now()) return held.value;
    try {
      return (await this.#refresh()).value;
    } catch (e) {
      if (held && this.#held === held && held.expiresAt > this.#now()) return held.value;
      throw e;
    }
  }

  invalidate(): void {
    this.#held = undefined;
  }

  #refresh(): Promise<EntraToken> {
    this.#pending ??= this.#fetchToken()
      .then((token) => { this.#held = token; return token; })
      .finally(() => { this.#pending = undefined; });
    return this.#pending;
  }
}

export interface EntraSourceDeps { fetch?: FetchImpl; imdsEndpoint?: string; runAz?: AzRunner; now?: () => number }

export function createTokenSource(config: AzureEntraConfig, deps: EntraSourceDeps = {}): EntraTokenSource {
  const fetcher = config.mode === "managed-identity"
    ? imdsTokenFetcher({ ...(config.clientId ? { clientId: config.clientId } : {}), ...(deps.fetch ? { fetch: deps.fetch } : {}), ...(deps.imdsEndpoint ? { endpoint: deps.imdsEndpoint } : {}), ...(deps.now ? { now: deps.now } : {}) })
    : azureCliTokenFetcher({ ...(deps.runAz ? { run: deps.runAz } : {}), ...(deps.now ? { now: deps.now } : {}) });
  return new EntraTokenSource(fetcher, deps.now);
}

/** The request transport for one turn: Azure's key header out, the Entra bearer in, and a 401 drops the
 *  held token so the next turn signs in again. The proxy is chosen by omp's own resolver (`PI_PROXY_<PROVIDER>`,
 *  `PI_PROXY`, `HTTPS_PROXY`, honoring `NO_PROXY` and never for local or metadata hosts) and set on the request
 *  explicitly, so a host that must reach the account through an egress proxy (the remote spoke, add-on
 *  ADR-A049) does not depend on the runtime's own reading of the proxy environment. A proxy omp's transport
 *  already set wins. */
export function bearerFetch(token: string, source: EntraTokenSource, base: FetchImpl, provider: string): FetchImpl {
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.delete("api-key");
    headers.set("Authorization", `Bearer ${token}`);
    const given = init && "proxy" in init && typeof init.proxy === "string" && init.proxy ? init.proxy : undefined;
    const proxy = given ?? getProxyForUrl(provider, new URL(input instanceof Request ? input.url : input.toString()));
    const next: RequestInit & { proxy?: string } = { ...init, headers, ...(proxy ? { proxy } : {}) };
    const res = await base(input, next);
    if (res.status === 401) source.invalidate();
    return res;
  };
}

function failure(model: Model<Api>, text: string): AssistantMessage {
  const message = createInitialResponsesAssistantMessage(model.api, model.provider, model.id);
  message.stopReason = "error";
  message.errorMessage = text;
  return message;
}

export interface AzureEntraStreamDeps {
  source: EntraTokenSource;
  mode: EntraMode;
  /** omp's own Azure catalog model for a registered id: the request really is that model. */
  azureModel: (id: string) => Model<Api> | undefined;
  /** Base transport (a test seam); omp's global fetch otherwise. */
  fetch?: FetchImpl;
}

/** The `streamSimple` registered for AZURE_ENTRA_API. */
export function makeAzureEntraStream(deps: AzureEntraStreamDeps) {
  return (model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream => {
    const out = new AssistantMessageEventStream();
    void (async () => {
      const target = deps.azureModel(model.id);
      if (!target) {
        out.push({ type: "error", reason: "error", error: failure(model, `Azure OpenAI (Entra ID): ${model.id} is not in omp's Azure catalog`) });
        return;
      }
      let token: string;
      try {
        token = await deps.source.bearer();
      } catch (e) {
        const why = e instanceof AzureEntraError ? e.message : `${deps.mode}: ${causeName(e)}`;
        out.push({ type: "error", reason: "error", error: failure(model, `Azure OpenAI sign-in with Microsoft Entra ID failed (${why})`) });
        return;
      }
      // The caller's fetch is omp's transport wrapper (user agent, extra CA, proxy, request debug). It is
      // replaced, not wrapped: streamSimple re-applies that wrapper once, around the bearer fetch, so the
      // debug recorder sees the placeholder key and never the token. The provider in-flight limit was
      // already taken for this request by omp's custom-API dispatch, so the inner call takes none.
      const inner = streamSimple(
        { ...target, baseUrl: model.baseUrl, ...(model.headers ? { headers: model.headers } : {}) },
        context,
        { ...options, apiKey: ENTRA_KEY_PLACEHOLDER, fetch: bearerFetch(token, deps.source, deps.fetch ?? globalThis.fetch, model.provider), maxInFlightRequests: {} },
      );
      out.forwardLocalWorkFrom(inner);
      try {
        for await (const event of inner) out.push(event);
        if (!out.done) out.end(await inner.result());
      } catch (e) {
        out.fail(e);
      } finally {
        out.forwardLocalWorkFrom(undefined);
      }
    })();
    return out;
  };
}
