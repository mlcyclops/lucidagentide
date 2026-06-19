// harness/omp/asksage_extension.ts
//
// Registers the AskSage government AI gateway (https://api.civ.asksage.ai/server)
// as an omp provider — WITHOUT forking omp. AskSage is an accredited proxy that
// fronts OpenAI / Anthropic / Google behind a non-standard `x-access-tokens`
// header. omp exposes a first-class `pi.registerProvider(name, config)` that takes
// a custom baseUrl + headers, so AskSage drops in as two providers (one per API
// route). See DECISIONS.md ADR-0007.
//
// Load it ALONGSIDE the security gate (both -e flags; omp's -e is repeatable):
//   omp acp -e harness/omp/security_extension.ts -e harness/omp/asksage_extension.ts
//
// Models registered here surface automatically over ACP as `model` config options,
// so the desktop picker shows them with no hardcoded list. Reads the key + base URL
// from env (the desktop passes them from ~/.omp/lucid-gui.json via applyEnv; keys
// are never committed). No key → registers nothing (quiet no-op).
//
// Routes:
//   - OpenAI (gpt/o-series): native omp `openai-completions` — AskSage streams it.
//   - Anthropic (claude) + Google (gemini): AskSage serves these NON-streamed, so
//     they use a custom `streamSimple` adapter (asksage_stream.ts) that calls
//     AskSage's non-streaming endpoints and replays the reply as one delta.
// The OpenAI path stays omp-import-free (typed `any`); the adapter is the one place
// that imports an omp type (AssistantMessageEventStream), which streamSimple requires.

import { makeAsksageStream } from "./asksage_stream.ts";

const DEFAULT_BASE = "https://api.civ.asksage.ai/server";

interface ModelSpec {
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  thinking?: unknown;
}

// AskSage model ids must match what the gateway accepts in the request `model`
// field — taken from the live `/openai/v1/models` on a real CIV account (note
// the o-series are `gpt-o3` / `gpt-o4-mini`, not `o3`). Cost is cosmetic here
// (AskSage bills via a monthly token quota, surfaced separately in the desktop).
const OPENAI_MODELS: ModelSpec[] = [
  { id: "gpt-5.2", name: "GPT-5.2 · AskSage Gov", reasoning: true, contextWindow: 256_000, maxTokens: 32_000 },
  { id: "gpt-5.5", name: "GPT-5.5 · AskSage Gov", reasoning: true, contextWindow: 256_000, maxTokens: 32_000 },
  { id: "gpt-5.4", name: "GPT-5.4 · AskSage Gov", reasoning: true, contextWindow: 256_000, maxTokens: 32_000 },
  { id: "gpt-5.1", name: "GPT-5.1 · AskSage Gov", reasoning: true, contextWindow: 256_000, maxTokens: 32_000 },
  { id: "gpt-5", name: "GPT-5 · AskSage Gov", reasoning: true, contextWindow: 256_000, maxTokens: 32_000 },
  { id: "gpt-5-mini", name: "GPT-5 mini · AskSage Gov", reasoning: true, contextWindow: 256_000, maxTokens: 32_000 },
  { id: "gpt-4.1", name: "GPT-4.1 · AskSage Gov", reasoning: false, contextWindow: 1_000_000, maxTokens: 32_000 },
  { id: "gpt-o3", name: "o3 · AskSage Gov", reasoning: true, contextWindow: 200_000, maxTokens: 100_000 },
  { id: "gpt-o3-mini", name: "o3-mini · AskSage Gov", reasoning: true, contextWindow: 200_000, maxTokens: 100_000 },
  { id: "gpt-o4-mini", name: "o4-mini · AskSage Gov", reasoning: true, contextWindow: 200_000, maxTokens: 100_000 },
];

