// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Increment P-LOCAL.6 - ask the server instead of guessing. P-LOCAL.5 shipped a curated catalog whose
// context windows were EDITORIAL: LUCID could not know what your box actually loaded, so `glm-5.3-flash`
// got a hand-picked 131072 and a model served under its real HuggingFace id got omp's 8192 default.
// This increment reads `GET <baseUrl>/models`, the same list omp's own discovery uses, so the id and the
// window come from the endpoint. The catalog keeps the job only it can do: the reasoning/vision flags and
// the `compat` wire shape, which a `/models` list never reports.
//
// Runs against a REAL HTTP server (a Bun.serve fixture that answers the way vLLM does, 401 included), so
// the sockets, the auth header, the body caps, and the parser are all exercised, not mocked.
//
// Run: bun run desktop/scripts/demo_p_local_6.ts

import {
  discoveryHeaders,
  parseDiscoveredModels,
  providerModelsUrl,
  toOmpProviderEntry,
  MAX_DISCOVERY_BYTES,
  type LocalProviderDef,
} from "../local_providers.ts";
import { enrichModelFromCatalog } from "../renderer/local_presets.ts";
import { modelsFieldValue, providerWithDiscovered } from "../renderer/local_providers_ui.ts";

let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? "  ok " : "FAIL "} ${label}`);
  if (!ok) failures++;
}

console.log("== P-LOCAL.6 - endpoint model discovery (ask the server, do not guess) ==");

// A stand-in for the user's 2x DGX Spark: vLLM behind `--api-key`, which answers exactly
// `401 {"error":"Unauthorized"}` to an unauthenticated request and serves HF-style model ids.
const TOKEN = "spark-token";
const SERVED = [
  { id: "zai-org/GLM-5.3-Flash-FP8", object: "model", owned_by: "vllm", root: "zai-org/GLM-5.3-Flash", parent: null, max_model_len: 65536, permission: [] },
  { id: "Qwen/Qwen3-Coder-30B-A3B-Instruct", object: "model", owned_by: "vllm", max_model_len: 262144 },
  { id: "bespoke-merge-v9", object: "model", owned_by: "vllm" },
];
const fake = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (req.headers.get("authorization") !== `Bearer ${TOKEN}`) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "content-type": "application/json" } });
    }
    if (path === "/v1/models") return Response.json({ object: "list", data: SERVED });
    if (path === "/junk/models") return new Response("<html>not json</html>", { headers: { "content-type": "text/html" } });
    return new Response("not found", { status: 404 });
  },
});
const BASE = `http://127.0.0.1:${fake.port}/v1`;

const def = (over: Partial<LocalProviderDef> = {}): LocalProviderDef => ({
  id: "lp_spark", name: "DGX Spark", ompProvider: "dgx_spark", baseUrl: BASE,
  api: "openai-completions", authKind: "bearer", vaultRef: "lpkey_lp_spark", zone: "internal",
  models: [{ id: "glm-5.3-flash", contextWindow: 131072 }], enabled: true, createdAt: 1, updatedAt: 1, ...over,
});

/** Exactly what the /api/local-providers/discover route does, so this demo exercises that logic. */
async function discover(provider: LocalProviderDef, secret?: string) {
  const target = providerModelsUrl(provider.baseUrl);
  if (!target) return { reachable: false as const, error: "invalid base URL" };
  const r = await fetch(target, { method: "GET", headers: discoveryHeaders(provider, secret), redirect: "manual", signal: AbortSignal.timeout(6000) });
  if (r.status === 401 || r.status === 403) return { reachable: true as const, status: r.status, authRequired: true, models: [], dropped: 0 };
  const raw = await r.text();
  if (raw.length > MAX_DISCOVERY_BYTES) return { reachable: true as const, status: r.status, error: "implausibly large", models: [], dropped: 0 };
  let body: unknown;
  try { body = JSON.parse(raw); }
  catch { return { reachable: true as const, status: r.status, error: "not an OpenAI model list", models: [], dropped: 0 }; }
  const d = parseDiscoveredModels(body);
  return { reachable: true as const, status: r.status, authRequired: false, ...d };
}

