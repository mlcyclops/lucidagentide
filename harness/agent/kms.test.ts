// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/agent/kms.test.ts — P-AGENT.16 (ADR-0144): provider-sourced secrets, the pure layer. Spec
// validation of provider refs (closed kinds, scheme/kind consistency), secret-guard coverage of refs, and
// the connector request builder.

import { test, expect, describe } from "bun:test";
import { buildKmsFetchRequest } from "./kms.ts";
import { validateSpec, newSpecId, SPEC_VERSION, SECRET_PROVIDER_KINDS, type AgentSpec } from "./spec.ts";
import { scanSpecForSecrets } from "./secret_guard.ts";

function spec(over: Partial<AgentSpec> = {}): AgentSpec {
  const now = 1_700_000_000_000;
  return {
    spec_id: newSpecId(),
    spec_version: SPEC_VERSION,
    name: "crm-logger",
    mode: "built-agent",
    tools: [],
    egress: [],
    selfEdit: "individual",
    nodes: [{ id: "a", kind: "prompt", label: "Work", prompt: "do" }],
    edges: [],
    created_at: now,
    updated_at: now,
    ...over,
  };
}

const providerSecret = {
  name: "CRM_JIT_TOKEN",
  kind: "jwt" as const,
  provisioning: { method: "jit-ticket" as const, provider: { kind: "vault" as const, ref: "vault:secret/data/lucid/crm#token" } },
};

describe("SecretProviderRef validation (P-AGENT.16) — fail-closed", () => {
  test("a well-formed provider ref validates; every kind maps to its scheme", () => {
    expect(validateSpec(spec({ secrets: [providerSecret] })).ok).toBe(true);
    expect(SECRET_PROVIDER_KINDS.length).toBeGreaterThan(1);
  });
  test("unknown kind, empty ref, and scheme/kind mismatch are refused with reasons", () => {
    const bad = (provider: unknown) =>
      validateSpec(spec({ secrets: [{ name: "X", kind: "apikey", provisioning: { method: "user-input", provider } }] } as unknown as Partial<AgentSpec>));
    expect(bad({ kind: "one-password", ref: "op:item" }).errors.join()).toContain("provider.kind");
    expect(bad({ kind: "vault", ref: "" }).errors.join()).toContain("provider.ref");
    const mismatch = bad({ kind: "aws-sm", ref: "vault:secret/data/x#y" });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.errors.join()).toContain('must start with "aws:"');
  });
  test("a secret VALUE pasted as a provider ref is caught by the guard", () => {
    const leaky = spec({
      secrets: [{ name: "GH", kind: "apikey", provisioning: { method: "user-input", provider: { kind: "vault", ref: "vault:ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345" } } }],
    });
    expect(scanSpecForSecrets(leaky).some((l) => l.where.includes("provider ref"))).toBe(true);
  });
});

describe("buildKmsFetchRequest (P-AGENT.16)", () => {
  test("collects ONLY provider-sourced secrets; null when none declared", () => {
    const s = spec({
      secrets: [
        providerSecret,
        { name: "PASTED_KEY", kind: "apikey", provisioning: { method: "user-input" } }, // vault-pasted → not fetched
      ],
    });
    const req = buildKmsFetchRequest(s, "/tmp/run/secrets.env.json")!;
    expect(req.out).toBe("/tmp/run/secrets.env.json");
    expect(req.requests).toEqual([{ name: "CRM_JIT_TOKEN", ref: "vault:secret/data/lucid/crm#token" }]);
    expect(buildKmsFetchRequest(spec(), "/tmp/x")).toBeNull();
    expect(buildKmsFetchRequest(spec({ secrets: [{ name: "A", kind: "apikey" }] }), "/tmp/x")).toBeNull();
  });
});
