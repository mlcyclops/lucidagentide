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

describe("the free / self-hosted additions and the paid catalog", () => {
  const spec = (id: string) => CREATOR_INTEGRATIONS.find((s) => s.id === id)!;

  test("every spec carries a CUI posture, and exactly the third-party services are cloud", () => {
    for (const s of CREATOR_INTEGRATIONS) expect(["on-device", "enclave", "cloud"]).toContain(s.cui.posture);
    expect(CREATOR_INTEGRATIONS.filter((s) => s.cui.posture === "cloud").map((s) => s.id).sort())
      .toEqual(["autodesk-aps", "bluebeam-studio", "elevenlabs", "heygen", "suno"]);
    // No Creator provider is CUI-authorized today: an authorization string is a deliberate, reviewed claim.
    expect(CREATOR_INTEGRATIONS.filter((s) => s.cui.authorization)).toEqual([]);
    expect(spec("dgx-avatar").cui.posture).toBe("enclave");
    expect(spec("dgx-cad").cui.posture).toBe("enclave");
    expect(spec("classcad").cui.posture).toBe("enclave"); // key sign-in + relay by default: never "on-device"
  });

  test("the free providers are available through the surface that really backs them", () => {
    expect(spec("hyperframes").transports).toEqual(["child-process"]);
    expect(spec("hyperframes").capabilities.find((c) => c.id === "video-compose")!.status).toBe("available");
    expect(spec("dgx-avatar").capabilities.find((c) => c.id === "avatar-video")!.status).toBe("available");
    expect(spec("dgx-cad").capabilities.map((c) => c.id).sort()).toEqual(["bim-inspect", "cad-convert", "cad-drawing", "cad-model"]);
    expect(spec("pdf-markup").transports).toEqual(["in-renderer"]);
    expect(spec("pdf-markup").group).toBe("cad");
  });

  test("a DGX service claims nothing usable until its /health probe attests it; pdf-markup is built in", () => {
    for (const id of ["dgx-avatar", "dgx-cad", "hyperframes"]) {
      expect(foldProviderStatus(spec(id), { endpoints: [], secretPresent: false }).usable).toEqual([]);
    }
    const cad: CreatorEndpointDef = { id: "nick-dgx-cad", providerId: "dgx-cad", label: "CAD", baseUrl: "http://127.0.0.1:8089", zone: "internal", enclave: true, enabled: true };
    expect(foldProviderStatus(spec("dgx-cad"), { endpoints: [cad], secretPresent: false, discovered: ["cad-drawing"] }).usable).toEqual(["cad-drawing"]);
    expect(foldProviderStatus(spec("pdf-markup"), { endpoints: [], secretPresent: false })).toMatchObject({ state: "built-in", usable: ["pdf-markup"] });
  });

  test("the Design suite: dgx-vision is an enclave service attested by probe, design is built into the renderer", () => {
    expect(spec("dgx-vision")).toMatchObject({ group: "video", kind: "local-service", transports: ["local-http"], cui: { posture: "enclave" } });
    expect(spec("dgx-vision").capabilities.map((c) => c.id).sort())
      .toEqual(["depth", "inpaint", "layer-decompose", "matte", "segment", "upscale", "vectorize", "vision-label"]);
    expect(foldProviderStatus(spec("dgx-vision"), { endpoints: [], secretPresent: false })).toMatchObject({ state: "needs-endpoint", usable: [] });
    const vision: CreatorEndpointDef = { id: "nick-dgx-vision", providerId: "dgx-vision", label: "Vision", baseUrl: "http://127.0.0.1:8090", zone: "internal", enclave: true, enabled: true };
    expect(foldProviderStatus(spec("dgx-vision"), { endpoints: [vision], secretPresent: false, discovered: ["segment", "upscale", "cad-model"] }).usable).toEqual(["segment", "upscale"]);
    expect(spec("design")).toMatchObject({ kind: "renderer", transports: ["in-renderer"], cui: { posture: "on-device" } });
    expect(foldProviderStatus(spec("design"), { endpoints: [], secretPresent: false })).toMatchObject({
      state: "built-in", usable: ["layers", "mask-trace", "vector-draw", "motion", "gif-export", "svg-export", "psd-export"],
    });
  });

  test("Drift is an on-device local app over its own localhost protocol with a bearer session token", () => {
    expect(spec("drift")).toMatchObject({
      group: "video", kind: "local-app", transports: ["local-http"], authKind: "bearer",
      secretEnv: "DRIFT_MCP_TOKEN", vaultRefHint: "drift_mcp_token", consentRequired: false, cui: { posture: "on-device" },
    });
    expect(spec("drift").capabilities.map((c) => c.id).sort()).toEqual(["motion", "stock-media", "transcript-edit", "video-edit"]);
    expect(spec("drift").capabilities.find((c) => c.id === "stock-media")!.detail).toContain("CC BY-NC-SA 4.0");
    expect(foldProviderStatus(spec("drift"), { endpoints: [], secretPresent: false })).toMatchObject({ state: "needs-endpoint" });
    const session: CreatorEndpointDef = { id: "drift-session", providerId: "drift", label: "Drift", baseUrl: "http://127.0.0.1:4731", zone: "local", enabled: true };
    expect(foldProviderStatus(spec("drift"), { endpoints: [session], secretPresent: false }).state).toBe("needs-credential");
    expect(foldProviderStatus(spec("drift"), { endpoints: [session], secretPresent: true, locked: true, discovered: ["video-edit", "motion"] }))
      .toMatchObject({ state: "ready", usable: ["video-edit", "motion"], cui: { allowed: true } });
  });

  test("under lockdown dgx-vision needs an enclave attestation; the design editor stays allowed", () => {
    const loopback: CreatorEndpointDef = { id: "my-vision", providerId: "dgx-vision", label: "Vision", baseUrl: "http://127.0.0.1:8090", zone: "local", enabled: true };
    const locked = creatorRegistryStatus({ "dgx-vision": { endpoints: [loopback], secretPresent: false } }, true);
    expect(locked.find((p) => p.id === "dgx-vision")!.cui).toMatchObject({ allowed: false, posture: "enclave" });
    expect(locked.find((p) => p.id === "design")!.cui.allowed).toBe(true);
    const attested = creatorRegistryStatus({ "dgx-vision": { endpoints: [{ ...loopback, zone: "internal", enclave: true }], secretPresent: false } }, true);
    expect(attested.find((p) => p.id === "dgx-vision")!.cui.allowed).toBe(true);
  });

  test("paid entries are honest about price and reach, and ODA is only planned", () => {
    expect(spec("heygen").docsUrl).toBe("https://docs.heygen.com");
    expect(spec("autodesk-aps").note).toContain("Flex tokens");
    expect(spec("autodesk-aps").note).toContain("no self-hosted option");
    expect(spec("bluebeam-studio").note).toContain("production app approval");
    expect(spec("classcad").note).toContain("CLASSCAD_SHARE=off");
    expect(spec("oda-drawings").capabilities.every((c) => c.status === "planned")).toBe(true);
  });

  // CREATOR-WHISTLE (ADR-0432 decision 6)
  test("Whistle is an in-engine provider: no endpoint, no key, on-device, sitting right after dots.tts", () => {
    expect(spec("whistle")).toMatchObject({
      name: "Whistle (in-process)", group: "audio", kind: "local-service", transports: ["in-engine"], authKind: "none",
      consentRequired: false, docsUrl: "https://huggingface.co/Cactus-Compute/whistle", cui: { posture: "on-device" },
    });
    expect(spec("whistle").secretEnv).toBeUndefined();
    expect(spec("whistle").capabilities.map((c) => [c.id, c.status, c.surface])).toEqual([["stt", "available", "runtime"], ["alignment", "available", "runtime"]]);
    expect(spec("whistle").note).toContain("no socket imports");
    const ids = CREATOR_INTEGRATIONS.map((s) => s.id);
    expect(ids.indexOf("whistle")).toBe(ids.indexOf("dots-tts") + 1);
    expect(CREATOR_PROVIDER_IDS.indexOf("whistle")).toBe(CREATOR_PROVIDER_IDS.indexOf("dots-tts") + 1);
  });

  test("an in-engine transport needs no declaration: the row folds to built-in with both runtime capabilities usable", () => {
    expect(foldProviderStatus(spec("whistle"), { endpoints: [], secretPresent: false })).toMatchObject({ state: "built-in", usable: ["stt", "alignment"], endpointCount: 0 });
    expect(foldProviderStatus(spec("whistle"), { endpoints: [], secretPresent: false, locked: true }).cui).toMatchObject({ allowed: true, posture: "on-device" });
  });

  test("dots.tts alignment is available because Whistle measures it, and the detail says dots.tts emits none itself", () => {
    const align = spec("dots-tts").capabilities.find((c) => c.id === "alignment")!;
    expect(align.status).toBe("available");
    expect(align.detail).toBe("Measured in-process by Whistle; dots.tts itself emits no timestamps.");
  });
});

