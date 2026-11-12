// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-COMPLY.1 (ADR-0479): the Contract D report shape, the per-requirement status logic, the read-only and
// no-secret guarantees of the probes, the route, the CLI arguments, and the control matrix CSV itself.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  auditProtectionCheck, authenticodeStatus, buildReport, configurationSettingsCheck, cryptoCheck, denyByDefaultCheck,
  eventLoggingCheck, gatherProbes, informationFlowCheck, keyManagementCheck, leastPrivilegeCheck, parseFdesetup,
  parseManageBde, renderMarkdown, signingCheck, transmissionStorageCheck,
  type AuditFacts, type ComplianceProbes, type EgressFacts,
} from "./compliance_report.ts";
import { handleComplianceRoutes } from "./compliance_routes.ts";
import { _setVaultBackendForTest } from "./engine_vault.ts";
import { __resetManagedCache } from "./managed_config.ts";
import { parseEvidenceArgs } from "../tools/compliance/evidence.ts";
import { MATRIX_COLUMNS, MATRIX_CSV, MATRIX_MD, parseCsv, readMatrix, renderMatrixMarkdown } from "../tools/compliance/matrix.ts";

const STATUSES = ["pass", "fail", "partial", "customer", "n/a"];

function probes(over: Partial<ComplianceProbes> = {}): ComplianceProbes {
  return {
    generatedAt: "2026-11-03T00:00:00.000Z",
    lucidVersion: "2.5.0",
    host: { os: "win32", arch: "x64", user: "assessor", diskEncryption: { status: "on", detail: "manage-bde" } },
    crypto: { module: "bun-boringssl", fips: false, detail: "node:crypto", osFipsPolicy: false, required: false },
    vault: { custody: "dpapi", state: "ok", entries: 3 },
    cui: { asksageOnly: false, managed: false },
    policy: { present: false, path: null, orgName: null },
    egress: { allowAll: true, allowWebSearch: true, whitelistEntries: 0, managedAllowedHosts: 0, managedDeniedHosts: 0, dangerModeDisabled: false, locked: false },
    audit: { enabled: true, sink: "file", path: "/x/lucid-audit.jsonl", exists: true, bytes: 10, lastWrite: "2026-11-03T00:00:00.000Z", ownerOnly: null },
    sandbox: { platform: "win32", requireIsolation: false, locksOn: false, foldersLocked: false },
    signing: { target: "C:/LucidAgentIDE.exe", status: "valid", signer: "CN=TECHLEAD 187 LLC", detail: "Signature verified." },
    ...over,
  };
}

describe("control-matrix-r3.csv", () => {
  const csvText = readFileSync(MATRIX_CSV, "utf8");
  const rows = parseCsv(csvText);
  const [header, ...body] = rows;
  const col = (name: string): number => header!.indexOf(name);

  test("parses with one header and a constant column count", () => {
    expect(header).toEqual([...MATRIX_COLUMNS]);
    for (const r of body) expect(r.length).toBe(header!.length);
    expect(readMatrix(csvText).length).toBe(body.length);
    expect(() => parseCsv('"open')).toThrow(/unterminated/);
    expect(parseCsv('a,"b,""c""\nd",e\r\nf,g,h')).toEqual([["a", 'b,"c"\nd', "e"], ["f", "g", "h"]]);
  });

  test("control-matrix-r3.md is the current rendering of the CSV", () => {
    expect(readFileSync(MATRIX_MD, "utf8").replace(/\r\n/g, "\n")).toBe(renderMatrixMarkdown(readMatrix(csvText)));
  });

  test("covers all 130 Rev 3 identifiers: 97 requirements + 33 withdrawn, 17 families, unique and ordered", () => {
    const ids = body.map((r) => r[col("r3_id")]!);
    expect(ids.length).toBe(130);
    expect(new Set(ids).size).toBe(130);
    expect([...ids].sort()).toEqual(ids);
    for (const id of ids) expect(id).toMatch(/^03\.(0[1-9]|1[0-7])\.\d\d$/);
    expect(new Set(ids.map((id) => id.slice(0, 5))).size).toBe(17);
    const withdrawn = body.filter((r) => r[col("status")] === "withdrawn");
    expect(withdrawn.length).toBe(33);
    for (const r of withdrawn) {
      expect(r[col("r3_title")]).toBe("Withdrawn");
      expect(r[col("withdrawn_note")]!.length).toBeGreaterThan(0);
      expect(r[col("responsibility")]).toBe("n-a");
    }
    for (const r of body.filter((x) => x[col("status")] !== "withdrawn")) {
      expect(["implemented", "partial", "planned", "gap", "customer"]).toContain(r[col("status")]!);
      expect(["LUCID", "shared", "customer", "n-a"]).toContain(r[col("responsibility")]!);
      expect(r[col("withdrawn_note")]).toBe("");
    }
  });

  test("Rev 2 cross-references are well-formed Rev 2 ids", () => {
    for (const r of body) {
      const r2 = r[col("r2_ids")]!;
      if (!r2) continue;
      for (const id of r2.split(";").map((s) => s.trim().replace(/ \[verify\]$/, ""))) expect(id).toMatch(/^3\.\d{1,2}\.\d{1,2}$/);
    }
  });

  test("every report check id and Rev 2 reference agrees with the matrix", () => {
    const byId = new Map(body.map((r) => [r[col("r3_id")]!, r]));
    for (const c of buildReport(probes()).checks) {
      const row = byId.get(c.id);
      expect(row).toBeDefined();
      expect(row![col("status")]).not.toBe("withdrawn");
      const r2 = row![col("r2_ids")]!.split(";").map((s) => s.trim().replace(/ \[verify\]$/, "")).filter(Boolean);
      for (const id of c.r2) expect(r2).toContain(id);
    }
  });

  test("no em dash in the compliance package", () => {
    const dir = join(import.meta.dir, "..", "docs", "compliance");
    for (const f of readdirSync(dir)) expect(readFileSync(join(dir, f), "utf8").includes("\u2014")).toBe(false);
  });
});

