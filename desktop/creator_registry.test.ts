// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, test } from "bun:test";
import {
  CREATOR_INTEGRATIONS, CREATOR_PROVIDER_IDS, creatorRegistryStatus, foldProviderStatus,
  scanForInlineSecret, validateCreatorEndpoint, type CreatorEndpointDef,
} from "./creator_registry.ts";

const endpoint = (over: Partial<CreatorEndpointDef> = {}): CreatorEndpointDef => ({
  id: "local-comfy",
  providerId: "comfyui",
  label: "Workstation ComfyUI",
  baseUrl: "http://127.0.0.1:8188",
  zone: "local",
  enabled: true,
  ...over,
});

describe("the registry catalog (CREATOR-0, ADR-0282)", () => {
  test("every declared provider id has exactly one entry, and nothing else is in the catalog", () => {
    expect(CREATOR_INTEGRATIONS.map((s) => s.id).sort()).toEqual([...CREATOR_PROVIDER_IDS].sort());
    expect(new Set(CREATOR_INTEGRATIONS.map((s) => s.id)).size).toBe(CREATOR_INTEGRATIONS.length);
  });

  test("every capability carries an honesty label and a detail line the UI can show", () => {
    for (const spec of CREATOR_INTEGRATIONS) {
      expect(spec.capabilities.length).toBeGreaterThan(0);
      expect(spec.docsUrl.startsWith("https://")).toBe(true);
      expect(spec.note.length).toBeGreaterThan(10);
      for (const c of spec.capabilities) {
        expect(["available", "planned", "product-ui-only", "unverified-endpoint"]).toContain(c.status);
        expect(c.detail.length).toBeGreaterThan(10);
      }
    }
  });

  test("no catalog entry names an env SECRET value, only an env var NAME", () => {
    for (const spec of CREATOR_INTEGRATIONS) {
      if (!spec.secretEnv) continue;
      expect(spec.secretEnv).toMatch(/^[A-Z][A-Z0-9_]+$/);
    }
  });

  test("ElevenLabs Studio project editing is labeled vendor-app-only, never an API we claim", () => {
    const el = CREATOR_INTEGRATIONS.find((s) => s.id === "elevenlabs")!;
    expect(el.capabilities.find((c) => c.id === "library-manage")!.status).toBe("product-ui-only");
    expect(el.capabilities.find((c) => c.id === "alignment")!.status).toBe("available"); // timestamps ARE documented
    expect(el.consentRequired).toBe(true);
  });

  test("Suno generation is bring-your-own-endpoint (no public self-serve API in 2026), but the local library is real", () => {
    const suno = CREATOR_INTEGRATIONS.find((s) => s.id === "suno")!;
    expect(suno.capabilities.find((c) => c.id === "music")!.status).toBe("unverified-endpoint");
    expect(suno.capabilities.find((c) => c.id === "library-manage")!.status).toBe("available");
    expect(suno.capabilities.find((c) => c.id === "remix")!.status).toBe("available");
    expect(suno.note).toContain("No endpoint is hardcoded");
  });

  test("three.js needs no endpoint and no key at all", () => {
    const three = CREATOR_INTEGRATIONS.find((s) => s.id === "threejs")!;
    expect(three.transports).toEqual(["in-renderer"]);
    expect(three.authKind).toBe("none");
  });
});

