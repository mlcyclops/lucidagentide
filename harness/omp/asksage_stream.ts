// harness/omp/asksage_stream.ts
//
// A custom `streamSimple` adapter for AskSage's Claude and Gemini routes (ADR-0007
// addendum). AskSage serves those models NON-streamed, which omp's built-in
// anthropic/google providers (which expect SSE) can't parse — a live Claude turn
// consumed tokens but returned no text. This adapter calls AskSage's native
// non-streaming endpoints, then replays the full reply through omp's
// AssistantMessageEventStream as a single text delta.
//
// Verified live: POST /anthropic/v1/messages (with anthropic-version) and POST
// /google/v1beta/models/<id>:generateContent both return text + usage. This is the
// ONE omp import the AskSage extension needs (streamSimple is inherently tied to
// omp's event-stream type); registered via pi.registerProvider({ api, streamSimple }).

import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";

export type AsksageRoute = "anthropic" | "google" | "query";
export interface AsksageStreamCfg { base: string; key: string }

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

// omp ToolCall content block (the shape omp's agent loop executes + the gate scans).
interface OmpToolCall { type: "toolCall"; id: string; name: string; arguments: Record<string, any> }

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter((c: any) => typeof c?.text === "string").map((c: any) => c.text).join("\n");
  }
  return "";
}

/** Flatten omp's Context (systemPrompt + messages) into a simple turn list. */
function toTurns(context: any): { system: string; messages: { role: "user" | "assistant"; text: string }[] } {
  const system = ((context?.systemPrompt ?? []) as string[]).join("\n\n").trim();
  const messages: { role: "user" | "assistant"; text: string }[] = [];
  for (const m of (context?.messages ?? []) as any[]) {
    const text = extractText(m?.content);
    if (!text.trim()) continue;
    if (m.role === "assistant") messages.push({ role: "assistant", text });
    else if (m.role === "toolResult") messages.push({ role: "user", text: `[tool result]\n${text}` });
    else messages.push({ role: "user", text }); // user / developer
  }
  if (!messages.length) messages.push({ role: "user", text: " " });
  return { system, messages };
}

// An Anthropic Messages API message: text content, or content BLOCKS (text / tool_use / tool_result).
interface AnthropicMsg { role: "user" | "assistant"; content: string | any[] }

// Build the Anthropic message array, PRESERVING tool-use structure (the text-flattening `toTurns` loses
// it). A prior assistant turn's `toolCall` content becomes `tool_use` blocks; `toolResult` messages
// become `tool_result` blocks merged into one user message (Anthropic requires tool_use to be answered
// by tool_result in the immediately following user turn). This is what makes multi-turn tool loops work.
function toAnthropicMessages(context: any): { system: string; messages: AnthropicMsg[] } {
  const system = ((context?.systemPrompt ?? []) as string[]).join("\n\n").trim();
  const out: AnthropicMsg[] = [];
  for (const m of (context?.messages ?? []) as any[]) {
    if (m.role === "assistant") {
      const blocks: any[] = [];
      for (const c of Array.isArray(m.content) ? m.content : []) {
        if (c?.type === "text" && typeof c.text === "string" && c.text) blocks.push({ type: "text", text: c.text });
        else if (c?.type === "toolCall") blocks.push({ type: "tool_use", id: String(c.id), name: String(c.name), input: isRecord(c.arguments) ? c.arguments : {} });
      }
      if (!blocks.length) { const t = extractText(m.content); if (t.trim()) blocks.push({ type: "text", text: t }); }
      if (blocks.length) out.push({ role: "assistant", content: blocks });
    } else if (m.role === "toolResult") {
      const block = { type: "tool_result", tool_use_id: String(m.toolCallId ?? ""), content: extractText(m.content) || " ", ...(m.isError ? { is_error: true } : {}) };
      const prev = out[out.length - 1];
      if (prev && prev.role === "user" && Array.isArray(prev.content) && prev.content.every((b: any) => b?.type === "tool_result")) prev.content.push(block);
      else out.push({ role: "user", content: [block] });
    } else {
      const t = extractText(m.content);
      if (t.trim()) out.push({ role: "user", content: t });
    }
  }
  if (!out.length) out.push({ role: "user", content: " " });
  if (out[0]?.role !== "user") out.unshift({ role: "user", content: " " }); // Anthropic: first message must be user
  return { system, messages: out };
}

// omp Tool → Anthropic `input_schema` (a JSON Schema object). `toolWireSchema` resolves Zod/ArkType/JSON
// Schema authoring shapes to a plain JSON Schema; we ensure the object/properties shape Anthropic requires.
function toolInputSchema(tool: any): Record<string, unknown> {
  let s: Record<string, unknown> = {};
  try { const w = toolWireSchema(tool); if (isRecord(w)) s = w; } catch { /* fall back to an empty object schema */ }
  return { ...s, type: "object", properties: isRecord(s.properties) ? s.properties : {} };
}

