// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-AZURE-ENTRA.1 (ADR-0485): Azure OpenAI with Microsoft Entra ID. The end-to-end block drives the REAL
// registered streamSimple through omp's REAL Azure Responses provider against two local doubles: a fake
// instance metadata service and a fake Azure OpenAI v1 endpoint that records every request it gets.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Api, AssistantMessage, Context, Model } from "@oh-my-pi/pi-ai";
import type { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModels } from "@oh-my-pi/pi-catalog";
import {
  AZ_TOKEN_ARGS, AZURE_ENTRA_API, AzureEntraError, azureCliTokenFetcher, COGNITIVE_SERVICES_RESOURCE, EntraTokenSource,
  ENTRA_KEY_PLACEHOLDER, imdsTokenFetcher, REFRESH_MARGIN_MS, resolveAzureAuth, type AzResult, type EntraToken,
} from "./azure_entra.ts";
import { registerAzureEntra } from "./azure_entra_extension.ts";

const CLIENT_ID = "0b6f1a52-3c1d-4e8f-9a7b-2d4c6e8f0a1b";
const T0 = 1_800_000_000_000;
const OMP_AZURE_ENV = ["AZURE_OPENAI_BASE_URL", "AZURE_OPENAI_RESOURCE_NAME", "AZURE_OPENAI_API_VERSION", "AZURE_OPENAI_DEPLOYMENT_NAME_MAP", "AZURE_OPENAI_API_KEY"];

describe("resolveAzureAuth", () => {
  test("no mode, or key, is omp's own key path", () => {
    expect(resolveAzureAuth({})).toEqual({ kind: "key" });
    expect(resolveAzureAuth({ AZURE_OPENAI_AUTH_MODE: " Key ", AZURE_OPENAI_API_KEY: "k" })).toEqual({ kind: "key" });
  });

  test("a resource name becomes the v1 base URL; a client id rides managed-identity only", () => {
    expect(resolveAzureAuth({ AZURE_OPENAI_AUTH_MODE: "managed-identity", AZURE_OPENAI_RESOURCE_NAME: "acct", AZURE_OPENAI_CLIENT_ID: CLIENT_ID }))
      .toEqual({ kind: "entra", config: { mode: "managed-identity", clientId: CLIENT_ID, baseUrl: "https://acct.openai.azure.com/openai/v1" } });
    expect(resolveAzureAuth({ AZURE_OPENAI_AUTH_MODE: "azure-cli", AZURE_OPENAI_BASE_URL: "https://acct.openai.azure.com/openai/v1/", AZURE_OPENAI_CLIENT_ID: CLIENT_ID }))
      .toEqual({ kind: "entra", config: { mode: "azure-cli", baseUrl: "https://acct.openai.azure.com/openai/v1" } });
  });

  test("refuses an unknown mode, a missing account, plain http to a remote host and a malformed client id", () => {
    const reason = (env: Record<string, string>) => {
      const r = resolveAzureAuth(env);
      return r.kind === "invalid" ? r.reason : `not invalid: ${r.kind}`;
    };
    expect(reason({ AZURE_OPENAI_AUTH_MODE: "oauth", AZURE_OPENAI_RESOURCE_NAME: "acct" })).toContain("is not one of key, managed-identity, azure-cli");
    expect(reason({ AZURE_OPENAI_AUTH_MODE: "managed-identity" })).toContain("needs AZURE_OPENAI_BASE_URL or AZURE_OPENAI_RESOURCE_NAME");
    expect(reason({ AZURE_OPENAI_AUTH_MODE: "managed-identity", AZURE_OPENAI_BASE_URL: "http://acct.openai.azure.com/openai/v1" })).toContain("must be https://");
    expect(reason({ AZURE_OPENAI_AUTH_MODE: "managed-identity", AZURE_OPENAI_RESOURCE_NAME: "acct", AZURE_OPENAI_CLIENT_ID: "my-identity" })).toContain("(a GUID)");
  });
});

