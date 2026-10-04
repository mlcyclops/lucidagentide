// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, test } from "bun:test";
import { cuiProviderVerdict, cuiRefusal, gateCreatorProvider, isLoopbackHost, type CuiRefusalAudit } from "./cui_policy.ts";
import { CREATOR_INTEGRATIONS, type CreatorEndpointDef, type CreatorIntegrationSpec } from "./creator_registry.ts";

const spec = (id: string): CreatorIntegrationSpec => CREATOR_INTEGRATIONS.find((s) => s.id === id)!;
const ep = (over: Partial<CreatorEndpointDef> = {}): CreatorEndpointDef => ({
  id: "comfy", providerId: "comfyui", label: "ComfyUI", baseUrl: "http://127.0.0.1:8188", zone: "local", enabled: true, ...over,
});

describe("unlocked", () => {
  test("every provider is allowed, cloud included, with its catalog posture", () => {
    for (const s of CREATOR_INTEGRATIONS) {
      const v = cuiProviderVerdict(false, s, ep({ providerId: s.id, zone: "external", baseUrl: "https://example.com" }));
      expect(v.allowed).toBe(true);
      expect(v.posture).toBe(s.cui.posture);
    }
  });
});

describe("locked: rule by rule", () => {
  test("a cloud provider without an authorization is refused, with or without an endpoint", () => {
    expect(cuiProviderVerdict(true, spec("elevenlabs"))).toMatchObject({ allowed: false, posture: "cloud" });
    expect(cuiProviderVerdict(true, spec("elevenlabs")).reason).toContain("no CUI authorization");
    expect(cuiProviderVerdict(true, spec("suno"), ep({ providerId: "suno", baseUrl: "https://partner.example", zone: "external" })).allowed).toBe(false);
  });

  test("an enclave flag cannot launder a cloud service", () => {
    expect(cuiProviderVerdict(true, spec("suno"), ep({ providerId: "suno", baseUrl: "http://127.0.0.1:9000", zone: "local", enclave: true })).allowed).toBe(false);
  });

  test("a cloud provider WITH an authorization string is allowed (the AskSage case)", () => {
    const authorized: CreatorIntegrationSpec = { ...spec("heygen"), cui: { posture: "cloud", authorization: "FedRAMP Moderate ATO 2026-01" } };
    const v = cuiProviderVerdict(true, authorized);
    expect(v).toMatchObject({ allowed: true, posture: "cloud" });
    expect(v.reason).toContain("FedRAMP Moderate ATO 2026-01");
    expect(cuiProviderVerdict(true, { ...authorized, cui: { posture: "cloud", authorization: "   " } }).allowed).toBe(false);
  });

  test("no network endpoint is allowed: in-renderer, a child process, or nothing declared", () => {
    expect(cuiProviderVerdict(true, spec("threejs")).reason).toContain("sandboxed renderer");
    expect(cuiProviderVerdict(true, spec("pdf-markup")).allowed).toBe(true);
    const child = cuiProviderVerdict(true, spec("hyperframes"), ep({ providerId: "hyperframes", baseUrl: undefined, command: "/usr/bin/hyperframes" }));
    expect(child).toMatchObject({ allowed: true, posture: "on-device" });
    expect(child.reason).toContain("child process");
    expect(cuiProviderVerdict(true, spec("comfyui")).allowed).toBe(true);
  });

  test("an endpoint attested as an enclave is allowed whatever its zone", () => {
    for (const zone of ["local", "internal", "external"] as const) {
      const v = cuiProviderVerdict(true, spec("dgx-avatar"), ep({ providerId: "dgx-avatar", baseUrl: "http://10.0.0.8:8088", zone, enclave: true }));
      expect(v).toMatchObject({ allowed: true, posture: "enclave" });
    }
  });

  test("zone local + loopback + an on-device provider is allowed", () => {
    for (const url of ["http://127.0.0.1:8188", "http://localhost:8188", "http://[::1]:8188", "ws://127.8.9.10:8188/ws"]) {
      expect(cuiProviderVerdict(true, spec("comfyui"), ep({ baseUrl: url })).allowed).toBe(true);
    }
  });

  test("a loopback endpoint for an ENCLAVE-posture provider still needs the attestation", () => {
    const v = cuiProviderVerdict(true, spec("dgx-cad"), ep({ providerId: "dgx-cad", baseUrl: "http://127.0.0.1:8089", zone: "local" }));
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain("must be attested as a DGX enclave host");
  });

  test("zone local but a non-loopback host is refused (a LAN box is not this workstation)", () => {
    const v = cuiProviderVerdict(true, spec("comfyui"), ep({ baseUrl: "http://192.168.1.20:8188" }));
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain("not a loopback address");
    expect(cuiProviderVerdict(true, spec("comfyui"), ep({ baseUrl: "http://localhost.evil.example:8188" })).allowed).toBe(false);
  });

  test("an internal endpoint that is not an enclave is refused", () => {
    const v = cuiProviderVerdict(true, spec("comfyui"), ep({ baseUrl: "http://gpu-box.internal:8188", zone: "internal" }));
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain("not attested as a DGX enclave host");
    expect(cuiProviderVerdict(true, spec("comfyui"), ep({ baseUrl: "http://127.0.0.1:8188", zone: "internal" })).allowed).toBe(false);
  });

  test("an external endpoint is refused", () => {
    const v = cuiProviderVerdict(true, spec("comfyui"), ep({ baseUrl: "https://comfy.example.com", zone: "external" }));
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain("external endpoint");
  });

  test("an unparseable URL is refused, never assumed local", () => {
    expect(cuiProviderVerdict(true, spec("comfyui"), ep({ baseUrl: "not a url" })).allowed).toBe(false);
  });
});

describe("isLoopbackHost", () => {
  test("only literal loopback counts", () => {
    for (const h of ["localhost", "LOCALHOST", "127.0.0.1", "127.255.255.254", "[::1]", "::1"]) expect(isLoopbackHost(h)).toBe(true);
    for (const h of ["127.0.0.256", "128.0.0.1", "0.0.0.0", "localhost.example", "10.0.0.1", "", "::"]) expect(isLoopbackHost(h)).toBe(false);
  });
});

describe("the route gate", () => {
  test("a refusal is audited once with metadata only, and its envelope carries the verdict", () => {
    const audits: CuiRefusalAudit[] = [];
    const v = gateCreatorProvider(true, spec("comfyui"), ep({ id: "lab", baseUrl: "https://comfy.example.com", zone: "external" }), (e) => audits.push(e));
    expect(v.allowed).toBe(false);
    expect(audits).toEqual([{ providerId: "comfyui", endpointId: "lab", reason: v.reason }]);
    const body = cuiRefusal(v);
    expect(body.ok).toBe(false);
    expect(body.error.startsWith("CUI lockdown: ")).toBe(true);
    expect(body.data.cui).toEqual(v);
  });

  test("an allowed call is not audited, and unlocking stops every refusal", () => {
    const audits: CuiRefusalAudit[] = [];
    gateCreatorProvider(true, spec("comfyui"), ep(), (e) => audits.push(e));
    gateCreatorProvider(false, spec("elevenlabs"), undefined, (e) => audits.push(e));
    expect(audits).toEqual([]);
  });

  test("a throwing audit sink never turns a refusal into an allow", () => {
    const v = gateCreatorProvider(true, spec("elevenlabs"), undefined, () => { throw new Error("sink down"); });
    expect(v.allowed).toBe(false);
  });
});