describe("buildReport (Contract D shape)", () => {
  test("carries every probe section plus checks sorted by id with valid fields", () => {
    const p = probes();
    const r = buildReport(p);
    for (const k of Object.keys(p)) expect(r).toHaveProperty(k);
    expect(r.checks.map((c) => c.id)).toEqual([...r.checks.map((c) => c.id)].sort());
    expect(new Set(r.checks.map((c) => c.id)).size).toBe(r.checks.length);
    for (const c of r.checks) {
      expect(c.id).toMatch(/^03\.\d\d\.\d\d$/);
      expect(STATUSES).toContain(c.status);
      for (const id of c.r2) expect(id).toMatch(/^3\.\d{1,2}\.\d{1,2}$/);
      expect(c.title.length).toBeGreaterThan(0);
      expect(c.evidence.length).toBeGreaterThan(0);
      expect(c.where.length).toBeGreaterThan(0);
    }
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
  });

  test("markdown lists every check and never uses an em dash", () => {
    const r = buildReport(probes());
    const md = renderMarkdown(r);
    for (const c of r.checks) expect(md).toContain(`| ${c.id} |`);
    expect(md.includes("\u2014")).toBe(false);
  });

  test("table cells escape backslash before pipe (CodeQL #119: incomplete escaping)", () => {
    const r = buildReport(probes());
    const md = renderMarkdown({ ...r, checks: [{ ...r.checks[0]!, evidence: "C:\\tmp\\ | bad\nnext" }] });
    // A trailing backslash must NOT be left able to escape the pipe that follows it.
    expect(md).toContain("| C:\\\\tmp\\\\ \\| bad next |");
  });
});