describe("EntraTokenSource", () => {
  const counting = (tokens: Array<EntraToken | Error>) => {
    let calls = 0;
    const fetcher = async (): Promise<EntraToken> => {
      const next = tokens[Math.min(calls, tokens.length - 1)]!;
      calls++;
      if (next instanceof Error) throw next;
      return next;
    };
    return { fetcher, calls: () => calls };
  };

  test("fetches once, reuses the token, and refreshes it 5 minutes before expiry", async () => {
    let now = T0;
    const f = counting([{ value: "tok-1", expiresAt: T0 + 3_600_000 }, { value: "tok-2", expiresAt: T0 + 7_200_000 }]);
    const source = new EntraTokenSource(f.fetcher, () => now);
    expect(await source.bearer()).toBe("tok-1");
    expect(await source.bearer()).toBe("tok-1");
    now = T0 + 3_600_000 - REFRESH_MARGIN_MS - 1;
    expect(await source.bearer()).toBe("tok-1");
    expect(f.calls()).toBe(1);
    now = T0 + 3_600_000 - REFRESH_MARGIN_MS; // inside the margin: replaced before it expires
    expect(await source.bearer()).toBe("tok-2");
    expect(f.calls()).toBe(2);
  });

  test("concurrent callers share one sign-in", async () => {
    const f = counting([{ value: "tok-1", expiresAt: T0 + 3_600_000 }]);
    const source = new EntraTokenSource(f.fetcher, () => T0);
    expect(await Promise.all([source.bearer(), source.bearer(), source.bearer()])).toEqual(["tok-1", "tok-1", "tok-1"]);
    expect(f.calls()).toBe(1);
  });

  test("a failed refresh keeps a token that has not expired yet, then fails once it has", async () => {
    let now = T0;
    const f = counting([{ value: "tok-1", expiresAt: T0 + 3_600_000 }, new AzureEntraError("managed identity: IMDS answered HTTP 500")]);
    const source = new EntraTokenSource(f.fetcher, () => now);
    await source.bearer();
    now = T0 + 3_600_000 - 60_000;
    expect(await source.bearer()).toBe("tok-1");
    now = T0 + 3_600_000;
    await expect(source.bearer()).rejects.toThrow("IMDS answered HTTP 500");
  });

  test("invalidate (a 401) drops the held token", async () => {
    const f = counting([{ value: "tok-1", expiresAt: T0 + 3_600_000 }, { value: "tok-2", expiresAt: T0 + 3_600_000 }]);
    const source = new EntraTokenSource(f.fetcher, () => T0);
    await source.bearer();
    source.invalidate();
    expect(await source.bearer()).toBe("tok-2");
  });
});

describe("azureCliTokenFetcher (fake az)", () => {
  test("runs az account get-access-token for Cognitive Services and reads expires_on", async () => {
    let argv: readonly string[] = [];
    const fetcher = azureCliTokenFetcher({
      run: async (args): Promise<AzResult> => {
        argv = args;
        return { code: 0, stderr: "", stdout: JSON.stringify({ accessToken: "cli-tok", expiresOn: "2027-01-01 00:00:00.000000", expires_on: 1_800_003_600, tokenType: "Bearer" }) };
      },
    });
    expect(await fetcher()).toEqual({ value: "cli-tok", expiresAt: 1_800_003_600_000 });
    expect(argv).toEqual(AZ_TOKEN_ARGS);
    expect(argv.join(" ")).toBe(`account get-access-token --resource ${COGNITIVE_SERVICES_RESOURCE} --output json`);
  });

  test("an older az with only the local expiresOn still yields an expiry", async () => {
    const fetcher = azureCliTokenFetcher({ run: async () => ({ code: 0, stderr: "", stdout: JSON.stringify({ accessToken: "cli-tok", expiresOn: "2027-01-01 00:00:00.000000" }) }) });
    expect((await fetcher()).expiresAt).toBe(new Date(2027, 0, 1).getTime());
  });

  test("a signed-out az is a clear error that quotes az, and a missing az says how to fix it", async () => {
    const signedOut = azureCliTokenFetcher({ run: async () => ({ code: 1, stdout: "", stderr: "ERROR: Please run 'az login' to setup account.\n" }) });
    await expect(signedOut()).rejects.toThrow("azure-cli: az account get-access-token exited 1: ERROR: Please run 'az login' to setup account.");
    const missing = azureCliTokenFetcher({ run: async () => { throw Object.assign(new Error("spawn az ENOENT"), { name: "ENOENT" }); } });
    await expect(missing()).rejects.toThrow("Install the Azure CLI and run az login");
  });
});