const jsonHeaders = (key: string, extra: Record<string, string> = {}) => ({
  "content-type": "application/json", "x-access-tokens": key, authorization: `Bearer ${key}`, ...extra,
});

interface RouteResult { text: string; usage: { input: number; output: number; cacheRead: number; cacheWrite: number } }
interface AnthropicResult extends RouteResult { toolCalls: OmpToolCall[]; stopReason: "stop" | "length" | "toolUse" }

// Call AskSage's Anthropic Messages route WITH tool support: pass the tool definitions, and parse both
// text and `tool_use` content blocks from the reply so omp can execute the calls and loop (previously
// tools were dropped, so Claude emitted tool-call XML as plain text and nothing ran).
async function callAnthropic(cfg: AsksageStreamCfg, model: string, system: string, messages: AnthropicMsg[], tools: any[] | undefined, maxTokens: number): Promise<AnthropicResult> {
  const body: any = { model, max_tokens: maxTokens, ...(system ? { system } : {}), messages };
  if (Array.isArray(tools) && tools.length) {
    body.tools = tools.map((t) => ({ name: t.name, description: t.description ?? "", input_schema: toolInputSchema(t) }));
  }
  const r = await fetch(`${cfg.base}/anthropic/v1/messages`, {
    method: "POST",
    headers: jsonHeaders(cfg.key, { "anthropic-version": "2023-06-01" }),
    body: JSON.stringify(body),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error?.message ?? `AskSage anthropic HTTP ${r.status}`);
  const content: any[] = Array.isArray(j?.content) ? j.content : [];
  const text = content.filter((c) => c?.type === "text" && typeof c.text === "string").map((c) => c.text).join("");
  const toolCalls: OmpToolCall[] = content
    .filter((c) => c?.type === "tool_use")
    .map((c) => ({ type: "toolCall", id: String(c.id ?? ""), name: String(c.name ?? ""), arguments: isRecord(c.input) ? c.input : {} }));
  const stopReason: AnthropicResult["stopReason"] = j?.stop_reason === "tool_use" || toolCalls.length ? "toolUse" : j?.stop_reason === "max_tokens" ? "length" : "stop";
  const u = j?.usage ?? {};
  return { text, toolCalls, stopReason, usage: { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 } };
}

// AskSage's /query returns citations INLINE at the end of `message` as a
// "References\n[1] …\n[2] …" section (the separate `references` field is empty),
// with [n] markers in the body. Split that trailing block out so the desktop can
// render it as an expandable <details> instead of a wall of text. Returns the
// answer body plus the parsed reference entries (one string per [n]).
function splitReferences(message: string): { body: string; refs: string[] } {
  const lines = message.replace(/\r/g, "").split("\n");
  let idx = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (/^\s*references\s*:?\s*$/i.test(lines[i] ?? "")) { idx = i; break; }
  if (idx === -1) return { body: message, refs: [] };
  const refs: string[] = [];
  let cur = "";
  for (const ln of lines.slice(idx + 1)) {
    if (/^\s*\[\d+\]/.test(ln)) { if (cur.trim()) refs.push(cur.trim()); cur = ln.trim(); }
    else if (cur) cur += " " + ln.trim();
  }
  if (cur.trim()) refs.push(cur.trim());
  if (!refs.length) return { body: message, refs: [] };
  return { body: lines.slice(0, idx).join("\n").trimEnd(), refs };
}

// AskSage's native /query route: a single `message`, with optional RAG grounding
// on `dataset` and a native `persona` id. One-shot (non-streamed). Underlying model
// + datasets + persona come from env (set by the desktop from the user's selection).
async function callQuery(cfg: AsksageStreamCfg, system: string, msgs: { role: string; text: string }[]): Promise<RouteResult & { references?: string }> {
  const model = process.env.ASKSAGE_QUERY_MODEL || "gpt-5.2";
  const datasets = (process.env.ASKSAGE_DATASETS || "").split(",").map((d) => d.trim()).filter(Boolean);
  const persona = Number(process.env.ASKSAGE_PERSONA || "") || undefined;
  // /query takes one message — flatten system + turns into a single transcript.
  const message = [system ? `[System guidance]\n${system}` : "", ...msgs.map((m) => `${m.role === "assistant" ? "Assistant" : "User"}: ${m.text}`)].filter(Boolean).join("\n\n");
  const body: any = { message, model, temperature: 0.0, limit_references: 5 };
  if (datasets.length) body.dataset = datasets;
  if (persona) body.persona = persona;
  const r = await fetch(`${cfg.base}/query`, { method: "POST", headers: jsonHeaders(cfg.key), body: JSON.stringify(body) });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error ?? j?.message ?? `AskSage query HTTP ${r.status}`);
  const raw = String(j?.message ?? j?.response ?? "").trim();
  const { body: answer, refs } = splitReferences(raw);
  // Prefer the datasets AskSage reports it actually grounded on (provenance) over what we asked for.
  const usedDs = Array.isArray(j?.provenance?.datasets) ? j.provenance.datasets.length : datasets.length;
  let text = answer;
  if (refs.length) {
    const items = refs.map((x) => `- ${x.replace(/\s+/g, " ").trim()}`).join("\n");
    const label = `📎 ${refs.length} reference${refs.length === 1 ? "" : "s"}${usedDs ? ` · grounded on ${usedDs} dataset${usedDs === 1 ? "" : "s"}` : ""}`;
    // Blank lines around the inner list so marked renders it as Markdown inside the HTML block.
    text = `${answer}\n\n<details class="rag-refs">\n<summary>${label}</summary>\n\n${items}\n\n</details>`;
  } else if (usedDs) {
    text = `${answer}\n\n<sub>Grounded on ${usedDs} dataset${usedDs === 1 ? "" : "s"} — no inline citations returned.</sub>`;
  }
  const u = j?.usage ?? {};
  return { text, usage: { input: u.input_tokens ?? u.prompt_tokens ?? 0, output: u.output_tokens ?? u.completion_tokens ?? 0, cacheRead: 0, cacheWrite: 0 } };
}

