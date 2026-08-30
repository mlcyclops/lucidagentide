// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, test } from "bun:test";
import {
  PROBE_STALE_MS, ProbeCache, attestComfyCapabilities, attestElevenCapabilities, probeBuiltIn, probeComfyui,
  probeElevenlabs, probeExecutable, probeFreshness, probeHttpService, probeProvider,
  type ProbeDeps, type ProbeResult,
} from "./creator_probe.ts";
import { foldProviderStatus, CREATOR_INTEGRATIONS, type CreatorEndpointDef } from "./creator_registry.ts";

const ep = (over: Partial<CreatorEndpointDef> = {}): CreatorEndpointDef => ({
  id: "comfy-local", providerId: "comfyui", label: "Workstation ComfyUI",
  baseUrl: "http://127.0.0.1:8188", zone: "local", enabled: true, ...over,
});

function deps(over: Partial<ProbeDeps> = {}): ProbeDeps {
  let t = 1_000_000;
  return {
    fetchImpl: async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    exec: () => "",
    exists: () => true,
    now: () => (t += 10),
    secret: () => "",
    timeoutMs: 500,
    ...over,
  };
}
const jsonRes = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("ComfyUI capability attestation (CREATOR-1, ADR-0292)", () => {
  test("a capability is attested ONLY when the node that does it is installed", () => {
    expect(attestComfyCapabilities({ KSampler: {}, SaveImage: {}, LoadImage: {} }).sort())
      .toEqual(["asset-import", "image", "runtime-feedback", "workflow-run"]);
    expect(attestComfyCapabilities({ KSampler: {}, SaveImage: {} })).not.toContain("video");
    expect(attestComfyCapabilities({ KSampler: {}, VHS_VideoCombine: {} })).toContain("video");
    expect(attestComfyCapabilities({ SaveGLB: {} })).toContain("model-3d");
  });

  test("an unknown or empty payload attests NOTHING", () => {
    expect(attestComfyCapabilities(null)).toEqual([]);
    expect(attestComfyCapabilities({})).toEqual([]);
    expect(attestComfyCapabilities("nodes")).toEqual([]);
  });

  test("a reachable install reports its node count and what it proved", async () => {
    const r = await probeComfyui(deps({ fetchImpl: async () => jsonRes({ KSampler: {}, SaveImage: {}, VHS_VideoCombine: {} }) }), ep());
    expect(r.state).toBe("ready");
    expect(r.attested).toContain("video");
    expect(r.detail).toContain("3 nodes installed");
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  });

  test("a server with nodes but no output node is no-capabilities, not ready", async () => {
    const r = await probeComfyui(deps({ fetchImpl: async () => jsonRes({ SomeCustomNode: {} }) }), ep());
    expect(r.state).toBe("no-capabilities");
    expect(r.attested).toEqual([]);
  });

  test("a SAMPLER with no save node is not ready either - queuing is not producing", async () => {
    // Found by harness/scripts/verify_creator_comfy.ts against the --bare fixture: `workflow-run` alone
    // used to read as ready, so a graph that can never yield a file looked usable.
    const r = await probeComfyui(deps({ fetchImpl: async () => jsonRes({ KSampler: {}, SomeCustomNode: {} }) }), ep());
    expect(r.state).toBe("no-capabilities");
    expect(r.attested).toEqual([]);
    expect(r.detail).toContain("OUTPUT");
  });

  test("an output node alone IS enough, and the enablers come along", async () => {
    const r = await probeComfyui(deps({ fetchImpl: async () => jsonRes({ SaveImage: {}, KSampler: {} }) }), ep());
    expect(r.state).toBe("ready");
    expect(r.attested).toContain("image");
    expect(r.attested).toContain("workflow-run");
  });

  test("401 is unauthorized, a dead socket is unreachable, and neither throws", async () => {
    expect((await probeComfyui(deps({ fetchImpl: async () => jsonRes({}, 401) }), ep())).state).toBe("unauthorized");
    expect((await probeComfyui(deps({ fetchImpl: async () => { throw new Error("ECONNREFUSED"); } }), ep())).state).toBe("unreachable");
    expect((await probeComfyui(deps({ fetchImpl: async () => jsonRes({}, 500) }), ep())).state).toBe("unreachable");
  });

  test("a declaration with no base URL is skipped, not failed", async () => {
    expect((await probeComfyui(deps(), ep({ baseUrl: undefined }))).state).toBe("skipped");
  });
});

describe("ElevenLabs attestation rides the documented model flags", () => {
  test("flags map to capabilities, and TTS implies streaming plus alignment", () => {
    const caps = attestElevenCapabilities([{ model_id: "eleven_turbo_v2_5", can_do_text_to_speech: true, can_do_voice_conversion: true }]);
    expect(caps).toContain("tts");
    expect(caps).toContain("dubbing");
    expect(caps).toContain("streaming-audio");
    expect(caps).toContain("alignment");
  });

  test("a flag nobody set attests nothing", () => {
    expect(attestElevenCapabilities([{ model_id: "x", can_do_text_to_speech: false }])).toEqual([]);
    expect(attestElevenCapabilities(null)).toEqual([]);
  });

  test("no key means SKIPPED - a probe never invents a credential", async () => {
    const r = await probeElevenlabs(deps());
    expect(r.state).toBe("skipped");
    expect(r.detail).toContain("No ElevenLabs API key");
  });

  test("the key rides the xi-api-key header and never the URL", async () => {
    const seen: { url: string; key: string | null }[] = [];
    const r = await probeElevenlabs(deps({
      secret: () => "xi-secret-value",
      fetchImpl: async (url, init) => {
        seen.push({ url, key: new Headers(init?.headers as HeadersInit | undefined).get("xi-api-key") });
        return jsonRes([{ model_id: "eleven_turbo_v2_5", can_do_text_to_speech: true }]);
      },
    }));
    expect(r.state).toBe("ready");
    expect(seen[0]!.key).toBe("xi-secret-value");
    expect(seen[0]!.url).not.toContain("xi-secret-value");
    expect(r.detail).not.toContain("xi-secret-value");
  });

  test("a rejected key is unauthorized", async () => {
    const r = await probeElevenlabs(deps({ secret: () => "bad", fetchImpl: async () => jsonRes({ detail: "unauthorized" }, 401) }));
    expect(r.state).toBe("unauthorized");
    expect(r.detail).toContain("refused that API key");
  });
});

