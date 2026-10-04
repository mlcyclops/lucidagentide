// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, test } from "bun:test";
import {
  PROBE_STALE_MS, ProbeCache, attestComfyCapabilities, attestElevenCapabilities, probeBuiltIn, probeComfyui,
  probeElevenlabs, probeExecutable, probeFreshness, probeHttpService, probeProvider,
  type ProbeDeps, type ProbeResult,
} from "./creator_probe.ts";
import { foldProviderStatus, CREATOR_INTEGRATIONS, type CreatorEndpointDef } from "./creator_registry.ts";
import { driftSessionEndpointDef } from "./creator_drift.ts";

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

describe("the DGX Loader services and HyperFrames", () => {
  const avatarEp = ep({ id: "nick-dgx-avatar", providerId: "dgx-avatar", baseUrl: "http://127.0.0.1:8088", zone: "internal", enclave: true });
  const cadEp = ep({ id: "nick-dgx-cad", providerId: "dgx-cad", baseUrl: "http://127.0.0.1:8089", zone: "internal", enclave: true });

  test("dgx-avatar attests avatar-video only when an engine is ready, and video-compose only when compose is", async () => {
    let asked = "";
    const health = { ok: true, service: "dgx-avatar", version: "1.0.0", engines: { musetalk: { ready: true }, echomimic: { ready: false, detail: "weights missing" } }, compose: { ready: false, detail: "no chromium" } };
    const r = await probeProvider(deps({ fetchImpl: async (url) => { asked = url; return jsonRes(health); } }), "dgx-avatar", [avatarEp]);
    expect(asked).toBe("http://127.0.0.1:8088/health");
    expect(r.state).toBe("ready");
    expect(r.attested).toEqual(["avatar-video"]);
    expect(r.detail).toContain("weights missing");
    const none = await probeProvider(deps({ fetchImpl: async () => jsonRes({ ...health, engines: { musetalk: { ready: false }, echomimic: { ready: false } } }) }), "dgx-avatar", [avatarEp]);
    expect(none.state).toBe("no-capabilities");
    expect(none.attested).toEqual([]);
  });

  test("a /health from some other service attests nothing", async () => {
    const r = await probeProvider(deps({ fetchImpl: async () => jsonRes({ ok: true, service: "dgx-cad" }) }), "dgx-avatar", [avatarEp]);
    expect(r.state).toBe("no-capabilities");
    expect(r.attested).toEqual([]);
  });

  test("dgx-cad maps each library to its capability and names what is absent", async () => {
    const health = { ok: true, service: "dgx-cad", version: "0.3", capabilities: { model: true, dxf: true, ifc: false, dwg: false }, detail: { ifc: "ifcopenshell not importable" } };
    const r = await probeProvider(deps({ fetchImpl: async () => jsonRes(health) }), "dgx-cad", [cadEp]);
    expect(r.state).toBe("ready");
    expect(r.attested).toEqual(["cad-model", "cad-drawing"]);
    expect(r.detail).toContain("ifcopenshell not importable");
  });

  test("dgx-vision attests only the capabilities /health reports and names models that are not ready", async () => {
    const visionEp = ep({ id: "nick-dgx-vision", providerId: "dgx-vision", baseUrl: "http://127.0.0.1:8090/", zone: "internal", enclave: true });
    let asked = "";
    const health = {
      ok: true, service: "dgx-vision", version: "0.1.0",
      capabilities: { segment: true, decompose: false, generative_decompose: true, matte: true, inpaint: false, upscale: true, depth: false, label: true, vectorize: true },
      models: { sam2: { ready: true, detail: "" }, depth: { ready: false, detail: "sha256 mismatch" }, "../x": { ready: false, detail: "ignored" } },
    };
    const r = await probeProvider(deps({ fetchImpl: async (url) => { asked = url; return jsonRes(health); } }), "dgx-vision", [visionEp]);
    expect(asked).toBe("http://127.0.0.1:8090/health");
    expect(r.state).toBe("ready");
    expect(r.attested).toEqual(["segment", "layer-decompose", "matte", "upscale", "vision-label", "vectorize"]);
    expect(r.detail).toContain("depth (sha256 mismatch)");
    expect(r.detail).not.toContain("../x");
    const other = await probeProvider(deps({ fetchImpl: async () => jsonRes({ ...health, service: "dgx-cad" }) }), "dgx-vision", [visionEp]);
    expect(other).toMatchObject({ state: "no-capabilities", attested: [] });
    const skipped = await probeProvider(deps(), "dgx-vision", []);
    expect(skipped.state).toBe("skipped");
  });

  test("the design editor is built into the renderer and needs no endpoint", async () => {
    const r = await probeProvider(deps({ fetchImpl: async () => { throw new Error("no network expected"); } }), "design", []);
    expect(r.state).toBe("ready");
    expect(r.attested).toContain("mask-trace");
  });

  test("a dead tunnel is unreachable and says where to look", async () => {
    const r = await probeProvider(deps({ fetchImpl: async () => { throw new Error("ECONNREFUSED"); } }), "dgx-cad", [cadEp]);
    expect(r.state).toBe("unreachable");
    expect(r.detail).toContain("SSH forward");
  });

  test("HyperFrames is probed with `--version` on the declared launcher, and a .cmd shim is refused before anything runs", async () => {
    const calls: string[][] = [];
    const hf = ep({ id: "hf", providerId: "hyperframes", baseUrl: undefined, command: "C:/node/node.exe", args: ["C:/hf/node_modules/hyperframes/dist/cli.js"] });
    const r = await probeProvider(deps({ exec: (argv) => { calls.push([...argv]); return "0.8.115\n"; } }), "hyperframes", [hf]);
    expect(calls).toEqual([["C:/node/node.exe", "C:/hf/node_modules/hyperframes/dist/cli.js", "--version"]]);
    expect(r.state).toBe("ready");
    expect(r.version).toBe("0.8.115");
    expect(r.attested).toContain("video-compose");
    const shim = await probeProvider(deps({ exec: (argv) => { calls.push([...argv]); return ""; } }), "hyperframes", [{ ...hf, command: "C:/hf/node_modules/.bin/hyperframes.cmd", args: [] }]);
    expect(shim.state).toBe("not-installed");
    expect(calls).toHaveLength(1);
  });

  test("paid catalog entries are never called, and pdf-markup is built in", async () => {
    let fetched = 0;
    const d = deps({ fetchImpl: async () => { fetched += 1; return jsonRes({}); }, secret: () => "a-key-that-is-present" });
    for (const id of ["heygen", "autodesk-aps", "bluebeam-studio", "classcad", "oda-drawings"] as const) {
      expect((await probeProvider(d, id, [])).state).toBe("skipped");
    }
    expect(fetched).toBe(0);
    expect((await probeProvider(d, "pdf-markup", [])).attested).toEqual(["pdf-markup"]);
  });
});