describe("status logic", () => {
  test("03.13.11 passes only with a FIPS-validated module", () => {
    expect(cryptoCheck({ module: "windows-cng", fips: true, detail: "CNG", osFipsPolicy: true, required: true }).status).toBe("pass");
    const notFips = cryptoCheck({ module: "bun-boringssl", fips: false, detail: "x", osFipsPolicy: null, required: false });
    expect(notFips.status).toBe("fail");
    const required = cryptoCheck({ module: "bun-boringssl", fips: false, detail: "x", osFipsPolicy: null, required: true });
    expect(required.status).toBe("fail");
    expect(required.evidence).not.toBe(notFips.evidence);
  });

  test("03.13.08 never passes (TLS gap) and fails only with neither vault custody nor disk encryption", () => {
    const off = { status: "off" as const, detail: "" };
    const on = { status: "on" as const, detail: "" };
    expect(transmissionStorageCheck({ custody: "dpapi", state: "ok", entries: 1 }, on).status).toBe("partial");
    expect(transmissionStorageCheck({ custody: "plaintext-file", state: "unavailable", entries: 1 }, on).status).toBe("partial");
    expect(transmissionStorageCheck({ custody: "keychain", state: "ok", entries: 1 }, off).status).toBe("partial");
    expect(transmissionStorageCheck({ custody: "plaintext-file", state: "unavailable", entries: 1 }, off).status).toBe("fail");
    expect(transmissionStorageCheck({ custody: "dpapi", state: "unreadable", entries: null }, { status: "unknown", detail: "" }).status).toBe("fail");
  });

  test("03.13.10 passes only for a readable vault under an OS key store", () => {
    for (const custody of ["dpapi", "keychain", "libsecret"]) expect(keyManagementCheck({ custody, state: "ok", entries: 0 }).status).toBe("pass");
    expect(keyManagementCheck({ custody: "plaintext-file", state: "unavailable", entries: 0 }).status).toBe("fail");
    expect(keyManagementCheck({ custody: "dpapi", state: "unreadable", entries: null }).status).toBe("fail");
  });

  test("03.01.03 follows the CUI lockdown: managed pass, user partial, off fail", () => {
    expect(informationFlowCheck({ asksageOnly: false, managed: true }).status).toBe("pass");
    expect(informationFlowCheck({ asksageOnly: true, managed: false }).status).toBe("partial");
    expect(informationFlowCheck({ asksageOnly: false, managed: false }).status).toBe("fail");
  });

  test("03.04.02 passes with a managed policy, else is the customer's", () => {
    expect(configurationSettingsCheck({ present: true, path: "p", orgName: "Org" }).status).toBe("pass");
    expect(configurationSettingsCheck({ present: false, path: null, orgName: null }).status).toBe("customer");
  });

  test("03.13.06 fails on allow-all, passes only when policy holds it off", () => {
    const e = (over: Partial<EgressFacts>): EgressFacts => ({ ...probes().egress, ...over });
    expect(denyByDefaultCheck(e({ allowAll: true })).status).toBe("fail");
    expect(denyByDefaultCheck(e({ allowAll: false })).status).toBe("partial");
    expect(denyByDefaultCheck(e({ allowAll: false, dangerModeDisabled: true })).status).toBe("pass");
    expect(denyByDefaultCheck(e({ allowAll: false, managedAllowedHosts: 2 })).status).toBe("pass");
    expect(denyByDefaultCheck(e({ allowAll: false, locked: true })).status).toBe("pass");
  });

  test("03.03.01 and 03.03.08 follow the audit sink", () => {
    const a = (over: Partial<AuditFacts>): AuditFacts => ({ ...probes().audit, ...over });
    expect(eventLoggingCheck(a({ enabled: false })).status).toBe("fail");
    expect(eventLoggingCheck(a({ exists: false })).status).toBe("partial");
    expect(eventLoggingCheck(a({})).status).toBe("pass");
    expect(auditProtectionCheck(a({ ownerOnly: false })).status).toBe("fail");
    expect(auditProtectionCheck(a({ ownerOnly: true })).status).toBe("partial");
    expect(auditProtectionCheck(a({ ownerOnly: null })).status).toBe("partial");
  });

  test("03.01.05 passes only when managed policy requires or locks the sandbox", () => {
    const s = probes().sandbox;
    expect(leastPrivilegeCheck({ ...s, requireIsolation: true }).status).toBe("pass");
    expect(leastPrivilegeCheck({ ...s, locksOn: true }).status).toBe("pass");
    expect(leastPrivilegeCheck(s).status).toBe("partial");
  });

  test("03.17.03 follows the binary signature", () => {
    const g = probes().signing;
    expect(signingCheck(g, "win32").status).toBe("pass");
    expect(signingCheck({ ...g, status: "unsigned" }, "darwin").status).toBe("fail");
    expect(signingCheck({ ...g, status: "invalid" }, "win32").status).toBe("fail");
    expect(signingCheck({ ...g, status: "not-found" }, "win32").status).toBe("n/a");
    expect(signingCheck({ ...g, status: "unknown" }, "linux").status).toBe("customer");
  });

  test("OS probe parsers", () => {
    expect(parseManageBde("    Protection Status:    Protection On\r\n")).toBe("on");
    expect(parseManageBde("    Protection Status:    Protection Off\r\n")).toBe("off");
    expect(parseManageBde("ERROR: An attempt to access a required resource was denied.")).toBe("unknown");
    expect(parseFdesetup("FileVault is On.\n")).toBe("on");
    expect(parseFdesetup("FileVault is Off.\n")).toBe("off");
    expect(parseFdesetup("")).toBe("unknown");
    expect(authenticodeStatus("Valid")).toBe("valid");
    expect(authenticodeStatus("NotSigned")).toBe("unsigned");
    expect(authenticodeStatus("HashMismatch")).toBe("invalid");
    expect(authenticodeStatus("")).toBe("unknown");
  });
});

