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
import { normalizeSchemaForGoogle, toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";

export type AsksageRoute = "anthropic" | "google" | "query";
export interface AsksageStreamCfg { base: string; key: string }

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

// ── Diagnostics (P-ASKSAGE.1, ADR-0055) ─────────────────────────────────────────────────────────────
// AskSage serves Claude/Gemini NON-streamed, so each streamSimple call is one HTTP round-trip = one
// assistant turn; omp drives the agentic loop. When that loop "gives up too soon" (tools run, files end
// up half-written, no retry), the usual cause is invisible: a follow-up response we parse to EMPTY text
// + ZERO tool calls makes omp think the model finished. These diagnostics make every call observable.
// Enabled by env LUCID_ASKSAGE_DEBUG (the desktop sets it in developer mode). One `[ASKSAGE_DIAG] {json}`
// line per call to stderr; acp_backend's onStderr captures it into the developer Logs panel.
function diag(rec: Record<string, unknown>): void {
  if (!process.env.LUCID_ASKSAGE_DEBUG) return;
  try { process.stderr.write(`[ASKSAGE_DIAG] ${JSON.stringify(rec)}\n`); } catch { /* never let logging break a turn */ }
}
/** A short, safe snippet of a raw response for the anomaly/error log (never the whole body). */
function snippet(j: unknown): string {
  try { return JSON.stringify(j).slice(0, 600); } catch { return String(j).slice(0, 600); }
}
function safeJsonArgs(v: unknown): Record<string, any> {
  if (isRecord(v)) return v;
  if (typeof v === "string") { try { const p = JSON.parse(v); return isRecord(p) ? p : {}; } catch { return {}; } }
  return {};
}

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

// A Gemini `generateContent` content turn: text, or functionCall / functionResponse parts.
interface GoogleContent { role: "user" | "model"; parts: any[] }

// Build Gemini `contents`, PRESERVING tool-use structure (mirrors omp's native Google provider):
// an assistant `toolCall` → a `functionCall` part in a "model" turn; an omp `toolResult` → a
// `functionResponse` part ({output} or {error}) merged into a "user" turn. Real Gemini models match
// responses to calls by NAME (no id — omp's `requiresToolCallId` is false for non-Claude models).
function toGoogleContents(context: any): { system: string; contents: GoogleContent[] } {
  const system = ((context?.systemPrompt ?? []) as string[]).join("\n\n").trim();
  const contents: GoogleContent[] = [];
  for (const m of (context?.messages ?? []) as any[]) {
    if (m.role === "assistant") {
      const parts: any[] = [];
      for (const c of Array.isArray(m.content) ? m.content : []) {
        if (c?.type === "text" && typeof c.text === "string" && c.text) parts.push({ text: c.text });
        else if (c?.type === "toolCall") parts.push({ functionCall: { name: String(c.name), args: isRecord(c.arguments) ? c.arguments : {} } });
      }
      if (!parts.length) { const t = extractText(m.content); if (t.trim()) parts.push({ text: t }); }
      if (parts.length) contents.push({ role: "model", parts });
    } else if (m.role === "toolResult") {
      const value = extractText(m.content) || " ";
      const part = { functionResponse: { name: String(m.toolName ?? ""), response: m.isError ? { error: value } : { output: value } } };
      const last = contents[contents.length - 1];
      if (last && last.role === "user" && last.parts.some((p: any) => p.functionResponse)) last.parts.push(part);
      else contents.push({ role: "user", parts: [part] });
    } else {
      const t = extractText(m.content);
      if (t.trim()) contents.push({ role: "user", parts: [{ text: t }] });
    }
  }
  if (!contents.length) contents.push({ role: "user", parts: [{ text: " " }] });
  return { system, contents };
}

const jsonHeaders = (key: string, extra: Record<string, string> = {}) => ({
  "content-type": "application/json", "x-access-tokens": key, authorization: `Bearer ${key}`, ...extra,
});

interface RouteResult { text: string; usage: { input: number; output: number; cacheRead: number; cacheWrite: number } }
interface AnthropicResult extends RouteResult { toolCalls: OmpToolCall[]; stopReason: "stop" | "length" | "toolUse" }

// Locate the Anthropic content blocks TOLERANTLY. The standard reply is `{ content: [...] }` (verified
// live for text), but a proxy may wrap it. Fallbacks can only RECOVER content the strict parse would
// drop (they fire only when `content` is absent), and `via` records which shape actually matched so a
// live test reveals the real wire format instead of silently emitting an empty turn. ADR-0055.
function anthropicBlocks(j: any): { blocks: any[]; via: string } {
  if (Array.isArray(j?.content)) return { blocks: j.content, via: "content" };
  if (Array.isArray(j?.response?.content)) return { blocks: j.response.content, via: "response.content" };
  if (Array.isArray(j?.message?.content)) return { blocks: j.message.content, via: "message.content" };
  // Some gateways normalize everything to the OpenAI chat shape.
  const choice = j?.choices?.[0]?.message;
  if (isRecord(choice)) {
    const b: any[] = [];
    if (typeof choice.content === "string" && choice.content) b.push({ type: "text", text: choice.content });
    for (const tc of (Array.isArray(choice.tool_calls) ? choice.tool_calls : [])) b.push({ type: "tool_use", id: (tc as any)?.id, name: (tc as any)?.function?.name, input: safeJsonArgs((tc as any)?.function?.arguments) });
    if (b.length) return { blocks: b, via: "openai-choices" };
  }
  for (const k of ["response", "message", "completion", "text", "answer"]) {
    if (typeof j?.[k] === "string" && j[k].trim()) return { blocks: [{ type: "text", text: j[k] }], via: `string:${k}` };
  }
  return { blocks: [], via: "none" };
}

// Call AskSage's Anthropic Messages route WITH tool support: pass the tool definitions, and parse both
// text and `tool_use` content blocks from the reply so omp can execute the calls and loop (previously
// tools were dropped, so Claude emitted tool-call XML as plain text and nothing ran).
async function callAnthropic(cfg: AsksageStreamCfg, model: string, system: string, messages: AnthropicMsg[], tools: any[] | undefined, maxTokens: number): Promise<AnthropicResult> {
  const body: any = { model, max_tokens: maxTokens, ...(system ? { system } : {}), messages };
  const toolNames = Array.isArray(tools) ? tools.map((t) => t?.name) : [];
  if (Array.isArray(tools) && tools.length) {
    body.tools = tools.map((t) => ({ name: t.name, description: t.description ?? "", input_schema: toolInputSchema(t) }));
  }
  const reqDiag = { route: "anthropic", model, maxTokens, tools: toolNames, msgs: messages.length };
  let r: Response;
  try {
    r = await fetch(`${cfg.base}/anthropic/v1/messages`, { method: "POST", headers: jsonHeaders(cfg.key, { "anthropic-version": "2023-06-01" }), body: JSON.stringify(body) });
  } catch (e) {
    diag({ ...reqDiag, ok: false, error: `fetch failed: ${String((e as Error)?.message ?? e)}` });
    throw e;
  }
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) {
    diag({ ...reqDiag, status: r.status, ok: false, error: j?.error?.message ?? `HTTP ${r.status}`, raw: snippet(j) });
    throw new Error(j?.error?.message ?? `AskSage anthropic HTTP ${r.status}`);
  }
  const { blocks: content, via } = anthropicBlocks(j);
  const text = content.filter((c) => c?.type === "text" && typeof c.text === "string").map((c) => c.text).join("");
  const toolCalls: OmpToolCall[] = content
    .filter((c) => c?.type === "tool_use")
    .map((c) => ({ type: "toolCall", id: String(c.id ?? ""), name: String(c.name ?? ""), arguments: isRecord(c.input) ? c.input : {} }));
  const stopReason: AnthropicResult["stopReason"] = j?.stop_reason === "tool_use" || toolCalls.length ? "toolUse" : j?.stop_reason === "max_tokens" ? "length" : "stop";
  const u = j?.usage ?? {};
  const anomaly = (!text && !toolCalls.length) ? "empty-response" : stopReason === "length" ? "truncated" : undefined;
  diag({ ...reqDiag, status: r.status, ok: true, respKeys: Object.keys(j ?? {}), via, textLen: text.length, toolCalls: toolCalls.map((t) => t.name), stopReason: j?.stop_reason ?? stopReason, usage: { in: u.input_tokens ?? 0, out: u.output_tokens ?? 0 }, ...(anomaly ? { anomaly, raw: snippet(j) } : {}) });
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
  if (!r.ok) { diag({ route: "query", model, status: r.status, ok: false, error: j?.error ?? j?.message ?? `HTTP ${r.status}`, raw: snippet(j) }); throw new Error(j?.error ?? j?.message ?? `AskSage query HTTP ${r.status}`); }
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

interface GoogleResult extends RouteResult { toolCalls: OmpToolCall[]; stopReason: "stop" | "length" | "toolUse" }

// Call AskSage's Gemini route WITH tool support: pass functionDeclarations, parse functionCall parts.
// Mirrors omp's native Google provider — `parametersJsonSchema` (full JSON Schema, normalized for
// Google) for real Gemini models. Gemini gives no call id, so we mint a synthetic one (omp tracks the
// call→result mapping internally and replays the result back by NAME).
// Locate the Gemini parts TOLERANTLY (mirrors anthropicBlocks). Standard shape is
// candidates[0].content.parts; `via` records what matched so a live test reveals the real format. ADR-0055.
function googleParts(j: any): { parts: any[]; via: string } {
  const std = j?.candidates?.[0]?.content?.parts;
  if (Array.isArray(std)) return { parts: std, via: "candidates" };
  if (Array.isArray(j?.content?.parts)) return { parts: j.content.parts, via: "content.parts" };
  if (Array.isArray(j?.parts)) return { parts: j.parts, via: "parts" };
  for (const k of ["response", "message", "text", "answer"]) {
    if (typeof j?.[k] === "string" && j[k].trim()) return { parts: [{ text: j[k] }], via: `string:${k}` };
  }
  return { parts: [], via: "none" };
}

async function callGoogle(cfg: AsksageStreamCfg, model: string, system: string, contents: GoogleContent[], tools: any[] | undefined, maxTokens: number): Promise<GoogleResult> {
  const body: any = { contents, ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}), generationConfig: { maxOutputTokens: maxTokens } };
  const toolNames = Array.isArray(tools) ? tools.map((t) => t?.name) : [];
  if (Array.isArray(tools) && tools.length) {
    body.tools = [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description ?? "", parametersJsonSchema: normalizeSchemaForGoogle(toolWireSchema(t)) })) }];
  }
  const reqDiag = { route: "google", model, maxTokens, tools: toolNames, msgs: contents.length };
  let r: Response;
  try {
    r = await fetch(`${cfg.base}/google/v1beta/models/${model}:generateContent`, { method: "POST", headers: jsonHeaders(cfg.key), body: JSON.stringify(body) });
  } catch (e) {
    diag({ ...reqDiag, ok: false, error: `fetch failed: ${String((e as Error)?.message ?? e)}` });
    throw e;
  }
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) {
    diag({ ...reqDiag, status: r.status, ok: false, error: j?.error?.message ?? `HTTP ${r.status}`, raw: snippet(j) });
    throw new Error(j?.error?.message ?? `AskSage google HTTP ${r.status}`);
  }
  const { parts, via } = googleParts(j);
  const text = parts.filter((p) => typeof p?.text === "string").map((p) => p.text).join("");
  let n = 0;
  const toolCalls: OmpToolCall[] = parts
    .filter((p) => p?.functionCall)
    .map((p) => ({ type: "toolCall", id: `${p.functionCall.name || "tool"}-${n++}`, name: String(p.functionCall.name ?? ""), arguments: isRecord(p.functionCall.args) ? p.functionCall.args : {} }));
  const finish = j?.candidates?.[0]?.finishReason;
  const stopReason: GoogleResult["stopReason"] = toolCalls.length ? "toolUse" : finish === "MAX_TOKENS" ? "length" : "stop";
  const um = j?.usageMetadata ?? {};
  const anomaly = (!text && !toolCalls.length) ? "empty-response" : stopReason === "length" ? "truncated" : undefined;
  diag({ ...reqDiag, status: r.status, ok: true, respKeys: Object.keys(j ?? {}), via, textLen: text.length, toolCalls: toolCalls.map((t) => t.name), stopReason: finish ?? stopReason, usage: { in: um.promptTokenCount ?? 0, out: um.candidatesTokenCount ?? 0 }, ...(anomaly ? { anomaly, raw: snippet(j) } : {}) });
  return { text, toolCalls, stopReason, usage: { input: um.promptTokenCount ?? 0, output: um.candidatesTokenCount ?? 0, cacheRead: 0, cacheWrite: 0 } };
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
      // Emit a (possibly tool-calling) assistant turn: text first, then one toolcall_start/end per call,
      // then `done`. omp executes each call (every one scanned by the in-process gate) and loops on toolUse.
      const emit = (text: string, toolCalls: OmpToolCall[], stop: "stop" | "length", usage: RouteResult["usage"]) => {
        const reason = toolCalls.length ? "toolUse" : stop;
        const content: any[] = [];
        if (text) content.push({ type: "text", text });
        for (const tc of toolCalls) content.push(tc);
        const message = mkMessage(content, reason, usage);
        stream.push({ type: "start", partial: message });
        let idx = 0;
        if (text) {
          stream.push({ type: "text_start", contentIndex: idx, partial: message });
          stream.push({ type: "text_delta", contentIndex: idx, delta: text, partial: message });
          stream.push({ type: "text_end", contentIndex: idx, content: text, partial: message });
          idx++;
        }
        for (const tc of toolCalls) {
          stream.push({ type: "toolcall_start", contentIndex: idx, partial: message });
          stream.push({ type: "toolcall_end", contentIndex: idx, toolCall: tc, partial: message });
          idx++;
        }
        stream.push({ type: "done", reason, message });
      };
      try {
        const maxTokens = Number(model?.maxTokens) || 8192;
        if (route === "anthropic") {
          const { system: sys, messages: amsgs } = toAnthropicMessages(context);
          const res = await callAnthropic(cfg, model.id, sys, amsgs, context?.tools, maxTokens);
          emit(res.text, res.toolCalls, res.stopReason === "length" ? "length" : "stop", res.usage);
          return;
        }
        if (route === "google") {
          const { system: sys, contents } = toGoogleContents(context);
          const res = await callGoogle(cfg, model.id, sys, contents, context?.tools, maxTokens);
          emit(res.text, res.toolCalls, res.stopReason === "length" ? "length" : "stop", res.usage);
          return;
        }
        // RAG /query: single-message, text-only (no tool use).
        const { text, usage } = await callQuery(cfg, system, messages);
        emit(text, [], "stop", usage);
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
