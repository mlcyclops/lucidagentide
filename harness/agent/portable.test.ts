// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/agent/portable.test.ts — P-AGENT.9 (ADR-0135): the shareable .lucid-agent format. Round-trip,
// tamper-evidence, the no-credential guarantee, and the import setup guidance (vault + JIT ticketing).

import { test, expect, describe } from "bun:test";
import {
  exportPortableAgent,
  parsePortableAgentJson,
  setupInstructions,
  specDigest,
  canonicalJson,
  PORTABLE_AGENT_FORMAT,
} from "./portable.ts";
import { newSpecId, SPEC_VERSION, type AgentSpec } from "./spec.ts";

function spec(over: Partial<AgentSpec> = {}): AgentSpec {
  const now = 1_700_000_000_000;
  return {
    spec_id: newSpecId(),
    spec_version: SPEC_VERSION,
    name: "crm-logger",
    mode: "built-agent",
    tools: ["web_search"],
    egress: ["api.crm.example.com"],
    selfEdit: "individual",
    secrets: [
      {
        name: "CRM_JIT_TOKEN",
        kind: "jwt",
        purpose: "CRM REST API",
        provisioning: {
          method: "jit-ticket",
          instructions: "Request a short-lived token from the KMS via IT ticketing.",
          ticket: {
            system: "ServiceNow",
            rationale: "Automated opportunity-logging agent needs CRM API write access.",
            template: { catalog_item: "JIT API Token", assignment_group: "IAM-Access", duration: "4h" },
          },
        },
      },
      { name: "SEARCH_API_KEY", kind: "apikey", purpose: "search backend", provisioning: { method: "user-input", instructions: "Generate under Account → API keys." } },
    ],
    nodes: [
      { id: "a", kind: "prompt", label: "Plan", prompt: "Plan the search" },
      { id: "b", kind: "tool", label: "Search", tool: "web_search" },
    ],
    edges: [{ id: "e1", from: "a", to: "b" }],
    created_at: now,
    updated_at: now,
    ...over,
  };
}

describe("portable agent export/import (P-AGENT.9)", () => {
  test("export → parse round-trips the spec and setup guidance", () => {
    const s = spec();
    const file = exportPortableAgent(s, 123);
    expect(file.format).toBe(PORTABLE_AGENT_FORMAT);
    expect(file.exported_at).toBe(123);
    const r = parsePortableAgentJson(`${JSON.stringify(file, null, 2)}\n`);
    expect(r.ok).toBe(true);
    expect(r.spec).toEqual(s);
    expect(r.setupMd).toBe(file.setup_md);
  });

  test("a tampered spec is rejected by the digest check", () => {
    const file = exportPortableAgent(spec());
    const evil = { ...file, spec: { ...file.spec, egress: [...file.spec.egress, "evil.example.net"] } };
    const r = parsePortableAgentJson(JSON.stringify(evil));
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toContain("digest mismatch");
  });

  test("export refuses a spec that embeds an apparent secret VALUE (never shipped)", () => {
    const leaky = spec({ description: "api_key = sk-abcdEFGH1234567890ijklMNOP" });
    expect(() => exportPortableAgent(leaky)).toThrow(/vault/);
  });

  test("parse refuses an invalid envelope and an invalid inner spec, fail-closed", () => {
    expect(parsePortableAgentJson("not json").ok).toBe(false);
    expect(parsePortableAgentJson(JSON.stringify({ format: "other" })).ok).toBe(false);
    const file = exportPortableAgent(spec());
    const brokenSpec = { ...file, spec: { ...file.spec, nodes: [] } };
    expect(parsePortableAgentJson(JSON.stringify(brokenSpec)).ok).toBe(false);
  });

  test("canonicalJson is key-order independent (digest stability across serializers)", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
    const s = spec();
    const reordered = JSON.parse(JSON.stringify(s)) as AgentSpec;
    expect(specDigest(reordered)).toBe(specDigest(s));
  });

  test("setup instructions tell the recipient about the vault, JIT ticketing, and sample ticket fields", () => {
    const md = setupInstructions(spec());
    // never credential values; vault + ref-name story
    expect(md).toContain("does not contain credential values");
    expect(md).toContain("OS-encrypted vault");
    // per-secret guidance: JIT via the org's ticketing system with sample fields + rationale
    expect(md).toContain("CRM_JIT_TOKEN");
    expect(md).toContain("Just-In-Time");
    expect(md).toContain("ServiceNow");
    expect(md).toContain("catalog_item: JIT API Token");
    expect(md).toContain("Automated opportunity-logging agent");
    // user-input credential points at Secrets & connections
    expect(md).toContain("SEARCH_API_KEY");
    expect(md).toContain("Secrets & connections");
    // tools + egress are disclosed for review
    expect(md).toContain("web_search");
    expect(md).toContain("api.crm.example.com");
  });
});
