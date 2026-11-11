// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-VAULT-DEST.1 (ADR-0478): the Settings section builders. Collapsed unless open; an honest
// not-installed state with no connector controls; with the add-on, rows offer Test / Contents / Push /
// Pull / auto-backup and the form picks a client secret from the vault instead of taking one.

import { describe, expect, test } from "bun:test";
import { autoBackupLine, destSummary, VAULT_DEST_SEC, vaultDestCardHtml, type DestinationsData, type DestRow } from "./vault_dest_card.ts";

const DEST: DestRow = { id: "dest-1", name: "Team <KV>", kind: "azure-kv", config: { vaultName: "contoso-kv", cloud: "usgov", auth: "azure-cli" }, addedAt: Date.UTC(2026, 10, 1) };
const data = (installed: boolean, destinations: DestRow[] = []): DestinationsData => ({
  addon: { installed, note: "The kms connector is part of the LUCID enterprise add-on.", version: installed ? "0.9.0" : null },
  kinds: ["azure-kv", "aws-sm", "gcp-sm", "hashicorp-vault"],
  destinations,
});

describe("vault destinations card", () => {
  test("collapsed by default, open when asked", () => {
    expect(vaultDestCardHtml(data(true), [], false)).toContain(`class="set-sec set-coll" data-sec="${VAULT_DEST_SEC}"`);
    expect(vaultDestCardHtml(data(true), [], true)).toContain(`class="set-sec set-coll open" data-sec="${VAULT_DEST_SEC}"`);
  });

  test("not installed: says so, shows the seam's note, offers no connector action", () => {
    const h = vaultDestCardHtml(data(false), [], false);
    expect(h).toContain('data-vd-state="not-installed"');
    expect(h).toContain("Enterprise add-on not installed");
    expect(h).toContain("part of the LUCID enterprise add-on");
    for (const action of ["data-vd-check", "data-vd-push", "data-vd-pull", "data-vd-list", "data-vd-save", "data-vd-auto"]) expect(h).not.toContain(action);
    const stale = vaultDestCardHtml(data(false, [DEST]), [], false);
    expect(stale).toContain("data-vd-remove"); // removing a saved destination needs no connector
    expect(stale).not.toContain("data-vd-push");
  });

  test("installed: each row has its actions and auto-backup toggle; names are escaped", () => {
    const h = vaultDestCardHtml(data(true, [{ ...DEST, autoBackup: true }]), [{ ref: "secret:kv_client", label: "KV client", kind: "password" }], false);
    expect(h).toContain('data-vd-state="installed"');
    for (const action of ["data-vd-check", "data-vd-list", "data-vd-push", "data-vd-pull", "data-vd-edit", "data-vd-remove", "data-vd-save"]) expect(h).toContain(action);
    expect(h).toMatch(/data-vd-auto checked/);
    expect(h).toContain("Team &lt;KV&gt;");
    expect(h).not.toContain("Team <KV>");
    expect(h).toContain('value="secret:kv_client"'); // the client secret is picked from the vault by ref
    expect(h).not.toMatch(/type="password"/); // and never typed here
  });

  test("summary and auto-backup lines carry names, dates and outcomes", () => {
    expect(destSummary(DEST)).toContain("contoso-kv");
    expect(destSummary(DEST)).toContain("Azure Government");
    expect(autoBackupLine(DEST)).toBe("");
    expect(autoBackupLine({ ...DEST, autoBackup: true })).toContain("Auto-backup on");
    expect(autoBackupLine({ ...DEST, lastAutoBackup: { at: Date.now(), ok: true, pushed: 2, detail: "ok" } })).toContain("2 pushed");
    expect(autoBackupLine({ ...DEST, lastAutoBackup: { at: Date.now(), ok: false, pushed: 0, detail: "403 Secrets Officer" } })).toContain("failed: 403 Secrets Officer");
  });

  test("an engine that did not answer is a clear error, not an empty list", () => {
    const h = vaultDestCardHtml(null, [], true, "the engine did not answer");
    expect(h).toContain("Couldn't read the vault destinations: the engine did not answer");
    expect(h).not.toContain("data-vd-save");
  });
});
