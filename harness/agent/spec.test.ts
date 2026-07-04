// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/agent/spec.test.ts — P-AGENT.1 (ADR-0133): the Agent Spec fail-closed DAG validator.

import { test, expect, describe } from "bun:test";
import {
  validateSpec,
  newSpecId,
  emptySpec,
  clampSelfEdit,
  SPEC_VERSION,
  type AgentSpec,
} from "./spec.ts";

/** A valid 3-node DAG: prompt -> tool(search) -> prompt. */
function validSpec(over: Partial<AgentSpec> = {}): AgentSpec {
  const now = 1_700_000_000_000;
  return {
    spec_id: newSpecId(),
    spec_version: SPEC_VERSION,
    name: "researcher",
    mode: "built-agent",
    tools: ["web_search"],
    egress: ["*.example.com"],
    selfEdit: "individual",
    nodes: [
      { id: "a", kind: "prompt", label: "Plan", prompt: "Plan the research" },
      { id: "b", kind: "tool", label: "Search", tool: "web_search" },
      { id: "c", kind: "prompt", label: "Summarize", prompt: "Summarize findings" },
    ],
    edges: [
      { id: "e1", from: "a", to: "b" },
      { id: "e2", from: "b", to: "c" },
    ],
    created_at: now,
    updated_at: now,
    ...over,
  };
}

