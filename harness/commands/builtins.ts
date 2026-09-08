// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/commands/builtins.ts - P-CMD.2 (ADR-0148): commands LUCID ships, presented exactly like the
// user's own saved "/" commands (same UserCommand shape, same expansion, same autocomplete). Merged into
// the list SERVER-side by `withBuiltins`: a user-saved command with the same name SHADOWS the builtin
// (their vocabulary wins), and deleting that user command resurfaces the builtin - no special cases
// anywhere downstream. Builtins are code, not workspace files, so the import gate/scanner path does not
// apply; they change only through a PR to this file.

import type { UserCommand } from "./spec.ts";

const NOW = 1_751_700_000_000;

/** /licensing - a guided, approval-gated walkthrough that applies the user's company license headers
 *  across their codebase. Interactive by design: it NEVER writes before the user approves the plan, and
 *  vendored/third-party trees are excluded loudly, not silently relicensed. */
const LICENSING: UserCommand = {
  name: "licensing",
  description: "Apply your company's license headers across the codebase - guided, approval-gated",
  mode: "send",
  spec_version: 1,
  created_at: NOW,
  updated_at: NOW,
  body: [
    "You are running LUCID's guided LICENSING walkthrough. Work with me interactively; NEVER write a file before I approve the plan.",
    "",
    "Context seed (may be empty): $ARGS",
    "",
    "1) DISCOVER the current state first: detect any existing license convention (LICENSE/COPYING files, SPDX headers, a header-check script, a pre-commit hook) and report it with counts - files WITH vs WITHOUT headers, grouped by top-level directory.",
    "2) INTERVIEW me for what you could not infer, in ONE short question set: the legal owner name exactly as it should appear; the license (an SPDX id like MIT / Apache-2.0 / BUSL-1.1, or proprietary text I paste); the copyright year or range; which trees are FIRST-PARTY vs vendored/generated. NEVER relicense vendor/, node_modules/, dist/, build outputs, or third-party code - list your planned exclusions and let me amend them.",
    "3) PLAN before touching anything: show the exact header block per file type using each language's comment syntax (// for TS/JS/Go/Rust/C-family, # for Python/shell/YAML/TOML, <!-- --> for HTML/Markdown/XML, /* */ for CSS, ; for INI), plus the per-directory counts the plan will touch. WAIT for my explicit approval.",
    "4) APPLY idempotently after approval: skip files already carrying the SPDX line or the exact header; insert AFTER a shebang or XML declaration when present; read each file then write it (never exists-then-read). Batch by directory and report progress as counts, not per-file noise.",
    "5) FINISH with totals (headered / already-had / excluded), then offer: (a) a header-check script suitable for CI, (b) a pre-commit hook that auto-applies headers to staged files, and (c) a LICENSE file if none exists. If any file's ownership looks ambiguous (mixed third-party code, a different pre-existing header), list it for my manual review instead of guessing.",
  ].join("\n"),
};

/** /providers - the guided "which AI plan should I buy and how do I wire it into LUCID" walkthrough
 *  (P-GUIDE.2 / P-CMD.3). Steers through the bundled advisor guides IN THE PREVIEW PANEL, verifies
 *  prices live (vendors reshuffle tiers constantly; the guides are dated snapshots), and finishes with
 *  the exact Settings clicks. Offers the voice upgrade last: ElevenLabs custom voices for Conversation
 *  mode, via the partner signup link, with the API-keys page kept separate (the key is what LUCID needs). */
const PROVIDERS: UserCommand = {
  name: "providers",
  description: "Choose the right AI provider + plan for what you're doing, then wire it into LUCID - guided",
  mode: "send",
  spec_version: 1,
  created_at: NOW,
  updated_at: NOW,
  body: [
    "You are running LUCID's guided PROVIDER walkthrough. Keep it simple and interactive: plain language, ONE question at a time, no jargon walls. What I am trying to do (may be empty): $ARGS",
    "",
    "1) START by asking me two things in one short message: (a) do I already pay for an AI plan - ChatGPT (OpenAI), Claude (Anthropic), Gemini (Google), or Grok (xAI) - or none yet; (b) if $ARGS didn't say, what kind of work I mainly want: coding, research/search, writing, creative media (video/audio/photo/3D), or regulated/government work.",
    "2) THEN fetch http://127.0.0.1:5319/api/guides (id → absolute path of LUCID's bundled advisor guides) and OPEN the relevant guide in the Preview panel with your preview-open tool so I can read along: the guide for the plan I already have (or 'choosing' when I have none), plus 'choosing' whenever my use case spans providers. Treat the guides' prices as September 2026 snapshots.",
    "3) VERIFY anything decision-critical with a live web search - current prices, which tiers still work with LUCID's OAuth (Google killed consumer Gemini CLI access in June 2026; check for similar moves), model availability - and tell me plainly when reality has drifted from the open guide.",
    "4) RECOMMEND one primary plan and one cheaper fallback, each with its monthly cost and one sentence on why it fits MY answer from step 1. If a free tier genuinely covers my use (the AI Studio key, Copilot Free), offer to start me there today so I can work while deciding. Special cases: creative media → tell me about the LUCID Creator edition special release at https://github.com/mlcyclops/lucidagentide/releases; regulated/government/CUI → steer me to the AskSage gateway card or Azure OpenAI under my own tenant and warn me off the ACKNOWLEDGE-gated non-U.S. providers for that work.",
    "5) WIRE IT UP: give me the exact LUCID steps for the recommendation - which Settings card, Connect via OAuth or paste an API key, any extra fields (GCP project ID, Azure resource name), and what should appear in the model picker when it works. NEVER ask me to paste a secret into chat; keys go straight into the Settings fields.",
    "6) FINISH with the voice upgrade, asked as a simple yes/no: would I like LUCID to SPEAK - reading replies aloud and holding a hands-free conversation where the agent talks through its status while it works (Conversation mode)? If yes: custom, natural voices come from ElevenLabs - have me create an account at https://try.elevenlabs.io/nru4d3mgw8b5 (open it in my browser), then get my API key from https://elevenlabs.io/app/settings/api-keys and paste it into Settings → Voice → ElevenLabs, pick a voice I like, and turn on Auto-speak plus Conversation. Explain it costs a few cents per spoken reply. If I'd rather keep audio on-device (air-gap), point me at offline Kokoro or a self-hosted dots.tts endpoint in the same card instead.",
  ].join("\n"),
};

export const BUILTIN_COMMANDS: readonly UserCommand[] = [LICENSING, PROVIDERS];

/** User-saved commands first; builtins fill the names the user has not claimed. */
export function withBuiltins(userCommands: UserCommand[]): UserCommand[] {
  const taken = new Set(userCommands.map((c) => c.name));
  return [...userCommands, ...BUILTIN_COMMANDS.filter((b) => !taken.has(b.name))];
}
