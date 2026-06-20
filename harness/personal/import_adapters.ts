// harness/personal/import_adapters.ts — parse third-party AI chat exports (OpenAI ChatGPT,
// Anthropic Claude) into a normalized conversation list. PURE, dependency-free, offline.
//
// The normalized output is UNTRUSTED external content. The importer (importer.ts) runs every
// USER message through the fail-closed scanner gate before anything enters the personalization
// store — a poisoned message in an old transcript is quarantined exactly like a live one
// (keystone #2). These adapters only RESHAPE; they never decide what is remembered.
//
// Formats (both export a top-level JSON array named `conversations.json`):
//   - OpenAI ChatGPT: each conversation has a `mapping` of node-id → { message:{author.role,
//     content.parts}, parent, children }. We flatten the node map (tree order isn't needed for
//     fact extraction) and sort by create_time.
//   - Anthropic Claude: each conversation has `chat_messages: [{ sender:"human"|"assistant",
//     text, content:[{type:"text",text}] }]`.

export type ImportVendor = "openai" | "anthropic";
export interface ImportedMessage { role: "user" | "assistant"; text: string }
export interface ImportedConversation { title: string; messages: ImportedMessage[] }
export interface ParsedExport { vendor: ImportVendor; conversations: ImportedConversation[] }

const MAX_MSG = 32_000; // bound one message's text so a giant paste can't bloat the scan
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const clipMsg = (s: string): string => (s.length > MAX_MSG ? s.slice(0, MAX_MSG) : s);

// Pull readable text from a content blob that may be a string, an array of strings, or an
// array of {text}/{input_text} parts (covers ChatGPT `parts` + Claude `content` blocks).
function partsText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const out: string[] = [];
    for (const p of content) {
      if (typeof p === "string") out.push(p);
      else if (p && typeof p === "object") { const t = str((p as any).text ?? (p as any).input_text); if (t) out.push(t); }
    }
    return out.join("\n");
  }
  if (content && typeof content === "object") return str((content as any).text);
  return "";
}

function parseOpenAI(data: any[]): ImportedConversation[] {
  const convos: ImportedConversation[] = [];
  for (const c of data) {
    const mapping = c?.mapping;
    if (!mapping || typeof mapping !== "object") continue;
    const msgs: { t: number; role: "user" | "assistant"; text: string }[] = [];
    for (const node of Object.values(mapping) as any[]) {
      const m = node?.message;
      const role = m?.author?.role;
      if (role !== "user" && role !== "assistant") continue; // skip system/tool nodes
      const content = m?.content;
      const text = clipMsg((content?.parts !== undefined ? partsText(content.parts) : partsText(content)).trim());
      if (!text) continue;
      msgs.push({ t: Number(m?.create_time) || 0, role, text });
    }
    msgs.sort((a, b) => a.t - b.t);
    if (msgs.length) convos.push({ title: str(c?.title).trim() || "Untitled", messages: msgs.map((x) => ({ role: x.role, text: x.text })) });
  }
  return convos;
}

function parseAnthropic(data: any[]): ImportedConversation[] {
  const convos: ImportedConversation[] = [];
  for (const c of data) {
    const cm = c?.chat_messages;
    if (!Array.isArray(cm)) continue;
    const messages: ImportedMessage[] = [];
    for (const m of cm) {
      const role = m?.sender === "human" ? "user" : m?.sender === "assistant" ? "assistant" : null;
      if (!role) continue;
      const text = clipMsg((str(m?.text).trim() || partsText(m?.content).trim()));
      if (!text) continue;
      messages.push({ role, text });
    }
    if (messages.length) convos.push({ title: str(c?.name).trim() || "Untitled", messages });
  }
  return convos;
}

/** Sniff the vendor from the export's shape. null = unrecognized. */
export function detectVendor(data: unknown): ImportVendor | null {
  if (!Array.isArray(data)) return null;
  for (const item of data.slice(0, 25)) {
    if (!item || typeof item !== "object") continue;
    if ("mapping" in item && (item as any).mapping && typeof (item as any).mapping === "object") return "openai";
    if (Array.isArray((item as any).chat_messages)) return "anthropic";
  }
  return null;
}

/** Parse a decoded export (the JSON value of conversations.json) into normalized conversations.
 *  THROWS with a user-facing message when the shape is unrecognized. */
export function parseExport(data: unknown, vendorHint?: ImportVendor): ParsedExport {
  const vendor = vendorHint ?? detectVendor(data);
  if (!vendor) throw new Error("Unrecognized export — point to the conversations.json from a ChatGPT or Claude data export.");
  if (!Array.isArray(data)) throw new Error("Export root must be a JSON array of conversations.");
  return { vendor, conversations: vendor === "openai" ? parseOpenAI(data) : parseAnthropic(data) };
}
