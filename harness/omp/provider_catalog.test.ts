// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// R-07 (#347): CI diff against omp's builtin provider catalog.
//
// omp ships 60 builtin providers at the pinned version and grows the list constantly (the R-07 risk:
// provider churn routes around sovereignty governance). This test pins the sorted id universe from
// @oh-my-pi/pi-catalog so any omp bump that adds or removes a provider FAILS here, forcing a review:
//   - ADDED ids: check them against the sovereignty posture (non-allied providers, gov routing) and the
//     managed models allowlists / the add-on's governance packs before anyone can route to them, then re-pin.
//   - REMOVED ids: a configured managed allowlist or pack that names them silently stops matching;
//     review those policies, then re-pin.
// Runtime-registered providers (the AskSage gov gateway extension, local providers) are OURS and are
// intentionally not part of this pin; the pin covers exactly what upstream ships.

import { expect, test } from "bun:test";
import { CATALOG_PROVIDERS } from "@oh-my-pi/pi-catalog";

// Pinned universe at @oh-my-pi/pi-catalog 16.1.20 (the exact version package.json pins). Sorted, 57 ids.
const PINNED_PROVIDER_IDS = [
	"aimlapi", "alibaba-coding-plan", "amazon-bedrock", "anthropic", "azure", "cerebras",
	"cloudflare-ai-gateway", "cursor", "deepseek", "devin", "firepass", "fireworks",
	"github-copilot", "gitlab-duo", "google", "google-antigravity",
	"google-gemini-cli", "google-vertex", "groq", "huggingface", "kilo", "kimi-code", "litellm",
	"lm-studio", "minimax", "minimax-code", "minimax-code-cn", "mistral", "moonshot", "nanogpt",
	"nvidia", "ollama", "ollama-cloud", "openai", "openai-codex", "opencode-go", "opencode-zen",
	"openrouter", "qianfan", "qwen-portal", "sakana", "synthetic", "together", "umans", "venice",
	"vercel-ai-gateway", "vllm", "wafer-serverless", "xai", "xai-oauth", "xiaomi",
	"xiaomi-token-plan-ams", "xiaomi-token-plan-cn", "xiaomi-token-plan-sgp", "zai", "zenmux",
	"zhipu-coding-plan",
] as const;

test("omp's builtin provider catalog matches the R-07 pin (review + re-pin on drift)", () => {
	const live = CATALOG_PROVIDERS.map((p) => p.id).sort();
	const pinned = new Set<string>(PINNED_PROVIDER_IDS);
	const liveSet = new Set(live);
	const added = live.filter((id) => !pinned.has(id));
	const removed = PINNED_PROVIDER_IDS.filter((id) => !liveSet.has(id));
	if (added.length || removed.length) {
		throw new Error(
			`omp's builtin provider catalog drifted from the R-07 pin.\n` +
				`  added:   ${added.join(", ") || "(none)"}\n` +
				`  removed: ${removed.join(", ") || "(none)"}\n` +
				`Review additions against the sovereignty posture (managed models allowlists, the add-on's ` +
				`governance classification packs) and removals against any policy that names them, then update ` +
				`PINNED_PROVIDER_IDS in this file.`,
		);
	}
	expect(live.length).toBe(PINNED_PROVIDER_IDS.length);
});

test("every catalog entry has a non-empty string id (the pin's comparison key is sound)", () => {
	for (const p of CATALOG_PROVIDERS) {
		expect(typeof p.id).toBe("string");
		expect(p.id.length).toBeGreaterThan(0);
	}
});