try {
  // (1) UNAUTHENTICATED, which is what the ADD FORM can do: the endpoint needs a key, and the probe says
  //     so rather than sending one. ADR-0135 keeps provider secrets off the engine's HTTP surface, so the
  //     user saves the provider (key -> OS vault) and discovers from its row instead.
  const anon = await discover(def(), undefined);
  check("an unauthenticated probe reports authRequired, not failure", anon.reachable && anon.authRequired === true);
  check("and returns no models rather than a partial list", (anon.models?.length ?? -1) === 0);

  // (2) AUTHENTICATED, which is what a SAVED provider does (secret from the vault-injected env).
  const found = await discover(def(), TOKEN);
  check("an authenticated probe reads the list", found.reachable && found.authRequired === false);
  check("every served id is offered, in the server's order", modelsFieldValue(found.models ?? []) === SERVED.map((m) => m.id).join(", "));
  check("nothing was dropped from a well-formed list", found.dropped === 0);

  // (3) THE POINT OF THE INCREMENT: the window is the SERVER's, not the catalog's editorial guess.
  const glm = (found.models ?? []).find((m) => m.id === "zai-org/GLM-5.3-Flash-FP8")!;
  check("GLM's window comes from max_model_len (65536), not the catalog's 131072", glm.contextWindow === 65536);
  const enriched = enrichModelFromCatalog(glm);
  check("the server's window survives enrichment", enriched.contextWindow === 65536);
  check("the catalog still supplies what /models cannot say: reasoning", enriched.reasoning === true);
  check("and the compat wire shape omp cannot infer from a LAN address", enriched.compat?.thinkingFormat === "qwen-chat-template");
  check("while the WIRE id stays exactly what the server called it", enriched.id === "zai-org/GLM-5.3-Flash-FP8");

  // (4) the HF-style id is the case P-LOCAL.5 alone would have lost: an exact-string catalog lookup
  //     fails on `zai-org/GLM-5.3-Flash-FP8`, so without normalization discovery would hand omp a
  //     reasoning model with no reasoning and no compat.
  const qwen = enrichModelFromCatalog((found.models ?? []).find((m) => m.id.startsWith("Qwen/"))!);
  check("a repo-qualified, variant-suffixed id still finds its preset", qwen.name === "Qwen3 Coder 30B");
  check("and keeps the server's 262144 window", qwen.contextWindow === 262144);

  // (5) refusing to guess is also a feature: an id resembling nothing gets no invented metadata.
  const bespoke = enrichModelFromCatalog((found.models ?? []).find((m) => m.id === "bespoke-merge-v9")!);
  check("an unrecognized model gets no invented window", bespoke.contextWindow === undefined);
  check("and no invented reasoning flag", bespoke.reasoning === undefined);

  // (6) the saved provider is replaced by what the endpoint really serves, and says what changed.
  const { def: next, added, removed } = providerWithDiscovered(def(), found.models ?? [], 1_800_000_000_000);
  check("the saved list becomes the served list", next.models.length === 3);
  check("a model the endpoint no longer serves is removed", removed.join() === "glm-5.3-flash");
  check("the new ids are reported as added", added.length === 3);
  check("compat reaches the SAVED def, not just the preview", next.models[0]!.compat?.reasoningContentField === "reasoning");
  check("and the overlay omp loads carries the server's window", toOmpProviderEntry(next, TOKEN).models[0]!.contextWindow === 65536);

  // (7) an empty answer must never wipe a working provider.
  const untouched = providerWithDiscovered(def(), [], 1_800_000_000_000);
  check("an empty answer leaves the provider exactly as it was", untouched.def.models.length === 1 && untouched.removed.length === 0);

  // (8) a reachable endpoint that answers something other than a model list is reported, not parsed.
  const junk = await discover(def({ baseUrl: `http://127.0.0.1:${fake.port}/junk` }), TOKEN);
  check("an HTML answer is reported as not-a-model-list", junk.reachable && (junk.models?.length ?? -1) === 0 && !!junk.error);

  // (9) unreachable is unreachable: a closed port fails, and never looks like an empty success.
  let threw = false;
  try { await discover(def({ baseUrl: "http://127.0.0.1:1/v1" }), TOKEN); } catch { threw = true; }
  check("a dead endpoint throws to the route's catch rather than returning 0 models", threw);
} finally {
  fake.stop(true);
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