describe("enclave attestation and the CUI fold", () => {
  const avatar = (over: Partial<CreatorEndpointDef> = {}): CreatorEndpointDef => ({
    id: "nick-dgx-avatar", providerId: "dgx-avatar", label: "Avatar (Nick DGX)", baseUrl: "http://127.0.0.1:8088", zone: "internal", enclave: true, enabled: true, ...over,
  });

  test("enclave must be a boolean when present", () => {
    expect(validateCreatorEndpoint(avatar()).ok).toBe(true);
    expect(validateCreatorEndpoint(avatar({ enclave: false })).ok).toBe(true);
    const bad = validateCreatorEndpoint({ ...avatar(), enclave: "yes" as unknown as boolean });
    expect(bad.ok).toBe(false);
    expect(bad.errors.join(" ")).toContain("enclave must be true or false");
  });

  test("unlocked, every provider is allowed; locked, cloud flips to refused and the enclave stays allowed", () => {
    const ctx = { "dgx-avatar": { endpoints: [avatar()], secretPresent: false }, elevenlabs: { endpoints: [], secretPresent: true } };
    const open = creatorRegistryStatus(ctx, false);
    expect(open.every((p) => p.cui.allowed)).toBe(true);
    const locked = creatorRegistryStatus(ctx, true);
    expect(locked.find((p) => p.id === "elevenlabs")!.cui).toMatchObject({ allowed: false, posture: "cloud" });
    expect(locked.find((p) => p.id === "heygen")!.cui.allowed).toBe(false);
    expect(locked.find((p) => p.id === "dgx-avatar")!.cui).toMatchObject({ allowed: true, posture: "enclave" });
    expect(locked.find((p) => p.id === "threejs")!.cui.allowed).toBe(true);
  });

  test("each declaration is listed with its own verdict and never leaks its vault reference or workflow", () => {
    const st = foldProviderStatus(CREATOR_INTEGRATIONS.find((s) => s.id === "comfyui")!, {
      endpoints: [endpoint({ id: "lab-comfy", baseUrl: "http://10.0.0.9:8188", zone: "internal", vaultRef: "comfyui_token", workflow: "{}" }), endpoint()],
      secretPresent: true, locked: true,
    });
    expect(st.endpoints.map((e) => [e.id, e.cui.allowed])).toEqual([["lab-comfy", false], ["local-comfy", true]]);
    expect(JSON.stringify(st.endpoints)).not.toContain("comfyui_token");
    expect(JSON.stringify(st.endpoints)).not.toContain("workflow");
    // The row reads allowed because a usable declaration exists, the one a route would pick.
    expect(st.cui.allowed).toBe(true);
  });

  test("a provider whose only declaration is refused reads refused, with the reason", () => {
    const st = foldProviderStatus(CREATOR_INTEGRATIONS.find((s) => s.id === "dgx-avatar")!, { endpoints: [avatar({ enclave: undefined })], secretPresent: false, locked: true });
    expect(st.cui.allowed).toBe(false);
    expect(st.cui.reason).toContain("not attested as a DGX enclave host");
  });
});
