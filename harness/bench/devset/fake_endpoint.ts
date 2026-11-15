// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/bench/devset/fake_endpoint.ts - P-BENCH.2a (ADR-0591): a stand-in OpenAI-compatible server.
//
// The dev set's real target is a local model behind an OpenAI-compatible endpoint, and this sandbox and CI
// have none. This server speaks enough of that protocol (streamed chat completions with tool calls) for
// omp to drive it exactly as it drives Ollama or vLLM, and answers with a scripted policy. It proves the
// endpoint path works end to end, so the first run against a real model is not also the first run of the
// code. It listens on loopback only and is used by tests and the demo, never by the app.

import type { Policy, Transcript } from "./policies.ts";

interface ChatMessage { role?: string; content?: unknown; tool_calls?: { id?: string; function?: { name?: string } }[]; tool_call_id?: string }

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((c) => (typeof c === "object" && c !== null && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : "")).join("");
}

/** PURE: what an OpenAI chat request has shown the model so far. The task prompt is the LAST user message
 *  that names the scoring line (omp may put its own context in earlier ones). */
export function transcriptOf(messages: readonly ChatMessage[]): Transcript {
  const names = new Map<string, string>();
  for (const m of messages) for (const c of m.tool_calls ?? []) if (c.id) names.set(c.id, c.function?.name ?? "");
  const users = messages.filter((m) => m.role === "user").map((m) => textOf(m.content));
  const prompt = [...users].reverse().find((u) => u.includes("ANSWER:")) ?? users[users.length - 1] ?? "";
  const results = messages.filter((m) => m.role === "tool").map((m) => ({ name: names.get(m.tool_call_id ?? "") ?? "", text: textOf(m.content) }));
  return { prompt, results };
}

export interface FakeEndpoint {
  baseUrl: string;
  requests: number;
  /** One line per request: what the model had been shown and what it did. For diagnosing a run. */
  trace: string[];
  /** The tool names the last chat request offered the model. */
  offered: string[];
  stop(): void;
}

/** Start the server on a free loopback port. With `bearer`, every request without that key answers 401,
 *  the way a credentialed vLLM does. */
export function startFakeEndpoint(policy: Policy, model = "fake-local", bearer?: string): FakeEndpoint {
  let calls = 0;
  const state = { requests: 0, offered: [] as string[] };
  const trace: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      if (bearer && req.headers.get("authorization") !== `Bearer ${bearer}`) return Response.json({ error: "Unauthorized" }, { status: 401 });
      const url = new URL(req.url);
      if (!url.pathname.endsWith("/chat/completions")) return Response.json({ object: "list", data: [{ id: model, object: "model" }] });
      state.requests += 1;
      const body = (await req.json().catch(() => ({}))) as { messages?: ChatMessage[]; tools?: { function?: { name?: string } }[] };
      state.offered = (body.tools ?? []).map((t) => t.function?.name ?? "");
      const shown = transcriptOf(body.messages ?? []);
      const step = policy(shown);
      const last = shown.results[shown.results.length - 1];
      trace.push(`${shown.results.map((r) => `${r.name}(${r.text.length})`).join(" > ") || "nothing yet"} => ${"call" in step ? `call ${step.call.name}` : step.answer}${last ? ` | last result: ${last.text.slice(0, 300).replace(/\n/g, " / ")}` : ""}`);
      const chunk = (delta: unknown, finish: string | null): string => `data: ${JSON.stringify({ id: `chatcmpl-${state.requests}`, object: "chat.completion.chunk", created: 0, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      const parts = "call" in step
        ? [
            chunk({ role: "assistant", content: null, tool_calls: [{ index: 0, id: `call_${++calls}`, type: "function", function: { name: step.call.name, arguments: JSON.stringify(step.call.arguments) } }] }, null),
            chunk({}, "tool_calls"),
          ]
        : [chunk({ role: "assistant", content: step.answer }, null), chunk({}, "stop")];
      const enc = new TextEncoder();
      const stream = new ReadableStream({ start(c) { for (const p of parts) c.enqueue(enc.encode(p)); c.enqueue(enc.encode("data: [DONE]\n\n")); c.close(); } });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    },
  });
  return { baseUrl: `http://127.0.0.1:${server.port}/v1`, get requests() { return state.requests; }, get offered() { return state.offered; }, trace, stop: () => server.stop(true) };
}