// ── fake IMDS + fake Azure OpenAI ───────────────────────────────────────────────────────────────────
interface Seen { path: string; apiVersion: string | null; auth: string | null; apiKey: string | null; model: unknown }
let clock = T0;
let imdsHits = 0;
let imdsStatus = 200;
let lastImds: { url: URL; metadata: string | null } | undefined;
let tokenSeq = 0;
let azureStatus = 200;
const seen: Seen[] = [];
interface Double { readonly port?: number; stop(closeActiveConnections?: boolean): unknown }
let imds: Double;
let azure: Double;
const savedEnv: Record<string, string | undefined> = {};

function sse(): string {
  const item = { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "pong", annotations: [] }] };
  const events: Array<Record<string, unknown>> = [
    { type: "response.created", response: { id: "resp_1", status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
    { type: "response.content_part.added", item_id: "msg_1", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "pong" },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "resp_1", status: "completed", output: [item], usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } },
  ];
  return events.map((e, i) => `event: ${String(e.type)}\ndata: ${JSON.stringify({ ...e, sequence_number: i })}\n\n`).join("");
}

beforeAll(() => {
  for (const k of OMP_AZURE_ENV) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  imds = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(req) {
      imdsHits++;
      lastImds = { url: new URL(req.url), metadata: req.headers.get("metadata") };
      if (imdsStatus !== 200) return Response.json({ error: "invalid_request", error_description: "Identity not found" }, { status: imdsStatus });
      tokenSeq++;
      return Response.json({ access_token: `eyJ-SECRET-${tokenSeq}`, expires_on: String(Math.floor(clock / 1000) + 3600), resource: COGNITIVE_SERVICES_RESOURCE, token_type: "Bearer" });
    },
  });
  azure = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = (await req.json()) as { model?: unknown };
      seen.push({ path: url.pathname, apiVersion: url.searchParams.get("api-version"), auth: req.headers.get("authorization"), apiKey: req.headers.get("api-key"), model: body.model });
      if (azureStatus !== 200) return Response.json({ error: { code: "PermissionDenied", message: "The principal lacks the required data action" } }, { status: azureStatus });
      return new Response(sse(), { headers: { "content-type": "text/event-stream" } });
    },
  });
});

afterAll(() => {
  imds.stop(true);
  azure.stop(true);
  for (const k of OMP_AZURE_ENV) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
});

beforeEach(() => {
  clock = T0; imdsHits = 0; imdsStatus = 200; azureStatus = 200; seen.length = 0; lastImds = undefined; tokenSeq = 0;
});

type StreamFn = (model: Model<Api>, context: Context, options?: object) => AssistantMessageEventStream;
interface Registration { name: string; config: Record<string, unknown> }

function register(env: Record<string, string>): { outcome: string; calls: Registration[]; logs: string[] } {
  const calls: Registration[] = [];
  const logs: string[] = [];
  const outcome = registerAzureEntra(
    { registerProvider: (name, config) => calls.push({ name, config }) },
    env,
    { imdsEndpoint: `http://127.0.0.1:${imds.port}/metadata/identity/oauth2/token`, now: () => clock, log: (l) => logs.push(l) },
  );
  return { outcome, calls, logs };
}

function entraEnv(): Record<string, string> {
  return { AZURE_OPENAI_AUTH_MODE: "managed-identity", AZURE_OPENAI_CLIENT_ID: CLIENT_ID, AZURE_OPENAI_BASE_URL: `http://127.0.0.1:${azure.port}/openai/v1` };
}

const CATALOG = getBundledModels("azure");
const MODEL = CATALOG.find((m) => m.id === "gpt-5.4-mini") ?? CATALOG[0]!;
const CONTEXT: Context = { messages: [{ role: "user", content: "ping", timestamp: T0 }] };

function turn(reg: Registration): Promise<AssistantMessage> {
  const stream = reg.config.streamSimple as StreamFn;
  const model = { ...MODEL, api: AZURE_ENTRA_API, baseUrl: String(reg.config.baseUrl) } as Model<Api>;
  return stream(model, CONTEXT, {}).result();
}

