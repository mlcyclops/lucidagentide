// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, test } from "bun:test";
import { creatorEndpointFromConfig, scanCreatorMailbox, type CreatorMailboxIo } from "./creator_mailbox.ts";
import { validateCreatorEndpoint, type CreatorEndpointDef } from "./creator_registry.ts";

const DIR = "/home/nick/.omp/creator_endpoints";
const docJson = (over: Record<string, unknown> = {}): string => JSON.stringify({
  kind: "lucid-creator-endpoint", version: 1, id: "nick-dgx-avatar", label: "Avatar render (Nick DGX)", provider: "dgx-avatar",
  url: "http://127.0.0.1:8088", enclave: { kind: "dgx", host: "10.0.0.8" },
  transport: { kind: "ssh-forward", command: "ssh -N -L 8088:127.0.0.1:8088 nick@10.0.0.8" }, exportedAt: 1790000000000, source: "dgx-loader 1.x",
  ...over,
});

/** An in-memory mailbox plus a settings list that runs the REAL declaration validator on upsert. */
function harness(files: Record<string, string> | null, existing: CreatorEndpointDef[] = []) {
  const saved: CreatorEndpointDef[] = [...existing];
  const io: CreatorMailboxIo = {
    listJson: (dir) => { if (!files || dir !== DIR) throw new Error("ENOENT"); return Object.keys(files); },
    readText: (path) => { const f = files?.[path.slice(DIR.length + 1)]; if (f === undefined) throw new Error("ENOENT"); return f; },
    endpoints: () => saved.map((e) => ({ ...e })),
    upsert: (def) => {
      const v = validateCreatorEndpoint(def);
      if (!v.ok) return v;
      const i = saved.findIndex((e) => e.id === def.id);
      if (i >= 0) saved[i] = def; else saved.push(def);
      return v;
    },
  };
  return { io, saved };
}

describe("the creator endpoint mailbox", () => {
  test("no mailbox yet is an empty report, never an error", () => {
    expect(scanCreatorMailbox(harness(null).io, DIR)).toEqual({ imported: [], rejected: [] });
  });

  test("an import becomes an internal-zone declaration attested as an enclave (contract section 3)", () => {
    const h = harness({ "nick-dgx-avatar.json": docJson(), "nick-dgx-cad.json": docJson({ id: "nick-dgx-cad", provider: "dgx-cad", url: "http://127.0.0.1:8089", label: "CAD (Nick DGX)" }) });
    const r = scanCreatorMailbox(h.io, DIR);
    expect(r).toEqual({ imported: ["nick-dgx-avatar", "nick-dgx-cad"], rejected: [] });
    expect(h.saved[0]).toEqual({ id: "nick-dgx-avatar", providerId: "dgx-avatar", label: "Avatar render (Nick DGX)", baseUrl: "http://127.0.0.1:8088", zone: "internal", enclave: true, enabled: true });
    expect(h.saved[1]!.providerId).toBe("dgx-cad");
  });

  test("one bad file is reported by name and the rest still import", () => {
    const h = harness({
      "a-good.json": docJson(),
      "b-not-json.json": "{oops",
      "c-secret.json": docJson({ id: "c", apiKey: "sk-whatever" }),
      "d-notes.txt": "ignored, not json",
    });
    const r = scanCreatorMailbox(h.io, DIR);
    expect(r.imported).toEqual(["nick-dgx-avatar"]);
    expect(r.rejected.map((x) => x.file)).toEqual(["b-not-json.json", "c-secret.json"]);
    expect(r.rejected[0]!.reason).toBe("unreadable or not JSON");
    expect(r.rejected[1]!.reason).toContain("credential-like field");
  });

  test("a contract-valid id the declaration validator refuses is rejected with that validator's reason", () => {
    const r = scanCreatorMailbox(harness({ "x.json": docJson({ id: "x" }) }).io, DIR);
    expect(r.imported).toEqual([]);
    expect(r.rejected[0]!.reason).toContain("2-49 chars");
  });

  test("a re-scan of an unchanged file imports nothing and never re-enables what the user switched off", () => {
    const h = harness({ "a.json": docJson() });
    scanCreatorMailbox(h.io, DIR);
    h.saved[0] = { ...h.saved[0]!, enabled: false };
    expect(scanCreatorMailbox(h.io, DIR).imported).toEqual([]);
    expect(h.saved[0]!.enabled).toBe(false);
  });

  test("a moved tunnel updates the URL but keeps the user's enabled choice", () => {
    const h = harness({ "a.json": docJson({ url: "http://127.0.0.1:18088" }) }, [
      { ...creatorEndpointFromConfig({ kind: "lucid-creator-endpoint", version: 1, id: "nick-dgx-avatar", label: "Avatar render (Nick DGX)", provider: "dgx-avatar", url: "http://127.0.0.1:8088", enclave: { kind: "dgx", host: "10.0.0.8" } }), enabled: false },
    ]);
    expect(scanCreatorMailbox(h.io, DIR).imported).toEqual(["nick-dgx-avatar"]);
    expect(h.saved[0]).toMatchObject({ baseUrl: "http://127.0.0.1:18088", enabled: false, enclave: true });
  });

  test("a file cannot take over an id that names another provider's declaration", () => {
    const comfy: CreatorEndpointDef = { id: "nick-dgx-avatar", providerId: "comfyui", label: "Mine", baseUrl: "http://127.0.0.1:8188", zone: "local", enabled: true };
    const h = harness({ "a.json": docJson() }, [comfy]);
    const r = scanCreatorMailbox(h.io, DIR);
    expect(r.imported).toEqual([]);
    expect(r.rejected[0]!.reason).toContain("already names a comfyui endpoint");
    expect(h.saved).toEqual([comfy]);
  });
});