describe("a user-run service proves reachability and nothing more", () => {
  test("dots.tts answering attests tts, and says what it does not prove", async () => {
    const r = await probeHttpService(deps({ fetchImpl: async () => jsonRes({ data: [] }) }), "dots-tts", ep({ providerId: "dots-tts", baseUrl: "http://127.0.0.1:8010" }), { attestOnOk: ["tts"] });
    expect(r.state).toBe("ready");
    expect(r.attested).toEqual(["tts"]);
  });

  test("a Suno partner endpoint that answers is READY with NO capability claimed", async () => {
    const r = await probeHttpService(deps({ fetchImpl: async () => jsonRes({}) }), "suno", ep({ providerId: "suno", baseUrl: "https://partner.example" }));
    expect(r.state).toBe("ready");
    expect(r.attested).toEqual([]);
    expect(r.detail).toContain("Reachability is all this proves");
  });

  test("every path failing is one unreachable answer, not a cascade of errors", async () => {
    let calls = 0;
    const r = await probeHttpService(deps({ fetchImpl: async () => { calls++; return jsonRes({}, 404); } }), "dots-tts", ep({ providerId: "dots-tts" }));
    expect(r.state).toBe("unreachable");
    expect(calls).toBe(3);
    expect(r.detail).toContain("404");
  });
});

describe("a desktop app is attested by being on disk", () => {
  const blender = ep({ id: "blender", providerId: "blender", baseUrl: undefined, command: "/usr/bin/blender" });

  test("a present executable is ready, and its version line is captured", () => {
    const r = probeExecutable(deps({ exec: () => "Blender 5.2.1\n" }), "blender", blender, { versionArgs: ["--version"], attested: ["render-still"] });
    expect(r.state).toBe("ready");
    expect(r.version).toBe("Blender 5.2.1");
    expect(r.attested).toEqual(["render-still"]);
  });

  test("a missing executable is not-installed, not unreachable", () => {
    const r = probeExecutable(deps({ exists: () => false }), "blender", blender, { attested: ["render-still"] });
    expect(r.state).toBe("not-installed");
    expect(r.attested).toEqual([]);
  });

  test("a tool that refuses --version is still installed", () => {
    const r = probeExecutable(deps({ exec: () => { throw new Error("exit 1"); } }), "unreal", ep({ providerId: "unreal", baseUrl: undefined, command: "/opt/UE/UnrealEditor-Cmd" }), { versionArgs: ["-version"], attested: ["engine-build"] });
    expect(r.state).toBe("ready");
    expect(r.version).toBe("");
    expect(r.attested).toEqual(["engine-build"]);
  });

  test("three.js is ready by construction", () => {
    const r = probeBuiltIn(deps(), "threejs", ["scene-preview"]);
    expect(r.state).toBe("ready");
    expect(r.detail).toContain("no endpoint, no credential, no network");
  });
});

describe("provider routing + the cache", () => {
  test("each provider gets the adapter its transports imply, and no declaration is skipped honestly", async () => {
    const d = deps();
    expect((await probeProvider(d, "threejs", [])).state).toBe("ready");
    expect((await probeProvider(d, "comfyui", [])).state).toBe("skipped");
    expect((await probeProvider(d, "suno", [])).detail).toContain("local library works without one");
    expect((await probeProvider(d, "blender", [])).state).toBe("skipped");
  });

  test("freshness is three states, and an expired answer is not trusted", () => {
    expect(probeFreshness(1000, 1000)).toBe("fresh");
    expect(probeFreshness(1000, 1000 + 200_000)).toBe("stale");
    expect(probeFreshness(1000, 1000 + PROBE_STALE_MS)).toBe("expired");
    expect(probeFreshness(0, 5)).toBe("expired");
  });

  test("the cache only hands over ATTESTED capabilities from a ready, unexpired probe", () => {
    const cache = new ProbeCache();
    const ready: ProbeResult = { providerId: "comfyui", state: "ready", at: 1000, latencyMs: 5, detail: "", attested: ["image", "workflow-run"], version: "" };
    cache.set(ready);
    expect(cache.discovered("comfyui", 1500)).toEqual(["image", "workflow-run"]);
    expect(cache.discovered("comfyui", 1000 + PROBE_STALE_MS)).toBeUndefined();
    cache.set({ ...ready, state: "unreachable", attested: [] });
    expect(cache.discovered("comfyui", 1500)).toBeUndefined();
    expect(cache.discovered("blender", 1500)).toBeUndefined();
  });

  test("a ready probe turns registry state from configured into READY, with only attested capabilities usable", () => {
    const comfy = CREATOR_INTEGRATIONS.find((s) => s.id === "comfyui")!;
    const before = foldProviderStatus(comfy, { endpoints: [ep()], secretPresent: true });
    expect(before.state).toBe("configured");
    const after = foldProviderStatus(comfy, { endpoints: [ep()], secretPresent: true, discovered: ["image", "workflow-run"] });
    expect(after.state).toBe("ready");
    expect(after.usable).toContain("image");
    expect(after.usable).not.toContain("video"); // the catalog lists it; this install did not prove it
  });
});
