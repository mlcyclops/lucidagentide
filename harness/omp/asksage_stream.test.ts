// harness/omp/asksage_stream.test.ts
//
// Tool-use support for the AskSage Anthropic adapter (bug fix: AskSage Claude couldn't use omp tools —
// it emitted tool-call XML as text and nothing executed). These tests mock the AskSage HTTP response and
// assert: (1) tool_use blocks → omp toolcall_start/end events with stopReason "toolUse"; (2) mixed
// text+tool ordering and a content array with both; (3) the request wire format carries tools (input_
// schema) and a prior tool round-trip as tool_use + tool_result; (4) text-only is unchanged.

import { afterEach, describe, expect, test } from "bun:test";
import { makeAsksageStream } from "./asksage_stream.ts";

const origFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = origFetch; });

function mockFetch(response: any, capture?: (url: string, init: any) => void): void {
  globalThis.fetch = (async (url: any, init: any) => {
    capture?.(String(url), init);
    return { ok: true, status: 200, json: async () => response } as any;
  }) as any;
}

async function collect(stream: any): Promise<any[]> {
  const events: any[] = [];
  for await (const ev of stream) events.push(ev);
  return events;
}

const cfg = { base: "https://asksage.test", key: "k" };
const model = { id: "claude-x", api: "asksage-anthropic", provider: "asksage-anthropic", maxTokens: 1000 };
const anthropic = makeAsksageStream("anthropic", () => cfg);
const writeTool = { name: "write_file", description: "write a file", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path"] } };

describe("AskSage Anthropic tool use", () => {
  test("a tool_use response emits toolcall_start/end with stopReason toolUse", async () => {
    mockFetch({ content: [{ type: "tool_use", id: "tu_1", name: "write_file", input: { path: "a.txt", content: "hi" } }], stop_reason: "tool_use", usage: { input_tokens: 10, output_tokens: 5 } });
    const events = await collect(anthropic(model, { systemPrompt: ["sys"], messages: [{ role: "user", content: "do it" }], tools: [writeTool] }));
    const start = events.find((e) => e.type === "toolcall_start");
    const end = events.find((e) => e.type === "toolcall_end");
    const done = events.find((e) => e.type === "done");
    expect(start).toBeDefined();
    expect(end.toolCall).toEqual({ type: "toolCall", id: "tu_1", name: "write_file", arguments: { path: "a.txt", content: "hi" } });
    expect(done.reason).toBe("toolUse");
    expect(done.message.content.some((c: any) => c.type === "toolCall")).toBe(true);
    expect(done.message.stopReason).toBe("toolUse");
  });

  test("mixed text + tool_use: text events precede the tool call, content holds both", async () => {
    mockFetch({ content: [{ type: "text", text: "Writing it now." }, { type: "tool_use", id: "tu_2", name: "write_file", input: { path: "b.txt" } }], stop_reason: "tool_use", usage: {} });
    const events = await collect(anthropic(model, { messages: [{ role: "user", content: "x" }], tools: [writeTool] }));
    const order = events.map((e) => e.type);
    expect(order.indexOf("text_end")).toBeLessThan(order.indexOf("toolcall_start"));
    const done = events.find((e) => e.type === "done");
    expect(done.message.content[0]).toEqual({ type: "text", text: "Writing it now." });
    expect(done.message.content[1].type).toBe("toolCall");
  });

  test("request wire format: tools carry input_schema; a prior round-trip is tool_use + tool_result", async () => {
    let body: any;
    mockFetch({ content: [{ type: "text", text: "done" }], stop_reason: "end_turn", usage: {} }, (_u, init) => { body = JSON.parse(init.body); });
    await collect(anthropic(model, {
      messages: [
        { role: "user", content: "create a.txt" },
        { role: "assistant", content: [{ type: "text", text: "sure" }, { type: "toolCall", id: "tu_9", name: "write_file", arguments: { path: "a.txt" } }] },
        { role: "toolResult", toolCallId: "tu_9", toolName: "write_file", content: [{ type: "text", text: "wrote a.txt" }], isError: false },
      ],
      tools: [writeTool],
    }));
    // tools serialized to Anthropic shape
    expect(body.tools[0].name).toBe("write_file");
    expect(body.tools[0].input_schema.type).toBe("object");
    expect(body.tools[0].input_schema.properties.path).toBeDefined();
    // prior assistant tool call → tool_use block
    const asst = body.messages.find((m: any) => m.role === "assistant");
    expect(asst.content.some((b: any) => b.type === "tool_use" && b.id === "tu_9")).toBe(true);
    // tool result → tool_result block referencing the same id
    const tr = body.messages.find((m: any) => Array.isArray(m.content) && m.content.some((b: any) => b.type === "tool_result"));
    expect(tr.content[0].tool_use_id).toBe("tu_9");
    expect(tr.content[0].content).toContain("wrote a.txt");
  });

  test("text-only response is unchanged (no tools key, reason stop, no toolcall events)", async () => {
    let body: any;
    mockFetch({ content: [{ type: "text", text: "hello world" }], stop_reason: "end_turn", usage: { input_tokens: 3, output_tokens: 2 } }, (_u, init) => { body = JSON.parse(init.body); });
    const events = await collect(anthropic(model, { messages: [{ role: "user", content: "hi" }] })); // no tools
    const done = events.find((e) => e.type === "done");
    expect(done.reason).toBe("stop");
    expect(done.message.content).toEqual([{ type: "text", text: "hello world" }]);
    expect(events.some((e) => e.type === "toolcall_start")).toBe(false);
    expect(body.tools).toBeUndefined();
  });

});

describe("AskSage Gemini tool use", () => {
  const google = makeAsksageStream("google", () => cfg);
  const gemini = { id: "gemini-x", api: "asksage-google", provider: "asksage-google", maxTokens: 1000 };

  test("a functionCall response emits toolcall_start/end with stopReason toolUse", async () => {
    mockFetch({ candidates: [{ content: { parts: [{ functionCall: { name: "write_file", args: { path: "x.txt" } } }] }, finishReason: "STOP" }], usageMetadata: {} });
    const events = await collect(google(gemini, { messages: [{ role: "user", content: "go" }], tools: [writeTool] }));
    const end = events.find((e) => e.type === "toolcall_end");
    expect(end.toolCall.name).toBe("write_file");
    expect(end.toolCall.arguments).toEqual({ path: "x.txt" });
    const done = events.find((e) => e.type === "done");
    expect(done.reason).toBe("toolUse");
    expect(done.message.content.some((c: any) => c.type === "toolCall")).toBe(true);
  });

  test("wire format: functionDeclarations carry parametersJsonSchema; round-trip is functionCall + functionResponse by name", async () => {
    let body: any;
    mockFetch({ candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }], usageMetadata: {} }, (_u, init) => { body = JSON.parse(init.body); });
    await collect(google(gemini, {
      messages: [
        { role: "user", content: "create a.txt" },
        { role: "assistant", content: [{ type: "toolCall", id: "write_file-0", name: "write_file", arguments: { path: "a.txt" } }] },
        { role: "toolResult", toolCallId: "write_file-0", toolName: "write_file", content: [{ type: "text", text: "wrote a.txt" }], isError: false },
      ],
      tools: [writeTool],
    }));
    expect(body.tools[0].functionDeclarations[0].name).toBe("write_file");
    expect(body.tools[0].functionDeclarations[0].parametersJsonSchema).toBeDefined();
    const modelTurn = body.contents.find((c: any) => c.role === "model");
    expect(modelTurn.parts.some((p: any) => p.functionCall?.name === "write_file")).toBe(true);
    const userTurn = body.contents.find((c: any) => Array.isArray(c.parts) && c.parts.some((p: any) => p.functionResponse));
    expect(userTurn.parts[0].functionResponse.name).toBe("write_file"); // Gemini matches by name, not id
    expect(userTurn.parts[0].functionResponse.response.output).toContain("wrote a.txt");
  });

  test("text-only with no tools is unchanged (no tools key, reason stop)", async () => {
    let body: any;
    mockFetch({ candidates: [{ content: { parts: [{ text: "google reply" }] } }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 3 } }, (_u, init) => { body = JSON.parse(init.body); });
    const events = await collect(google(gemini, { messages: [{ role: "user", content: "hi" }] }));
    const done = events.find((e) => e.type === "done");
    expect(done.reason).toBe("stop");
    expect(done.message.content).toEqual([{ type: "text", text: "google reply" }]);
    expect(body.tools).toBeUndefined();
  });
});

