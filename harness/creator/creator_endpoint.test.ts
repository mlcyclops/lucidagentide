// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, test } from "bun:test";
import { parseCreatorEndpointConfig } from "./creator_endpoint.ts";

/** The contract's own example document (lucid-creator-endpoint v1, contract section 3). */
const doc = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: "lucid-creator-endpoint",
  version: 1,
  id: "nick-dgx-avatar",
  label: "Avatar render (Nick DGX)",
  provider: "dgx-avatar",
  url: "http://127.0.0.1:8088",
  enclave: { kind: "dgx", host: "10.0.0.8" },
  transport: { kind: "ssh-forward", command: "ssh -N -L 8088:127.0.0.1:8088 nick@10.0.0.8" },
  exportedAt: 1790000000000,
  source: "dgx-loader 1.x",
  ...over,
});

const reason = (raw: unknown): string => {
  const r = parseCreatorEndpointConfig(raw);
  if (r.ok) throw new Error("expected a rejection");
  return r.reason;
};

describe("lucid-creator-endpoint v1", () => {
  test("the contract example parses, normalized and complete", () => {
    const r = parseCreatorEndpointConfig(doc());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config).toEqual({
      kind: "lucid-creator-endpoint", version: 1, id: "nick-dgx-avatar", label: "Avatar render (Nick DGX)", provider: "dgx-avatar",
      url: "http://127.0.0.1:8088", enclave: { kind: "dgx", host: "10.0.0.8" },
      transport: { kind: "ssh-forward", command: "ssh -N -L 8088:127.0.0.1:8088 nick@10.0.0.8" },
      exportedAt: 1790000000000, source: "dgx-loader 1.x",
    });
    const cad = parseCreatorEndpointConfig(doc({ id: "nick-dgx-cad", provider: "dgx-cad", url: "http://127.0.0.1:8089/" }));
    expect(cad.ok && cad.config.url).toBe("http://127.0.0.1:8089");
  });

  test("a dgx-vision export is imported as its own provider, still enclave-attested", () => {
    const r = parseCreatorEndpointConfig(doc({ id: "nick-dgx-vision", provider: "dgx-vision", url: "http://127.0.0.1:8090/", label: "Vision (Nick DGX)" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.provider).toBe("dgx-vision");
    expect(r.config.url).toBe("http://127.0.0.1:8090");
    expect(r.config.enclave).toEqual({ kind: "dgx", host: "10.0.0.8" });
    expect(reason(doc({ provider: "dgx-vision", enclave: undefined }))).toContain("enclave is required");
    expect(reason(doc({ provider: "DGX-VISION" }))).toContain("unsupported provider");
  });

  test("unknown kind, version, or provider is rejected, never guessed", () => {
    expect(reason(doc({ kind: "lucid-voice-endpoint" }))).toContain("not a lucid-creator-endpoint");
    expect(reason(doc({ version: 2 }))).toContain("unsupported version (2)");
    expect(reason(doc({ version: undefined }))).toContain("unsupported version");
    expect(reason(doc({ provider: "heygen" }))).toContain("unsupported provider (heygen)");
    expect(reason([doc()])).toBe("not a JSON object");
    expect(reason(null)).toBe("not a JSON object");
  });

  test("a credential-like key ANYWHERE rejects the whole file", () => {
    expect(reason(doc({ apiKey: "x" }))).toContain("credential-like field (\"apiKey\")");
    expect(reason(doc({ transport: { kind: "ssh-forward", privateKeyPath: "~/.ssh/id_ed25519" } }))).toContain("privateKeyPath");
    expect(reason(doc({ enclave: { kind: "dgx", host: "10.0.0.8", token: "t" } }))).toContain("\"token\"");
  });

  test("ids are slugs, so an import can never write outside its own name", () => {
    for (const id of ["../evil", "Nick", "-lead", "", "a".repeat(65), "has space"]) expect(reason(doc({ id }))).toContain("lowercase slug");
    expect(parseCreatorEndpointConfig(doc({ id: "a" })).ok).toBe(true);
    expect(parseCreatorEndpointConfig(doc({ id: "a".repeat(64) })).ok).toBe(true);
  });

  test("the url is http(s), carries no userinfo, and is a bare base", () => {
    expect(reason(doc({ url: "http://nick:pw@127.0.0.1:8088" }))).toContain("must not embed credentials");
    expect(reason(doc({ url: "file:///etc/passwd" }))).toContain("must be http(s)");
    expect(reason(doc({ url: "not a url" }))).toContain("does not parse");
    expect(reason(doc({ url: "http://127.0.0.1:8088/?next=x" }))).toContain("bare base URL");
    expect(reason(doc({ url: 8088 }))).toBe("url is required");
  });

  test("the enclave attestation is required and shaped", () => {
    expect(reason(doc({ enclave: undefined }))).toContain("enclave is required");
    expect(reason(doc({ enclave: true }))).toContain("enclave is required");
    expect(reason(doc({ enclave: { kind: "aws", host: "10.0.0.8" } }))).toContain("enclave.kind");
    expect(reason(doc({ enclave: { kind: "dgx", host: "nick@10.0.0.8" } }))).toContain("enclave.host");
    expect(reason(doc({ enclave: { kind: "dgx", host: "" } }))).toContain("enclave.host");
    expect(parseCreatorEndpointConfig(doc({ enclave: { kind: "dgx", host: "spark-01.lab" } })).ok).toBe(true);
  });

  test("labels are bounded and optional fields are dropped when malformed", () => {
    expect(reason(doc({ label: " " }))).toContain("label");
    expect(reason(doc({ label: "x".repeat(81) }))).toContain("label");
    const r = parseCreatorEndpointConfig(doc({ exportedAt: "yesterday", source: 7, transport: { kind: "carrier-pigeon" } }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.exportedAt).toBeUndefined();
    expect(r.config.source).toBeUndefined();
    expect(r.config.transport).toEqual({ kind: "direct" });
  });
});
