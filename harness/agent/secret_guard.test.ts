// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/agent/secret_guard.test.ts — P-AGENT.8 (ADR-0134): the secret guardrail (no credential can ride
// inside an agent). High-signal: declared SecretRefs + env-var NAMES + ordinary prose stay clean.

import { test, expect, describe } from "bun:test";
import { scanSpecForSecrets, assertSecretFree } from "./secret_guard.ts";
import { newSpecId, SPEC_VERSION, type AgentSpec } from "./spec.ts";

function spec(over: Partial<AgentSpec> = {}): AgentSpec {
  return {
    spec_id: newSpecId(),
    spec_version: SPEC_VERSION,
    name: "gov-bd",
    description: "search for DoD opportunities and log them to Salesforce",
    persona: "You help with business development.",
    mode: "built-agent",
    tools: ["web_search"],
    egress: ["*.salesforce.com", "*.govwin.com"],
    // DECLARED secret refs (names only — this is the CORRECT way): must stay clean.
    secrets: [
      { name: "SALESFORCE_API_TOKEN", kind: "apikey", purpose: "Salesforce REST API; generate under Setup → API" },
      { name: "GOVWIN_PASSWORD", kind: "basic", purpose: "your GovWin login password" },
    ],
    nodes: [{ id: "a", kind: "prompt", label: "Plan", prompt: "Plan the search using SALESFORCE_API_TOKEN from the vault." }],
    edges: [],
    selfEdit: "individual",
    created_at: 1,
    updated_at: 1,
    ...over,
  };
}

describe("scanSpecForSecrets (P-AGENT.8) — clean cases stay clean", () => {
  test("a spec that DECLARES secret refs (names only) has no leaks", () => {
    expect(scanSpecForSecrets(spec())).toEqual([]);
  });
  test("env-var-style ref names and ordinary prose don't false-positive", () => {
    const s = spec({
      persona: "Read the official docs to help the user generate an API token. Store it in the vault, never in chat.",
      nodes: [{ id: "a", kind: "prompt", label: "Connect", prompt: "Use GOVWIN_PASSWORD and SALESFORCE_API_TOKEN from the vault." }],
    });
    expect(scanSpecForSecrets(s)).toEqual([]);
  });
});

describe("scanSpecForSecrets (P-AGENT.8) — apparent secret VALUES are caught", () => {
  test("a PEM private key in the persona is flagged", () => {
    const leaks = scanSpecForSecrets(spec({ persona: "key:\n-----BEGIN RSA PRIVATE KEY-----\nMIIEabc\n-----END RSA PRIVATE KEY-----" }));
    expect(leaks.length).toBeGreaterThan(0);
    expect(leaks[0]!.pattern).toContain("PEM");
    expect(leaks[0]!.where).toBe("persona");
  });
  test("an AWS access key in a node prompt is flagged", () => {
    const leaks = scanSpecForSecrets(spec({ nodes: [{ id: "a", kind: "prompt", label: "x", prompt: "use AKIAIOSFODNN7EXAMPLE to sign" }] }));
    expect(leaks.some((l) => l.pattern.includes("AWS"))).toBe(true);
  });
  test("an sk- style key is flagged", () => {
    const leaks = scanSpecForSecrets(spec({ description: "the key is sk-abcdEFGH1234567890ijklMNOP" }));
    expect(leaks.some((l) => l.pattern.includes("OpenAI/Anthropic"))).toBe(true);
  });
  test("an inline `password: <value>` assignment is flagged", () => {
    const leaks = scanSpecForSecrets(spec({ description: "login with password: hunter2SuperSecret" }));
    expect(leaks.some((l) => l.pattern.includes("credential assignment"))).toBe(true);
  });
  test("the snippet is redacted (never the full secret)", () => {
    const leaks = scanSpecForSecrets(spec({ description: "sk-abcdEFGH1234567890ijklMNOP" }));
    expect(leaks[0]!.snippet).toContain("redacted");
    expect(leaks[0]!.snippet).not.toContain("ijklMNOP");
  });
});

describe("scanSpecForSecrets (P-AGENT.9) — provisioning guidance is scanned too", () => {
  test("clean provisioning guidance (instructions + JIT ticket template) stays clean", () => {
    const s = spec({
      secrets: [{
        name: "CRM_JIT_TOKEN", kind: "jwt", purpose: "CRM API",
        provisioning: {
          method: "jit-ticket",
          instructions: "File a ticket with IAM; paste the issued token into the vault.",
          ticket: { system: "ServiceNow", rationale: "Agent needs CRM API access for opportunity logging.", template: { catalog_item: "JIT API Token", assignment_group: "IAM-Access" } },
        },
      }],
    });
    expect(scanSpecForSecrets(s)).toEqual([]);
  });
  test("a token pasted into provisioning instructions is flagged with its location", () => {
    const s = spec({
      secrets: [{ name: "GH", kind: "apikey", provisioning: { method: "user-input", instructions: "use ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345" } }],
    });
    const leaks = scanSpecForSecrets(s);
    expect(leaks.some((l) => l.where.includes("provisioning instructions"))).toBe(true);
  });
  test("a secret smuggled into a JIT ticket template VALUE is flagged", () => {
    const s = spec({
      secrets: [{ name: "AWS", kind: "apikey", provisioning: { method: "jit-ticket", ticket: { system: "ServiceNow", template: { note: "key AKIAIOSFODNN7EXAMPLE" } } } }],
    });
    expect(scanSpecForSecrets(s).some((l) => l.pattern.includes("AWS"))).toBe(true);
  });
});

describe("assertSecretFree (P-AGENT.8)", () => {
  test("does not throw for a clean spec (declared refs only)", () => {
    expect(() => assertSecretFree(spec())).not.toThrow();
  });
  test("throws for a spec that embeds a secret, pointing the user to the vault", () => {
    expect(() => assertSecretFree(spec({ persona: "token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345" }))).toThrow(/vault/);
  });
});
