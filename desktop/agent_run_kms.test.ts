// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/agent_run_secrets.test.ts — P-AGENT.16 (ADR-0144): resolveProviderSecrets, end-to-end through the
// REAL add-on seam against a FAKE kms connector installed in a temp LUCID_ADDON_DIR (the addon_seam.test
// pattern — a real child process honoring the ADR-A014 file contract, not a mocked function).
//
// Keystones: inject-then-DROP (request + env files deleted even on success), fail-closed on a failed fetch
// attempt, and honest skips (no refs declared / connector absent → today's vault flow, never a refusal).

import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProviderSecrets } from "./agent_run.ts";
import { newSpecId, SPEC_VERSION, type AgentSpec } from "../harness/agent/spec.ts";

let tmp: string | null = null;
afterEach(() => {
  delete process.env.LUCID_ADDON_DIR;
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

/** A fake kms connector honoring ADR-A014: reads the request file, writes the out file, one JSON line. */
function installFakeKms(cliBody: string): void {
  tmp = mkdtempSync(join(tmpdir(), "lucid-kms-addon-"));
  const dir = join(tmp, "connectors", "kms");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@lucid-addon/kms", version: "0.0.1" }));
  writeFileSync(join(dir, "src", "cli.ts"), cliBody);
  process.env.LUCID_ADDON_DIR = tmp;
}

const RESOLVING_CLI = `
import { readFileSync, writeFileSync } from "node:fs";
const file = process.argv[process.argv.indexOf("--file") + 1];
const req = JSON.parse(readFileSync(file, "utf8"));
const out = Object.fromEntries(req.requests.map((r) => [r.name, "resolved-" + r.name.toLowerCase()]));
writeFileSync(req.out, JSON.stringify(out), { mode: 0o600 });
console.log(JSON.stringify({ ok: true, detail: "fetched " + req.requests.length + " secret(s)" }));
`;

function spec(withProvider: boolean): AgentSpec {
  const now = 1_700_000_000_000;
  return {
    spec_id: newSpecId(),
    spec_version: SPEC_VERSION,
    name: "crm-logger",
    mode: "built-agent",
    tools: [],
    egress: [],
    selfEdit: "individual",
    ...(withProvider
      ? { secrets: [{ name: "CRM_JIT_TOKEN", kind: "jwt" as const, provisioning: { method: "jit-ticket" as const, provider: { kind: "vault" as const, ref: "vault:secret/data/lucid/crm#token" } } }] }
      : {}),
    nodes: [{ id: "a", kind: "prompt", label: "Work", prompt: "do" }],
    edges: [],
    created_at: now,
    updated_at: now,
  };
}

function runDir(): string {
  return join(mkdtempSync(join(tmpdir(), "agent-run-")), "run");
}

describe("resolveProviderSecrets (P-AGENT.16)", () => {
  test("fetches through the real seam + fake connector; env returned; BOTH artifact files dropped", () => {
    installFakeKms(RESOLVING_CLI);
    const dir = runDir();
    const r = resolveProviderSecrets(spec(true), dir);
    expect(r.ok).toBe(true);
    expect(r.skipped).toBeUndefined();
    expect(r.env).toEqual({ CRM_JIT_TOKEN: "resolved-crm_jit_token" });
    // inject-then-DROP: nothing secret-bearing survives on disk
    expect(existsSync(join(dir, "secrets.env.json"))).toBe(false);
    expect(existsSync(join(dir, "secrets.request.json"))).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
    rmSync(join(dir, ".."), { recursive: true, force: true });
  });

  test("a FAILED fetch attempt refuses (fail-closed) and never leaves files behind", () => {
    installFakeKms(`console.log(JSON.stringify({ ok: false, detail: "unresolved secret(s) - refusing partial credentials: CRM_JIT_TOKEN: permission denied" }));`);
    const dir = runDir();
    const r = resolveProviderSecrets(spec(true), dir);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("CRM_JIT_TOKEN");
    expect(r.env).toBeUndefined();
    expect(existsSync(join(dir, "secrets.request.json"))).toBe(false);
    rmSync(join(dir, ".."), { recursive: true, force: true });
  });

  test("a lying connector (ok but missing values) is refused — no partial credential set", () => {
    installFakeKms(`
import { readFileSync, writeFileSync } from "node:fs";
const req = JSON.parse(readFileSync(process.argv[process.argv.indexOf("--file") + 1], "utf8"));
writeFileSync(req.out, JSON.stringify({}), { mode: 0o600 });
console.log(JSON.stringify({ ok: true, detail: "fetched" }));`);
    const dir = runDir();
    const r = resolveProviderSecrets(spec(true), dir);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("partial credential");
    rmSync(join(dir, ".."), { recursive: true, force: true });
  });

  test("honest skips: no provider refs declared, or connector absent — never a refusal", () => {
    process.env.LUCID_ADDON_DIR = join(tmpdir(), "definitely-no-addon-here");
    const noRefs = resolveProviderSecrets(spec(false), runDir());
    expect(noRefs).toMatchObject({ ok: true, skipped: true });
    const noConnector = resolveProviderSecrets(spec(true), runDir());
    expect(noConnector.ok).toBe(true);
    expect(noConnector.skipped).toBe(true);
    expect(noConnector.detail).toContain("connector is not installed");
  });
});