// ── Diagnostics + tolerant extraction (P-ASKSAGE.1, ADR-0055) ────────────────────────────────────────
// These cover the "gives up too soon" failure mode: a follow-up response whose content we'd otherwise
// drop (proxy wraps it differently) → empty turn → omp thinks the model finished. Tolerant extraction
// recovers it; the diagnostics make every call (and the empty-response anomaly) observable.
function mockResp(opts: { ok?: boolean; status?: number; json: any }, capture?: (url: string, init: any) => void): void {
  globalThis.fetch = (async (url: any, init: any) => {
    capture?.(String(url), init);
    return { ok: opts.ok ?? true, status: opts.status ?? 200, json: async () => opts.json } as any;
  }) as any;
}
/** Run `fn` with LUCID_ASKSAGE_DEBUG on and capture parsed `[ASKSAGE_DIAG]` records from stderr. */
async function withDiag(fn: () => Promise<void>): Promise<any[]> {
  const lines: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.env.LUCID_ASKSAGE_DEBUG = "1";
  (process.stderr as any).write = (s: any) => { lines.push(String(s)); return true; };
  try { await fn(); } finally { (process.stderr as any).write = orig; delete process.env.LUCID_ASKSAGE_DEBUG; }
  return lines.filter((l) => l.includes("[ASKSAGE_DIAG]")).map((l) => JSON.parse(l.slice(l.indexOf("{"))));
}