async function callGoogle(cfg: AsksageStreamCfg, model: string, system: string, msgs: { role: string; text: string }[]): Promise<RouteResult> {
  const contents = msgs.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.text }] }));
  const r = await fetch(`${cfg.base}/google/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: jsonHeaders(cfg.key),
    body: JSON.stringify({ contents, ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}) }),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error?.message ?? `AskSage google HTTP ${r.status}`);
  const text = (j?.candidates?.[0]?.content?.parts ?? []).map((p: any) => p?.text).filter(Boolean).join("");
  const um = j?.usageMetadata ?? {};
  return { text, usage: { input: um.promptTokenCount ?? 0, output: um.candidatesTokenCount ?? 0, cacheRead: 0, cacheWrite: 0 } };
}

/** Build a streamSimple bound to a route. `getCfg` is read lazily so a key/base
 *  change (without a respawn) is still picked up. */
export function makeAsksageStream(route: AsksageRoute, getCfg: () => AsksageStreamCfg) {
  return function streamSimple(model: any, context: any, _options?: any): AssistantMessageEventStream {
    const stream = new AssistantMessageEventStream();
    void (async () => {
      const cfg = getCfg();
      const { system, messages } = toTurns(context);
      const usageOf = (u: { input: number; output: number; cacheRead: number; cacheWrite: number }) => ({ ...u, totalTokens: u.input + u.output + u.cacheRead + u.cacheWrite });
      const mkMessage = (content: any[], stopReason: string, usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }): any => ({
        role: "assistant",
        content,
        api: model?.api ?? `asksage-${route}`,
        provider: model?.provider ?? `asksage-${route}`,
        model: model?.id ?? "",
        usage: usageOf(usage),
        stopReason,
        timestamp: Date.now(),
      });
      try {
        const maxTokens = Number(model?.maxTokens) || 8192;
        if (route === "anthropic") {
          // Tool-capable path: pass tools, parse tool_use blocks, and emit toolcall events so omp executes
          // them (each scanned by the in-process gate) and loops. Falls back to plain text when no tools.
          const { system: sys, messages: amsgs } = toAnthropicMessages(context);
          const res = await callAnthropic(cfg, model.id, sys, amsgs, context?.tools, maxTokens);
          const content: any[] = [];
          if (res.text) content.push({ type: "text", text: res.text });
          for (const tc of res.toolCalls) content.push(tc);
          const reason = res.toolCalls.length ? "toolUse" : res.stopReason === "length" ? "length" : "stop";
          const message = mkMessage(content, reason, res.usage);
          stream.push({ type: "start", partial: message });
          let idx = 0;
          if (res.text) {
            stream.push({ type: "text_start", contentIndex: idx, partial: message });
            stream.push({ type: "text_delta", contentIndex: idx, delta: res.text, partial: message });
            stream.push({ type: "text_end", contentIndex: idx, content: res.text, partial: message });
            idx++;
          }
          for (const tc of res.toolCalls) {
            stream.push({ type: "toolcall_start", contentIndex: idx, partial: message });
            stream.push({ type: "toolcall_end", contentIndex: idx, toolCall: tc, partial: message });
            idx++;
          }
          stream.push({ type: "done", reason, message });
          return;
        }
        // Google / RAG: text-only (no tool use; see Fix 5 in the bug doc).
        const { text, usage } = route === "query"
          ? await callQuery(cfg, system, messages)
          : await callGoogle(cfg, model.id, system, messages);
        const message = mkMessage(text ? [{ type: "text", text }] : [], "stop", usage);
        stream.push({ type: "start", partial: message });
        stream.push({ type: "text_start", contentIndex: 0, partial: message });
        stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
        stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
        stream.push({ type: "done", reason: "stop", message }); // resolves the final result
      } catch (e) {
        const errMessage = mkMessage([], "error");
        errMessage.errorMessage = String((e as Error)?.message ?? e);
        stream.push({ type: "error", reason: "error", error: errMessage });
        stream.fail(e);
      }
    })();
    return stream;
  };
}
