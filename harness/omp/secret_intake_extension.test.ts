// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/omp/secret_intake_extension.test.ts - P-SECRET-INTAKE.1 (ADR-0476): the agent-side `request_secret`
// tool against a mock `pi` and a stubbed fetch. Load-bearing: the model-facing text is rebuilt from a
// whitelist, so it is only {stored, ref, envName} or {stored:false, reason} even if the wire carried more;
// only the five declared arguments leave the tool (a pasted value never does); every failure is a
// stored:false, never a throw; no LUCID env means no tool.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import secretIntakeExtension, { formatSecretResult, requestBody } from "./secret_intake_extension.ts";

interface Captured {
  name: string;
  approval: string;
  parameters: { required?: string[] };
  execute: (id: string, params: unknown, signal?: AbortSignal) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
}
const capture = (): { pi: unknown; tools: Captured[] } => {
  const tools: Captured[] = [];
  return { pi: { registerTool: (t: Captured) => { tools.push(t); } }, tools };
};
const tool = (): Captured => {
  const { pi, tools } = capture();
  secretIntakeExtension(pi);
  expect(tools.length).toBe(1);
  return tools[0]!;
};

const URL_KEY = "LUCID_SECRET_REQUEST_URL";
const TOKEN_KEY = "LUCID_SECRET_REQUEST_TOKEN";
const MASTER_TOKEN = "master-request-token";
const inherited = { url: process.env[URL_KEY], token: process.env[TOKEN_KEY] };
const realFetch = globalThis.fetch;
beforeEach(() => {
  process.env[URL_KEY] = "http://127.0.0.1:9/api/secret/request";
  process.env[TOKEN_KEY] = MASTER_TOKEN;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  if (inherited.url === undefined) delete process.env[URL_KEY]; else process.env[URL_KEY] = inherited.url;
  if (inherited.token === undefined) delete process.env[TOKEN_KEY]; else process.env[TOKEN_KEY] = inherited.token;
});
/** Answer each POST with the next scripted reply; "hang" never answers until the call is aborted (and
 *  resolves `hung` when it starts). Returns the request bodies the tool sent, in order, and their
 *  `x-lucid-token` headers and URLs. */
const script = (replies: Array<{ body: unknown; status?: number } | "hang">) => {
  const sent: unknown[] = [];
  const auth: Array<{ url: string; token: string | null }> = [];
  const hung = Promise.withResolvers<void>();
  globalThis.fetch = ((url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)));
    auth.push({ url: String(url), token: new Headers(init.headers).get("x-lucid-token") });
    const next = replies.shift();
    if (next === "hang" || next === undefined) {
      const { promise, reject } = Promise.withResolvers<Response>();
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      hung.resolve();
      return promise;
    }
    return Promise.resolve(new Response(JSON.stringify(next.body), { status: next.status ?? 200, headers: { "content-type": "application/json" } }));
  }) as unknown as typeof fetch;
  return { sent, auth, hung: hung.promise };
};
const respond = (body: unknown, status = 200) => script([{ body, status }]).sent;
const resultOf = async (params: unknown, signal?: AbortSignal): Promise<unknown> => {
  const r = await tool().execute("call-1", params, signal);
  expect(r.isError).toBeFalsy();
  return JSON.parse(r.content[0]!.text);
};
const ask = { name: "OpenAI API key", kind: "apikey", purpose: "To run the script.", envName: "OPENAI_API_KEY" };

