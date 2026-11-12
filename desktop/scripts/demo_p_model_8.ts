// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// demo-P-MODEL.8 (ADR-0448): Gemini 4 Argon is the flagship, Gemini 3.8 Flash is the Gemini default, and
// a Gemini session hands its Thinking / Architect / Subtask roles to Argon.
//
//   [1] omp's REAL Gemini discovery (fetchGeminiModels, the function the child runs once a GEMINI_API_KEY
//       is saved) against Google's live /v1beta/models, with the key from LUCID's settings store. Self-skips
//       to the recorded 2026-10-14 catalog when no key is saved, so the demo stays green offline.
//   [2] the picker over that catalog: Argon ranks first in the Gemini group, the fresh default is 3.8 Flash
//   [3] the spawn overlay through omp's REAL Settings loader + role resolver: slow / plan / task resolve to
//       Argon then the session's Flash; a Claude session and lockdown get no heavy roles at all
//   [4] the estimate prices Argon at the $4/$20 standard rate, not the $2/$10 promo
//
// Run with: bun run desktop/scripts/demo_p_model_8.ts   (make demo-P-MODEL.8)

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchGeminiModels } from "@oh-my-pi/pi-catalog/discovery/gemini";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { formatModelStringWithRouting, resolveRoleChain } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { capabilityTier, groupByFamily, preferredDefaultModel, sortGovFirstByLevel, type ModelOption } from "../renderer/model_families.ts";
import { GEMINI_HEAVY_MODEL, GEMINI_HEAVY_ROLES, heavyRoleModel, modelRolesOverlayYaml } from "../model_roles.ts";
import { listPrice } from "../model_pricing.ts";
import { load } from "../settings_store.ts";

let failures = 0;
const check = (cond: boolean, msg: string) => { console.log(`  ${cond ? "ok  " : "FAIL"} ${msg}`); if (!cond) failures++; };

// The Gemini chat ids Google listed for this key on 2026-10-14 (the offline fallback).
const RECORDED = ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-3-flash-preview", "gemini-3.1-pro-preview", "gemini-3.5-flash",
  "gemini-3.6-flash", "gemini-3.7-flash", "gemini-3.8-flash", "gemini-4-argon"];

console.log("\n[1] omp's Gemini discovery against the live API");
const key = load().keys?.GEMINI_API_KEY || process.env.GEMINI_API_KEY || "";
const live = key ? await fetchGeminiModels({ apiKey: key, signal: AbortSignal.timeout(15_000) }) : null;
const ids = live ? live.map((m) => m.id) : RECORDED;
if (live) {
  check(ids.includes("gemini-4-argon"), `discovery registers gemini-4-argon (${live.length} models for this key)`);
  check(ids.includes("gemini-3.8-flash"), "discovery registers gemini-3.8-flash");
  const argon = live.find((m) => m.id === "gemini-4-argon");
  if (argon) console.log(`       gemini-4-argon: ${argon.contextWindow} ctx, ${argon.maxTokens} max output`);
} else {
  console.log(`  skip ${key ? "the live call failed" : "no GEMINI_API_KEY saved"}; using the recorded 2026-10-14 catalog`);
}

console.log("\n[2] the picker over that catalog");
const options: ModelOption[] = ids.map((id) => ({ value: `google/${id}`, name: id }));
// The picker's Gemini section: sortGovFirstByLevel then groupByFamily, as familyListHTML renders it.
// Google's Deep Research agents (`deep-research-pro-…`) also rank tier 2 but group under Other models.
const gemini = groupByFamily(sortGovFirstByLevel(options)).find((g) => g.fam.id === "gemini")?.models.map((m) => m.value) ?? [];
check(gemini[0] === GEMINI_HEAVY_MODEL, `Gemini section order starts ${gemini.slice(0, 3).join(" > ")}`);
check(capabilityTier(GEMINI_HEAVY_MODEL) === 2, "Argon is capability tier 2 (flagship)");
const def = preferredDefaultModel(options)?.value;
check(def === "google/gemini-3.8-flash", `a Google-only install opens on ${def}`);

console.log("\n[3] the spawn overlay through omp's role resolver");
const dir = mkdtempSync(join(tmpdir(), "lucid-pmodel8-"));
try {
  const mk = (id: string) => ({ provider: "google", id, name: id, api: "google-generative-ai", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_048_576, maxTokens: 32_768 });
  const pool = ids.map(mk);
  const resolveFor = async (chatModel: string, locked: boolean, role: string): Promise<string[]> => {
    const base = join(dir, "base.yml"), roles = join(dir, "roles.yml");
    writeFileSync(base, `modelRoles:\n  default: ${JSON.stringify(chatModel)}\n`);
    writeFileSync(roles, modelRolesOverlayYaml(heavyRoleModel({ chatModel, locked, allowed: () => true })));
    const s = await Settings.loadReadOnly({ agentDir: dir, cwd: dir, configFiles: [base, roles] });
    return resolveRoleChain(role, s, pool as never).map((c) => formatModelStringWithRouting(c.model));
  };
  for (const role of GEMINI_HEAVY_ROLES) {
    const chain = await resolveFor("google/gemini-3.8-flash", false, role);
    check(chain[0] === GEMINI_HEAVY_MODEL && chain.includes("google/gemini-3.8-flash"), `Gemini session: ${role} -> ${chain.join(" , ")}`);
  }
  const claude = await resolveFor("anthropic/claude-opus-5-5", false, "task");
  check(!claude.includes(GEMINI_HEAVY_MODEL), `Claude session: task -> ${claude.join(" , ") || "(unset, inherits the session model)"}`);
  const locked = await resolveFor("google/gemini-3.8-flash", true, "task");
  check(!locked.includes(GEMINI_HEAVY_MODEL), `lockdown: task -> ${locked.join(" , ") || "(unset)"}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log("\n[4] the cost estimate");
const p = listPrice(GEMINI_HEAVY_MODEL);
check(p.inPerM === 4 && p.outPerM === 20, `Argon estimates at $${p.inPerM}/$${p.outPerM} per Mtok (standard rate)`);

console.log(failures ? `\n${failures} check(s) FAILED` : "\ndemo-P-MODEL.8 OK");
process.exit(failures ? 1 : 0);
