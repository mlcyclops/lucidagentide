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

export type AsksageRoute = "anthropic" | "google" | "query";
export interface AsksageStreamCfg { base: string; key: string }

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

const jsonHeaders = (key: string, extra: Record<string, string> = {}) => ({
  "content-type": "application/json", "x-access-tokens": key, authorization: `Bearer ${key}`, ...extra,
});

interface RouteResult { text: string; usage: { input: number; output: number; cacheRead: number; cacheWrite: number } }

async function callAnthropic(cfg: AsksageStreamCfg, model: string, system: string, msgs: { role: string; text: string }[], maxTokens: number): Promise<RouteResult> {
  const r = await fetch(`${cfg.base}/anthropic/v1/messages`, {
    method: "POST",
    headers: jsonHeaders(cfg.key, { "anthropic-version": "2023-06-01" }),
    body: JSON.stringify({ model, max_tokens: maxTokens, ...(system ? { system } : {}), messages: msgs.map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.text })) }),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error?.message ?? `AskSage anthropic HTTP ${r.status}`);
  const u = j?.usage ?? {};
  return { text: extractText(j?.content), usage: { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 } };
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
      const mkMessage = (text: string, stopReason: string, usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }): any => ({
        role: "assistant",
        content: text ? [{ type: "text", text }] : [],
        api: model?.api ?? `asksage-${route}`,
        provider: model?.provider ?? `asksage-${route}`,
        model: model?.id ?? "",
        usage: { ...usage, totalTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite },
        stopReason,
        timestamp: Date.now(),
      });
      try {
        const maxTokens = Number(model?.maxTokens) || 8192;
        const { text, usage } = route === "anthropic"
          ? await callAnthropic(cfg, model.id, system, messages, maxTokens)
          : route === "query"
            ? await callQuery(cfg, system, messages)
            : await callGoogle(cfg, model.id, system, messages);
        const message = mkMessage(text, "stop", usage);
        stream.push({ type: "start", partial: message });
        stream.push({ type: "text_start", contentIndex: 0, partial: message });
        stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
        stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
        stream.push({ type: "done", reason: "stop", message }); // resolves the final result
      } catch (e) {
        const errMessage = mkMessage("", "error");
        errMessage.errorMessage = String((e as Error)?.message ?? e);
        stream.push({ type: "error", reason: "error", error: errMessage });
        stream.fail(e);
      }
    })();
    return stream;
  };
}