describe("registration", () => {
  test("no LUCID_SECRET_REQUEST_URL: no tool (a plain omp run never sees it)", () => {
    delete process.env[URL_KEY];
    const { pi, tools } = capture();
    secretIntakeExtension(pi);
    expect(tools).toEqual([]);
  });
  test("no master request token: no tool (a lane or a child with only the URL cannot open the dialog)", () => {
    delete process.env[TOKEN_KEY];
    const { pi, tools } = capture();
    secretIntakeExtension(pi);
    expect(tools).toEqual([]);
  });
  test("SECRET-INTAKE-REQUESTER-SPOOF: the URL and token leave the env at load and the token rides a header", async () => {
    const t = tool();
    expect(process.env[URL_KEY]).toBeUndefined(); // the agent's own commands inherit neither
    expect(process.env[TOKEN_KEY]).toBeUndefined();
    const { auth } = script([{ body: { ok: true, data: { stored: false, reason: "cancelled" } } }]);
    await t.execute("call-1", ask);
    expect(auth).toEqual([{ url: "http://127.0.0.1:9/api/secret/request", token: MASTER_TOKEN }]);
  });
  test("registered as a read-tier tool with name, purpose and kind required (literal schema mode)", () => {
    const t = tool();
    expect(t.name).toBe("request_secret");
    expect(t.approval).toBe("read");
    expect(t.parameters.required).toEqual(["name", "purpose", "kind"]);
  });
  test("a bare or throwing pi never throws", () => {
    expect(() => secretIntakeExtension(null)).not.toThrow();
    expect(() => secretIntakeExtension({ registerTool: () => { throw new Error("x"); } })).not.toThrow();
  });
});

describe("the model never gets a value", () => {
  test("the reply is rebuilt from a whitelist: extra wire fields never reach the model", async () => {
    respond({ ok: true, data: { stored: true, ref: "key:OPENAI_API_KEY", envName: "OPENAI_API_KEY", value: "sk-LEAKED-0000000000000000000", last4: "0000" } });
    expect(await resultOf(ask)).toEqual({ stored: true, ref: "key:OPENAI_API_KEY", envName: "OPENAI_API_KEY" });
  });
  test("a value the model invents (e.g. one pasted in chat) is not sent; only the declared fields are", async () => {
    const sent = respond({ ok: true, data: { stored: false, reason: "cancelled" } });
    await resultOf({ ...ask, value: "sk-pasted-in-chat-1111111111111111", workspaceScoped: "true" });
    expect(sent).toEqual([{ name: "OpenAI API key", kind: "apikey", purpose: "To run the script.", envName: "OPENAI_API_KEY", workspaceScoped: true }]);
    expect(requestBody({ secret: "x" })).toEqual({});
  });
  test("while the user decides, the tool polls the same request by id until the answer", async () => {
    const { sent } = script([
      { body: { ok: true, data: { pending: true, id: "r1" } } },
      { body: { ok: true, data: { pending: true, id: "r1" } } },
      { body: { ok: true, data: { stored: true, ref: "key:OPENAI_API_KEY", envName: "OPENAI_API_KEY" } } },
    ]);
    expect(await resultOf(ask)).toEqual({ stored: true, ref: "key:OPENAI_API_KEY", envName: "OPENAI_API_KEY" });
    expect(sent.slice(1)).toEqual([{ id: "r1" }, { id: "r1" }]);
  });
  test("cancel and timeout come back as stored:false with the engine's reason", async () => {
    respond({ ok: true, data: { stored: false, reason: "timeout" } });
    expect(await resultOf(ask)).toEqual({ stored: false, reason: "timeout" });
  });
});

describe("failures are stored:false, never a throw", () => {
  test("an HTTP refusal", async () => {
    respond({ ok: false, error: "forbidden" }, 403);
    expect(await resultOf(ask)).toMatchObject({ stored: false });
  });
  test("an unreachable desktop", async () => {
    globalThis.fetch = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    expect(await resultOf(ask)).toEqual({ stored: false, reason: "the LUCID desktop could not be reached" });
  });
  test("the user pressed Stop: the call reads as cancelled and the dialog's request is withdrawn", async () => {
    const { sent, hung } = script([{ body: { ok: true, data: { pending: true, id: "r1" } } }, "hang", { body: { ok: true, data: { stored: false, reason: "cancelled" } } }]);
    const ac = new AbortController();
    const pending = resultOf(ask, ac.signal);
    await hung;
    ac.abort();
    expect(await pending).toEqual({ stored: false, reason: "cancelled" });
    expect(sent.slice(1)).toEqual([{ id: "r1" }, { id: "r1", withdraw: true }]);
  });
  test("an unreadable answer", () => {
    expect(JSON.parse(formatSecretResult("<html>"))).toMatchObject({ stored: false });
    expect(JSON.parse(formatSecretResult({ data: { stored: true } }))).toMatchObject({ stored: false });
  });
});