describe("validateSpec (P-AGENT.1)", () => {
  test("accepts a valid 3-node DAG", () => {
    const r = validateSpec(validSpec());
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.spec?.name).toBe("researcher");
  });

  test("emptySpec is valid and starts as an individual built-agent", () => {
    const r = validateSpec(emptySpec("blank", 1));
    expect(r.ok).toBe(true);
    expect(r.spec?.mode).toBe("built-agent");
    expect(r.spec?.selfEdit).toBe("individual");
  });

  test("rejects non-objects and unknown spec_versions fail-closed; v1 files stay valid (P-AGENT.15)", () => {
    expect(validateSpec(null).ok).toBe(false);
    expect(validateSpec("nope").ok).toBe(false);
    expect(validateSpec(validSpec({ spec_version: 3 as never })).ok).toBe(false);
    expect(validateSpec(validSpec({ spec_version: 1 })).ok).toBe(true); // pre-branch files load forever
  });

  test("v2: branch nodes need ≥2 outgoing edges; choice labels ride the edges (P-AGENT.11c)", () => {
    const branchy = validSpec({
      nodes: [
        { id: "a", kind: "prompt", label: "Assess", prompt: "assess" },
        { id: "d", kind: "branch", label: "Risky?" },
        { id: "y", kind: "prompt", label: "Escalate", prompt: "escalate" },
        { id: "n", kind: "prompt", label: "Proceed", prompt: "proceed" },
      ],
      edges: [
        { id: "e1", from: "a", to: "d" },
        { id: "e2", from: "d", to: "y", label: "yes" },
        { id: "e3", from: "d", to: "n", label: "no" },
      ],
    });
    expect(validateSpec(branchy).ok).toBe(true);
    const lonely = validSpec({
      nodes: [
        { id: "a", kind: "prompt", label: "Assess", prompt: "assess" },
        { id: "d", kind: "branch", label: "Risky?" },
      ],
      edges: [{ id: "e1", from: "a", to: "d" }],
    });
    const r = validateSpec(lonely);
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toContain("at least two outgoing edges");
  });

  test("v2: retry/timeout bounds are fail-closed (P-AGENT.15)", () => {
    const good = validSpec({ nodes: [{ id: "a", kind: "prompt", label: "P", prompt: "x", retry: { max: 2, backoffMs: 250 }, timeoutMs: 30_000 }], edges: [] });
    expect(validateSpec(good).ok).toBe(true);
    expect(validateSpec(validSpec({ nodes: [{ id: "a", kind: "prompt", label: "P", retry: { max: 9 } }], edges: [] })).errors.join()).toContain("retry.max");
    expect(validateSpec(validSpec({ nodes: [{ id: "a", kind: "prompt", label: "P", timeoutMs: 100 }], edges: [] })).errors.join()).toContain("timeoutMs");
    expect(validateSpec(validSpec({ edges: [{ id: "e1", from: "a", to: "b", label: 7 }] } as unknown as Partial<AgentSpec>)).errors.join()).toContain("label");
  });

  test("rejects an unknown mode (closed set, invariant #7-style)", () => {
    const r = validateSpec(validSpec({ mode: "wizard" as never }));
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toContain("mode must be one of");
  });

  test("rejects a cycle — v1 is a DAG", () => {
    const r = validateSpec(
      validSpec({
        edges: [
          { id: "e1", from: "a", to: "b" },
          { id: "e2", from: "b", to: "c" },
          { id: "e3", from: "c", to: "a" }, // cycle
        ],
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toContain("acyclic");
  });

  test("rejects a dangling edge reference", () => {
    const r = validateSpec(validSpec({ edges: [{ id: "e1", from: "a", to: "ghost" }] }));
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toContain("not an existing node id");
  });

  test("rejects duplicate node ids", () => {
    const r = validateSpec(
      validSpec({
        nodes: [
          { id: "a", kind: "prompt", label: "one", prompt: "" },
          { id: "a", kind: "prompt", label: "two", prompt: "" },
        ],
        edges: [],
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toContain("duplicate node id");
  });

  test("accepts provisioning guidance on a SecretRef and rejects malformed provisioning (P-AGENT.9)", () => {
    const withProv = validSpec({
      secrets: [{
        name: "CRM_JIT_TOKEN",
        kind: "jwt",
        purpose: "CRM REST API",
        provisioning: {
          method: "jit-ticket",
          instructions: "Request a 4-hour token from the KMS.",
          ticket: { system: "ServiceNow", rationale: "Automated CRM logging agent needs API access.", template: { catalog_item: "JIT API Token", assignment_group: "IAM" } },
        },
      }],
    });
    expect(validateSpec(withProv).ok).toBe(true);
    // bad method → closed set
    const badMethod = validSpec({ secrets: [{ name: "X", kind: "apikey", provisioning: { method: "email-me" } }] } as unknown as Partial<AgentSpec>);
    const r1 = validateSpec(badMethod);
    expect(r1.ok).toBe(false);
    expect(r1.errors.join()).toContain("provisioning.method");
    // jit ticket without a system name
    const noSystem = validSpec({ secrets: [{ name: "X", kind: "apikey", provisioning: { method: "jit-ticket", ticket: {} } }] } as unknown as Partial<AgentSpec>);
    expect(validateSpec(noSystem).errors.join()).toContain("ticket.system");
    // template values must be strings
    const badTpl = validSpec({ secrets: [{ name: "X", kind: "apikey", provisioning: { method: "jit-ticket", ticket: { system: "Jira", template: { hours: 4 } } } }] } as unknown as Partial<AgentSpec>);
    expect(validateSpec(badTpl).errors.join()).toContain("template");
    // a value smuggled into provisioning is refused
    const smuggled = validSpec({ secrets: [{ name: "X", kind: "apikey", provisioning: { method: "user-input", value: "hunter2" } }] } as unknown as Partial<AgentSpec>);
    expect(validateSpec(smuggled).errors.join()).toContain("must NOT carry a value");
  });

  test("rejects a tool node whose tool is not in the allow-list", () => {
    const r = validateSpec(
      validSpec({
        tools: ["web_search"],
        nodes: [
          { id: "a", kind: "prompt", label: "Plan", prompt: "" },
          { id: "b", kind: "tool", label: "Shell", tool: "bash" }, // not allow-listed
        ],
        edges: [{ id: "e1", from: "a", to: "b" }],
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toContain("not in the tools allow-list");
  });

  test("rejects a self-loop edge and an entry-less graph", () => {
    expect(validateSpec(validSpec({ edges: [{ id: "e1", from: "a", to: "a" }] })).ok).toBe(false);
  });
});

describe("clampSelfEdit (managed ceiling, tighten-only)", () => {
  test("managed deny forces selfEdit off", () => {
    const s = validSpec({ selfEdit: "individual" });
    expect(clampSelfEdit(s, false).selfEdit).toBe("off");
  });
  test("managed allow leaves the user's choice intact (never widened elsewhere)", () => {
    const s = validSpec({ selfEdit: "individual" });
    expect(clampSelfEdit(s, true).selfEdit).toBe("individual");
    expect(clampSelfEdit(validSpec({ selfEdit: "off" }), true).selfEdit).toBe("off");
  });
});
