// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/addon_seam.test.ts — P-AGENT.10 (ADR-0138): the enterprise add-on seam. Honest absence, presence
// probing, and the one-JSON-line CLI dispatch contract (fail-honest on every bad reply shape).

import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addonDir, connectorStatus, connectorVersion, runConnector } from "./addon_seam.ts";

let tmp: string | null = null;
afterEach(() => {
  delete process.env.LUCID_ADDON_DIR;
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

function fakeAddon(cliBody: string): string {
  tmp = mkdtempSync(join(tmpdir(), "lucid-addon-"));
  const dir = join(tmp, "connectors", "n8n");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@lucid-addon/n8n", version: "0.1.0" }));
  writeFileSync(join(dir, "src", "cli.ts"), cliBody);
  process.env.LUCID_ADDON_DIR = tmp;
  return tmp;
}

describe("addon seam (P-AGENT.10)", () => {
  test("without the add-on, status is installed:false with an actionable note (never a fake feature)", () => {
    process.env.LUCID_ADDON_DIR = join(tmpdir(), "definitely-not-a-real-addon-dir");
    const st = connectorStatus("n8n");
    expect(st.installed).toBe(false);
    expect(st.note).toContain("enterprise add-on");
    expect(connectorVersion("n8n")).toBeNull();
    const r = runConnector("n8n", "push", "artifact.json");
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("enterprise add-on");
  });

  test("env LUCID_ADDON_DIR overrides the sibling default", () => {
    process.env.LUCID_ADDON_DIR = "X:/custom/addon";
    expect(addonDir()).toBe("X:/custom/addon");
    delete process.env.LUCID_ADDON_DIR;
    expect(addonDir().toLowerCase()).toContain("lucidagentideaddon");
  });

  test("an installed connector is dispatched and its one-line JSON reply is returned", () => {
    fakeAddon(`console.log(JSON.stringify({ ok: true, detail: "pushed", url: "https://n8n.local/workflow/7" }));`);
    const st = connectorStatus("n8n");
    expect(st.installed).toBe(true);
    expect(connectorVersion("n8n")).toBe("0.1.0");
    const r = runConnector("n8n", "push", "artifact.json");
    expect(r).toEqual({ ok: true, detail: "pushed", url: "https://n8n.local/workflow/7" });
  });

  test("a connector that fails, or replies with garbage, is reported as failure — never success", () => {
    fakeAddon(`console.error("boom"); process.exit(3);`);
    expect(runConnector("n8n", "push", "artifact.json").ok).toBe(false);
    fakeAddon(`console.log("not json at all");`);
    const r = runConnector("n8n", "push", "artifact.json");
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("not JSON");
  });
});
