// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-VAULT-ENV.1 (ADR-0477): the "Import from .env" card markup. Blocked rows cannot be ticked, a stored
// value is not preselected, the follow-ups are opt-in (unchecked), a committed file shows the rotate
// warning, and the temporary write is tucked away in a collapsed block.

import { describe, expect, test } from "bun:test";
import { importSummary, preselected, vaultEnvScanHtml, type EnvScan, type EnvScanRow } from "./vault_env_view.ts";

const row = (over: Partial<EnvScanRow>): EnvScanRow => ({
  name: "STRIPE_SECRET_KEY", line: 1, slot: "workspace", ref: "ws:0123456789abcdef:STRIPE_SECRET_KEY", envName: "STRIPE_SECRET_KEY",
  kind: "apikey", status: "new", last4: "0005", ...over,
});
const scan = (over: Partial<EnvScan> = {}): EnvScan => ({
  workspace: "/w/app", file: ".env", exists: true, problems: [], isGit: true, ignored: false, committed: false,
  rows: [
    row({}),
    row({ name: "GITHUB_TOKEN", slot: "git-host", host: "github.com", ref: "git_pat_github_com", status: "same", last4: "001A" }),
    row({ name: "GH_TOKEN", slot: "git-host", host: "github.com", ref: "git_pat_github_com", blocked: "same slot as GITHUB_TOKEN" }),
    row({ name: "<b>X</b>", last4: undefined, status: "replaces" }),
  ],
  ...over,
});
const checkbox = (html: string, name: string): string => html.match(new RegExp(`<input type="checkbox" data-venv-name="${name}"[^>]*>`))?.[0] ?? "";

describe("vaultEnvScanHtml", () => {
  test("new and replacing rows are preselected; a stored or blocked one is not; a blocked one is disabled", () => {
    const h = vaultEnvScanHtml(scan());
    expect(checkbox(h, "STRIPE_SECRET_KEY")).toContain(" checked");
    expect(checkbox(h, "GITHUB_TOKEN")).not.toContain(" checked");
    expect(checkbox(h, "GH_TOKEN")).toContain(" disabled");
    expect(checkbox(h, "GH_TOKEN")).not.toContain(" checked");
    expect(h).toContain("same slot as GITHUB_TOKEN");
    expect(h).toContain("••••001A");
    expect(h).toContain("git token · github.com");
    expect(h).not.toContain("<b>X</b>"); // names are escaped
    expect(scan().rows.filter(preselected).map((r) => r.name)).toEqual(["STRIPE_SECRET_KEY", "<b>X</b>"]);
  });

  test("blank and gitignore are opt-in; an ignored file offers no gitignore box", () => {
    const h = vaultEnvScanHtml(scan());
    expect(h).toMatch(/<input type="checkbox" data-venv-opt="blank" \/>/);
    expect(h).toMatch(/<input type="checkbox" data-venv-opt="gitignore" \/>/);
    expect(vaultEnvScanHtml(scan({ ignored: true }))).not.toContain('data-venv-opt="gitignore"');
  });

  test("a committed file shows the rotate warning; the temporary write is never on the default path", () => {
    expect(vaultEnvScanHtml(scan())).not.toContain("data-venv-rotate");
    expect(vaultEnvScanHtml(scan({ committed: true }))).toContain("data-venv-rotate");
    const h = vaultEnvScanHtml(scan());
    const details = h.indexOf("<details");
    expect(details).toBeGreaterThan(h.indexOf('data-venv="import"'));
    expect(h.indexOf('data-venv="materialize"')).toBeGreaterThan(details);
    expect(h).not.toContain("<details open");
  });

  test("no file, an empty file and unreadable lines each say so", () => {
    expect(vaultEnvScanHtml(scan({ exists: false }))).toContain("No .env file");
    expect(vaultEnvScanHtml(scan({ rows: [] }))).toContain("no NAME=value entries");
    expect(vaultEnvScanHtml(scan({ problems: [{ line: 3, reason: "x" }, { line: 9, reason: "y" }] }))).toContain("line 3, 9");
  });
});

test("importSummary names what moved and what was skipped, never more", () => {
  const s = importSummary({
    imported: [{ name: "A", ref: "ws:x:A", slot: "workspace", envName: "A" }], skipped: [{ name: "PATH", reason: "reserved name" }],
    blanked: true, gitignored: true, committed: false,
  });
  expect(s.title).toBe("Imported from .env");
  expect(s.desc).toContain("1 secret moved into the vault: A.");
  expect(s.desc).toContain("PATH (reserved name)");
  expect(importSummary({ imported: [], skipped: [], blanked: false, gitignored: false, committed: null }).title).toBe("Nothing imported");
});