describe("endpoint declarations are fail-closed", () => {
  test("a well-formed local ComfyUI declaration passes", () => {
    expect(validateCreatorEndpoint(endpoint()).ok).toBe(true);
  });

  test("a URL with embedded credentials is refused", () => {
    const r = validateCreatorEndpoint(endpoint({ baseUrl: "https://user:secret@comfy.internal:8188" }));
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toContain("credentials must never be embedded");
  });

  test("only http, https, ws, and wss are accepted", () => {
    for (const url of ["file:///etc/passwd", "ftp://host/x", "javascript:alert(1)"]) {
      expect(validateCreatorEndpoint(endpoint({ baseUrl: url })).ok).toBe(false);
    }
    expect(validateCreatorEndpoint(endpoint({ baseUrl: "wss://comfy.internal/ws" })).ok).toBe(true);
  });

  test("a command is an executable, never a shell string, and args carry no metacharacters", () => {
    expect(validateCreatorEndpoint({ id: "blender", providerId: "blender", label: "Blender 5", command: "/usr/bin/blender", args: ["-b"], zone: "local", enabled: true }).ok).toBe(true);
    const shell = validateCreatorEndpoint({ id: "blender", providerId: "blender", label: "Blender 5", command: "blender && rm -rf /", zone: "local", enabled: true });
    expect(shell.ok).toBe(false);
    expect(shell.errors.join(" ")).toContain("never a shell string");
    const arg = validateCreatorEndpoint({ id: "blender", providerId: "blender", label: "Blender 5", command: "/usr/bin/blender", args: ["-b; curl evil"], zone: "local", enabled: true });
    expect(arg.ok).toBe(false);
  });

  test("a provider is not launched by a path it has no transport for", () => {
    expect(validateCreatorEndpoint({ id: "el", providerId: "elevenlabs", label: "ElevenLabs", command: "/usr/bin/elevenlabs", zone: "external", enabled: true }).ok).toBe(false);
    expect(validateCreatorEndpoint({ id: "b", providerId: "blender", label: "Blender", baseUrl: "https://blender.example", zone: "external", enabled: true }).ok).toBe(false);
  });

  test("a pasted secret is caught in every field it could hide in", () => {
    expect(scanForInlineSecret(endpoint({ label: "key sk-abcdefghijklmnopqrst" }))).toBe("label");
    expect(scanForInlineSecret(endpoint({ baseUrl: "https://comfy.internal/?token=sk-abcdefghijklmnopqrst" }))).toBe("baseUrl");
    expect(scanForInlineSecret({ id: "b", providerId: "blender", label: "Blender", command: "/usr/bin/blender", args: ["--key", "sk-abcdefghijklmnopqrst"], zone: "local", enabled: true })).toBe("args");
    expect(scanForInlineSecret(endpoint())).toBeNull();
    expect(validateCreatorEndpoint(endpoint({ label: "sk-abcdefghijklmnopqrst" })).errors.join(" ")).toContain("store it in the vault");
  });

  test("vaultRef must be a NAME", () => {
    expect(validateCreatorEndpoint(endpoint({ vaultRef: "comfyui_token" })).ok).toBe(true);
    expect(validateCreatorEndpoint(endpoint({ vaultRef: "Bearer eyJhbGciOiJIUzI1NiJ9" })).ok).toBe(false);
  });
});

describe("availability folding", () => {
  test("no declaration means needs-endpoint, and a keyed provider without its key means needs-credential", () => {
    const comfy = CREATOR_INTEGRATIONS.find((s) => s.id === "comfyui")!;
    expect(foldProviderStatus(comfy, { endpoints: [], secretPresent: false }).state).toBe("needs-endpoint");
    expect(foldProviderStatus(comfy, { endpoints: [endpoint()], secretPresent: false }).state).toBe("needs-credential");
    expect(foldProviderStatus(comfy, { endpoints: [endpoint()], secretPresent: true }).state).toBe("configured");
    expect(foldProviderStatus(comfy, { endpoints: [endpoint()], secretPresent: true, discovered: ["workflow-run"] }).state).toBe("ready");
  });

  test("a disabled declaration does not count", () => {
    const comfy = CREATOR_INTEGRATIONS.find((s) => s.id === "comfyui")!;
    expect(foldProviderStatus(comfy, { endpoints: [endpoint({ enabled: false })], secretPresent: true }).state).toBe("needs-endpoint");
  });

  test("three.js is built-in and immediately usable; nothing to configure", () => {
    const three = CREATOR_INTEGRATIONS.find((s) => s.id === "threejs")!;
    const st = foldProviderStatus(three, { endpoints: [], secretPresent: false });
    expect(st.state).toBe("built-in");
    expect(st.usable).toContain("scene-preview");
  });

  test("Suno's LOCAL capabilities are usable with no endpoint and no key at all", () => {
    const suno = CREATOR_INTEGRATIONS.find((s) => s.id === "suno")!;
    const st = foldProviderStatus(suno, { endpoints: [], secretPresent: false });
    expect(st.state).toBe("needs-endpoint");
    expect(st.usable).toContain("library-manage");
    expect(st.usable).toContain("remix");
    expect(st.usable).not.toContain("music"); // generation is never claimed without a probed endpoint
  });

  test("a probe can never invent a capability the catalog does not know", () => {
    const comfy = CREATOR_INTEGRATIONS.find((s) => s.id === "comfyui")!;
    const st = foldProviderStatus(comfy, { endpoints: [endpoint()], secretPresent: true, discovered: ["engine-build"] });
    expect(st.usable).not.toContain("engine-build");
  });

  test("the full status list covers every provider in Studio order", () => {
    const all = creatorRegistryStatus({ comfyui: { endpoints: [endpoint()], secretPresent: true } });
    expect(all).toHaveLength(CREATOR_INTEGRATIONS.length);
    expect(all.find((p) => p.id === "comfyui")!.endpointCount).toBe(1);
    expect(all.find((p) => p.id === "unreal")!.state).toBe("needs-endpoint");
  });
});
