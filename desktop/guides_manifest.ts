// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/guides_manifest.ts - P-GUIDE.2: the single source of truth mapping provider ids (and the
// "choosing" onboarding entry) to bundled advisor guide files under renderer/guides/. Imported by
// THREE consumers that must never drift: dev.ts (/api/guides resolves ids to absolute paths),
// renderer/app.ts (provider cards render a guide link only for ids present here), and
// guides.test.ts (every mapped file must exist and honor the shared invariants). Pure data,
// browser-safe (the renderer bundle inlines it).

/** Guide id (provider card id, or "choosing" for the hub onboarding entry) -> filename in renderer/guides/. */
export const GUIDE_FILES: Record<string, string> = {
  choosing: "choosing_a_provider.html",
  google: "gemini_plans.html",
  "google-vertex": "gemini_plans.html", // the Gemini guide's Path C covers the Vertex/ADC route
  openai: "openai_plans.html",
  anthropic: "anthropic_plans.html",
  xai: "xai_plans.html",
  "github-copilot": "github_copilot_plans.html",
  azure: "azure_openai_plans.html",
  perplexity: "perplexity_plans.html",
  // The gated OTHERS section shares one guide: the sovereignty story is collective by design.
  openrouter: "openweight_plans.html",
  deepseek: "openweight_plans.html",
  moonshot: "openweight_plans.html",
  "qwen-portal": "openweight_plans.html",
  zai: "openweight_plans.html",
  minimax: "openweight_plans.html",
  groq: "openweight_plans.html",
  // Voice provider: creative-media work routes through the choosing guide's Creator section.
  elevenlabs: "choosing_a_provider.html",
};