describe("imdsTokenFetcher (fake IMDS)", () => {
  test("asks IMDS for a Cognitive Services token for the user-assigned identity, with Metadata: true", async () => {
    const fetcher = imdsTokenFetcher({ clientId: CLIENT_ID, endpoint: `http://127.0.0.1:${imds.port}/metadata/identity/oauth2/token` });
    const tok = await fetcher();
    expect(tok.value).toStartWith("eyJ-SECRET-");
    expect(tok.expiresAt).toBe((Math.floor(T0 / 1000) + 3600) * 1000);
    expect(lastImds?.metadata).toBe("true");
    expect(lastImds?.url.searchParams.get("resource")).toBe(COGNITIVE_SERVICES_RESOURCE);
    expect(lastImds?.url.searchParams.get("api-version")).toBe("2018-02-01");
    expect(lastImds?.url.searchParams.get("client_id")).toBe(CLIENT_ID);
  });

  test("IMDS refusing and IMDS absent are both named errors", async () => {
    imdsStatus = 400;
    await expect(imdsTokenFetcher({ endpoint: `http://127.0.0.1:${imds.port}/t` })()).rejects.toThrow("managed identity: IMDS answered HTTP 400: invalid_request: Identity not found");
    await expect(imdsTokenFetcher({ endpoint: "http://127.0.0.1:1/t" })()).rejects.toThrow("the instance metadata service did not answer");
  });
});

describe("registerAzureEntra: the omp provider", () => {
  test("key mode registers nothing: omp's built-in azure provider and AZURE_OPENAI_API_KEY are untouched", () => {
    const r = register({ AZURE_OPENAI_API_KEY: "sk-azure", AZURE_OPENAI_RESOURCE_NAME: "acct" });
    expect(r.outcome).toBe("key");
    expect(r.calls).toEqual([]);
    expect(r.logs).toEqual([]);
  });

  test("an invalid Entra setting registers nothing and says why", () => {
    const r = register({ AZURE_OPENAI_AUTH_MODE: "managed-identity" });
    expect(r.outcome).toBe("invalid");
    expect(r.calls).toEqual([]);
    expect(r.logs[0]).toContain("needs AZURE_OPENAI_BASE_URL or AZURE_OPENAI_RESOURCE_NAME");
  });

  test("an Entra mode re-registers `azure` with omp's catalog on the custom API, holding no secret", () => {
    const r = register(entraEnv());
    expect(r.outcome).toBe("entra");
    expect(r.calls.length).toBe(1);
    const { name, config } = r.calls[0]!;
    expect(name).toBe("azure");
    expect(config.api).toBe(AZURE_ENTRA_API);
    expect(config.apiKey).toBe(ENTRA_KEY_PLACEHOLDER);
    expect(config.baseUrl).toBe(`http://127.0.0.1:${azure.port}/openai/v1`);
    const ids = (config.models as Array<{ id: string }>).map((m) => m.id);
    expect(ids).toEqual(CATALOG.map((m) => m.id));
    expect(imdsHits).toBe(0); // registering signs in to nothing; the first request does
    expect(r.logs[0]).toContain("managed-identity, user-assigned identity");
  });
});

