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
// Intentionally omp-import-free (typed `any`) so it loads under any omp version.
// URL construction is verified against the installed omp: openai-completions hits
// `${baseUrl}/chat/completions`, anthropic-messages hits `${baseUrl}/v1/messages`.

const DEFAULT_BASE = "https://api.civ.asksage.ai/server";

interface ModelSpec {
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  thinking?: unknown;
}

// AskSage model ids must match what the gateway expects in the request `model`
// field (mirrors the prototype's curated list). Cost is cosmetic here (AskSage
// bills via a monthly token quota, surfaced separately in the desktop).
const OPENAI_MODELS: ModelSpec[] = [
  { id: "gpt-5.2", name: "GPT-5.2 · AskSage Gov", reasoning: false, contextWindow: 256_000, maxTokens: 32_000 },
  { id: "gpt-5", name: "GPT-5 · AskSage Gov", reasoning: false, contextWindow: 256_000, maxTokens: 32_000 },
  { id: "gpt-5-mini", name: "GPT-5 mini · AskSage Gov", reasoning: false, contextWindow: 256_000, maxTokens: 32_000 },
  { id: "o3", name: "o3 · AskSage Gov", reasoning: true, contextWindow: 200_000, maxTokens: 100_000 },
  { id: "o4-mini", name: "o4-mini · AskSage Gov", reasoning: true, contextWindow: 200_000, maxTokens: 100_000 },
];

const ANTHROPIC_THINKING = { mode: "anthropic-adaptive", efforts: ["minimal", "low", "medium", "high"] };
const ANTHROPIC_MODELS: ModelSpec[] = [
  { id: "claude-opus-4", name: "Claude Opus 4 · AskSage Gov", reasoning: true, contextWindow: 200_000, maxTokens: 32_000, thinking: ANTHROPIC_THINKING },
  { id: "claude-sonnet-4", name: "Claude Sonnet 4 · AskSage Gov", reasoning: true, contextWindow: 200_000, maxTokens: 64_000, thinking: ANTHROPIC_THINKING },
  { id: "claude-haiku-3.5", name: "Claude Haiku 3.5 · AskSage Gov", reasoning: false, contextWindow: 200_000, maxTokens: 8_192 },
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

    // Anthropic route: omp appends `/v1/messages` to baseUrl and sends `x-api-key`
    // from apiKey; we add `x-access-tokens`.
    pi.registerProvider("asksage-anthropic", {
      baseUrl: `${base}/anthropic`,
      api: "anthropic-messages",
      apiKey: "ASKSAGE_API_KEY",
      headers: { "x-access-tokens": key },
      models: toProviderModels(ANTHROPIC_MODELS),
    });

    process.stderr.write(`\n🏛️  [LucidAgentIDE] AskSage gov gateway registered (${base})\n`);
  } catch (e) {
    // Never break the session if registration shape is off — log and carry on.
    process.stderr.write(`\n[LucidAgentIDE] AskSage registration skipped: ${String((e as Error)?.message ?? e)}\n`);
  }
}
