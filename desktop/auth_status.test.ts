// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-PROV.1 (ADR-0210): first-party enterprise providers. Asserts the descriptor set (Azure OpenAI, GitHub
// Copilot OAuth, Google Vertex / Gemini Enterprise, + the Gemini-CLI enterprise project field) and that
// providerAuth() reports each extra config field's status: secret fields masked to last4, non-secret config
// (project id, resource name, location) echoed back so the Settings inputs pre-fill.

import { afterEach, describe, expect, test } from "bun:test";
import { MAJORS, providerAuth, type Provider } from "./auth_status.ts";

const find = (id: string): Provider | undefined => MAJORS.find((m) => m.id === id);
const fieldEnvs = (p: Provider | undefined): string[] => (p?.fields ?? []).map((f) => f.env);

describe("provider descriptors (ADR-0210)", () => {
  test("GitHub Copilot is an OAuth-only major (no key env, device-flow broker id)", () => {
    const cp = find("github-copilot");
    expect(cp).toBeDefined();
    expect(cp!.oauthId).toBe("github-copilot");
    expect(cp!.canOauth).toBe(true);
    expect(cp!.env).toBe(""); // OAuth-only → no primary key input
    expect(cp!.fields ?? []).toHaveLength(0);
  });

  test("Azure OpenAI: key + the omp-read config envs", () => {
    const az = find("azure");
    expect(az).toBeDefined();
    expect(az!.env).toBe("AZURE_OPENAI_API_KEY");
    expect(az!.canOauth).toBe(false);
    const envs = fieldEnvs(az);
    expect(envs).toContain("AZURE_OPENAI_RESOURCE_NAME");
    expect(envs).toContain("AZURE_OPENAI_BASE_URL");
    expect(envs).toContain("AZURE_OPENAI_API_VERSION");
  });

  test("Google Vertex (Gemini Enterprise): key OR ADC (project + location + credentials)", () => {
    const vx = find("google-vertex");
    expect(vx).toBeDefined();
    expect(vx!.env).toBe("GOOGLE_CLOUD_API_KEY"); // omp's Vertex api-key env (NOT the markdown's VERTEX_API_KEY)
    const envs = fieldEnvs(vx);
    expect(envs).toContain("GOOGLE_CLOUD_PROJECT");
    expect(envs).toContain("GOOGLE_CLOUD_LOCATION");
    expect(envs).toContain("GOOGLE_APPLICATION_CREDENTIALS");
  });

  test("the Gemini card exposes GOOGLE_CLOUD_PROJECT so Workspace/Enterprise OAuth works", () => {
    const g = find("google");
    expect(g).toBeDefined();
    expect(g!.oauthId).toBe("google-gemini-cli");
    expect(fieldEnvs(g)).toContain("GOOGLE_CLOUD_PROJECT");
  });
});

describe("providerAuth() field reporting", () => {
  const touched: string[] = [];
  const setEnv = (k: string, v: string) => { touched.push(k); process.env[k] = v; };
  afterEach(() => { for (const k of touched.splice(0)) delete process.env[k]; });

  test("secret key masks to last4; non-secret config echoes its value", () => {
    setEnv("AZURE_OPENAI_API_KEY", "sk-azure-SECRET-9animal7"); // secret primary key
    setEnv("AZURE_OPENAI_RESOURCE_NAME", "contoso-openai");     // non-secret config
    const az = providerAuth().majors.find((m) => m.id === "azure");
    expect(az).toBeDefined();
    expect(az!.keySet).toBe(true);
    expect(az!.keyLast4).toBe("mal7"); // last 4 of the key, never the whole thing
    const resField = az!.fields?.find((f) => f.env === "AZURE_OPENAI_RESOURCE_NAME");
    expect(resField?.set).toBe(true);
    expect(resField?.value).toBe("contoso-openai"); // echoed (non-secret) so the input pre-fills
    expect(resField?.last4).toBeUndefined();
    const unsetField = az!.fields?.find((f) => f.env === "AZURE_OPENAI_BASE_URL");
    expect(unsetField?.set).toBe(false);
    expect(unsetField?.value).toBeUndefined();
  });

  test("GOOGLE_CLOUD_PROJECT set → the Gemini card's field reports it", () => {
    setEnv("GOOGLE_CLOUD_PROJECT", "my-enterprise-proj");
    const g = providerAuth().majors.find((m) => m.id === "google");
    const proj = g!.fields?.find((f) => f.env === "GOOGLE_CLOUD_PROJECT");
    expect(proj?.set).toBe(true);
    expect(proj?.value).toBe("my-enterprise-proj");
  });
});