describe("an Entra-signed Azure OpenAI turn end to end", () => {
  test("the token is fetched, sent as Bearer to the v1 URL with no api-key, cached, and refreshed near expiry", async () => {
    const reg = register(entraEnv()).calls[0]!;
    const first = await turn(reg);
    expect(first.stopReason).toBe("stop");
    expect(first.content.some((c) => c.type === "text" && c.text === "pong")).toBe(true);
    expect(seen.length).toBe(1);
    expect(seen[0]!.path).toBe("/openai/v1/responses");
    expect(seen[0]!.apiVersion).toBe("v1");
    expect(seen[0]!.auth).toBe("Bearer eyJ-SECRET-1");
    expect(seen[0]!.apiKey).toBeNull(); // the placeholder key never leaves the process
    expect(seen[0]!.model).toBe(MODEL.id);
    expect(imdsHits).toBe(1);

    clock = T0 + 30 * 60_000; // half an hour later: the held token is reused
    await turn(reg);
    expect(imdsHits).toBe(1);
    expect(seen[1]!.auth).toBe("Bearer eyJ-SECRET-1");

    clock = T0 + 3_600_000 - REFRESH_MARGIN_MS + 1_000; // inside 5 minutes of expiry: a new token first
    await turn(reg);
    expect(imdsHits).toBe(2);
    expect(seen[2]!.auth).toBe("Bearer eyJ-SECRET-2");
  });

  test("a 401 from Azure drops the held token, so the next turn signs in again", async () => {
    const reg = register(entraEnv()).calls[0]!;
    azureStatus = 401;
    const denied = await turn(reg);
    expect(denied.stopReason).toBe("error");
    const hitsAfterDenial = imdsHits;
    azureStatus = 200;
    const ok = await turn(reg);
    expect(ok.stopReason).toBe("stop");
    expect(imdsHits).toBe(hitsAfterDenial + 1);
  });

  // The remote spoke (add-on ADR-A049) reaches the account BY NAME through its egress proxy: HTTPS_PROXY set,
  // only IMDS in NO_PROXY. The request must carry that proxy; a host listed in NO_PROXY must go direct.
  test("the Entra request to the account goes through HTTPS_PROXY unless NO_PROXY names the host", async () => {
    const ACCOUNT_HOST = "lucid-spoke-aoai-7f3k.openai.azure.com";
    const imdsUrl = `http://127.0.0.1:${imds.port}/metadata/identity/oauth2/token`;
    const sent: Array<{ url: string; proxy: string | undefined; auth: string | null; apiKey: string | null }> = [];
    const transport = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.startsWith(imdsUrl)) return globalThis.fetch(url, init);
      const proxy = init && "proxy" in init && typeof init.proxy === "string" ? init.proxy : undefined;
      const headers = new Headers(init?.headers);
      sent.push({ url, proxy, auth: headers.get("authorization"), apiKey: headers.get("api-key") });
      return new Response(sse(), { headers: { "content-type": "text/event-stream" } });
    }) as typeof globalThis.fetch;
    const saved = { HTTPS_PROXY: process.env.HTTPS_PROXY, NO_PROXY: process.env.NO_PROXY };
    try {
      process.env.HTTPS_PROXY = "http://127.0.0.1:3128";
      const calls: Registration[] = [];
      registerAzureEntra(
        { registerProvider: (name, config) => calls.push({ name, config }) },
        { AZURE_OPENAI_AUTH_MODE: "managed-identity", AZURE_OPENAI_BASE_URL: `https://${ACCOUNT_HOST}/openai/v1` },
        { imdsEndpoint: imdsUrl, now: () => clock, log: () => {}, fetch: transport },
      );
      const reg = calls[0]!;

      process.env.NO_PROXY = "localhost,127.0.0.1,::1,169.254.169.254"; // the spoke's egress.env for an Azure model
      expect((await turn(reg)).stopReason).toBe("stop");
      expect(sent[0]).toEqual({ url: `https://${ACCOUNT_HOST}/openai/v1/responses?api-version=v1`, proxy: "http://127.0.0.1:3128", auth: "Bearer eyJ-SECRET-1", apiKey: null });

      process.env.NO_PROXY = `localhost,127.0.0.1,${ACCOUNT_HOST}`;
      expect((await turn(reg)).stopReason).toBe("stop");
      expect(sent[1]?.proxy).toBeUndefined();
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });

  test("a failed sign-in ends the turn with a clear error, sends nothing to Azure, and leaks no token", async () => {
    const reg = register(entraEnv()).calls[0]!;
    await turn(reg); // holds eyJ-SECRET-n
    const held = seen[0]!.auth!.slice("Bearer ".length);
    clock = T0 + 3_600_000 + 1; // expired
    imdsStatus = 500;
    const before = seen.length;
    const failed = await turn(reg);
    expect(failed.stopReason).toBe("error");
    expect(failed.errorMessage).toContain("Azure OpenAI sign-in with Microsoft Entra ID failed (managed identity: IMDS answered HTTP 500");
    expect(JSON.stringify(failed)).not.toContain(held);
    expect(JSON.stringify(failed)).not.toContain("eyJ-SECRET");
    expect(seen.length).toBe(before);
  });
});