describe("AskSage diagnostics + tolerant extraction", () => {
  const google = makeAsksageStream("google", () => cfg);
  const gemini = { id: "gemini-x", api: "asksage-google", provider: "asksage-google", maxTokens: 1000 };

  test("Anthropic: a `response.content`-wrapped reply is still parsed (not dropped)", async () => {
    mockResp({ json: { response: { content: [{ type: "text", text: "recovered text" }] }, usage: {} } });
    const done = (await collect(anthropic(model, { messages: [{ role: "user", content: "x" }] }))).find((e) => e.type === "done");
    expect(done.message.content).toEqual([{ type: "text", text: "recovered text" }]);
    expect(done.reason).toBe("stop");
  });

  test("Anthropic: an OpenAI-chat-shaped reply (choices[].message) recovers text + tool calls", async () => {
    mockResp({ json: { choices: [{ message: { content: "doing it", tool_calls: [{ id: "c1", function: { name: "write_file", arguments: '{"path":"a.txt"}' } }] } }], usage: {} } });
    const events = await collect(anthropic(model, { messages: [{ role: "user", content: "x" }], tools: [writeTool] }));
    const end = events.find((e) => e.type === "toolcall_end");
    expect(end.toolCall).toEqual({ type: "toolCall", id: "c1", name: "write_file", arguments: { path: "a.txt" } });
    expect(events.find((e) => e.type === "done").reason).toBe("toolUse");
  });

  test("Gemini: a `{response: \"...\"}`-wrapped reply is still parsed", async () => {
    mockResp({ json: { response: "gemini wrapped reply", usageMetadata: {} } });
    const done = (await collect(google(gemini, { messages: [{ role: "user", content: "x" }] }))).find((e) => e.type === "done");
    expect(done.message.content).toEqual([{ type: "text", text: "gemini wrapped reply" }]);
  });

  test("diag is OFF without the env (no [ASKSAGE_DIAG] lines)", async () => {
    mockResp({ json: { content: [{ type: "text", text: "hi" }], usage: {} } });
    const lines: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (s: any) => { lines.push(String(s)); return true; };
    try { await collect(anthropic(model, { messages: [{ role: "user", content: "x" }] })); } finally { (process.stderr as any).write = orig; }
    expect(lines.some((l) => l.includes("[ASKSAGE_DIAG]"))).toBe(false);
  });

  test("diag records the request + parsed response per call (via=content, stopReason)", async () => {
    const recs = await withDiag(async () => {
      mockResp({ json: { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 2 } } });
      await collect(anthropic(model, { messages: [{ role: "user", content: "x" }], tools: [writeTool] }));
    });
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ route: "anthropic", ok: true, via: "content", tools: ["write_file"], textLen: 2 });
    expect(recs[0].anomaly).toBeUndefined();
  });

  test("diag flags an empty ok response as the `empty-response` anomaly (the give-up smoking gun)", async () => {
    const recs = await withDiag(async () => {
      mockResp({ json: { id: "x", usage: {} } }); // no content, no tool calls → empty turn
      await collect(anthropic(model, { messages: [{ role: "user", content: "x" }] }));
    });
    expect(recs[0].anomaly).toBe("empty-response");
    expect(recs[0].via).toBe("none");
    expect(typeof recs[0].raw).toBe("string"); // raw snippet captured for inspection
  });

  test("diag captures HTTP errors with a raw snippet, and the stream errors", async () => {
    const recs = await withDiag(async () => {
      mockResp({ ok: false, status: 502, json: { error: { message: "bad gateway" } } });
      const events = await collect(google(gemini, { messages: [{ role: "user", content: "x" }] }));
      expect(events.some((e) => e.type === "error")).toBe(true);
    });
    expect(recs[0]).toMatchObject({ route: "google", ok: false, status: 502 });
    expect(recs[0].error).toContain("bad gateway");
  });
});
