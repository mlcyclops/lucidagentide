// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// R-07 (#347): CI diff against omp's builtin provider catalog.
//
// omp ships a growing list of builtin providers (the R-07 risk: provider churn routes around sovereignty
// governance). This test pins the sorted id universe from @oh-my-pi/pi-catalog so any omp bump that adds or
// removes a provider FAILS here, forcing a review:
//   - ADDED ids: check them against the sovereignty posture (non-allied providers, gov routing) and the
//     managed models allowlists / the add-on's governance packs before anyone can route to them, then re-pin.
//   - REMOVED ids: a configured managed allowlist or pack that names them silently stops matching;
//     review those policies, then re-pin.
// Runtime-registered providers (the AskSage gov gateway extension, local providers) are OURS and are
// intentionally not part of this pin; the pin covers exactly what upstream ships.
//
// omp 18 dropped the CATALOG_PROVIDERS export; the universe is now the keys of DEFAULT_MODEL_PER_PROVIDER
// (one entry per provider the catalog knows). The first pin (drafted at 16.1.20, 57 ids) is a strict
// subset of this one. Ported to 18.2.10 with these 23 providers ADDED since that draft, pending the
// sovereignty review above: abliteration, aiand, alibaba-token-plan, baseten, bedrock-mantle, charm-hyper,
// cline-pass, commandcode, coreweave, deepinfra, gitlab-duo-agent, gmi-cloud, local, meta, muse-code, novita,
// siliconflow, siliconflow-cn, singularityapi-dev, singularityapi-tech, typesafe, web, yolo-auto.

import { expect, test } from "bun:test";
import { DEFAULT_MODEL_PER_PROVIDER } from "@oh-my-pi/pi-catalog";

// Pinned universe at @oh-my-pi/pi-catalog 18.2.10 (the exact version package.json pins). Sorted, 80 ids.
const PINNED_PROVIDER_IDS = [
	"abliteration", "aiand", "aimlapi", "alibaba-coding-plan", "alibaba-token-plan", "amazon-bedrock",
	"anthropic", "azure", "baseten", "bedrock-mantle", "cerebras", "charm-hyper", "cline-pass",
	"cloudflare-ai-gateway", "commandcode", "coreweave", "cursor", "deepinfra", "deepseek", "devin",
	"firepass", "fireworks", "github-copilot", "gitlab-duo", "gitlab-duo-agent", "gmi-cloud", "google",
	"google-antigravity", "google-gemini-cli", "google-vertex", "groq", "huggingface", "kilo",
	"kimi-code", "litellm", "lm-studio", "local", "meta", "minimax", "minimax-code", "minimax-code-cn",
	"mistral", "moonshot", "muse-code", "nanogpt", "novita", "nvidia", "ollama", "ollama-cloud", "openai",
	"openai-codex", "opencode-go", "opencode-zen", "openrouter", "qianfan", "qwen-portal", "sakana",
	"siliconflow", "siliconflow-cn", "singularityapi-dev", "singularityapi-tech", "synthetic", "together",
	"typesafe", "umans", "venice", "vercel-ai-gateway", "vllm", "wafer-serverless", "web", "xai",
	"xai-oauth", "xiaomi", "xiaomi-token-plan-ams", "xiaomi-token-plan-cn", "xiaomi-token-plan-sgp",
	"yolo-auto", "zai", "zenmux", "zhipu-coding-plan",
] as const;

test("omp's builtin provider catalog matches the R-07 pin (review + re-pin on drift)", () => {
	const live = Object.keys(DEFAULT_MODEL_PER_PROVIDER).sort();
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

test("every catalog provider id is a non-empty string (the pin's comparison key is sound)", () => {
	for (const id of Object.keys(DEFAULT_MODEL_PER_PROVIDER)) {
		expect(typeof id).toBe("string");
		expect(id.length).toBeGreaterThan(0);
	}
});