// Claude + Gemini go through the streamSimple adapter (AskSage serves them
// non-streamed). reasoning:false — the adapter delivers a complete reply and does
// not implement provider thinking, so we don't surface a thinking control for them.
// Model ids verified to reply on a live CIV account (broken ones like gpt-5.4-gov
// (502) / gpt-5.4-sec (400) are intentionally omitted).
const ANTHROPIC_MODELS: ModelSpec[] = [
  { id: "google-claude-45-opus", name: "Claude 4.5 Opus · AskSage Gov", reasoning: false, contextWindow: 200_000, maxTokens: 32_000 },
  { id: "google-claude-45-sonnet", name: "Claude 4.5 Sonnet · AskSage Gov", reasoning: false, contextWindow: 200_000, maxTokens: 64_000 },
  { id: "aws-bedrock-claude-45-sonnet-gov", name: "Claude 4.5 Sonnet (Gov) · AskSage", reasoning: false, contextWindow: 200_000, maxTokens: 64_000 },
  { id: "claude-opus-4", name: "Claude Opus 4 · AskSage Gov", reasoning: false, contextWindow: 200_000, maxTokens: 32_000 },
  { id: "claude-sonnet-4", name: "Claude Sonnet 4 · AskSage Gov", reasoning: false, contextWindow: 200_000, maxTokens: 64_000 },
];
const GOOGLE_MODELS: ModelSpec[] = [
  { id: "google-gemini-3.1-pro-com", name: "Gemini 3.1 Pro · AskSage Gov", reasoning: false, contextWindow: 1_000_000, maxTokens: 64_000 },
  { id: "google-gemini-3.5-flash-gov", name: "Gemini 3.5 Flash (Gov) · AskSage", reasoning: false, contextWindow: 1_000_000, maxTokens: 64_000 },
  { id: "google-gemini-2.5-pro", name: "Gemini 2.5 Pro · AskSage Gov", reasoning: false, contextWindow: 1_000_000, maxTokens: 64_000 },
  { id: "google-gemini-2.5-flash", name: "Gemini 2.5 Flash · AskSage Gov", reasoning: false, contextWindow: 1_000_000, maxTokens: 64_000 },
];

const COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function toProviderModels(specs: ModelSpec[]): any[] {
  return specs.map((m) => ({
    id: m.id,
    name: m.name,
    reasoning: m.reasoning,
    ...(m.thinking ? { thinking: m.thinking } : {}),
    input: ["text", "image"],
    cost: COST,
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
  }));
}

export default function asksageExtension(pi: any): void {
  try {
    const key = process.env.ASKSAGE_API_KEY ?? "";
    if (!key) return; // no key → register nothing (the desktop sets it once saved)
    const base = (process.env.ASKSAGE_BASE_URL ?? DEFAULT_BASE).replace(/\/+$/, "");

    // OpenAI-compatible route: omp appends `/chat/completions` to baseUrl and sends
    // `Authorization: Bearer` from apiKey; we add AskSage's extra `x-access-tokens`.
    pi.registerProvider("asksage-openai", {
      baseUrl: `${base}/openai/v1`,
      api: "openai-completions",
      apiKey: "ASKSAGE_API_KEY",
      headers: { "x-access-tokens": key },
      models: toProviderModels(OPENAI_MODELS),
    });

    // Anthropic (claude) + Google (gemini): AskSage serves these non-streamed, so a
    // custom streamSimple adapter calls the native endpoints and replays the reply.
    const getCfg = () => ({ base: (process.env.ASKSAGE_BASE_URL ?? DEFAULT_BASE).replace(/\/+$/, ""), key: process.env.ASKSAGE_API_KEY ?? "" });
    pi.registerProvider("asksage-anthropic", {
      baseUrl: `${base}/anthropic`,
      api: "asksage-anthropic",
      apiKey: "ASKSAGE_API_KEY",
      headers: { "x-access-tokens": key },
      streamSimple: makeAsksageStream("anthropic", getCfg),
      models: toProviderModels(ANTHROPIC_MODELS),
    });
    pi.registerProvider("asksage-google", {
      baseUrl: `${base}/google/v1beta`,
      api: "asksage-google",
      apiKey: "ASKSAGE_API_KEY",
      headers: { "x-access-tokens": key },
      streamSimple: makeAsksageStream("google", getCfg),
      models: toProviderModels(GOOGLE_MODELS),
    });

    process.stderr.write(`\n🏛️  [LucidAgentIDE] AskSage gov gateway registered (${base})\n`);
  } catch (e) {
    // Never break the session if registration shape is off — log and carry on.
    process.stderr.write(`\n[LucidAgentIDE] AskSage registration skipped: ${String((e as Error)?.message ?? e)}\n`);
  }
}
