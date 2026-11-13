// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/omp/commit_gate_extension.test.ts - P-OWN.1: the agent-side commit gate hook against a mock `pi`
// and a stubbed fetch. Load-bearing: no registration without the LUCID env; a command without a `git`
// token never touches the network; the engine's block reason reaches the model verbatim behind the
// refusal prefix; a dead engine or a torn payload fails OPEN with one stderr notice.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import commitGateExtension, { REFUSAL_PREFIX, WRITE_WAIT_MS, checkoutGateUrl, mentionsGit, parseGateVerdict, writeTargets } from "./commit_gate_extension.ts";
import { CHANNEL_ENV, CHANNEL_PROOF_HEADER, mintChannelKey } from "./engine_channel.ts";
import { answerChannel, channelAdmits, LaneChannels } from "../../desktop/lane_channel.ts";

const ENV_KEYS = ["LUCID_INTERJECT_TARGET", "LUCID_CHECKOUT_GATE_URL", "LUCID_CHECKOUT_WRITE_URL", CHANNEL_ENV] as const;
const inherited: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) inherited[k] = process.env[k];
const realFetch = globalThis.fetch;
const realStderrWrite = process.stderr.write;
beforeEach(() => { for (const k of ENV_KEYS) delete process.env[k]; });
afterEach(() => {
  globalThis.fetch = realFetch;
  process.stderr.write = realStderrWrite;
  for (const k of ENV_KEYS) {
    const v = inherited[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function liveEnv(): void {
  process.env.LUCID_INTERJECT_TARGET = "lane-1";
  process.env.LUCID_CHECKOUT_GATE_URL = "http://127.0.0.1:9/api/checkout/gate?t=tok";
}

type Handler = (event: unknown) => Promise<unknown>;

/** Register against a mock pi and hand back the tool_call handler it installed (null when none). */
function install(): Handler | null {
  let handler: Handler | null = null;
  const mock = { on: (name: string, h: Handler) => { if (name === "tool_call") handler = h; } };
  // omp's ExtensionAPI is a library type far wider than the one seam this extension uses.
  const pi = mock as unknown as Parameters<typeof commitGateExtension>[0];
  commitGateExtension(pi);
  return handler;
}

/** Stub fetch with one canned envelope; records the URLs the gate asked. */
function stubFetch(envelope: unknown): string[] {
  const urls: string[] = [];
  globalThis.fetch = ((input: string | URL | Request) => {
    urls.push(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    return Promise.resolve(new Response(JSON.stringify(envelope), { headers: { "content-type": "application/json" } }));
  }) as typeof globalThis.fetch;
  return urls;
}

/** Capture stderr notices without letting them reach the terminal. */
function captureStderr(): string[] {
  const lines: string[] = [];
  process.stderr.write = ((chunk: unknown) => { lines.push(String(chunk)); return true; }) as typeof process.stderr.write;
  return lines;
}

const bash = (command: string, cwd?: string): unknown => ({ type: "tool_call", toolCallId: "1", toolName: "bash", input: { command, ...(cwd ? { cwd } : {}) } });

describe("pure helpers", () => {
  test("mentionsGit: whole-word git token only", () => {
    expect(mentionsGit("git add -A")).toBe(true);
    expect(mentionsGit("cd x && git commit -am 'wip'")).toBe(true);
    expect(mentionsGit("echo digital")).toBe(false);
    expect(mentionsGit("gitk")).toBe(false);
    expect(mentionsGit("bun test")).toBe(false);
  });

  test("checkoutGateUrl: null unless both env vars; identity appended after the token", () => {
    expect(checkoutGateUrl({})).toBeNull();
    expect(checkoutGateUrl({ LUCID_INTERJECT_TARGET: "master" })).toBeNull();
    expect(checkoutGateUrl({ LUCID_CHECKOUT_GATE_URL: "http://x/g?t=1" })).toBeNull();
    expect(checkoutGateUrl({ LUCID_INTERJECT_TARGET: "lane a", LUCID_CHECKOUT_GATE_URL: "http://x/g?t=1" })).toBe("http://x/g?t=1&target=lane%20a");
  });

  test("parseGateVerdict: needs a boolean block; reason defaults empty; torn bodies are null", () => {
    expect(parseGateVerdict({ ok: true, data: { block: true, reason: "r" } })).toEqual({ block: true, reason: "r" });
    expect(parseGateVerdict({ ok: true, data: { block: false } })).toEqual({ block: false, reason: "" });
    expect(parseGateVerdict({ ok: true, data: { block: "yes" } })).toBeNull();
    expect(parseGateVerdict({ ok: false, error: "x" })).toBeNull();
    expect(parseGateVerdict(null)).toBeNull();
  });
});

describe("tool_call handler", () => {
  test("registers nothing without the LUCID env", () => {
    expect(install()).toBeNull();
  });

  test("no network for a non-bash tool or a bash command without a git token", async () => {
    liveEnv();
    const urls = stubFetch({ ok: true, data: { block: true, reason: "must not be asked" } });
    const handler = install()!;
    expect(await handler(bash("bun test x.test.ts"))).toBeUndefined();
    expect(await handler({ type: "tool_call", toolCallId: "1", toolName: "write", input: { path: "git", content: "git add -A" } })).toBeUndefined();
    expect(await handler(bash("echo digital garden"))).toBeUndefined();
    expect(urls).toEqual([]);
  });

  test("asks the engine with target, cwd and the command; a block carries the reason behind the prefix", async () => {
    liveEnv();
    const reason = "lane-2 (Lane 2) owns uncommitted edits: src/a.ts\nStage explicit paths you own instead: git add src/b.ts";
    const urls = stubFetch({ ok: true, data: { block: true, reason } });
    const r = await install()!(bash("git add -A && git commit -m x", "C:/w"));
    expect(urls.length).toBe(1);
    expect(urls[0]).toBe(
      "http://127.0.0.1:9/api/checkout/gate?t=tok&target=lane-1&cwd=C%3A%2Fw&command=git%20add%20-A%20%26%26%20git%20commit%20-m%20x",
    );
    expect(r).toEqual({ block: true, reason: `${REFUSAL_PREFIX}${reason}` });
  });

  test("falls back to process.cwd() when the call names no cwd; an allow is undefined", async () => {
    liveEnv();
    const urls = stubFetch({ ok: true, data: { block: false } });
    const r = await install()!(bash("git status"));
    expect(r).toBeUndefined();
    expect(urls[0]).toContain(`&cwd=${encodeURIComponent(process.cwd())}&command=git%20status`);
  });

  test("P-WAIT.1: a write/edit asks the WRITE url with its file(s) and the wait bound; a hold blocks with the reason", async () => {
    process.env.LUCID_INTERJECT_TARGET = "lane-1";
    process.env.LUCID_CHECKOUT_WRITE_URL = "http://127.0.0.1:9/api/checkout/write?t=tok";
    const reason = "a.ts is being edited by \"Main\" (session id \"master\"), whose turn is still running (waited 20 s).";
    const urls = stubFetch({ ok: true, data: { block: true, reason } });
    const handler = install()!;
    const r = await handler({ type: "tool_call", toolCallId: "1", toolName: "edit", input: { path: "src/a.ts", paths: ["src/a.ts", "src/b.ts"] } });
    expect(urls).toEqual([
      `http://127.0.0.1:9/api/checkout/write?t=tok&target=lane-1&cwd=${encodeURIComponent(process.cwd())}&path=src%2Fa.ts&path=src%2Fb.ts&waitMs=${WRITE_WAIT_MS}`,
    ]);
    expect(r).toEqual({ block: true, reason: `${REFUSAL_PREFIX}${reason}` });
    // Without the commit-gate url, a git command costs no round trip; a read never does.
    expect(await handler(bash("git add -A"))).toBeUndefined();
    expect(await handler({ type: "tool_call", toolCallId: "2", toolName: "read", input: { path: "src/a.ts" } })).toBeUndefined();
    expect(urls.length).toBe(1);
  });

  test("writeTargets: path plus derived paths, deduped; only write and edit name targets", () => {
    expect(writeTargets("write", { path: " a.ts ", content: "x" })).toEqual(["a.ts"]);
    expect(writeTargets("edit", { paths: ["a.ts", "b.ts", "a.ts"] })).toEqual(["a.ts", "b.ts"]);
    expect(writeTargets("edit", { input: "no header" })).toEqual([]);
    expect(writeTargets("bash", { path: "a.ts" })).toEqual([]);
  });

  test("fails OPEN on a dead engine, a non-200, or a torn body: undefined plus one stderr line each", async () => {
    liveEnv();
    const handler = install()!;
    const lines = captureStderr();
    globalThis.fetch = (async (_input: string | URL | Request): Promise<Response> => { throw new Error("ECONNREFUSED"); }) as typeof globalThis.fetch;
    expect(await handler(bash("git add -A"))).toBeUndefined();
    globalThis.fetch = (async (_input: string | URL | Request) => new Response("nope", { status: 503 })) as typeof globalThis.fetch;
    expect(await handler(bash("git add -A"))).toBeUndefined();
    stubFetch({ ok: true, data: { verdict: "block" } });
    expect(await handler(bash("git add -A"))).toBeUndefined();
    expect(lines.length).toBe(3);
    expect(lines[0]).toContain("checkout gate unreachable, command allowed (fail-open): ECONNREFUSED");
    expect(lines[1]).toContain("responded 503");
    expect(lines[2]).toContain("malformed gate response");
  });
});

describe("LH-03: an answer the gate cannot trust fails CLOSED", () => {
  const blocked = (r: unknown): string => {
    expect(r).toMatchObject({ block: true });
    return r && typeof r === "object" && "reason" in r && typeof r.reason === "string" ? r.reason : "";
  };
  const held = (): string => { const key = mintChannelKey(); process.env[CHANNEL_ENV] = key; return key; };
  const allow = { ok: true, data: { block: false } };

  test("a 401 or 403 (an engine that does not accept this session's token) blocks instead of allowing", async () => {
    liveEnv();
    const handler = install()!;
    for (const status of [401, 403]) {
      globalThis.fetch = (async (_input: string | URL | Request) => new Response("forbidden", { status })) as typeof globalThis.fetch;
      expect(blocked(await handler(bash("git add -A")))).toContain(`credentials (${status})`);
    }
  });

  test("a held lane blocks an allow that carries no proof, or one made for another request (a squatter on the port)", async () => {
    liveEnv();
    held();
    const handler = install()!;
    const urls = stubFetch(allow); // what any process holding the port can send back
    expect(blocked(await handler(bash("git add -A")))).toContain("could not be verified");
    // The old engine's token never leaves the lane; the request MAC it sends cannot sign a reply.
    expect(urls[0]).not.toContain("t=tok");
    const replayed = new Response(JSON.stringify(allow), { headers: { [CHANNEL_PROOF_HEADER]: "0".repeat(64) } });
    globalThis.fetch = (async (_input: string | URL | Request) => replayed.clone()) as typeof globalThis.fetch;
    blocked(await handler(bash("git add -A")));
  });

  test("a held lane trusts the verdict of the engine that holds its channel (any engine that reattached it)", async () => {
    liveEnv();
    const key = held();
    const channels = new LaneChannels();
    channels.register("lane-1", key); // what a later engine does from the lane's holder record
    let verdict: unknown = allow;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const req = new Request(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url, init);
      // The engine's half: the request's MAC names this lane, it speaks for itself, and the reply carries its proof.
      const url = new URL(req.url);
      const ch = await channels.authenticate(req, url);
      if (!ch) throw new Error("the gate's request did not authenticate as lane-1");
      expect(ch.laneId).toBe("lane-1");
      expect(channelAdmits(ch, url, () => null)).toBe(true);
      return answerChannel(ch, new Response(JSON.stringify(verdict), { headers: { "content-type": "application/json" } }));
    }) as typeof globalThis.fetch;
    const handler = install()!;
    expect(await handler(bash("git add -A"))).toBeUndefined();
    verdict = { ok: true, data: { block: true, reason: "b.ts belongs to Main" } };
    expect(blocked(await handler(bash("git add -A")))).toBe(`${REFUSAL_PREFIX}b.ts belongs to Main`);
  });
});