describe("gatherProbes (isolated host state)", () => {
  const SECRET = "sk-test-NEVER-IN-REPORT-0123456789abcdef";
  const saved: Record<string, string | undefined> = {};
  const KEYS = ["LUCID_GUI_SETTINGS_FILE", "LUCID_ENGINE_VAULT_DIR", "LUCID_AUDIT_PATH", "LUCID_MANAGED_CONFIG", "LUCID_FIPS_REQUIRED"];
  let dir = "";
  let settingsFile = "";
  let vaultDir = "";

  beforeAll(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    dir = mkdtempSync(join(tmpdir(), "lucid-comply-"));
    settingsFile = join(dir, "lucid-gui.json");
    vaultDir = join(dir, "vault");
    writeFileSync(settingsFile, JSON.stringify({ asksageOnly: true, keys: { OPENAI_API_KEY: SECRET } }));
    writeFileSync(join(dir, "audit.jsonl"), '{"class_uid":2004}\n');
    writeFileSync(join(dir, "policy.json"), JSON.stringify({ orgName: "Test Org", models: { asksageOnly: true }, security: { exec: { requireIsolation: true }, egress: { disableDangerMode: true } } }));
    process.env.LUCID_GUI_SETTINGS_FILE = settingsFile;
    process.env.LUCID_ENGINE_VAULT_DIR = vaultDir;
    process.env.LUCID_AUDIT_PATH = join(dir, "audit.jsonl");
    process.env.LUCID_MANAGED_CONFIG = join(dir, "policy.json");
    process.env.LUCID_FIPS_REQUIRED = "1";
    _setVaultBackendForTest(() => null); // no OS key store: custody must report plaintext-file
    __resetManagedCache();
  });

  afterAll(() => {
    _setVaultBackendForTest(null);
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    __resetManagedCache();
    rmSync(dir, { recursive: true, force: true });
  });

  test("reads the seams, writes nothing, and never carries a secret value", async () => {
    const before = readFileSync(settingsFile, "utf8");
    const r = buildReport(await gatherProbes({ skipOsProbes: true, now: () => new Date("2026-11-03T12:00:00Z") }));
    expect(r.generatedAt).toBe("2026-11-03T12:00:00.000Z");
    expect(r.cui).toEqual({ asksageOnly: true, managed: true });
    expect(r.policy.present).toBe(true);
    expect(r.policy.orgName).toBe("Test Org");
    expect(r.vault.custody).toBe("plaintext-file");
    expect(r.crypto.required).toBe(true);
    expect(r.audit.exists).toBe(true);
    expect(r.audit.path).toBe(join(dir, "audit.jsonl"));
    expect(r.sandbox.requireIsolation).toBe(true);
    expect(r.egress.allowAll).toBe(false);
    expect(r.egress.dangerModeDisabled).toBe(true);
    expect(r.signing.status).toBe("unknown");
    expect(r.host.diskEncryption.status).toBe("unknown");
    const byId = Object.fromEntries(r.checks.map((c) => [c.id, c.status]));
    expect(byId["03.01.03"]).toBe("pass");
    expect(byId["03.01.05"]).toBe("pass");
    expect(byId["03.04.02"]).toBe("pass");
    expect(byId["03.13.06"]).toBe("pass");
    expect(byId["03.13.10"]).toBe("fail");
    expect(byId["03.13.11"]).toBe(r.crypto.fips ? "pass" : "fail");
    const serialized = JSON.stringify(r) + renderMarkdown(r);
    expect(serialized.includes(SECRET)).toBe(false);
    expect(serialized.includes(SECRET.slice(-4))).toBe(false);
    expect(readFileSync(settingsFile, "utf8")).toBe(before);
    expect(existsSync(vaultDir)).toBe(false);
  });
});

describe("GET /api/compliance/report", () => {
  test("ignores other paths and refuses non-GET", async () => {
    expect(await handleComplianceRoutes(new Request("http://127.0.0.1/api/audit"), "/api/audit")).toBeNull();
    const post = await handleComplianceRoutes(new Request("http://127.0.0.1/api/compliance/report", { method: "POST" }), "/api/compliance/report");
    expect(post?.status).toBe(405);
  });
});

describe("evidence CLI arguments", () => {
  test("parses flags and rejects unknown or valueless ones", () => {
    expect(parseEvidenceArgs([])).toEqual({ skipOsProbes: false });
    expect(parseEvidenceArgs(["--out", "ev", "--installer", "C:/a.exe", "--skip-os-probes"])).toEqual({ out: "ev", installer: "C:/a.exe", skipOsProbes: true });
    expect(() => parseEvidenceArgs(["--out"])).toThrow(/needs a value/);
    expect(() => parseEvidenceArgs(["--out", "--skip-os-probes"])).toThrow(/needs a value/);
    expect(() => parseEvidenceArgs(["--bogus"])).toThrow(/unknown argument/);
  });
});
