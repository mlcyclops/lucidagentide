// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/local_providers_runtime.test.ts — P-LOCAL.2 (ADR-0135): main-process delivery to omp.

import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mergeModelsYaml,
  materializeLocalProviders,
  localProviderEgressEntry,
  modelsYamlPath,
} from "./local_providers_runtime.ts";
import { toOmpRuntimeOverlay, type LocalProviderDef, type OmpConfigOverlay } from "./local_providers.ts";

function def(over: Partial<LocalProviderDef> = {}): LocalProviderDef {
  const now = 1_700_000_000_000;
  return {
    id: "dgx1", name: "DGX Vienna", ompProvider: "dgx-vienna", baseUrl: "https://10.20.30.40:8000/v1",
    api: "openai-completions", authKind: "bearer", vaultRef: "cred_dgx", zone: "internal",
    models: [{ id: "llama-3.1-70b", name: "Llama 3.1 70B" }], enabled: true, createdAt: now, updatedAt: now, ...over,
  };
}
function overlayFor(defs: LocalProviderDef[], refs: string[]): OmpConfigOverlay {
  return toOmpRuntimeOverlay(defs, new Set(refs)).overlay;
}

describe("mergeModelsYaml (safe merge)", () => {
  test("fresh file → just our providers, marked managed", () => {
    const ov = overlayFor([def({ authKind: "none", vaultRef: undefined })], []);
    const r = mergeModelsYaml("", ov, []);
    expect(r.ok).toBe(true);
    expect(JSON.parse(r.content!).providers["dgx-vienna"]).toBeDefined();
    expect(r.managedIds).toEqual(["dgx-vienna"]);
    expect(r.preserved).toBe(0);
  });
  test("preserves a non-LUCID provider, replaces a managed one, and DROPS a stale managed id", () => {
    const existing = JSON.stringify({
      providers: {
        "hand-authored": { baseUrl: "http://x/v1", api: "openai-completions", auth: "none", models: [{ id: "m" }] },
        "dgx-vienna": { baseUrl: "OLD", api: "openai-completions", models: [] },
        "old-lucid": { baseUrl: "STALE", api: "openai-completions", models: [] },
      },
    });
    const ov = overlayFor([def({ authKind: "none", vaultRef: undefined })], []);
    const r = mergeModelsYaml(existing, ov, ["dgx-vienna", "old-lucid"]); // both were LUCID-managed
    expect(r.ok).toBe(true);
    const p = JSON.parse(r.content!).providers;
    expect(p["hand-authored"]).toBeDefined(); // preserved
    expect(p["old-lucid"]).toBeUndefined(); // stale managed id dropped
    expect(p["dgx-vienna"].baseUrl).toBe("https://10.20.30.40:8000/v1"); // replaced with current
    expect(r.preserved).toBe(1);
  });
  test("REFUSES to overwrite a file it can't parse (hand-authored YAML) — never destroys user content", () => {
    const r = mergeModelsYaml("providers:\n  ollama: # a yaml comment\n    baseUrl: http://x", overlayFor([def()], ["cred_dgx"]), []);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("refusing to overwrite");
  });
});

describe("materializeLocalProviders (vault → child env + write)", () => {
  let dir = "";
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ""; delete process.env.LUCID_OMP_MODELS_YAML; });
  test("authed provider: secret from the vault lands in childEnv, models.yml holds only the env-var NAME", () => {
    dir = mkdtempSync(join(tmpdir(), "lpr-"));
    process.env.LUCID_OMP_MODELS_YAML = join(dir, "models.yml");
    const r = materializeLocalProviders({ defs: [def()], readSecret: (ref) => (ref === "cred_dgx" ? "sk-live-DGX" : null) });
    expect(r.wrote).toBe(true);
    expect(r.included).toEqual(["dgx-vienna"]);
    expect(r.childEnv).toEqual({ LUCID_LP_DGX_VIENNA_KEY: "sk-live-DGX" }); // the real secret, child-only
    const written = readFileSync(modelsYamlPath(), "utf8");
    expect(written).toContain("LUCID_LP_DGX_VIENNA_KEY"); // the NAME is in the file
    expect(written).not.toContain("sk-live-DGX"); // the VALUE is NOT
  });
  test("fail-closed: no vault secret → provider skipped, no env, still writes (empty providers)", () => {
    dir = mkdtempSync(join(tmpdir(), "lpr-"));
    process.env.LUCID_OMP_MODELS_YAML = join(dir, "models.yml");
    const r = materializeLocalProviders({ defs: [def()], readSecret: () => null });
    expect(r.included).toEqual([]);
    expect(r.childEnv).toEqual({});
    expect(r.skipped[0]).toMatchObject({ id: "dgx-vienna" });
  });
  test("an open provider needs no vault and still routes", () => {
    dir = mkdtempSync(join(tmpdir(), "lpr-"));
    process.env.LUCID_OMP_MODELS_YAML = join(dir, "models.yml");
    const r = materializeLocalProviders({ defs: [def({ authKind: "none", vaultRef: undefined })], readSecret: () => null });
    expect(r.included).toEqual(["dgx-vienna"]);
    expect(r.childEnv).toEqual({});
    expect(JSON.parse(readFileSync(modelsYamlPath(), "utf8")).providers["dgx-vienna"].auth).toBe("none");
  });
});

describe("localProviderEgressEntry", () => {
  test("builds a stable ip entry bound to the vault via AuthRef", () => {
    const e = localProviderEgressEntry(def(), 1_700_000_000_000)!;
    expect(e).toMatchObject({ id: "lp_dgx1", kind: "ip", pattern: "10.20.30.40", zone: "internal", scope: "always" });
    expect(e.auth).toMatchObject({ kind: "apikey", vaultRef: "cred_dgx" });
  });
  test("disabled provider → no entry; open provider → entry with no auth", () => {
    expect(localProviderEgressEntry(def({ enabled: false }), 1)).toBeNull();
    expect(localProviderEgressEntry(def({ authKind: "none", vaultRef: undefined }), 1)!.auth).toBeNull();
  });
});
