// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Increment P-LOCAL.1 — Local Providers foundation (ADR-0135). A user can point LUCID at a
// self-hosted / custom OpenAI-compatible LLM (Ollama, llama.cpp, vLLM, a DGX box over a SonicWall
// VPN) as a DECLARATION: the endpoint + models are stored, the API token lives ONLY in the
// OS-encrypted vault (referenced by an opaque `vaultRef`), and omp is handed a `--config` overlay at
// launch (wired in P-LOCAL.2). This demo proves the pure core end to end, headlessly.

import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateLocalProvider,
  toOmpConfigOverlay,
  toOmpRuntimeOverlay,
  egressProposal,
  newLocalProviderId,
  type LocalProviderDef,
} from "../local_providers.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) { console.error("  ✗ " + msg); process.exit(1); }
  console.log("  ✓ " + msg);
}

const now = 1_700_000_000_000;
console.log("== #ADR-0135 Local Providers: declare self-hosted/custom LLMs, secrets to the vault ==\n");

// 1) A local Ollama box (no auth) + a private DGX Spark in Vienna, VA over a SonicWall VPN (bearer).
const ollama: LocalProviderDef = {
  id: newLocalProviderId("Ollama Local", now), name: "Ollama (local)", ompProvider: "ollama-local",
  baseUrl: "http://localhost:11434/v1", api: "openai-completions", authKind: "none", zone: "internal",
  models: [{ id: "llama3.1:8b", name: "Llama 3.1 8B" }], enabled: true, createdAt: now, updatedAt: now,
};
const dgx: LocalProviderDef = {
  id: newLocalProviderId("DGX Vienna", now), name: "DGX Spark · Vienna VA (VPN)", ompProvider: "dgx-vienna",
  baseUrl: "https://10.20.30.40:8000/v1", api: "openai-completions", authKind: "bearer",
  vaultRef: "cred_apikey_dgx_001", zone: "internal",
  models: [{ id: "llama-3.1-70b-instruct", name: "Llama 3.1 70B", contextWindow: 131072, maxTokens: 8192, supportsTools: true }],
  enabled: true, createdAt: now, updatedAt: now,
};

console.log("[1] validate declarations (fail-closed)");
assert(validateLocalProvider(ollama).length === 0, "open Ollama endpoint validates clean");
assert(validateLocalProvider(dgx).length === 0, "VPN-routed DGX endpoint validates clean");
assert(validateLocalProvider({ ...dgx, ompProvider: "anthropic" }).some((e) => e.includes("reserved")),
  "a def that would shadow a built-in vendor (anthropic) is refused");

console.log("\n[2] emit the omp --config overlay (secret injected from the vault, main-process only)");
const vault: Record<string, string> = { cred_apikey_dgx_001: "sk-live-DGX-TOKEN-not-on-disk" };
const { overlay, included, skipped } = toOmpConfigOverlay([ollama, dgx], (ref) => vault[ref]);
assert(included.length === 2, "both providers emitted: " + included.join(", "));
assert(overlay.providers["ollama-local"].apiKey === undefined, "open Ollama provider carries NO key");
assert(overlay.providers["dgx-vienna"].apiKey === "sk-live-DGX-TOKEN-not-on-disk", "DGX provider gets its bearer token from the vault");
assert(overlay.providers["dgx-vienna"].models[0].cost.input === 0, "self-hosted model cost is 0");
console.log("    overlay = " + JSON.stringify(overlay).slice(0, 160) + " …");

console.log("\n[3] fail-closed: a secret-requiring provider with NO vault entry is SKIPPED");
const missing = toOmpConfigOverlay([dgx], () => undefined);
assert(missing.included.length === 0 && missing.skipped.length === 1, "DGX skipped when its token is absent (never emitted half-authenticated)");

console.log("\n[4] egress proposal — the endpoint the whitelist must allow");
assert(egressProposal(dgx)?.kind === "ip" && egressProposal(dgx)?.pattern === "10.20.30.40", "DGX internal IP → an 'ip' whitelist proposal");
assert(egressProposal(ollama)?.kind === "domain" && egressProposal(ollama)?.pattern === "localhost", "Ollama localhost → a 'domain' proposal");

console.log("\n[5] persist the declaration — the secret is NEVER written to settings");
const dir = mkdtempSync(join(tmpdir(), "lp-demo-"));
try {
  process.env.LUCID_GUI_SETTINGS_FILE = join(dir, "gui.json");
  const store = await import("../settings_store.ts");
  store.upsertLocalProvider(dgx);
  store.upsertLocalProvider(ollama);
  assert(store.listLocalProviders().length === 2, "both providers persisted");
  const raw = readFileSync(process.env.LUCID_GUI_SETTINGS_FILE, "utf8");
  assert(raw.includes("cred_apikey_dgx_001"), "the opaque vault ref IS persisted");
  assert(!raw.includes("sk-live-DGX-TOKEN-not-on-disk"), "the secret value is NOT on disk");
  assert(!/"apiKey"|"secret"/.test(raw), "no secret-bearing keys in the settings file");
} finally {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.LUCID_GUI_SETTINGS_FILE;
}

console.log("\n[6] RUNTIME overlay — the secret is referenced by ENV VAR NAME, never written to the file");
const rt = toOmpRuntimeOverlay([ollama, dgx], new Set(["cred_apikey_dgx_001"]));
assert(rt.overlay.providers["dgx-vienna"].apiKey === "LUCID_LP_DGX_VIENNA_KEY", "authed provider references an env var NAME (omp resolves it from the child env at call time)");
assert(!JSON.stringify(rt.overlay).includes("sk-live"), "the models.yml overlay contains NO secret value");
assert(rt.env["LUCID_LP_DGX_VIENNA_KEY"] === "cred_apikey_dgx_001", "the env plan maps the var name → the vault ref (MAIN resolves ref→secret and sets it on the omp child only)");
assert(rt.overlay.providers["ollama-local"].auth === "none", "the open provider emits auth:none (required by omp; no key)");
console.log("    (verified live: `omp models` with this overlay at ~/.omp/agent/models.yml lists both custom providers)");

console.log("\n✓ P-LOCAL.1/.2 core demo passed — declarations validated, overlay emitted (inline + secure env-ref), secrets stayed in the vault.");