describe("CutWire Drift (CREATOR-DRIFT)", () => {
  const session = { port: 4731, url: "http://127.0.0.1:4731/mcp", token: "hex-token-never-shown", pid: 5152 };
  const sessionPath = "C:\\Users\\nick/drift/mcp-session.json";
  const withSession = (s: typeof session | null, error = "") => () => ({ path: sessionPath, session: s, error });
  const rpc = (body: unknown) => async (_url: string, init?: RequestInit) => {
    const req = JSON.parse(String(init?.body)) as { method: string; params?: { name?: string } };
    if (req.method === "initialize") return jsonRes({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "drift", version: "0.7.3" } } });
    return jsonRes({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: JSON.stringify(body) }], isError: false } });
  };
  const exeOnly = (p: string) => p === "C:\\Program Files\\Drift\\drift.exe";

  test("no session and no executable is not-installed, naming where it looked", async () => {
    let fetched = 0;
    const r = await probeProvider(deps({ fetchImpl: async () => { fetched += 1; return jsonRes({}); }, exists: () => false, platform: "win32", env: {}, driftSession: withSession(null, "ENOENT") }), "drift", []);
    expect(r.state).toBe("not-installed");
    expect(r.detail).toContain("C:\\Program Files\\Drift\\drift.exe");
    expect(fetched).toBe(0);
  });

  test("the executable without a session is unreachable with the Agent access steps", async () => {
    const r = await probeProvider(deps({ exists: exeOnly, platform: "win32", env: {}, driftSession: withSession(null, "ENOENT") }), "drift", []);
    expect(r.state).toBe("unreachable");
    expect(r.detail).toContain("Drift is installed (C:\\Program Files\\Drift\\drift.exe) but Agent access is off");
    expect(r.detail).toContain("Settings -> Agent access -> On");
  });

  test("a 401 is unauthorized and never echoes the token", async () => {
    const r = await probeProvider(deps({ fetchImpl: async () => new Response('{"error":"unauthorized"}', { status: 401 }), platform: "win32", env: {}, driftSession: withSession(session) }), "drift", []);
    expect(r.state).toBe("unauthorized");
    expect(r.detail).toContain(sessionPath);
    expect(JSON.stringify(r)).not.toContain("hex-token-never-shown");
  });

  test("a dead port from a session file says the file may be stale", async () => {
    const r = await probeProvider(deps({ fetchImpl: async () => { throw new Error("ECONNREFUSED"); }, platform: "win32", env: {}, driftSession: withSession(session) }), "drift", []);
    expect(r.state).toBe("unreachable");
    expect(r.detail).toContain("stale");
    expect(r.detail).toContain("Agent access");
  });

  test("initialize ok is ready with the version; stock-media only when market_status reports configured", async () => {
    const ready = await probeProvider(deps({ fetchImpl: rpc({ ok: true, configured: false }), platform: "win32", env: {}, driftSession: withSession(session) }), "drift", []);
    expect(ready.state).toBe("ready");
    expect(ready.version).toBe("0.7.3");
    expect(ready.attested).toEqual(["video-edit", "motion", "transcript-edit"]);
    expect(JSON.stringify(ready)).not.toContain("hex-token-never-shown");
    const market = await probeProvider(deps({ fetchImpl: rpc({ ok: true, configured: true }), platform: "win32", env: {}, driftSession: withSession(session) }), "drift", []);
    expect(market.attested).toEqual(["video-edit", "motion", "transcript-edit", "stock-media"]);
    const marketDown = await probeProvider(deps({ fetchImpl: rpc({ ok: false, error: "market_unavailable" }), platform: "win32", env: {}, driftSession: withSession(session) }), "drift", []);
    expect(marketDown.attested).not.toContain("stock-media");
  });

  test("a declared headless endpoint uses the declared token and needs one", async () => {
    const headless = ep({ id: "drift-headless", providerId: "drift", baseUrl: "http://127.0.0.1:4800", vaultRef: "drift_mcp_token" });
    let auth = "";
    const d = deps({
      fetchImpl: async (url, init) => { auth = new Headers(init?.headers).get("authorization") ?? ""; return rpc({ ok: true, configured: false })(url, init); },
      secret: (id) => (id === "drift" ? "declared-token" : ""), platform: "win32", env: {}, driftSession: withSession(session),
    });
    const r = await probeProvider(d, "drift", [headless]);
    expect(r.state).toBe("ready");
    expect(r.detail).toContain("http://127.0.0.1:4800");
    expect(auth).toBe("Bearer declared-token");
    const noToken = await probeProvider(deps({ fetchImpl: rpc({}), secret: () => "", platform: "win32", env: {} }), "drift", [headless]);
    expect(noToken.state).toBe("unauthorized");
    expect(noToken.detail).toContain("DRIFT_MCP_TOKEN");
  });

  test("the engine's synthesized session endpoint probes as the session, with the session token and its stale-file hint", async () => {
    // The route hands probeProvider the endpoint a call would use; for a session-discovered Drift that is the
    // declaration synthesized from mcp-session.json, so the probe must read the session's token, not the vault.
    const synthesized = driftSessionEndpointDef(session);
    let auth = "";
    const ready = await probeProvider(deps({
      fetchImpl: async (url, init) => { auth = new Headers(init?.headers).get("authorization") ?? ""; return rpc({ ok: true, configured: false })(url, init); },
      secret: () => "", platform: "win32", env: {}, driftSession: withSession(session),
    }), "drift", [synthesized]);
    expect(ready.state).toBe("ready");
    expect(auth).toBe("Bearer hex-token-never-shown");
    expect(ready.detail).toContain("Agent access session");
    expect(ready.detail).not.toContain("declared endpoint");
    const dead = await probeProvider(deps({ fetchImpl: async () => { throw new Error("ECONNREFUSED"); }, platform: "win32", env: {}, driftSession: withSession(session) }), "drift", [synthesized]);
    expect(dead.detail).toContain("stale");
  });
});
